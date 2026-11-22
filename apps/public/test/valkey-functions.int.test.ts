// US-031: the public API's rate limits are an FCALL of the worker-loaded function ebt_rate_limit_v1, under the DEV
// ACL file itself (infra/dev/valkey/users.acl, the same grants as production: infra/verify/src/provision.test.ts).
// Its own throwaway Valkey 9.1.3 container (Docker), so deleting the function here never disturbs the other test
// files. Proves: public FCALLs it and nothing else (EVAL, EVALSHA, SCRIPT LOAD, FUNCTION LOAD / DELETE / FLUSH are
// NOPERM); a missing function fails closed (503) on the rate-limited routes and logs `public.valkey_function_missing`
// until the function is back.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadPublicValkeyFunctions, PUBLIC_VALKEY_LIBRARY, RATE_LIMIT_FUNCTION } from "@ebooktrivia/adapters/valkey-functions";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { logEvent } from "../src/lib/log.ts";
import { orderRateLimit } from "../src/lib/order/handler.ts";
import { hitRateLimits, ValkeyUnavailable } from "../src/lib/valkey.ts";

const run = promisify(execFile);
const VALKEY_IMAGE = "docker.io/valkey/valkey:9.1.3@sha256:3add1a336a920ea54770a001ab6feb3da5fceea96a40373a3a2cd469b815f0b7";
const DEV_ACL = new URL("../../../infra/dev/valkey/users.acl", import.meta.url);
// The dev ACL's passwords (DEV ONLY, infra/dev/valkey/users.acl).
const PASSWORDS = { public: "public-devonly", worker: "worker-devonly" } as const;

let dir: string;
let id: string | undefined;
let port: number;
const clients: Redis[] = [];

function client(user: keyof typeof PASSWORDS): Redis {
  // How lib/valkey.ts connects as public: no offline queue, no ready check (public has no INFO), bounded commands.
  const redis = new Redis({ host: "127.0.0.1", port, username: user, password: PASSWORDS[user], lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, commandTimeout: 2000, enableReadyCheck: false, disableClientInfo: true });
  clients.push(redis);
  return redis;
}
const reply = (p: Promise<unknown>) => p.then((value) => JSON.stringify(value), (error: unknown) => (error instanceof Error ? error.message : String(error)));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ebt-pub-valkey-fn-"));
  writeFileSync(join(dir, "users.acl"), readFileSync(DEV_ACL));
  writeFileSync(join(dir, "valkey.conf"), "maxmemory 32mb\nmaxmemory-policy noeviction\nsave \"\"\nappendonly no\naclfile /etc/valkey/users.acl\n");
  const { stdout } = await run("docker", [
    "run", "-d", "--rm", "-p", "127.0.0.1::6379",
    "-v", `${join(dir, "valkey.conf")}:/etc/valkey/valkey.conf:ro`,
    "-v", `${join(dir, "users.acl")}:/etc/valkey/users.acl:ro`,
    VALKEY_IMAGE, "valkey-server", "/etc/valkey/valkey.conf",
  ]);
  id = stdout.trim();
  const mapped = (await run("docker", ["port", id, "6379/tcp"])).stdout.trim().split("\n")[0] ?? "";
  port = Number(mapped.slice(mapped.lastIndexOf(":") + 1));
  const deadline = Date.now() + 30_000;
  for (;;) {
    const probe = new Redis({ host: "127.0.0.1", port, username: "worker", password: PASSWORDS.worker, lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    try {
      await probe.connect();
      await probe.ping();
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("the throwaway Valkey with the dev ACL did not answer");
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      probe.disconnect();
    }
  }
}, 60_000);

afterAll(async () => {
  for (const c of clients) c.disconnect();
  if (id !== undefined) await run("docker", ["rm", "-f", id]).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("the public rate-limit function under the dev ACL", () => {
  it("is loaded by the worker user, FCALLed by public, and public can run no Lua of its own", async () => {
    const worker = client("worker");
    const pub = client("public");
    await Promise.all([worker.connect(), pub.connect()]);
    expect(await loadPublicValkeyFunctions(worker)).toBe(PUBLIC_VALKEY_LIBRARY);

    const limits = [{ key: "acl:fn:a", limit: 1, windowMs: 60_000 }];
    expect(await hitRateLimits(pub, limits)).toEqual({ allowed: true });
    expect(await hitRateLimits(pub, limits)).toMatchObject({ allowed: false, index: 0 });
    expect(await reply(worker.get("rl:acl:fn:a"))).toBe('"2"');
    expect(await reply(pub.call("FCALL", RATE_LIMIT_FUNCTION, 0))).toBe("[0,0]");

    for (const [what, attempt] of [
      ["EVAL", () => pub.eval("return 1", 0)],
      ["EVAL of the old rate-limit script", () => pub.eval("return redis.call('INCR', KEYS[1])", 1, "rl:acl:fn:eval")],
      ["EVALSHA", () => pub.evalsha("e0e1f9fabfc9d4800c877a703b823ac0578ff8db", 0)],
      ["SCRIPT LOAD", () => pub.call("SCRIPT", "LOAD", "return 1")],
      ["FUNCTION LOAD", () => pub.call("FUNCTION", "LOAD", "REPLACE", "#!lua name=evil\nredis.register_function('evil', function() return 1 end)")],
      ["FUNCTION DELETE", () => pub.call("FUNCTION", "DELETE", PUBLIC_VALKEY_LIBRARY)],
      ["FUNCTION FLUSH", () => pub.call("FUNCTION", "FLUSH")],
      ["FUNCTION LIST", () => pub.call("FUNCTION", "LIST")],
      ["FCALL_RO", () => pub.call("FCALL_RO", RATE_LIMIT_FUNCTION, 0)],
      ["FCALL on a key outside public's prefixes", () => pub.call("FCALL", RATE_LIMIT_FUNCTION, 1, "ebt:acl", "1", "1000")],
    ] as const) {
      expect(await reply(attempt()), what).toMatch(/NOPERM/);
    }
    // Still there: public could not remove it.
    expect(await reply(pub.call("FCALL", RATE_LIMIT_FUNCTION, 0))).toBe("[0,0]");
  });

  it("missing: fails closed with 503 on the rate-limited routes and logs public.valkey_function_missing, until it is loaded again", async () => {
    const worker = client("worker");
    const pub = client("public");
    await Promise.all([worker.connect(), pub.connect()]);
    await loadPublicValkeyFunctions(worker);
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      expect(await reply(worker.call("FUNCTION", "DELETE", PUBLIC_VALKEY_LIBRARY))).toBe('"OK"');
      await expect(hitRateLimits(pub, [{ key: "acl:fn:b", limit: 5, windowMs: 60_000 }])).rejects.toBeInstanceOf(ValkeyUnavailable);
      const refused = await orderRateLimit({ valkey: pub, log: logEvent }, new Headers(), "order.page");
      expect(refused?.status).toBe(503);
      expect(await refused?.json()).toEqual({ v: 1, error: "unavailable" });
      const missing = lines.filter((l) => l.includes('"event":"public.valkey_function_missing"'));
      expect(missing.length).toBe(2);
      expect(JSON.parse(missing[0] ?? "{}")).toMatchObject({ level: "error", role: "public", kind: RATE_LIMIT_FUNCTION });

      await loadPublicValkeyFunctions(worker);
      expect(await hitRateLimits(pub, [{ key: "acl:fn:b", limit: 5, windowMs: 60_000 }])).toEqual({ allowed: true });
    } finally {
      stderr.mockRestore();
    }
  });
});
