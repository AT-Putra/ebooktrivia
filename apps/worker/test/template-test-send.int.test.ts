// US-017: template test-sends run in the worker only. The admin console writes a
// template_test_sends row + an outbox row (template.test_send); this consumer claims the test-send
// once, renders the stored template with sample values (never a real login code or link), sends it
// and records the outcome. E-mail goes through the real SMTP sender to Mailpit (dev stack).
import { randomBytes, randomUUID } from "node:crypto";
import { createSecretOpener, createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { SECRET_NAMES } from "@ebooktrivia/db";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { afterAll, describe, expect, inject, it } from "vitest";
import { inertFailpoint } from "../src/failpoint.ts";
import { createLogger } from "../src/log.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { createTemplateTestSendConsumer, TEST_SEND_TOPIC, TestSendError, type TestSender } from "../src/template-test-send.ts";
import { createTestSenders, testSendFromEnv } from "../src/test-send-senders.ts";
import { first, sql, suffix } from "./support/db.ts";

const workerSql = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 4, onnotice: () => undefined });
afterAll(async () => {
  await workerSql.end({ timeout: 5 });
});
const log = createLogger({ level: "silent", role: "worker" });
const SMTP_PORT = Number(process.env["MAILPIT_SMTP_PORT"] ?? "51025");
const MAILPIT_API = process.env["MAILPIT_API"] ?? "http://127.0.0.1:58025";

async function testSend(channel: "email" | "whatsapp", body: string, opts: { subject?: string; recipient?: string; sessionId?: string } = {}): Promise<{ testSendId: string; outboxId: string }> {
  const { id: templateId } = first(
    await sql<{ id: string }[]>`
      INSERT INTO message_templates (key, channel, subject, body) VALUES (${`t_${suffix()}`}, ${channel}, ${opts.subject ?? null}, ${body}) RETURNING id`,
  );
  const testSendId = randomUUID();
  const outboxId = randomUUID();
  await sql`
    INSERT INTO template_test_sends (id, template_id, channel, recipient, waha_session_id, requested_by_admin_user_id)
    VALUES (${testSendId}, ${templateId}, ${channel}, ${opts.recipient ?? (channel === "email" ? "owner@example.test" : "+6281234567890")},
            ${opts.sessionId ?? null}, 'admin-test')`;
  await sql`INSERT INTO outbox (id, topic, dedupe_key, payload) VALUES (${outboxId}, ${TEST_SEND_TOPIC}, ${`${TEST_SEND_TOPIC}:${testSendId}`}, ${sql.json({ test_send_id: testSendId })})`;
  return { testSendId, outboxId };
}

const status = async (id: string) => first(await sql<{ status: string; error: string | null; sent: boolean }[]>`SELECT status, error, sent_at IS NOT NULL AS sent FROM template_test_sends WHERE id = ${id}`);
const processor = (sender: TestSender) => createOutboxProcessor(createTemplateTestSendConsumer({ sql: workerSql, sender }), { sql: workerSql, failpoint: inertFailpoint, log });

function recordingSender(): TestSender & { readonly calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    email: (message) => {
      calls.push({ email: message });
      return Promise.resolve();
    },
    whatsapp: (message) => {
      calls.push({ whatsapp: message });
      return Promise.resolve();
    },
  };
}

describe("template.test_send consumer", () => {
  it("sends the stored template once, with sample values and no real login code or link", async () => {
    const sender = recordingSender();
    const sessionId = first(
      await sql<{ id: string }[]>`
        WITH s AS (INSERT INTO waha_servers (name, base_url, base_url_host) VALUES ('W', 'https://waha.invalid/', 'waha.invalid') RETURNING id)
        INSERT INTO waha_sessions (server_id, session_name) SELECT id, 'default' FROM s RETURNING id`,
    ).id;
    const { testSendId, outboxId } = await testSend("whatsapp", "Halo {nama}: {link_trivia} {kode_otp}", { sessionId });
    const run = processor(sender);
    expect(await run({ id: outboxId })).toBe("processed");
    expect(sender.calls).toEqual([{ whatsapp: { sessionId, to: "+6281234567890", text: "[UJI] Halo Budi Santoso: [link_trivia] [kode_otp]" } }]);
    expect(await status(testSendId)).toEqual({ status: "sent", error: null, sent: true });
    // A re-relay or a second job finds the outbox row processed; a re-claimed outbox row (crash
    // after the send) would find the test-send no longer pending: never a second message.
    expect(await run({ id: outboxId })).toBe("skipped");
    await sql`UPDATE outbox SET processed_at = NULL, available_at = now() WHERE id = ${outboxId}`;
    expect(await run({ id: outboxId })).toBe("processed");
    expect(sender.calls).toHaveLength(1);
  });

  it("a crash after the claim leaves the test-send `sending`; the re-claimed outbox row sends nothing (code review L9)", async () => {
    const sender = recordingSender();
    const { testSendId, outboxId } = await testSend("email", "<p>Halo {nama}</p>", { subject: "Uji" });
    // The state a worker that died between the claim and the finalize leaves behind.
    await sql`UPDATE template_test_sends SET status = 'sending' WHERE id = ${testSendId}`;
    expect(await processor(sender)({ id: outboxId })).toBe("processed");
    expect(sender.calls).toHaveLength(0);
    expect(await status(testSendId)).toEqual({ status: "sending", error: null, sent: false });
  });

  it("records a failure code and does not retry", async () => {
    const failing: TestSender = {
      email: () => Promise.reject(new TestSendError("smtp_rejected")),
      whatsapp: () => Promise.reject(new Error("provider said: +6281234567890 is invalid")),
    };
    const email = await testSend("email", "<p>Halo {nama}</p>", { subject: "Uji" });
    expect(await processor(failing)({ id: email.outboxId })).toBe("processed");
    expect(await status(email.testSendId)).toEqual({ status: "failed", error: "smtp_rejected", sent: false });
    const [outbox] = await sql<{ processed: boolean; last_error: string | null }[]>`SELECT processed_at IS NOT NULL AS processed, last_error FROM outbox WHERE id = ${email.outboxId}`;
    expect(outbox).toEqual({ processed: true, last_error: null });
    // A provider error's text (which may quote the number) is never stored: only a code.
    const sessionId = first(
      await sql<{ id: string }[]>`
        WITH s AS (INSERT INTO waha_servers (name, base_url, base_url_host) VALUES ('WF', 'https://waha-fail.invalid/', 'waha-fail.invalid') RETURNING id)
        INSERT INTO waha_sessions (server_id, session_name) SELECT id, 'default' FROM s RETURNING id`,
    ).id;
    const wa = await testSend("whatsapp", "Halo {nama}", { sessionId });
    expect(await processor(failing)({ id: wa.outboxId })).toBe("processed");
    expect(await status(wa.testSendId)).toEqual({ status: "failed", error: "send_failed", sent: false });
  });

  it("records render failures, a missing session and unknown error codes; refuses a payload without a test-send", async () => {
    const sender = recordingSender();
    const broken = await testSend("whatsapp", "Halo {tidak_ada}");
    expect(await processor(sender)({ id: broken.outboxId })).toBe("processed");
    expect(await status(broken.testSendId)).toMatchObject({ status: "failed", error: "render_failed" });
    const noSession = await testSend("whatsapp", "Halo {nama}");
    expect(await processor(sender)({ id: noSession.outboxId })).toBe("processed");
    expect(await status(noSession.testSendId)).toMatchObject({ status: "failed", error: "no_session" });
    expect(sender.calls).toHaveLength(0);
    const odd: TestSender = { email: () => Promise.reject(new TestSendError("Not A Code")), whatsapp: () => Promise.resolve() };
    const email = await testSend("email", "<p>x</p>");
    expect(await processor(odd)({ id: email.outboxId })).toBe("processed");
    expect(await status(email.testSendId)).toMatchObject({ status: "failed", error: "send_failed" });
    const outboxId = randomUUID();
    await sql`INSERT INTO outbox (id, topic, dedupe_key, payload) VALUES (${outboxId}, ${TEST_SEND_TOPIC}, ${`bad:${outboxId}`}, '{"test_send_id": "nope"}'::jsonb)`;
    await expect(processor(sender)({ id: outboxId })).rejects.toThrow(/no valid test_send_id/);
  });

  it("the worker role can only record the outcome", async () => {
    const { testSendId } = await testSend("email", "<p>x</p>", { subject: "x" });
    await expect(workerSql`UPDATE public.template_test_sends SET recipient = 'other@example.test' WHERE id = ${testSendId}`).rejects.toMatchObject({ code: "42501" });
  });
});

describe("real senders", () => {
  const messaging = generateScopeKeyPair();
  const opener = createSecretOpener({ messaging: messaging.privateKey });
  const sealer = createSecretSealer({ messaging: messaging.publicKey });
  const dev = { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: true };

  it("e-mails the rendered template through SMTP (Mailpit)", async () => {
    await sql`DELETE FROM smtp_settings`;
    await sql`INSERT INTO smtp_settings (host, port, security, from_address, from_name) VALUES ('127.0.0.1', ${SMTP_PORT}, 'starttls', 'noreply@example.test', 'Toko Uji')`;
    const tag = randomBytes(6).toString("hex");
    const { testSendId, outboxId } = await testSend("email", '<p>Halo {nama}, <a href="{link_trivia}">masuk</a></p>', { subject: `Ebook {judul_ebook} ${tag}`, recipient: `budi-${tag}@example.test` });
    expect(await processor(createTestSenders({ sql: workerSql, opener, dev }))({ id: outboxId })).toBe("processed");
    expect(await status(testSendId)).toMatchObject({ status: "sent" });
    const search = (await (await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(tag)}`)).json()) as { messages: { ID: string; Subject: string; To: { Address: string }[] }[] };
    expect(search.messages).toHaveLength(1);
    expect(search.messages[0]).toMatchObject({ Subject: `[UJI] Ebook Contoh Ebook ${tag}`, To: [{ Address: `budi-${tag}@example.test` }] });
    const message = (await (await fetch(`${MAILPIT_API}/api/v1/message/${search.messages[0]?.ID ?? ""}`)).json()) as { HTML: string };
    expect(message.HTML).toContain("[link_trivia]");
    await sql`DELETE FROM smtp_settings`;
  });

  it("are wired from worker.env only when the messaging private key is there", () => {
    expect(testSendFromEnv({}, dev)).toBeUndefined();
    expect(testSendFromEnv({ SECRETS_MESSAGING_PRIVATE_KEY: "" }, dev)).toBeUndefined();
    expect(typeof testSendFromEnv({ SECRETS_MESSAGING_PRIVATE_KEY: Buffer.from(messaging.privateKey).toString("base64url") }, dev)).toBe("function");
    expect(() => testSendFromEnv({ SECRETS_MESSAGING_PRIVATE_KEY: "not-a-key" }, dev)).toThrow();
  });

  it("e-mail: refuses without SMTP settings or a needed password, and classifies SMTP failures", async () => {
    const senders = createTestSenders({ sql: workerSql, opener, dev });
    const mail = { to: "budi@example.test", subject: "s", html: "<p>h</p>", text: "t" };
    await sql`DELETE FROM smtp_settings`;
    await expect(senders.email(mail, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "smtp_not_configured" });
    // Nothing listens on port 9 (discard) of loopback: the connection is refused before DATA.
    await sql`INSERT INTO smtp_settings (host, port, security, username, from_address) VALUES ('127.0.0.1', 9, 'starttls', 'mailer', 'noreply@example.test')`;
    await expect(senders.email(mail, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "smtp_password_missing" });
    const sealed = sealer.sealSecret({ scope: "messaging", name: SECRET_NAMES.smtpPassword, adnetId: null, boundHost: "127.0.0.1", plaintext: "smtp-password-0001" });
    await sql`
      INSERT INTO settings_secrets (id, scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
      VALUES (${sealed.id}, 'messaging', ${sealed.name}, NULL, ${sealed.boundHost}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.sealedDek}, ${sealed.keyId}, ${sealed.last4})`;
    await expect(senders.email(mail, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "smtp_failed" });
    // Defence in depth: a password bound to another host is refused even if the DB check were bypassed.
    await sql.begin(async (tx) => {
      await tx`ALTER TABLE smtp_settings DISABLE TRIGGER smtp_settings_clear_bound_secrets`;
      await tx`UPDATE smtp_settings SET host = 'smtp.example.test'`;
      await tx`ALTER TABLE smtp_settings ENABLE ALWAYS TRIGGER smtp_settings_clear_bound_secrets`;
    });
    await expect(senders.email(mail, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "binding_mismatch" });
    await sql`DELETE FROM smtp_settings`;
  });

  it("WhatsApp: refuses an inactive session, a non-Indonesian number and an aborted send", async () => {
    const senders = createTestSenders({ sql: workerSql, opener, dev });
    const serverId = first(await sql<{ id: string }[]>`INSERT INTO waha_servers (name, base_url, base_url_host, active) VALUES ('W3', 'https://10.1.2.4/', '10.1.2.4', false) RETURNING id`).id;
    const sessionId = first(await sql<{ id: string }[]>`INSERT INTO waha_sessions (server_id, session_name) VALUES (${serverId}, 'default') RETURNING id`).id;
    await expect(senders.whatsapp({ sessionId, to: "+6281234567890", text: "x" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "session_inactive" });
    await expect(senders.whatsapp({ sessionId: randomUUID(), to: "+6281234567890", text: "x" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "session_inactive" });
    await expect(senders.whatsapp({ sessionId, to: "+14155550100", text: "x" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "invalid_recipient" });
    await sql`UPDATE waha_servers SET active = true, allow_private_ip = true WHERE id = ${serverId}`;
    const sealed = sealer.sealSecret({ scope: "messaging", name: SECRET_NAMES.wahaApiKey(serverId), adnetId: null, boundHost: "10.1.2.4", plaintext: "waha-api-key-0002" });
    await sql`
      INSERT INTO settings_secrets (id, scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
      VALUES (${sealed.id}, 'messaging', ${sealed.name}, NULL, ${sealed.boundHost}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.sealedDek}, ${sealed.keyId}, ${sealed.last4})`;
    const aborted = new AbortController();
    aborted.abort();
    await expect(senders.whatsapp({ sessionId, to: "+6281234567890", text: "x" }, aborted.signal)).rejects.toMatchObject({ code: "timeout" });
  });

  it("WhatsApp: refuses without the server's sealed key, opens it with the messaging key otherwise", async () => {
    const serverId = first(await sql<{ id: string }[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES ('W2', 'https://waha-test.invalid/', 'waha-test.invalid') RETURNING id`).id;
    const sessionId = first(await sql<{ id: string }[]>`INSERT INTO waha_sessions (server_id, session_name) VALUES (${serverId}, 'default') RETURNING id`).id;
    const senders = createTestSenders({ sql: workerSql, opener, dev });
    await expect(senders.whatsapp({ sessionId, to: "+6281234567890", text: "x" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "waha_key_missing" });
    const sealed = sealer.sealSecret({ scope: "messaging", name: SECRET_NAMES.wahaApiKey(serverId), adnetId: null, boundHost: "waha-test.invalid", plaintext: "waha-api-key-0001" });
    await sql`
      INSERT INTO settings_secrets (id, scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
      VALUES (${sealed.id}, 'messaging', ${sealed.name}, NULL, ${sealed.boundHost}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.sealedDek}, ${sealed.keyId}, ${sealed.last4})`;
    // .invalid never resolves (RFC 6761): the key opened, the request was attempted and failed.
    await expect(senders.whatsapp({ sessionId, to: "+6281234567890", text: "x" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "waha_failed" });
    // A key sealed to another messaging key does not open.
    const other = createSecretOpener({ messaging: generateScopeKeyPair().privateKey });
    await expect(createTestSenders({ sql: workerSql, opener: other, dev }).whatsapp({ sessionId, to: "+6281234567890", text: "x" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "secret_unreadable" });
  });
});
