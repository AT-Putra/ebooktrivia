import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AppHandler, KEEP_ALIVE_TIMEOUT_MS, type RunningEdge, startEdgeServer } from "./edge-server.ts";

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** A raw request, so any header (several X-Forwarded-For lines, Forwarded, ...) can be sent. */
function send(port: number, path: string, headers: [string, string][] = [], method = "GET"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    // A raw header array gets no automatic Host header, and HTTP/1.1 requires one.
    const raw = [["Host", `127.0.0.1:${String(port)}`], ...headers].flat();
    const req = request({ host: "127.0.0.1", port, path, method, headers: raw, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Echoes what the app sees: the client-address headers and the raw header names. */
const echo: AppHandler = (req, res) => {
  const seen = {
    xff: req.headers["x-forwarded-for"] ?? null,
    proto: req.headers["x-forwarded-proto"] ?? null,
    host: req.headers["x-forwarded-host"] ?? null,
    realIp: req.headers["x-real-ip"] ?? null,
    forwarded: req.headers.forwarded ?? null,
    raw: req.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase()),
    rawXff: req.rawHeaders.filter((_, i, all) => i % 2 === 1 && all[i - 1]?.toLowerCase() === "x-forwarded-for"),
  };
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(seen));
};

const running: RunningEdge[] = [];
const temp: string[] = [];
afterEach(async () => {
  for (const edge of running.splice(0)) {
    if (edge.server.listening) await new Promise((resolve) => edge.server.close(resolve));
  }
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(options: { trustedProxy: string | null; handle?: AppHandler; drainMs?: number; drainFile?: string }): Promise<RunningEdge> {
  const edge = await startEdgeServer({
    host: "127.0.0.1",
    port: 0,
    trustedProxy: options.trustedProxy,
    drainMs: options.drainMs ?? 0,
    drainFile: options.drainFile,
    closeTimeoutMs: 2000,
    handle: options.handle ?? echo,
    log: () => undefined,
  });
  running.push(edge);
  return edge;
}

const SPOOF: [string, string][] = [
  ["X-Forwarded-For", "203.0.113.66"],
  ["X-Forwarded-For", "198.51.100.66"],
  ["X-Real-IP", "203.0.113.67"],
  ["Forwarded", "for=203.0.113.68;proto=https"],
  ["True-Client-IP", "203.0.113.69"],
  ["CF-Connecting-IP", "203.0.113.70"],
  ["X-Forwarded-Proto", "https"],
  ["X-Forwarded-Host", "admin.example.test"],
];

describe("client address", () => {
  it("takes X-Forwarded-For from the trusted proxy (here: loopback plays Caddy)", async () => {
    const edge = await start({ trustedProxy: "127.0.0.1" });
    const reply = await send(edge.port, "/x", [
      ["X-Forwarded-For", "198.51.100.7"],
      ["X-Forwarded-Proto", "https"],
      ["X-Forwarded-Host", "play.example.test"],
      ["X-Real-IP", "203.0.113.1"],
    ]);
    const seen = JSON.parse(reply.body) as Record<string, unknown>;
    expect(seen).toMatchObject({ xff: "198.51.100.7", proto: "https", host: "play.example.test", realIp: null, rawXff: ["198.51.100.7"] });
    expect(seen["raw"]).not.toContain("x-real-ip");
  });

  it("ignores every forwarding header from a peer that is not the proxy", async () => {
    const edge = await start({ trustedProxy: "192.0.2.10" });
    const seen = JSON.parse((await send(edge.port, "/x", SPOOF)).body) as Record<string, unknown>;
    expect(seen).toMatchObject({ xff: "127.0.0.1", proto: null, host: null, realIp: null, forwarded: null, rawXff: ["127.0.0.1"] });
    for (const name of ["x-real-ip", "forwarded", "true-client-ip", "cf-connecting-ip", "x-forwarded-proto", "x-forwarded-host"]) {
      expect(seen["raw"]).not.toContain(name);
    }
  });

  it("trusts nobody when no proxy is configured", async () => {
    const edge = await start({ trustedProxy: null });
    const seen = JSON.parse((await send(edge.port, "/x", SPOOF)).body) as Record<string, unknown>;
    expect(seen).toMatchObject({ xff: "127.0.0.1", proto: null });
  });
});

describe("/livez and draining", () => {
  it("answers /livez itself, before the app and without rewriting headers", async () => {
    let appCalls = 0;
    const edge = await start({
      trustedProxy: null,
      handle: (_req, res) => {
        appCalls++;
        res.end("app");
      },
    });
    const ok = await send(edge.port, "/livez");
    expect([ok.status, ok.body, ok.headers["cache-control"]]).toEqual([200, "ok\n", "no-store"]);
    expect((await send(edge.port, "/livez?probe=1")).status).toBe(200);
    const head = await send(edge.port, "/livez", [], "HEAD");
    expect([head.status, head.body]).toEqual([200, ""]);
    const post = await send(edge.port, "/livez", [], "POST");
    expect([post.status, post.headers["allow"]]).toEqual([405, "GET, HEAD"]);
    expect(appCalls).toBe(0);
    expect((await send(edge.port, "/livez/x")).body).toBe("app");
  });

  it("answers 503 while the drain file exists, and asks clients to close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edge-"));
    temp.push(dir);
    const drainFile = join(dir, "drain");
    const edge = await start({
      trustedProxy: null,
      drainFile,
      handle: (_req, res) => {
        res.end("app");
      },
    });
    expect((await send(edge.port, "/livez")).status).toBe(200);
    writeFileSync(drainFile, "");
    const draining = await send(edge.port, "/livez");
    expect([draining.status, draining.body]).toEqual([503, "draining\n"]);
    const app = await send(edge.port, "/");
    expect([app.status, app.headers["connection"]]).toEqual([200, "close"]);
    rmSync(drainFile);
    expect((await send(edge.port, "/livez")).status).toBe(200);
    expect(edge.server.listening).toBe(true);
  });

  it("drain(): 503 at once, keeps serving for drainMs, finishes in-flight requests, then stops accepting", async () => {
    let release: (() => void) | undefined;
    const edge = await start({
      trustedProxy: null,
      drainMs: 300,
      handle: (req, res) => {
        if (req.url === "/slow") {
          release = () => res.end("slow done");
          return;
        }
        res.end("app");
      },
    });
    const slow = send(edge.port, "/slow");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const drained = edge.drain();
    expect(edge.drain()).toBe(drained);
    expect(edge.isDraining()).toBe(true);
    expect((await send(edge.port, "/livez")).status).toBe(503);
    expect((await send(edge.port, "/")).body).toBe("app");
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Past drainMs: no new connections, but the in-flight request still completes.
    await expect(send(edge.port, "/livez")).rejects.toThrow();
    release?.();
    expect((await slow).body).toBe("slow done");
    await drained;
    expect(edge.server.listening).toBe(false);
  });

  it("turns a failing app handler into a 500", async () => {
    const sync = await start({
      trustedProxy: null,
      handle: () => {
        throw new Error("boom");
      },
    });
    expect((await send(sync.port, "/")).status).toBe(500);
    const async = await start({ trustedProxy: null, handle: () => Promise.reject(new Error("boom")) });
    expect((await send(async.port, "/")).status).toBe(500);
  });

  it("keeps idle connections longer than Caddy's upstream keepalive (30 s)", async () => {
    const edge = await start({ trustedProxy: null });
    expect(edge.server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it("reports a port it cannot bind", async () => {
    const edge = await start({ trustedProxy: null });
    await expect(
      startEdgeServer({ host: "127.0.0.1", port: edge.port, trustedProxy: null, drainMs: 0, drainFile: undefined, closeTimeoutMs: 0, handle: echo, log: () => undefined }),
    ).rejects.toThrow(/EADDRINUSE/);
  });
});
