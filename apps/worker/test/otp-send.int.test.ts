// US-026: the OTP's way out. apps/public stores an OTP (HMAC + the code sealed to the messaging public key)
// and calls enqueue_otp (eligibility + per-phone cap in SQL), which writes the otp.send outbox row; this
// consumer opens the code with the messaging private key, checks ^[0-9]{6}$, drops an expired job, sends
// the Owner's `otp` template by WhatsApp and the finalize wipes the sealed code. The send path is the real
// WAHA client (packages/adapters) against the dev stack's waha-mock (WAHA_MOCK_URL, default 127.0.0.1:53000).
import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createWahaClient, type HttpFetch } from "@ebooktrivia/adapters";
import { type IdMobileE164, issueOtp, toWaChatId } from "@ebooktrivia/core";
import { createSecretOpener, createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { SECRET_NAMES } from "@ebooktrivia/db";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { inertFailpoint } from "../src/failpoint.ts";
import { createLogger } from "../src/log.ts";
import { createOtpSendConsumer, OTP_MAX_ATTEMPTS, OTP_TOPIC, OtpSendError, type OtpMessage, type OtpSender } from "../src/otp-send.ts";
import { createWahaOtpSender, otpFromEnv } from "../src/otp-senders.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { sweepExpiredOtps } from "../src/sweepers.ts";
import { first, sql, suffix } from "./support/db.ts";
import { WahaAccessError, type WahaAccess } from "../src/delivery/ports.ts";
import { createSession, createWahaFake } from "./support/delivery.ts";

const workerSql = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 4, onnotice: () => undefined });
afterAll(async () => {
  await workerSql.end({ timeout: 5 });
});

const WAHA_MOCK = process.env["WAHA_MOCK_URL"] ?? "http://127.0.0.1:53000"; // DEV ONLY
const WAHA_MOCK_KEY = process.env["WAHA_MOCK_API_KEY"] ?? "devonly-waha-key"; // DEV ONLY
const plainFetch: HttpFetch = (url, init) => fetch(url, { method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
const waha = createWahaClient({ target: new URL(`${WAHA_MOCK}/`), apiKey: WAHA_MOCK_KEY, fetch: plainFetch });

const keys = generateScopeKeyPair();
const sealer = createSecretSealer({ messaging: keys.publicKey });
const opener = createSecretOpener({ messaging: keys.privateKey });
const PEPPER = randomBytes(32);

/** Captured log lines (the worker's real pino logger and redaction). */
function capturedLog() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString("utf8"));
      done();
    },
  });
  return { lines, log: createLogger({ level: "info", role: "worker" }, stream) };
}

let programId = "";
beforeAll(async () => {
  const product = first(await sql<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
  programId = first(
    await sql<{ id: string }[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product.id}, ${`otp-${suffix()}`}, 'Program', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`,
  ).id;
});

const phoneFor = (): IdMobileE164 => `+62812${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}` as IdMobileE164;

/** What apps/public does for an eligible phone: the HMAC row, the sealed code, enqueue_otp. Returns the outbox id and the code. */
async function enqueuedOtp(): Promise<{ outboxId: string; code: string; phone: IdMobileE164 }> {
  const phone = phoneFor();
  const player = first(await sql<{ id: string }[]>`INSERT INTO players (phone, name) VALUES (${phone}, 'Pemain') RETURNING id`);
  await sql`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${player.id}, ${programId}, now(), true)`;
  const otpId = randomUUID();
  const issued = issueOtp({ pepper: PEPPER, phone, now: new Date() });
  const sealed = sealer.sealOtp({ otpId, phone, code: issued.code });
  await sql`INSERT INTO player_otps (id, phone, mac, sealed_code, expires_at) VALUES (${otpId}, ${phone}, ${issued.mac}, ${sealed}, ${issued.expiresAt})`;
  const outboxId = first(await sql<{ id: string }[]>`SELECT enqueue_otp(${otpId}) AS id`).id;
  return { outboxId, code: issued.code, phone };
}

const outbox = async (id: string) =>
  first(await sql<{ processed: boolean; sealed: Buffer | null; last_error: string | null; attempts: number }[]>`
    SELECT processed_at IS NOT NULL AS processed, sealed, last_error, attempts FROM outbox WHERE id = ${id}`);

function recordingSender(fail?: Error): OtpSender & { readonly sent: OtpMessage[] } {
  const sent: OtpMessage[] = [];
  return {
    sent,
    send: (message) => {
      if (fail !== undefined) return Promise.reject(fail);
      sent.push(message);
      return Promise.resolve();
    },
  };
}

const processorFor = (sender: OtpSender, log = capturedLog().log, over: { opener?: typeof opener } = {}) =>
  createOutboxProcessor(createOtpSendConsumer({ sql: workerSql, opener: over.opener ?? opener, sender, log }), { sql: workerSql, failpoint: inertFailpoint, log });

describe("otp.send consumer", () => {
  it("sends the code through WAHA (waha-mock) with the Owner's template, then wipes it; the log has neither code nor phone", async () => {
    const { outboxId, code, phone } = await enqueuedOtp();
    const session = `otp${suffix()}`;
    const sender: OtpSender = {
      async send(message) {
        await waha.sendText(session, toWaChatId(message.phone), message.text);
      },
    };
    const captured = capturedLog();
    expect(await processorFor(sender, captured.log)({ id: outboxId })).toBe("processed");
    const chat = toWaChatId(phone);
    expect(await waha.recentOutgoing(session, chat, 5)).toHaveLength(1);
    // The message text, from waha-mock's record of what it was sent.
    const listed = await fetch(`${WAHA_MOCK}/api/${session}/chats/${encodeURIComponent(chat)}/messages?fromMe=true`, { headers: { "x-api-key": WAHA_MOCK_KEY } });
    const [received] = (await listed.json()) as { body: string }[];
    expect(received?.body).toBe(`Kode masuk trivia Anda: ${code}. Berlaku 5 menit. Jangan berikan kode ini kepada siapa pun.`);
    expect(await outbox(outboxId)).toMatchObject({ processed: true, sealed: null, last_error: null });
    // "Wiped after send": no sealed code of this OTP is left anywhere (enqueue_otp moved it, the finalize wiped it).
    expect(await sql`SELECT 1 FROM player_otps WHERE phone = ${phone} AND sealed_code IS NOT NULL`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM outbox WHERE payload->>'phone' = ${phone} AND sealed IS NOT NULL`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM player_otps WHERE phone = ${phone}`).toHaveLength(1); // only its HMAC, until it expires
    const text = captured.lines.join("");
    expect(text).toContain('"outcome":"sent"');
    expect(text).not.toContain(code);
    expect(text).not.toContain(phone.slice(1));
    // Processed: a second job is a no-op.
    expect(await processorFor(sender)({ id: outboxId })).toBe("skipped");
  });

  it("drops an expired job: processed and wiped, nothing sent", async () => {
    const { outboxId } = await enqueuedOtp();
    await sql`UPDATE outbox SET payload = jsonb_set(payload, '{expires_at}', to_jsonb((now() - interval '1 second')::text)) WHERE id = ${outboxId}`;
    const sender = recordingSender();
    expect(await processorFor(sender)({ id: outboxId })).toBe("processed");
    expect(sender.sent).toEqual([]);
    expect(await outbox(outboxId)).toMatchObject({ processed: true, sealed: null });
  });

  it.each([
    ["a code that does not open (forged sealed bytes)", async (id: string) => sql`UPDATE outbox SET sealed = ${randomBytes(54)} WHERE id = ${id}`],
    ["no sealed code", async (id: string) => sql`UPDATE outbox SET sealed = NULL WHERE id = ${id}`],
    ["a payload without a valid phone", async (id: string) => sql`UPDATE outbox SET payload = jsonb_set(payload, '{phone}', '"+1555"') WHERE id = ${id}`],
    ["a payload without an expiry", async (id: string) => sql`UPDATE outbox SET payload = payload - 'expires_at' WHERE id = ${id}`],
    ["an unparseable expiry", async (id: string) => sql`UPDATE outbox SET payload = jsonb_set(payload, '{expires_at}', '"soon"') WHERE id = ${id}`],
  ])("drops %s without sending", async (_name, tamper) => {
    const { outboxId } = await enqueuedOtp();
    await tamper(outboxId);
    const sender = recordingSender();
    expect(await processorFor(sender)({ id: outboxId })).toBe("processed");
    expect(sender.sent).toEqual([]);
    expect(await outbox(outboxId)).toMatchObject({ processed: true, sealed: null });
  });

  it("drops a code that is not exactly 6 digits even if the opener returned it (the worker checks ^[0-9]{6}$ itself)", async () => {
    const { outboxId } = await enqueuedOtp();
    const sender = recordingSender();
    expect(await processorFor(sender, capturedLog().log, { opener: { ...opener, openOtp: () => "12345a" } })({ id: outboxId })).toBe("processed");
    expect(sender.sent).toEqual([]);
  });

  it("a failed send is retried with backoff (an error code, no phone, no code) and keeps the sealed code until then", async () => {
    const { outboxId, code, phone } = await enqueuedOtp();
    await expect(processorFor(recordingSender(new Error(`boom ${phone} ${code}`)))({ id: outboxId })).rejects.toBeInstanceOf(OtpSendError);
    const row = await outbox(outboxId);
    expect(row).toMatchObject({ processed: false, last_error: "otp send failed: send_failed", attempts: 1 });
    expect(row.sealed).not.toBeNull();
    // The sender's own code passes through.
    await sql`UPDATE outbox SET available_at = now() WHERE id = ${outboxId}`;
    await expect(processorFor(recordingSender(new OtpSendError("no_session")))({ id: outboxId })).rejects.toMatchObject({ code: "no_session" });
    expect(OTP_MAX_ATTEMPTS).toBeGreaterThanOrEqual(5);
    expect(new OtpSendError("Not A Code").code).toBe("send_failed");
  });

  it("fails (retried) while the Owner's otp template is missing or does not render", async () => {
    const { outboxId } = await enqueuedOtp();
    const [template] = await sql<{ id: string; body: string }[]>`SELECT id, body FROM message_templates WHERE key = 'otp' AND channel = 'whatsapp' AND locale = 'id'`;
    try {
      await sql`UPDATE message_templates SET locale = 'en' WHERE id = ${template?.id ?? ""}`;
      await expect(processorFor(recordingSender())({ id: outboxId })).rejects.toMatchObject({ code: "template_missing" });
      await sql`UPDATE message_templates SET locale = 'id', body = 'Halo {nama}: {kode_otp}' WHERE id = ${template?.id ?? ""}`;
      await sql`UPDATE outbox SET available_at = now() WHERE id = ${outboxId}`;
      await expect(processorFor(recordingSender())({ id: outboxId })).rejects.toMatchObject({ code: "template_failed" });
    } finally {
      await sql`UPDATE message_templates SET locale = 'id', body = ${template?.body ?? ""} WHERE id = ${template?.id ?? ""}`;
    }
  });
});

describe("the OTP expiry sweeper", () => {
  it("deletes expired OTP rows and wipes the sealed code of otp.send jobs that expired unsent; live ones stay", async () => {
    const live = await enqueuedOtp();
    const dead = await enqueuedOtp();
    await sql`UPDATE player_otps SET expires_at = clock_timestamp() - interval '1 second' WHERE phone = ${dead.phone}`;
    await sql`UPDATE outbox SET payload = jsonb_set(payload, '{expires_at}', to_jsonb(clock_timestamp() - interval '1 second')) WHERE id = ${dead.outboxId}`;
    const stale = phoneFor();
    await sql`INSERT INTO otp_enqueues (otp_id, phone, outbox_id, enqueued_at) VALUES (gen_random_uuid(), ${stale}, gen_random_uuid(), now() - interval '25 hours')`;
    const swept = await sweepExpiredOtps(workerSql);
    expect(swept.deleted).toBeGreaterThanOrEqual(1);
    expect(swept.wiped).toBeGreaterThanOrEqual(1);
    // The send ledger past every cap window goes too (through prune_otp_enqueues); this phone's recent sends stay.
    expect(swept.pruned).toBeGreaterThanOrEqual(1);
    expect(await sql`SELECT 1 FROM otp_enqueues WHERE phone = ${stale}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM otp_enqueues WHERE phone = ${live.phone}`).toHaveLength(1);
    expect(swept.sessions).toBeGreaterThanOrEqual(0);
    expect(await sql`SELECT 1 FROM player_otps WHERE phone = ${dead.phone}`).toHaveLength(0);
    expect((await outbox(dead.outboxId)).sealed).toBeNull();
    expect(await sql`SELECT 1 FROM player_otps WHERE phone = ${live.phone}`).toHaveLength(1);
    expect((await outbox(live.outboxId)).sealed).not.toBeNull();
  });

  it("worker_rw finds expired rows by their expiry only: it reads neither the HMAC nor any sealed code", async () => {
    for (const column of ["mac", "sealed_code", "phone"]) {
      await expect(workerSql.unsafe(`SELECT ${column} FROM public.player_otps LIMIT 1`)).rejects.toMatchObject({ code: "42501" });
    }
  });
});

/** The shared test database: the sessions other files made are switched off for the test, and put back afterwards. */
async function withOnlyTheseSessions<T>(use: () => Promise<T>): Promise<T> {
  const active = (await sql<{ id: string }[]>`SELECT id FROM waha_sessions WHERE active`).map((r) => r.id);
  await sql`UPDATE waha_sessions SET active = false WHERE id = ANY(${active}::uuid[])`;
  try {
    return await use();
  } finally {
    await sql`UPDATE waha_sessions SET active = false WHERE id <> ALL(${active}::uuid[])`;
    await sql`UPDATE waha_sessions SET active = true WHERE id = ANY(${active}::uuid[])`;
  }
}

describe("the OTP sender on the delivery pool (US-025): the audited WAHA access, a number picked by weight, caps and health", () => {
  it("needs a WORKING number; it sends through the audited WAHA path (key bound to the server's host)", async () => {
    let serverId = "";
    await withOnlyTheseSessions(async () => {
      try {
        const sender = createWahaOtpSender({ sql: workerSql, log: capturedLog().log, opener, dev: { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: false } });
        const message = { phone: phoneFor(), text: "x" };
        await expect(sender.send(message, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "no_session" });
        serverId = first(await sql<{ id: string }[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES (${`O${suffix()}`}, 'https://waha-otp.invalid/', 'waha-otp.invalid') RETURNING id`).id;
        await sql`INSERT INTO waha_sessions (server_id, session_name, status, status_at) VALUES (${serverId}, 'default', 'WORKING', now())`;
        await expect(sender.send(message, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "waha_key_missing" });
        const sealed = sealer.sealSecret({ scope: "messaging", name: SECRET_NAMES.wahaApiKey(serverId), adnetId: null, boundHost: "waha-otp.invalid", plaintext: "waha-api-key-otp-0001" });
        await sql`
          INSERT INTO settings_secrets (id, scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
          VALUES (${sealed.id}, ${sealed.scope}, ${sealed.name}, ${sealed.adnetId}, ${sealed.boundHost}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.sealedDek}, ${sealed.keyId}, ${sealed.last4})`;
        // The host does not resolve: a WAHA failure, as an error code only.
        await expect(sender.send(message, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "waha_failed" });
        expect(await sql`SELECT 1 FROM waha_sessions WHERE active`).toHaveLength(1);
      } finally {
        if (serverId !== "") {
          await sql`DELETE FROM waha_sends WHERE session_id IN (SELECT id FROM waha_sessions WHERE server_id = ${serverId})`;
          await sql`DELETE FROM settings_secrets WHERE name = ${SECRET_NAMES.wahaApiKey(serverId)}`;
          await sql`DELETE FROM waha_sessions WHERE server_id = ${serverId}`;
          await sql`DELETE FROM waha_servers WHERE id = ${serverId}`;
        }
      }
    });
  });

  it("sends from a pool number and records the send in the ledger as `otp` (it counts against the number's daily cap)", async () => {
    await withOnlyTheseSessions(async () => {
      const wahaFake = createWahaFake();
      const number = await createSession({ dailyCap: 2 });
      const sender = createWahaOtpSender({ sql: workerSql, log: capturedLog().log, opener, dev: { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: false }, waha: wahaFake.access, random: () => 0 });
      const phone = phoneFor();
      await sender.send({ phone, text: "kode 123456" }, AbortSignal.timeout(10_000));
      expect(wahaFake.sent).toEqual([expect.objectContaining({ kind: "text", session: number.name, chatId: toWaChatId(phone), text: "kode 123456" })]);
      expect(await sql`SELECT kind, delivery_id FROM waha_sends WHERE session_id = ${number.id}`).toEqual([{ kind: "otp", delivery_id: null }]);
      await sender.send({ phone: phoneFor(), text: "kode 2" }, AbortSignal.timeout(10_000));
      // The daily cap of 2 is spent: no third code from this number (and so no_session for the consumer, which retries or drops by the code's expiry).
      await expect(sender.send({ phone: phoneFor(), text: "kode 3" }, AbortSignal.timeout(10_000))).rejects.toMatchObject({ code: "no_session" });
      expect(wahaFake.sent).toHaveLength(2);
    });
  });

  it("fails over to another number when WAHA refuses the send, and never to a second number once a send may have gone out", async () => {
    await withOnlyTheseSessions(async () => {
      const wahaFake = createWahaFake();
      const refusing = await createSession({ weight: 5 });
      const other = await createSession({ weight: 1 });
      const sender = createWahaOtpSender({ sql: workerSql, log: capturedLog().log, opener, dev: { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: false }, waha: wahaFake.access, random: () => 0 });
      wahaFake.fault(refusing.name, "unauthorized");
      await sender.send({ phone: phoneFor(), text: "kode a" }, AbortSignal.timeout(10_000));
      expect(wahaFake.sent).toEqual([expect.objectContaining({ session: other.name })]);
      // The refusal counted against the refusing number's health, not the other's.
      expect(first(await sql<{ fail_streak: number }[]>`SELECT fail_streak FROM waha_sessions WHERE id = ${refusing.id}`).fail_streak).toBe(1);
      expect(first(await sql<{ fail_streak: number }[]>`SELECT fail_streak FROM waha_sessions WHERE id = ${other.id}`).fail_streak).toBe(0);

      // A timeout after the request left: the code MAY be on its way. The second number is never asked (the player would get two codes).
      wahaFake.fault(refusing.name, "timeout_after_send");
      await sql`UPDATE waha_sessions SET cooldown_until = NULL, fail_streak = 0, next_send_at = NULL`;
      const before = wahaFake.sent.length;
      await expect(sender.send({ phone: phoneFor(), text: "kode b" }, AbortSignal.timeout(10_000))).rejects.toMatchObject({ code: "waha_maybe_sent" });
      expect(wahaFake.sent.slice(before)).toEqual([expect.objectContaining({ session: refusing.name })]);
      expect(wahaFake.sent.filter((s) => s.session === other.name)).toHaveLength(1);
      expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM waha_sends WHERE session_id = ${other.id}`)[0]?.n).toBe(1);
    });
  });

  // The sender's error codes are all the consumer and the console ever see of a failed send: a code, never a number or a text.
  it("says a phone that is not on WhatsApp is `no_whatsapp`, sends nothing and does not penalise the number", async () => {
    await withOnlyTheseSessions(async () => {
      const wahaFake = createWahaFake();
      const number = await createSession();
      const sender = createWahaOtpSender({ sql: workerSql, log: capturedLog().log, opener, dev: { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: false }, waha: wahaFake.access, random: () => 0 });
      const phone = phoneFor();
      await wahaFake.contact(phone, { numberExists: false });
      await expect(sender.send({ phone, text: "kode 123456" }, AbortSignal.timeout(10_000))).rejects.toMatchObject({ code: "no_whatsapp" });
      expect(wahaFake.sent).toEqual([]);
      expect(first(await sql<{ fail_streak: number }[]>`SELECT fail_streak FROM waha_sessions WHERE id = ${number.id}`).fail_streak).toBe(0);
      // The ledger row of the claim was given back: it is no send of the number's day.
      expect(await sql`SELECT 1 FROM waha_sends WHERE session_id = ${number.id} AND outcome <> 'failed'`).toEqual([]);
    });
  });

  it("says `contact_limit` for a second code to the same phone inside its 30 to 60 s gap: not sent, to be retried by the outbox", async () => {
    await withOnlyTheseSessions(async () => {
      const wahaFake = createWahaFake();
      await createSession();
      const sender = createWahaOtpSender({ sql: workerSql, log: capturedLog().log, opener, dev: { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: false }, waha: wahaFake.access, random: () => 0 });
      const phone = phoneFor();
      await sender.send({ phone, text: "kode pertama" }, AbortSignal.timeout(10_000));
      await expect(sender.send({ phone, text: "kode kedua" }, AbortSignal.timeout(10_000))).rejects.toMatchObject({ code: "contact_limit" });
      expect(wahaFake.sent.map((s) => s.text)).toEqual(["kode pertama"]);
    });
  });

  it("maps a session the worker may not use to its access code, a number that refuses to `waha_<code>`, and anything it cannot name to `send_failed` / `waha_maybe_sent`", async () => {
    await withOnlyTheseSessions(async () => {
      const dev = { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: false };
      const sendWith = (waha: WahaAccess, message: OtpMessage, signal = AbortSignal.timeout(10_000)) =>
        createWahaOtpSender({ sql: workerSql, log: capturedLog().log, opener, dev, waha, random: () => 0 }).send(message, signal);
      // The access to the number is refused (no key stored, a key bound to another host, session switched off): the access code.
      await createSession();
      const refused: WahaAccess = { withSession: () => Promise.reject(new WahaAccessError("binding_mismatch")) };
      await expect(sendWith(refused, { phone: phoneFor(), text: "x" })).rejects.toMatchObject({ code: "binding_mismatch" });
      // Not something of WAHA's or the access's: it may have gone out already, so the retry must not hide it.
      await sql`UPDATE waha_sessions SET cooldown_until = NULL, fail_streak = 0, next_send_at = NULL`;
      const broken: WahaAccess = { withSession: () => Promise.reject(new Error("socket hang up")) };
      await expect(sendWith(broken, { phone: phoneFor(), text: "x" })).rejects.toMatchObject({ code: "waha_maybe_sent" });
      // An aborted wait for the number's slot: nothing was sent, and no number refused anything.
      await sql`UPDATE waha_sessions SET cooldown_until = NULL, fail_streak = 0, next_send_at = NULL`;
      const aborted = new AbortController();
      aborted.abort();
      await expect(sendWith(createWahaFake().access, { phone: phoneFor(), text: "x" }, aborted.signal)).rejects.toMatchObject({ code: "send_failed" });
      // Something that is no pool error at all (an empty text is refused before a number is claimed).
      await expect(sendWith(createWahaFake().access, { phone: phoneFor(), text: "   " })).rejects.toMatchObject({ code: "send_failed" });
    });
  });

  it("is wired from worker.env only with the messaging private key", () => {
    const dev = { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: false };
    expect(otpFromEnv({}, dev)).toBeUndefined();
    const port = otpFromEnv({ SECRETS_MESSAGING_PRIVATE_KEY: keys.privateKey.toString("base64url") }, dev);
    expect(port?.opener).toBeDefined();
    expect(port?.sender(workerSql, capturedLog().log)).toBeDefined();
    expect(OTP_TOPIC).toBe("otp.send");
  });
});
