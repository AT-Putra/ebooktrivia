// AC 4: the internal process, as a REAL child process (`node src/main.ts --role=internal`) on the
// internal_rw login: /caddy/ask from an in-memory host set (NOTIFY invalidation, reload after a
// LISTEN reconnect, normalized hosts, no DB per request), /hooks/glitchtip/{token} (64 KB, insert
// an alert row only, token by hash, rate limit), and it holds no keys.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { INTERNAL_ENV } from "../src/internal-config.ts";
import { createCatalog, sleep, sql, suffix, waitFor } from "./support/db.ts";
import { type Child, kill, MAIN, RECORD_GRAPH, spawnNode, waitForLine } from "./support/processes.ts";

const TOKEN = `gt-${randomBytes(16).toString("hex")}`;
const TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");
const RATE = 8;
const internalUser = new URL(inject("internalDbUrl")).username;

function internalEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    DATABASE_URL_INTERNAL: inject("internalDbUrl"),
    GLITCHTIP_HOOK_TOKEN_SHA256: TOKEN_SHA256,
    INTERNAL_PORT: "0",
    // Long safety-net reload: the tests below must pass through NOTIFY / reconnect alone.
    INTERNAL_DOMAINS_RELOAD_MS: "3600000",
    INTERNAL_HOOK_RATE_PER_MINUTE: String(RATE),
    ...extra,
  };
}

let child: Child;
let base: string;
let landingPageId: string;
const recordDir = mkdtempSync(join(tmpdir(), "ebt-graph-"));
const recordFile = join(recordDir, "graph.txt");

beforeAll(async () => {
  landingPageId = (await createCatalog()).landingPageId;
  await sql`INSERT INTO lp_domains (landing_page_id, host) VALUES (${landingPageId}, ${`preloaded-${suffix()}.example.com`})`;
  child = spawnNode(["--import", `./${RECORD_GRAPH}`, MAIN, "--role=internal"], internalEnv({ RECORD_GRAPH_FILE: recordFile }));
  const listening = await waitForLine(child, (l) => l["msg"] === "internal listening");
  base = `http://127.0.0.1:${String(listening["port"])}`;
});
afterAll(async () => {
  await kill(child);
  rmSync(recordDir, { recursive: true, force: true });
});

const ask = async (domain: string): Promise<number> => (await fetch(`${base}/caddy/ask?domain=${encodeURIComponent(domain)}`)).status;
const host = () => `shop-${suffix()}.example.com`;
const addDomain = (h: string) => sql`INSERT INTO lp_domains (landing_page_id, host) VALUES (${landingPageId}, ${h})`;

/** Milliseconds until `domain` answers `status`. */
async function timeUntil(domain: string, status: number, timeoutMs = 5000): Promise<number> {
  const started = Date.now();
  await waitFor(`${domain} -> ${String(status)}`, async () => (await ask(domain)) === status, timeoutMs, 10);
  return Date.now() - started;
}

describe("GET /caddy/ask", () => {
  it("serves hosts loaded at start, and picks up inserts and deletes by NOTIFY within a second", async () => {
    const [preloaded] = await sql<{ host: string }[]>`SELECT host FROM lp_domains WHERE host LIKE 'preloaded-%' LIMIT 1`;
    expect(await ask(preloaded?.host ?? "")).toBe(200);
    const added = host();
    expect(await ask(added)).toBe(404);
    await addDomain(added);
    expect(await timeUntil(added, 200)).toBeLessThan(1000);
    await sql`DELETE FROM lp_domains WHERE host = ${added}`;
    expect(await timeUntil(added, 404)).toBeLessThan(1000);
  });

  it("approves only the stored form (ASCII case aside): no trailing dot, no Unicode alias, no port or IP literal", async () => {
    const added = host();
    await addDomain(added);
    await addDomain("xn--bcher-kva.example");
    await timeUntil("xn--bcher-kva.example", 200);
    expect(await ask(added.toUpperCase())).toBe(200);
    expect(await ask("XN--BCHER-KVA.example")).toBe(200);
    // Security review US-013 #1: each of these used to be approved as an alias.
    for (const alias of [`${added}.`, `\uFF53${added.slice(1)}`, `${added.slice(0, 2)}\u00AD${added.slice(2)}`, added.replace(".", "\u3002"), `${added.slice(0, 3)}\u200B${added.slice(3)}`, "bücher.example", "BÜCHER.example"]) {
      expect(await ask(alias), alias).toBe(400);
    }
    expect(await ask(`${added}:443`)).toBe(400);
    expect(await ask(`${added}..`)).toBe(400);
    expect(await ask("127.0.0.1")).toBe(400);
    expect(await ask("[::1]")).toBe(400);
    expect(await ask("")).toBe(400);
  });

  // Code review US-013 #5: the NOTIFY must really be missed. The login is locked out so the
  // listener cannot re-LISTEN before the insert; with the 1 h safety-net reload only the reload on
  // LISTEN (re)connect can serve the host.
  it("reloads the full set when its LISTEN connection comes back (a NOTIFY sent meanwhile is lost)", async () => {
    const added = host();
    await sql.unsafe(`ALTER ROLE ${internalUser} NOLOGIN`);
    try {
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${internalUser}`;
      await waitFor("internal backends gone", async () => (await sql`SELECT 1 FROM pg_stat_activity WHERE usename = ${internalUser}`).length === 0, 5000);
      await addDomain(added); // its NOTIFY reaches no listener
      await sleep(300);
      expect(await ask(added)).toBe(404);
    } finally {
      await sql.unsafe(`ALTER ROLE ${internalUser} LOGIN`);
    }
    expect(await timeUntil(added, 200, 15_000)).toBeLessThan(15_000);
  });

  it("answers from memory, without the database: a known host still gets 200 while the login is locked out", async () => {
    const added = host();
    await addDomain(added);
    await timeUntil(added, 200);
    await sql.unsafe(`ALTER ROLE ${internalUser} NOLOGIN`);
    try {
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${internalUser}`;
      await sleep(200);
      for (let i = 0; i < 20; i++) expect(await ask(added)).toBe(200);
      expect(await ask(host())).toBe(404);
    } finally {
      await sql.unsafe(`ALTER ROLE ${internalUser} LOGIN`);
    }
    const after = host();
    await addDomain(after);
    await timeUntil(after, 200, 15_000);
  });
});

describe("POST /hooks/glitchtip/{token}", () => {
  const issue = (title: string) =>
    JSON.stringify({ alias: "GlitchTip", text: "GlitchTip Alert", attachments: [{ title, title_link: `https://glitchtip.example.com/issues/${title}`, text: "x" }] });
  const post = (body: string | ReadableStream<Uint8Array>, token = TOKEN, init: RequestInit = {}) =>
    fetch(`${base}/hooks/glitchtip/${token}`, { method: "POST", body, headers: { "content-type": "application/json" }, ...init });
  const alertsWith = async (title: string) =>
    sql<{ source: string; kind: string; severity: string; message: string; dedupe_key: string }[]>`
      SELECT source, kind, severity, message, dedupe_key FROM alerts WHERE message = ${title}`;

  it("inserts exactly one alerts row as internal_rw for the right token, and 404s a wrong one", async () => {
    const title = `Boom-${suffix()}`;
    expect((await post(issue(title), "wrong-token-of-some-length")).status).toBe(404);
    expect(await alertsWith(title)).toEqual([]);
    expect((await post(issue(title))).status).toBe(204);
    expect(await alertsWith(title)).toEqual([
      { source: "glitchtip", kind: "glitchtip_webhook", severity: "warning", message: title, dedupe_key: `glitchtip:https://glitchtip.example.com/issues/${title}` },
    ]);
  });

  it("refuses bodies over 64 KB with 413 (declared or streamed) and non-JSON with 400, storing nothing", async () => {
    const title = `Big-${suffix()}`;
    const big = JSON.stringify({ text: title, pad: "x".repeat(64 * 1024) });
    expect((await post(big)).status).toBe(413);
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ text: title }).slice(0, -1)));
        for (let i = 0; i < 70; i++) controller.enqueue(new Uint8Array(1024).fill(0x20));
        controller.close();
      },
    });
    expect((await post(chunks, TOKEN, { duplex: "half" })).status).toBe(413);
    expect((await post("not json")).status).toBe(400);
    expect(await alertsWith(title)).toEqual([]);
  });

  it("rate-limits the hook per minute (429)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < RATE + 2; i++) statuses.push((await post(issue(`Rate-${suffix()}`))).status);
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.filter((s) => s === 204).length).toBeLessThanOrEqual(RATE);
  });

  it("has no other routes", async () => {
    expect((await fetch(`${base}/hooks/glitchtip/${TOKEN}`)).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(404);
  });
});

describe("holds no keys", () => {
  it("never loads @ebooktrivia/crypto, settings secrets, get_payment_secret, the adapters or BullMQ, and reads only its own variables", () => {
    const lines = readFileSync(recordFile, "utf8").split("\n").filter((l) => l !== "");
    const modules = lines.filter((l) => l.startsWith("m ")).map((l) => l.slice(2));
    const envReads = lines.filter((l) => l.startsWith("e ")).map((l) => l.slice(2));
    expect(modules.some((m) => m.endsWith("/apps/worker/src/internal.ts"))).toBe(true);
    expect(modules.some((m) => m.endsWith("/packages/db/src/connection.ts"))).toBe(true);
    const forbidden = /packages\/crypto|@ebooktrivia\/crypto|packages\/adapters|packages\/db\/src\/(?:index|secrets|schema)|\/bullmq\/|\/ioredis\/|\/undici\/|apps\/worker\/src\/(?:worker|relay|sweepers|conversion-fire|outbox-consumer|heartbeat|queues)\.ts/;
    expect(modules.filter((m) => forbidden.test(m))).toEqual([]);
    for (const url of modules.filter((m) => m.startsWith("file:"))) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      expect(/get_payment_secret|settings_secrets/.test(source), url).toBe(false);
    }
    // Besides its own list: the postgres driver's PG* defaults and pgpass location (APPDATA on
    // Windows, HOME elsewhere), Node's own NODE_* / WATCH_REPORT_DEPENDENCIES / FORCE_COLOR.
    const runtime = new Set(["WATCH_REPORT_DEPENDENCIES", "FORCE_COLOR", "NO_COLOR", "APPDATA", "HOME"]);
    const unexpected = envReads.filter((name) => !(INTERNAL_ENV as readonly string[]).includes(name) && !runtime.has(name) && !/^(?:PG|NODE_)[A-Z0-9_]*$/.test(name));
    expect(unexpected).toEqual([]);
    expect(envReads.filter((name) => /SECRET|PRIVATE|PASSWORD|TOKEN(?!_SHA256)|VALKEY|WORKER/.test(name))).toEqual([]);
  });

  it("refuses to start with a key or worker variable in its environment, naming it but not its value", async () => {
    for (const extra of [{ SECRETS_PAYMENT_PRIVATE_KEY: "hunter2-key" }, { DATABASE_URL_WORKER: "postgres://w:hunter2@x/y" }, { VALKEY_PASSWORD: "hunter2" }]) {
      const refused = spawnNode([MAIN, "--role=internal"], internalEnv(extra));
      const { code } = await refused.exited;
      expect(code).toBe(1);
      expect(refused.stderr()).toContain(Object.keys(extra)[0]);
      expect(refused.stderr()).not.toContain("hunter2");
    }
  });
});

describe("in-process start and stop", () => {
  // Security review US-013 #3b: the internal process must run as an internal_rw login only.
  it("refuses a database login that is not internal_rw only (a worker login, the superuser)", async () => {
    const { startInternal } = await import("../src/internal.ts");
    const { loadInternalConfig } = await import("../src/internal-config.ts");
    const { createLogger } = await import("../src/log.ts");
    const silent = createLogger({ level: "silent", role: "internal" });
    for (const url of [inject("workerDbUrl"), inject("dbUrl")]) {
      await expect(startInternal(loadInternalConfig(internalEnv({ DATABASE_URL_INTERNAL: url })), silent)).rejects.toThrow(
        "DATABASE_URL_INTERNAL must be an internal_rw login",
      );
    }
  });

  it("binds the configured address and stops cleanly", async () => {
    const { startInternal } = await import("../src/internal.ts");
    const { loadInternalConfig } = await import("../src/internal-config.ts");
    const { createLogger } = await import("../src/log.ts");
    const running = await startInternal(loadInternalConfig(internalEnv()), createLogger({ level: "silent", role: "internal" }));
    const added = host();
    await addDomain(added);
    await waitFor("in-process ask", async () => (await fetch(`http://127.0.0.1:${String(running.port)}/caddy/ask?domain=${added}`)).status === 200, 5000, 10);
    const response = await fetch(`http://127.0.0.1:${String(running.port)}/hooks/glitchtip/${TOKEN}`, { method: "POST", body: JSON.stringify({ text: `inproc-${suffix()}` }) });
    expect(response.status).toBe(204);
    await running.stop();
    await expect(fetch(`http://127.0.0.1:${String(running.port)}/caddy/ask?domain=${added}`)).rejects.toThrow();
  });
});
