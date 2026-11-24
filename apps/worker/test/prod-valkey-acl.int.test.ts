// Story US-014: the PRODUCTION Valkey ACL and config (infra/provision/files/valkey/) against a
// throwaway Valkey 9.1.3 container, with test passwords rendered into users.acl.template the way
// infra/provision/provision.sh does it (SHA-256 hashes). Proves BullMQ runs as `worker` under the
// production key pattern (~ebt:* only, +info, no @dangerous / @admin) and that every other user
// is confined to its keys. Needs Docker (run by test:chaos / test:int).
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPublicValkeyFunctions, parseWaReadItem, PUBLIC_VALKEY_LIBRARY, PUBLIC_VALKEY_LIBRARY_CODE, RATE_LIMIT_FUNCTION, WA_READ_FUNCTION, WA_READ_NAMESPACE, waReadCall, waReadKeys } from "@ebooktrivia/adapters/valkey-functions";
import { createLogger } from "../src/log.ts";
import { startValkeyFunctionLoader } from "../src/valkey-functions.ts";
import { VALKEY_IMAGE } from "./support/docker.ts";

const run = promisify(execFile);
const FILES = new URL("../../../infra/provision/files/valkey/", import.meta.url);
const passwords = { public: hex(), worker: hex(), admin: hex(), ops: hex() };
function hex(): string {
  return randomBytes(32).toString("hex");
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let dir: string;
let id: string | undefined;
let port: number;
const clients: Redis[] = [];

function client(user: keyof typeof passwords): Redis {
  const redis = new Redis({
    host: "127.0.0.1",
    port,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    username: user,
    password: passwords[user],
  });
  clients.push(redis);
  return redis;
}
const reply = (p: Promise<unknown>) => p.then(String, (error: unknown) => (error instanceof Error ? error.message : String(error)));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ebt-valkey-acl-"));
  const acl = readFileSync(new URL("users.acl.template", FILES), "utf8")
    .replace("@PUBLIC_SHA256@", sha256(passwords.public))
    .replace("@WORKER_SHA256@", sha256(passwords.worker))
    .replace("@ADMIN_SHA256@", sha256(passwords.admin))
    .replace("@OPS_SHA256@", sha256(passwords.ops));
  writeFileSync(join(dir, "users.acl"), acl);
  writeFileSync(join(dir, "valkey.conf"), readFileSync(new URL("valkey.conf", FILES)));
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
    const ops = new Redis({ host: "127.0.0.1", port, username: "ops", password: passwords.ops, lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    try {
      await ops.connect();
      await ops.ping();
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("valkey with the production ACL did not answer PING as ops");
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      ops.disconnect();
    }
  }
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  if (id !== undefined) await run("docker", ["rm", "-f", id]).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("production Valkey ACL", () => {
  it("refuses the default user and wrong passwords", async () => {
    // Raw sockets: ioredis 6 opens with HELLO and only reports a closed connection.
    const raw = (command: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => socket.write(`${command}\r\n`));
        socket.setEncoding("utf8");
        socket.once("data", (data: string) => {
          socket.destroy();
          resolve(data);
        });
        socket.once("error", reject);
      });
    expect(await raw("PING")).toMatch(/^-NOAUTH/);
    expect(await raw(`AUTH worker ${hex()}`)).toMatch(/^-WRONGPASS/);
    expect(await raw(`AUTH default ${hex()}`)).toMatch(/^-WRONGPASS/);
  });

  it("runs BullMQ as `worker` under the ebt: prefix (INFO allowed, nothing dangerous)", async () => {
    const connection = { host: "127.0.0.1", port, username: "worker", password: passwords.worker, maxRetriesPerRequest: null };
    const queue = new Queue("acl.probe", { connection, prefix: "ebt" });
    const events = new QueueEvents("acl.probe", { connection, prefix: "ebt" });
    const worker = new Worker("acl.probe", (job) => Promise.resolve(`done ${String((job.data as { n: number }).n)}`), { connection, prefix: "ebt" });
    try {
      await events.waitUntilReady();
      const job = await queue.add("probe", { n: 7 }, { attempts: 1, removeOnComplete: true });
      expect(await job.waitUntilFinished(events, 15_000)).toBe("done 7");
      const counts = await queue.getJobCounts("waiting", "active", "failed");
      expect(counts).toEqual({ waiting: 0, active: 0, failed: 0 });
    } finally {
      await worker.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("confines every user to its keys and keeps @dangerous / @admin away from all of them", async () => {
    const worker = client("worker");
    const pub = client("public");
    const admin = client("admin");
    const ops = client("ops");
    await Promise.all([worker.connect(), pub.connect(), admin.connect(), ops.connect()]);

    expect(await reply(worker.set("ebt:acl", "1"))).toBe("OK");
    expect(await reply(worker.set("cache:worker:acl", "1"))).toBe("OK");
    expect(await reply(worker.set("cache:public:acl", "1"))).toMatch(/NOPERM/);
    expect(await reply(worker.set("rl:acl", "1"))).toMatch(/NOPERM/);
    expect(await reply(worker.set("tother:acl", "1"))).toMatch(/NOPERM/); // another BullMQ prefix
    expect(await reply(worker.info("server"))).toMatch(/^# Server[\s\S]*\nvalkey_version:/);

    expect(await reply(pub.set("rl:acl", "1"))).toBe("OK");
    expect(await reply(pub.set("cache:public:acl", "1"))).toBe("OK");
    expect(await reply(pub.get("cache:admin:acl"))).toMatch(/NOPERM/);
    expect(await reply(pub.get("cache:worker:acl"))).toMatch(/NOPERM/);
    expect(await reply(pub.get("ebt:acl"))).toMatch(/NOPERM/);
    // US-020: public runs an allowlist (-@all +ping +fcall +incr +pttl +pexpire +set): the rate-limit function the
    // worker loads (US-031) and the single-use marks of (stateless) Cap tokens. No INFO, no reads, no deletes, no Lua.
    expect(await reply(pub.info("server"))).toMatch(/NOPERM/);
    expect(await reply(pub.eval("redis.call('INCR', KEYS[1]); return redis.call('PTTL', KEYS[1])", 1, "rl:acl-script"))).toMatch(/NOPERM/);
    expect(await reply(pub.set("cache:public:acl-once", "1", "PX", 60_000, "NX"))).toBe("OK");
    expect(await reply(pub.getdel("cache:public:acl-once"))).toMatch(/NOPERM/);
    expect(await reply(pub.del("cache:public:acl-once"))).toMatch(/NOPERM/);
    expect(await reply(pub.get("rl:acl"))).toMatch(/NOPERM/);
    expect(await reply(pub.exists("rl:acl"))).toMatch(/NOPERM/);
    expect(await reply(pub.eval("return redis.call('GET', KEYS[1])", 1, "rl:acl"))).toMatch(/NOPERM/);
    expect(await reply(pub.eval("return redis.call('INCR', KEYS[1])", 1, "ebt:acl"))).toMatch(/NOPERM/);

    expect(await reply(admin.set("cache:admin:acl", "2"))).toBe("OK");
    expect(await reply(admin.get("cache:public:acl"))).toMatch(/NOPERM/);
    expect(await reply(admin.get("rl:acl"))).toMatch(/NOPERM/);
    expect(await reply(admin.get("ebt:acl"))).toMatch(/NOPERM/);
    expect(await reply(admin.info())).toMatch(/NOPERM/);

    expect(await reply(ops.ping())).toBe("PONG");
    expect(await reply(ops.get("cache:public:acl"))).toMatch(/NOPERM/);

    // Security review S8: no key enumeration and no script / function control for the apps.
    for (const user of [pub, admin]) {
      expect(await reply(user.scan("0"))).toMatch(/NOPERM/);
      expect(await reply(user.randomkey())).toMatch(/NOPERM/);
      expect(await reply(user.call("SCRIPT", "FLUSH"))).toMatch(/NOPERM/);
      expect(await reply(user.call("FUNCTION", "LIST"))).toMatch(/NOPERM/);
      expect(await reply(user.call("FUNCTION", "FLUSH"))).toMatch(/NOPERM/);
    }

    for (const user of [worker, pub, admin, ops]) {
      expect(await reply(user.flushall())).toMatch(/NOPERM/);
      expect(await reply(user.call("CONFIG", "GET", "maxmemory"))).toMatch(/NOPERM/);
      expect(await reply(user.keys("*"))).toMatch(/NOPERM/);
      expect(await reply(user.call("ACL", "LIST"))).toMatch(/NOPERM/);
      expect(await reply(user.subscribe("acl-channel"))).toMatch(/NOPERM/);
      expect(await reply(user.call("CLIENT", "KILL", "ID", "999999"))).toMatch(/NOPERM/);
    }
    // Still there: nothing was flushed.
    expect(await reply(worker.get("ebt:acl"))).toBe("1");
  });

  it("US-031: the worker loads public's function at start, after a reconnect and after a flush; public may only FCALL it", async () => {
    // The health connection's settings in src/worker.ts (lazy, ready check on: the worker may INFO).
    const worker = new Redis({ host: "127.0.0.1", port, username: "worker", password: passwords.worker, lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 2000 });
    clients.push(worker);
    const pub = client("public");
    await pub.connect();
    const lines: { msg: string; reason?: string }[] = [];
    const log = createLogger({ level: "info", role: "worker" }, { write: (line: string) => void lines.push(JSON.parse(line) as { msg: string; reason?: string }) });
    const fcall = () => reply(pub.call("FCALL", RATE_LIMIT_FUNCTION, 0));
    const loadedFor = (reason: string) => lines.filter((l) => l.msg === "valkey functions loaded" && l.reason === reason).length;

    let missingReported = 0;
    const loader = await startValkeyFunctionLoader(worker, log, () => {
      missingReported++;
      return Promise.resolve();
    });
    try {
      expect(loadedFor("start")).toBe(1);
      expect(await fcall()).toBe("0,0");
      expect(await reply(pub.call("FCALL", RATE_LIMIT_FUNCTION, 1, "rl:acl-fn", "1", "60000"))).toBe("0,0");
      expect(await reply(pub.call("FCALL", RATE_LIMIT_FUNCTION, 1, "rl:acl-fn", "1", "60000"))).toMatch(/^1,\d+$/);
      expect(await reply(pub.call("FCALL", RATE_LIMIT_FUNCTION, 1, "ebt:acl-fn", "1", "60000"))).toMatch(/NOPERM/);
      for (const attempt of [
        () => pub.call("FUNCTION", "LOAD", "REPLACE", PUBLIC_VALKEY_LIBRARY_CODE),
        () => pub.call("FUNCTION", "DELETE", PUBLIC_VALKEY_LIBRARY),
        () => pub.call("FUNCTION", "FLUSH"),
        () => pub.call("SCRIPT", "LOAD", "return 1"),
        () => pub.evalsha("e0e1f9fabfc9d4800c877a703b823ac0578ff8db", 0),
        () => pub.eval("return 1", 0),
      ]) {
        expect(await reply(attempt())).toMatch(/NOPERM/);
      }

      // Flushed (a restored or replaced Valkey): the heartbeat's check loads it again.
      expect(await reply(worker.call("FUNCTION", "FLUSH"))).toBe("OK");
      expect(await fcall()).toMatch(/Function not found/i);
      expect(await loader.check()).toBe(true);
      expect(lines.filter((l) => l.msg === "valkey functions loaded" && l.reason === "missing")).toHaveLength(1);
      expect(missingReported).toBe(1); // the worker raises valkey_function_missing from here (worker.ts)
      expect(await fcall()).toBe("0,0");
      expect(await loader.check()).toBe(true); // present: nothing to load, nothing to report
      expect(lines.filter((l) => l.msg === "valkey functions loaded" && l.reason === "missing")).toHaveLength(1);
      expect(missingReported).toBe(1);

      // Flushed and then the connection drops (a Valkey restart): the reconnect loads it again.
      expect(await reply(worker.call("FUNCTION", "FLUSH"))).toBe("OK");
      const reconnected = new Promise<void>((resolve) => {
        worker.once("ready", () => {
          resolve();
        });
      });
      worker.disconnect(true);
      await reconnected;
      for (let i = 0; i < 40 && loadedFor("reconnect") === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(loadedFor("reconnect")).toBe(1);
      expect(await fcall()).toBe("0,0");
    } finally {
      loader.stop();
    }
  });

  it("the read-mark ring: public hands a message over with ONE FCALL of the worker-loaded function and nothing else; the worker alone takes it, and reaches no other key of public", async () => {
    const worker = client("worker");
    const pub = client("public");
    await Promise.all([worker.connect(), pub.connect()]);
    await loadPublicValkeyFunctions(worker);
    // The production namespace itself (the worker's ACL names exactly cache:public:wa-read:*); the container is a throwaway.
    const namespace = WA_READ_NAMESPACE;
    const keys = waReadKeys(namespace);
    const item = { session: "acl", messageId: "false_628123456789@c.us_3EB0ACL0001", digest: "0123456789abcdef0123456789abcdef" };
    const call = waReadCall(namespace, item);
    if (call === null) throw new Error("the item is well formed");
    const fcall = () => reply(pub.call("FCALL", WA_READ_FUNCTION, call.keys.length, ...call.keys, ...call.args));
    // Public, with the commands it already had (SET, INCR, PEXPIRE) on its own cache:public:* keys: a new read answers its number, a second one for the chat is a no-op.
    expect(await fcall()).toBe("1");
    expect(await fcall()).toBe("0");
    // It cannot read the ring back, delete anything or reach a key outside its prefixes through the function.
    expect(await reply(pub.get(keys.item(1)))).toMatch(/NOPERM/);
    expect(await reply(pub.del(keys.pending(item.digest)))).toMatch(/NOPERM/);
    expect(await reply(pub.call("FCALL", WA_READ_FUNCTION, 2, "ebt:acl-pending", "ebt:acl-seq", "60", "2000", "600", "1000", "ebt:acl-i:", "x"))).toMatch(/NOPERM/);
    // The worker takes the item (its production ACL reaches exactly this pattern of public's keys) and lets the chat's mark go.
    expect(parseWaReadItem(await worker.get(keys.item(1)))).toEqual({ n: 1, ...item });
    expect(await reply(worker.del(keys.pending(item.digest)))).toBe("1");
    expect(await fcall()).toBe("2");
    expect(await reply(worker.get("cache:public:acl-other"))).toMatch(/NOPERM/);
    expect(await reply(worker.get("rl:acl"))).toMatch(/NOPERM/);
    await worker.del(keys.pending(item.digest), keys.seq, keys.item(1), keys.item(2));
  });

  it("runs with noeviction and AOF", async () => {
    const worker = client("worker");
    await worker.connect();
    const info = await worker.info();
    expect(info).toMatch(/maxmemory_policy:noeviction/);
    expect(info).toMatch(/aof_enabled:1/);
    expect(info).toMatch(/maxmemory:402653184/);
  });
});
