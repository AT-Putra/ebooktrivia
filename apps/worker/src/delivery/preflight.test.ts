// US-005 R11 / security review: the REAL pre-flight path of a file send (createEbookFiles with NO injected fetch, so createSafeFetch of the adapters), not the fake the
// delivery tests use. What it must hold: the egress rules of every outgoing call of the worker (https only; a private, loopback or metadata address is never connected to), a
// budget of its own (PREFLIGHT_TIMEOUT_MS, never WAHA's request timeout), and a missing file that fails before anything is fetched. A TLS stub with a certificate the client would
// trust cannot be made without a certificate authority, so the stub here is a plain TCP listener that counts connections: it proves WHETHER the safe-fetch connected.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEbookFiles, edgeResolver } from "./access.ts";
import { PREFLIGHT_TIMEOUT_MS } from "./config.ts";

const STORAGE = `deliverables/${randomUUID()}.pdf`;
const KEY = randomBytes(32);
const PRODUCTION = { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: false };
const DEV_LOOPBACK = { allowHttp: false, allowLoopback: true, allowPlaintextSmtp: false };
let dataDir: string;
let stub: Server;
let connections = 0;
let port = 0;
const sockets = new Set<Socket>();

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ebt-preflight-"));
  await mkdir(join(dataDir, "deliverables"), { recursive: true });
  await writeFile(join(dataDir, STORAGE), Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(512), Buffer.from("\n%%EOF\n")]));
  // Accepts and never answers: a connection is counted, the TLS handshake never completes.
  stub = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    stub.listen(0, "127.0.0.1", resolve);
  });
  const address = stub.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => {
    stub.close(() => {
      resolve();
    });
  });
  await rm(dataDir, { recursive: true, force: true });
});

const filesFor = (apiOrigin: string, dev: typeof PRODUCTION, timeoutMs?: number, apiEdgeAddress: string | null = null) =>
  createEbookFiles({ dataDir, apiOrigin, fileUrlKey: KEY, dev, apiEdgeAddress }, timeoutMs === undefined ? {} : { timeoutMs });

describe("the edge address of api.<DOMAIN> (WORKER_API_EDGE_ADDRESS: the single-VM install)", () => {
  it("resolves the API host alone to the edge proxy, any case; every other name goes to the normal resolver", async () => {
    const asked: string[] = [];
    const resolve = edgeResolver("api.example.id", "10.90.55.2", (name) => {
      asked.push(name);
      return Promise.resolve([{ address: "203.0.113.9", family: 4 }]);
    });
    expect(await resolve("api.example.id")).toEqual([{ address: "10.90.55.2", family: 4 }]);
    expect(await resolve("API.Example.ID")).toEqual([{ address: "10.90.55.2", family: 4 }]);
    expect(await resolve("play.example.id")).toEqual([{ address: "203.0.113.9", family: 4 }]);
    expect(await resolve("api.example.id.evil.test")).toEqual([{ address: "203.0.113.9", family: 4 }]);
    expect(asked).toEqual(["play.example.id", "api.example.id.evil.test"]);
    expect(await edgeResolver("api.example.id", "fd00:89::2")("api.example.id")).toEqual([{ address: "fd00:89::2", family: 6 }]);
  });

  it("connects to the edge address for the API host, not to what its name resolves to (here: a name that resolves nowhere)", async () => {
    const before = connections;
    expect(await filesFor(`https://api.ebt-preflight.invalid:${String(port)}`, DEV_LOOPBACK, 300, "127.0.0.1").preflight(STORAGE, new Date())).toEqual({ ok: false, reason: "unreachable" });
    expect(connections).toBeGreaterThan(before);
  });

  it("still never connects to a metadata or link-local address, even if one were configured", async () => {
    const before = connections;
    for (const edge of ["169.254.169.254", "169.254.1.2"]) {
      const started = Date.now();
      expect(await filesFor("https://api.ebt-preflight.invalid", PRODUCTION, 1500, edge).preflight(STORAGE, new Date()), edge).toEqual({ ok: false, reason: "unreachable" });
      expect(Date.now() - started, edge).toBeLessThan(1400);
    }
    expect(connections).toBe(before);
  });
});

describe("the pre-flight through the real safe-fetch (no injected fetch)", () => {
  it("never connects to a loopback, private or metadata address under the production policy: unreachable, and not a single connection is opened", async () => {
    const before = connections;
    for (const origin of [`https://127.0.0.1:${String(port)}`, "https://10.0.0.5", "https://192.168.1.10", "https://169.254.169.254", "https://[::1]"]) {
      const started = Date.now();
      expect(await filesFor(origin, PRODUCTION, 1500).preflight(STORAGE, new Date()), origin).toEqual({ ok: false, reason: "unreachable" });
      // Refused at once by the address policy (an allowed address that does not answer would take the whole 1.5 s budget).
      expect(Date.now() - started, origin).toBeLessThan(1400);
    }
    expect(connections).toBe(before);
  });

  it("with loopback allowed (dev) the real fetch DOES connect, so the refusal above is the address policy's and nothing else; a server that never answers is given up after the pre-flight's OWN budget", async () => {
    const before = connections;
    const started = Date.now();
    expect(await filesFor(`https://127.0.0.1:${String(port)}`, DEV_LOOPBACK, 300).preflight(STORAGE, new Date())).toEqual({ ok: false, reason: "unreachable" });
    expect(connections).toBeGreaterThan(before);
    // Its own short budget (300 ms here), never WAHA's request timeout (60 s by default).
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("the default budget is PREFLIGHT_TIMEOUT_MS: short, and nowhere near WAHA's whole-request timeout", () => {
    expect(PREFLIGHT_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it("a stored file that is missing fails BEFORE anything is fetched (the caller treats it as a missing PDF, never as an uncertain send)", async () => {
    const before = connections;
    await expect(filesFor(`https://127.0.0.1:${String(port)}`, DEV_LOOPBACK, 300).preflight(`deliverables/${randomUUID()}.pdf`, new Date())).rejects.toMatchObject({ code: "ENOENT" });
    expect(connections).toBe(before);
    // And a path that is not a deliverable one is refused the same way, before the disk or the network is touched.
    await expect(filesFor("https://api.example.test", PRODUCTION).preflight("deliverables/../../etc/passwd", new Date())).rejects.toThrow(RangeError);
  });
});
