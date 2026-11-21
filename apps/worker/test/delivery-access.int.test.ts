// US-025: the real delivery ports (src/delivery/access.ts), the pool's database side (pool.ts), the session poll (health.ts) and the production
// wiring (index.ts deliveriesFromEnv) against PostgreSQL as the worker_rw login. Secrets are sealed with real keys; mail goes to Mailpit.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmtpError, verifyFileUrl, WahaError } from "@ebooktrivia/adapters";
import { DELIVERY_GAP_MS, OTP_GAP_MS } from "@ebooktrivia/core";
import { createSecretOpener, createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { SECRET_NAMES } from "@ebooktrivia/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/env.ts";
import { createEbookFiles, createMailSender, createWahaAccess } from "../src/delivery/access.ts";
import { createSessionPoller, UNREACHABLE } from "../src/delivery/health.ts";
import { deliveriesFromEnv, INBOUND_TOPIC } from "../src/delivery/index.ts";
import { MailAccessError, WahaAccessError } from "../src/delivery/ports.ts";
import { claimSession, listPoolSessions, pruneSends } from "../src/delivery/pool.ts";
import { createLogger } from "../src/log.ts";
import {
  createDeliveryShop,
  createSession,
  createWahaFake,
  type DeliveryShop,
  deliveryConfig,
  fakeMagicLinks,
  paidOrder,
  retireDeliveries,
  retireSessions,
} from "./support/delivery.ts";
import { first, sql } from "./support/db.ts";
import { silentLog, workerPool } from "./support/midtrans.ts";

const workerSql = workerPool(6);
const messaging = generateScopeKeyPair();
const opener = createSecretOpener({ messaging: messaging.privateKey });
const sealer = createSecretSealer({ messaging: messaging.publicKey });
const SMTP_PORT = Number(process.env["MAILPIT_SMTP_PORT"] ?? "51025");
const MAILPIT_API = process.env["MAILPIT_API"] ?? "http://127.0.0.1:58025";
const dev = { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: true };
const shops: DeliveryShop[] = [];

beforeEach(async () => {
  await retireSessions();
  await retireDeliveries();
});
afterAll(async () => {
  await sql`DELETE FROM smtp_settings`;
  await retireSessions();
  await retireDeliveries();
  await Promise.all(shops.map((s) => s.cleanup()));
});

async function putSecret(name: string, boundHost: string, plaintext: string, sealWith = sealer): Promise<void> {
  const sealed = sealWith.sealSecret({ scope: "messaging", name, adnetId: null, boundHost, plaintext });
  await sql`
    INSERT INTO settings_secrets (id, scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
    VALUES (${sealed.id}, 'messaging', ${sealed.name}, NULL, ${sealed.boundHost}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.sealedDek}, ${sealed.keyId}, ${sealed.last4})`;
}

describe("the ebook files", () => {
  it("reads only deliverable storage paths, reports their size and signs a download URL under the api origin", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ebt-files-"));
    try {
      const id = randomUUID();
      await mkdir(join(dataDir, "deliverables"), { recursive: true });
      await writeFile(join(dataDir, `deliverables/${id}.pdf`), "%PDF-1.4 test");
      const key = randomBytes(32);
      const files = createEbookFiles({ dataDir, apiOrigin: "https://api.example.test", fileUrlKey: key });
      expect(await files.size(`deliverables/${id}.pdf`)).toBe(13);
      expect(Buffer.from(await files.read(`deliverables/${id}.pdf`)).toString()).toBe("%PDF-1.4 test");
      const now = new Date();
      const url = new URL(files.signedUrl(`deliverables/${id}.pdf`, now));
      expect(url.origin + url.pathname).toBe(`https://api.example.test/files/deliverables/${id}.pdf`);
      expect(verifyFileUrl({ path: url.pathname, exp: url.searchParams.get("exp"), sig: url.searchParams.get("sig"), key, now })).toEqual({ ok: true, path: `/files/deliverables/${id}.pdf` });
      const long = new URL(files.signedUrl(`deliverables/${id}.pdf`, now, 72 * 3600));
      expect(Number(long.searchParams.get("exp")) - Math.floor(now.getTime() / 1000)).toBe(72 * 3600);
      for (const bad of ["../etc/passwd", "deliverables/../x.pdf", "deliverables/notauuid.pdf", `uploads/${id}.pdf`, `deliverables/${id}.png`, `/deliverables/${id}.pdf`]) {
        await expect(files.read(bad), bad).rejects.toThrow(RangeError);
        await expect(files.size(bad), bad).rejects.toThrow(RangeError);
        expect(() => files.signedUrl(bad, now), bad).toThrow(RangeError);
      }
      await expect(files.read(`deliverables/${randomUUID()}.pdf`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("the WAHA access: the key is opened only for the server it is bound to", () => {
  async function server(options: { host?: string; active?: boolean; allowPrivateIp?: boolean } = {}) {
    const host = options.host ?? `waha-${randomBytes(4).toString("hex")}.invalid`;
    const row = first(
      await sql<{ id: string }[]>`
        INSERT INTO waha_servers (name, base_url, base_url_host, active, allow_private_ip) VALUES ('W', ${`https://${host}/`}, ${host}, ${options.active ?? true}, ${options.allowPrivateIp ?? false}) RETURNING id`,
    );
    const session = first(await sql<{ id: string }[]>`INSERT INTO waha_sessions (server_id, session_name) VALUES (${row.id}, 'default') RETURNING id`);
    return { serverId: row.id, sessionId: session.id, host };
  }
  const access = (o = opener) => createWahaAccess({ sql: workerSql, opener: o, config: { dev, wahaTimeoutMs: 2000 } });
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (error) {
      if (error instanceof WahaAccessError) return error.code;
      throw error;
    }
    return "no error";
  };

  it("refuses a missing or inactive session, a server without a sealed key, a binding mismatch and a key that does not open", async () => {
    expect(await code(access().withSession(randomUUID(), () => Promise.resolve()))).toBe("session_unusable");
    const inactive = await server({ active: false });
    expect(await code(access().withSession(inactive.sessionId, () => Promise.resolve()))).toBe("session_unusable");

    const s = await server();
    expect(await code(access().withSession(s.sessionId, () => Promise.resolve()))).toBe("key_missing");
    await putSecret(SECRET_NAMES.wahaApiKey(s.serverId), s.host, "waha-api-key-0001");
    // A key sealed to another messaging key does not open.
    const other = createSecretOpener({ messaging: generateScopeKeyPair().privateKey });
    expect(await code(access(other).withSession(s.sessionId, () => Promise.resolve()))).toBe("key_unreadable");
    // Defence in depth: a secret bound to another host than the server's is refused even if the DB triggers were bypassed.
    await sql.begin(async (tx) => {
      await tx`ALTER TABLE waha_servers DISABLE TRIGGER waha_servers_clear_bound_secrets`;
      await tx`UPDATE waha_servers SET base_url = 'https://other-host.invalid/', base_url_host = 'other-host.invalid' WHERE id = ${s.serverId}`;
      await tx`ALTER TABLE waha_servers ENABLE ALWAYS TRIGGER waha_servers_clear_bound_secrets`;
    });
    expect(await code(access().withSession(s.sessionId, () => Promise.resolve()))).toBe("binding_mismatch");
  });

  it("opens the key and hands the use a client for that server, closed afterwards (a request to a name that never resolves fails as WAHA's own error)", async () => {
    const s = await server();
    await putSecret(SECRET_NAMES.wahaApiKey(s.serverId), s.host, "waha-api-key-0002");
    const seen = await access().withSession(s.sessionId, async ({ sessionName, client }) => {
      await expect(client.sessionStatus(sessionName)).rejects.toBeInstanceOf(WahaError);
      return sessionName;
    });
    expect(seen).toBe("default");
    // The private-network allowlist applies to an IPv4 literal of a server that has it, and the use gets its own timeout.
    const priv = await server({ host: "10.1.2.9", allowPrivateIp: true });
    await putSecret(SECRET_NAMES.wahaApiKey(priv.serverId), "10.1.2.9", "waha-api-key-0003");
    await access().withSession(
      priv.sessionId,
      async ({ client }) => {
        await expect(client.sessionStatus("default")).rejects.toBeInstanceOf(WahaError);
      },
      { timeoutMs: 300 },
    );
  });
});

describe("the mail sender: Mailpit, and the SMTP settings it refuses", () => {
  const sender = (o = opener) => createMailSender({ sql: workerSql, opener: o, config: { dev, smtpTimeoutMs: 5000 } });
  const mail = (to: string) => ({ to, subject: "Ebook Uji", text: "teks", html: "<p>html</p>", attachments: [{ filename: "Ebook-Uji.pdf", content: Buffer.from("%PDF-1.4 x"), contentType: "application/pdf" }] });
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (error) {
      if (error instanceof MailAccessError || error instanceof SmtpError) return error.code;
      throw error;
    }
    return "no error";
  };

  it("sends through SMTP with the attachment, and refuses without settings, without a needed password, and with a password bound to another host", async () => {
    await sql`DELETE FROM smtp_settings`;
    await sql`DELETE FROM settings_secrets WHERE name = ${SECRET_NAMES.smtpPassword}`;
    expect(await code(sender().send(mail("a@example.test")))).toBe("smtp_not_configured");

    await sql`INSERT INTO smtp_settings (host, port, security, from_address, from_name) VALUES ('127.0.0.1', ${SMTP_PORT}, 'starttls', 'noreply@example.test', 'Toko Uji')`;
    const tag = randomBytes(6).toString("hex");
    const to = `uji-${tag}@example.test`;
    await sender().send(mail(to));
    const search = (await (await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json()) as { messages: { ID: string }[] };
    expect(search.messages).toHaveLength(1);
    const detail = (await (await fetch(`${MAILPIT_API}/api/v1/message/${search.messages[0]?.ID ?? ""}`)).json()) as { From: { Name: string; Address: string }; Attachments: { FileName: string; Size: number }[] };
    expect(detail.From).toMatchObject({ Name: "Toko Uji", Address: "noreply@example.test" });
    expect(detail.Attachments).toEqual([expect.objectContaining({ FileName: "Ebook-Uji.pdf", Size: 10 })]);
    // Without attachments too.
    await sender().send({ to, subject: "Tanpa lampiran", text: "t", html: "<p>h</p>" });

    // A login without its password; then a password sealed to another key; then one bound to another host.
    await sql`UPDATE smtp_settings SET username = 'mailer'`;
    expect(await code(sender().send(mail(to)))).toBe("smtp_password_missing");
    await putSecret(SECRET_NAMES.smtpPassword, "127.0.0.1", "smtp-password-0001");
    expect(await code(sender(createSecretOpener({ messaging: generateScopeKeyPair().privateKey })).send(mail(to)))).toBe("key_unreadable");
    // The secret opens; Mailpit takes any login, so the send itself works (the password is only ever sent to the bound host).
    await sender().send({ to, subject: "Dengan login", text: "t", html: "<p>h</p>" });
    await sql.begin(async (tx) => {
      await tx`ALTER TABLE smtp_settings DISABLE TRIGGER smtp_settings_clear_bound_secrets`;
      await tx`UPDATE smtp_settings SET host = 'smtp.example.test'`;
      await tx`ALTER TABLE smtp_settings ENABLE ALWAYS TRIGGER smtp_settings_clear_bound_secrets`;
    });
    expect(await code(sender().send(mail(to)))).toBe("binding_mismatch");
    // An address that is not one plain address is a programming error, not a send.
    await sql`DELETE FROM smtp_settings`;
    await sql`INSERT INTO smtp_settings (host, port, security, from_address) VALUES ('127.0.0.1', ${SMTP_PORT}, 'starttls', 'noreply@example.test')`;
    await expect(sender().send(mail("a@example.test, b@example.test"))).rejects.toThrow(RangeError);
    await sql`DELETE FROM smtp_settings`;
    await sql`DELETE FROM settings_secrets WHERE name = ${SECRET_NAMES.smtpPassword}`;
  });
});

describe("the pool in the database", () => {
  it("claims a session for an OTP with the short gap: counted against the cap and the round-robin like any send", async () => {
    const a = await createSession({ dailyCap: 2 });
    const claimed = await workerSql.begin((tx) => claimSession(tx, { exclude: [], kind: "otp", deliveryId: null, gap: OTP_GAP_MS, random: () => 0 }));
    expect(claimed).toMatchObject({ kind: "claimed", sessionId: a.id });
    const row = first(await sql<{ next_send_at: Date }[]>`SELECT next_send_at FROM waha_sessions WHERE id = ${a.id}`);
    expect(row.next_send_at.getTime() - Date.now()).toBeGreaterThan(OTP_GAP_MS[0] - 700);
    expect(row.next_send_at.getTime() - Date.now()).toBeLessThanOrEqual(OTP_GAP_MS[0] + 100);
    expect((await sql`SELECT 1 FROM waha_sends WHERE session_id = ${a.id} AND kind = 'otp' AND delivery_id IS NULL`).length).toBe(1);
    // A delivery next: the cap counts both.
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    expect((await workerSql.begin((tx) => claimSession(tx, { exclude: [], kind: "opener", deliveryId: null, gap: DELIVERY_GAP_MS, random: () => 0 }))).kind).toBe("claimed");
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    expect(await workerSql.begin((tx) => claimSession(tx, { exclude: [], kind: "otp", deliveryId: null, gap: OTP_GAP_MS, random: () => 0 }))).toMatchObject({ kind: "none", reason: "all_capped", known: 1 });
    // Restricted to one number (a reply goes out of the number the buyer wrote to).
    const b = await createSession();
    expect(await workerSql.begin((tx) => claimSession(tx, { exclude: [], only: a.id, kind: "reply", deliveryId: null, gap: DELIVERY_GAP_MS, random: () => 0 }))).toMatchObject({ kind: "none", reason: "all_capped" });
    expect(await workerSql.begin((tx) => claimSession(tx, { exclude: [], only: b.id, kind: "reply", deliveryId: null, gap: DELIVERY_GAP_MS, random: () => 0 }))).toMatchObject({ kind: "claimed", sessionId: b.id });
    const listed = await listPoolSessions(workerSql);
    expect(listed.sessions.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(listed.sessions.find((s) => s.id === a.id)?.sentToday).toBe(2);
  });

  it("two claims at once never take the same slot or pass the same cap check (one advisory lock)", async () => {
    const only = await createSession({ dailyCap: 100 });
    const results = await Promise.all(Array.from({ length: 8 }, () => workerSql.begin((tx) => claimSession(tx, { exclude: [], kind: "opener", deliveryId: null, gap: DELIVERY_GAP_MS, random: () => 0.5, maxWaitMs: 3_600_000 }))));
    expect(results.every((r) => r.kind === "claimed")).toBe(true);
    const slots = results.flatMap((r) => (r.kind === "claimed" ? [r.slot.startAt.getTime()] : [])).sort((x, y) => x - y);
    for (let i = 1; i < slots.length; i++) expect((slots[i] ?? 0) - (slots[i - 1] ?? 0)).toBeGreaterThanOrEqual(5900);
    expect((await sql`SELECT 1 FROM waha_sends WHERE session_id = ${only.id}`).length).toBe(8);
    // The cap (5) was not checked against 8 racing claims: the first five fit, the rest are refused.
    await sql`DELETE FROM waha_sends WHERE session_id = ${only.id}`;
    await sql`UPDATE waha_sessions SET daily_cap = 5 WHERE id = ${only.id}`;
    await sql`UPDATE waha_sessions SET next_send_at = NULL WHERE id = ${only.id}`;
    const raced = await Promise.all(Array.from({ length: 8 }, () => workerSql.begin((tx) => claimSession(tx, { exclude: [], kind: "opener", deliveryId: null, gap: [0, 0], random: () => 0 }))));
    expect(raced.filter((r) => r.kind === "claimed")).toHaveLength(5);
  });

  it("prunes ledger rows older than a month (the history a number has with a contact) and keeps the rest", async () => {
    const s = await createSession();
    await sql`INSERT INTO waha_sends (session_id, kind, created_at) VALUES (${s.id}, 'otp', now() - interval '32 days'), (${s.id}, 'otp', now() - interval '8 days'), (${s.id}, 'otp', now())`;
    expect(await pruneSends(workerSql)).toBeGreaterThanOrEqual(1);
    expect((await sql`SELECT 1 FROM waha_sends WHERE session_id = ${s.id}`).length).toBe(2);
  });
});

describe("the session poll (pool health)", () => {
  it("records each number's WAHA status, raises the persisted alerts, and prunes the ledger at most once an hour", async () => {
    const waha = createWahaFake();
    const up = await createSession({ status: null });
    const stopped = await createSession({ status: null });
    const away = await createSession({ status: null });
    await waha.status(stopped.name, "SCAN_QR_CODE");
    waha.outage(away.name, true);
    await sql`INSERT INTO waha_sends (session_id, kind, created_at) VALUES (${up.id}, 'otp', now() - interval '40 days')`;
    let wall = 1_000_000_000;
    const poll = createSessionPoller({ sql: workerSql, log: silentLog, waha: waha.access, now: () => wall });
    expect(await poll()).toEqual({ total: 3, working: 1 });
    const status = async (id: string) => first(await sql<{ status: string; fresh: boolean }[]>`SELECT status, status_at > now() - interval '1 minute' AS fresh FROM waha_sessions WHERE id = ${id}`);
    expect(await status(up.id)).toEqual({ status: "WORKING", fresh: true });
    expect(await status(stopped.id)).toEqual({ status: "SCAN_QR_CODE", fresh: true });
    expect(await status(away.id)).toEqual({ status: UNREACHABLE, fresh: true });
    const down = await sql<{ dedupe_key: string; severity: string }[]>`SELECT dedupe_key, severity FROM alerts WHERE kind = 'waha_session_down' AND resolved_at IS NULL`;
    expect(down.map((a) => a.dedupe_key).sort()).toEqual([`waha_session_down:${stopped.id}`, `waha_session_down:${away.id}`].sort());
    expect(down.every((a) => a.severity === "warning")).toBe(true);
    // The old ledger row went with the first poll; the next prune is an hour away.
    expect((await sql`SELECT 1 FROM waha_sends WHERE session_id = ${up.id} AND created_at < now() - interval '31 days'`).length).toBe(0);
    await sql`INSERT INTO waha_sends (session_id, kind, created_at) VALUES (${up.id}, 'otp', now() - interval '40 days')`;
    wall += 60_000;
    await poll();
    expect((await sql`SELECT 1 FROM waha_sends WHERE session_id = ${up.id} AND created_at < now() - interval '31 days'`).length).toBe(1);
    wall += 3_600_000;
    await poll();
    expect((await sql`SELECT 1 FROM waha_sends WHERE session_id = ${up.id} AND created_at < now() - interval '31 days'`).length).toBe(0);

    // None WORKING: the pool is empty, a critical persisted alert (once an hour).
    await waha.status(up.name, "STOPPED");
    await sql`UPDATE alerts SET resolved_at = now() WHERE kind = 'wa_pool_empty'`;
    expect(await poll()).toEqual({ total: 3, working: 0 });
    expect(await sql`SELECT severity FROM alerts WHERE kind = 'wa_pool_empty' AND resolved_at IS NULL`).toEqual([{ severity: "critical" }]);
    await poll();
    expect((await sql`SELECT 1 FROM alerts WHERE kind = 'wa_pool_empty' AND resolved_at IS NULL`).length).toBe(1);
    // No sessions at all is not "an empty pool" of the poll (the delivery that finds none says so).
    await retireSessions();
    expect(await poll()).toEqual({ total: 0, working: 0 });
  });
});

describe("the production wiring (deliveriesFromEnv)", () => {
  const payment = Buffer.from(generateScopeKeyPair().privateKey).toString("base64url");
  const key = Buffer.from(messaging.privateKey).toString("base64url");
  const env = (extra: Record<string, string> = {}) => ({ DOMAIN: "ebooktrivia.example.id", SECRETS_PAYMENT_PRIVATE_KEY: payment, SECRETS_MESSAGING_PRIVATE_KEY: key, ...extra });

  it("is off without the messaging key; a malformed key, a missing DOMAIN or a missing payment key stops the worker", () => {
    const magic = () => fakeMagicLinks();
    expect(deliveriesFromEnv({}, { dev }, magic)).toBeUndefined();
    expect(deliveriesFromEnv({ SECRETS_MESSAGING_PRIVATE_KEY: "" }, { dev }, magic)).toBeUndefined();
    expect(() => deliveriesFromEnv(env({ SECRETS_MESSAGING_PRIVATE_KEY: "not-a-key" }), { dev }, magic)).toThrow();
    expect(() => deliveriesFromEnv(env({ DOMAIN: "" }), { dev }, magic)).toThrow(ConfigError);
    expect(() => deliveriesFromEnv({ ...env(), SECRETS_PAYMENT_PRIVATE_KEY: "" }, { dev }, magic)).toThrow(ConfigError);
  });

  it("builds the runtime on the worker's pool: the delivery consumer, the inbound consumer, the nudge, the poll loop and the unknown-send sweep", async () => {
    // The magic links are a factory over the worker's own pool (US-026 issues them in the database): create() calls it with that pool.
    const asked: unknown[] = [];
    const port = deliveriesFromEnv(env(), { dev }, (context) => {
      asked.push(context.sql);
      return fakeMagicLinks();
    });
    expect(port?.topics).toEqual([INBOUND_TOPIC]);
    const enqueued: { channel: string; jobId: string }[] = [];
    const runtime = port?.create({
      sql: workerSql,
      log: createLogger({ level: "silent", role: "worker" }),
      enqueue: (jobs) => {
        enqueued.push(...jobs.map((j) => ({ channel: j.channel, jobId: j.jobId })));
        return Promise.resolve();
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(workerSql);
    expect(runtime?.outboxConsumers.map((c) => c.topic)).toEqual([INBOUND_TOPIC]);
    expect(runtime?.loops.map((l) => l.name)).toEqual(["wa-pool-health"]);
    expect(Object.keys(runtime?.sweeps ?? {})).toEqual(["resolve_unknown", "opener_lease"]);
    // The nudge puts a paid order's due deliveries on their queues, by channel.
    const shop = await createDeliveryShop();
    shops.push(shop);
    const order = await paidOrder(shop, { waNotBefore: new Date(Date.now() + 3_600_000) });
    await runtime?.nudge(order.orderId);
    expect(enqueued).toEqual([{ channel: "email", jobId: `${order.deliveries.email}-0` }]);
    await sql`UPDATE deliveries SET not_before = now() - interval '1 second' WHERE id = ${order.deliveries.whatsapp}`;
    enqueued.length = 0;
    await runtime?.nudge(order.orderId);
    expect(enqueued.map((j) => j.channel).sort()).toEqual(["email", "whatsapp"]);
    // The unknown-send sweep and the poll run against the real database (nothing to do here).
    expect(await runtime?.sweeps["resolve_unknown"]?.()).toMatchObject({ resolved: 0 });
    expect(typeof (await runtime?.sweeps["opener_lease"]?.())).toBe("number");
    expect(await runtime?.loops[0]?.tick()).toBe(false);
    expect(deliveryConfig(shop).dataDir).toBe(shop.dataDir);
  });
});
