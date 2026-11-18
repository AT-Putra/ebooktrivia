import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningEdge } from "./edge-server.ts";
import { type NextFactory, readStandaloneConfig, startNextBehindEdge } from "./next-app.ts";
import type { SignalProcess } from "./signals.ts";

const dirs: string[] = [];
const edges: RunningEdge[] = [];
afterEach(async () => {
  for (const edge of edges.splice(0)) if (edge.server.listening) await new Promise((resolve) => edge.server.close(resolve));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env["__NEXT_PRIVATE_STANDALONE_CONFIG"];
});

function standaloneDir(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "edge-next-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".next"));
  writeFileSync(join(dir, ".next", "required-server-files.json"), JSON.stringify(manifest));
  return dir;
}

const quietProcess: SignalProcess = { on: () => undefined, exit: () => undefined };
const PROD = { NODE_ENV: "production", TRUSTED_PROXY_IP: "127.0.0.1", EDGE_HOST: "127.0.0.1", EDGE_PORT: "0" };

describe("startNextBehindEdge", () => {
  it("hands the build's config to Next and serves it behind the edge listener", async () => {
    const dir = standaloneDir({ version: 1, config: { poweredByHeader: false, output: "standalone" } });
    const calls: unknown[] = [];
    const next: NextFactory = (options) => {
      calls.push(options);
      return {
        prepare: () => Promise.resolve(),
        getRequestHandler: () => (req, res) => {
          res.end(String(req.headers["x-forwarded-for"]));
        },
      };
    };
    const edge = await startNextBehindEdge(dir, PROD, next, () => undefined, quietProcess);
    edges.push(edge);
    expect(calls).toEqual([{ dev: false, dir, hostname: "127.0.0.1", port: 0, conf: { poweredByHeader: false, output: "standalone" } }]);
    expect(JSON.parse(process.env["__NEXT_PRIVATE_STANDALONE_CONFIG"] ?? "{}")).toEqual({ poweredByHeader: false, output: "standalone" });
    const base = `http://127.0.0.1:${String(edge.port)}`;
    expect(await (await fetch(`${base}/livez`)).text()).toBe("ok\n");
    expect(await (await fetch(`${base}/`, { headers: { "x-forwarded-for": "198.51.100.7" } })).text()).toBe("198.51.100.7");
  });

  it("refuses to run outside production or without a build config", async () => {
    const next: NextFactory = () => {
      throw new Error("not reached");
    };
    await expect(startNextBehindEdge(standaloneDir({ config: {} }), { NODE_ENV: "development" }, next, () => undefined, quietProcess)).rejects.toThrow(
      "NODE_ENV=production only",
    );
    expect(() => readStandaloneConfig(standaloneDir({ version: 1 }))).toThrow("has no config");
  });
});
