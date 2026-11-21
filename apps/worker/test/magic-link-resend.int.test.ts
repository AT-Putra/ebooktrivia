// US-027 (Owner decision): "send my login link again". apps/public answers every phone alike and then calls
// enqueue_magic_link_resend (as public_rw); for a player who may log in that writes ONE magic_link.resend job (at
// most 3 a day); the worker (as worker_rw) issues a fresh link per channel through issue_magic_link, which makes
// the link sent before stop working, and sends it by WhatsApp and e-mail through the MagicLinkSender port.
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { type IdMobileE164, issueMagicLink, type MagicLinkChannel, parseMagicLinkFragment, toWaChatId } from "@ebooktrivia/core";
import { generateScopeKeyPair } from "@ebooktrivia/crypto";
import { messages } from "@ebooktrivia/i18n";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { MailAccessError } from "../src/delivery/ports.ts";
import { inertFailpoint } from "../src/failpoint.ts";
import { createLogger } from "../src/log.ts";
import {
  createMagicLinkResendConsumer,
  createMagicLinkSender,
  MAGIC_LINK_RESEND_TOPIC,
  MagicLinkSendError,
  type MagicLinkMessage,
  type MagicLinkSender,
  magicLinkMessage,
  magicLinkResendFromEnv,
} from "../src/magic-link-resend.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { createQueue, redisOptions } from "../src/queues.ts";
import { relayOnce } from "../src/relay.ts";
import { first, sql, suffix } from "./support/db.ts";
import { createSession, createWahaFake, recordingMail, retireSessions } from "./support/delivery.ts";
import { silentLog } from "./support/midtrans.ts";
import { obliterate, testValkey, uniquePrefix } from "./support/valkey.ts";

const workerSql = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 4, onnotice: () => undefined });
afterAll(async () => {
  await workerSql.end({ timeout: 5 });
});
const PLAY_ORIGIN = "https://play.ebooktrivia.example.test";

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
      VALUES (${product.id}, ${`resend-${suffix()}`}, 'Program', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`,
  ).id;
});

const phoneFor = (): string => `+62812${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`;

async function player(opts: { eligible?: boolean; email?: string | null } = {}): Promise<{ id: string; phone: string }> {
  const phone = phoneFor();
  const row = first(await sql<{ id: string }[]>`INSERT INTO players (phone, name, email) VALUES (${phone}, 'Pemain', ${opts.email === undefined ? `p${suffix()}@example.test` : opts.email}) RETURNING id`);
  const eligible = opts.eligible ?? true;
  await sql`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${row.id}, ${programId}, ${eligible ? new Date() : null}, ${eligible})`;
  return { id: row.id, phone };
}

/** What apps/public calls after its uniform answer: as public_rw. */
const enqueue = (phone: string) =>
  sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE public_rw");
    return first(await tx<{ id: string | null }[]>`SELECT public.enqueue_magic_link_resend(${phone}) AS id`).id;
  });

/** The player_auth user a token would log in (public_rw's own read), or null when the link does not work. */
const wouldLogIn = async (token: string, channel: MagicLinkChannel) =>
  first(await sql<{ u: string | null }[]>`SELECT public.magic_link_login_user(${createHash("sha256").update(token).digest()}, ${channel}) AS u`).u;

function recordingSender(failOn: readonly MagicLinkChannel[] = []): MagicLinkSender & { readonly sent: MagicLinkMessage[] } {
  const sent: MagicLinkMessage[] = [];
  return {
    sent,
    send: (message) => {
      if (failOn.includes(message.channel)) return Promise.reject(new MagicLinkSendError("no_session"));
      sent.push(message);
      return Promise.resolve();
    },
  };
}

const processorFor = (sender: MagicLinkSender, log = capturedLog().log) =>
  createOutboxProcessor(createMagicLinkResendConsumer({ sql: workerSql, playOrigin: PLAY_ORIGIN, sender, log }), { sql: workerSql, failpoint: inertFailpoint, log });

const tokenIn = (message: MagicLinkMessage): string => {
  const url = /https:\/\/\S+/.exec(message.text)?.[0] ?? "";
  return parseMagicLinkFragment(new URL(url).hash)?.token ?? "";
};

describe("magic_link.resend", () => {
  it("sends a fresh link by WhatsApp and e-mail; the links sent before stop working; the log names no one", async () => {
    const p = await player();
    // The links the player had (the delivery's, US-025), one per channel.
    const before = { whatsapp: issueMagicLink({ channel: "whatsapp" }), email: issueMagicLink({ channel: "email" }) };
    for (const [channel, link] of Object.entries(before)) await sql`SELECT issue_magic_link(${p.id}, ${channel}, ${link.tokenHash})`;
    expect(await wouldLogIn(before.whatsapp.token, "whatsapp")).not.toBeNull();

    const outboxId = await enqueue(p.phone);
    expect(outboxId).not.toBeNull();
    const job = first(await sql<{ topic: string; payload: unknown }[]>`SELECT topic, payload FROM outbox WHERE id = ${outboxId}`);
    expect(job).toEqual({ topic: MAGIC_LINK_RESEND_TOPIC, payload: { player_id: p.id } });
    const sender = recordingSender();
    const captured = capturedLog();
    expect(await processorFor(sender, captured.log)({ id: outboxId })).toBe("processed");

    expect(sender.sent.map((m) => [m.channel, m.to === p.phone || m.to.endsWith("@example.test")])).toEqual([
      ["whatsapp", true],
      ["email", true],
    ]);
    for (const message of sender.sent) {
      expect(message.text).toMatch(new RegExp(`^Tautan masuk Trivia Arena kamu: ${PLAY_ORIGIN}/masuk#c=${message.channel}&t=[A-Za-z0-9_-]{43}\\n`));
      expect(await wouldLogIn(tokenIn(message), message.channel)).not.toBeNull();
    }
    // In HTML the link's "&" is written "&amp;" (the browser reads it back as "&").
    expect(sender.sent[1]?.html).toContain(`href="${PLAY_ORIGIN}/masuk#c=email&amp;t=`);
    // The links sent before no longer work.
    expect(await wouldLogIn(before.whatsapp.token, "whatsapp")).toBeNull();
    expect(await wouldLogIn(before.email.token, "email")).toBeNull();
    const text = captured.lines.join("");
    expect(text).toContain('"outcome":"sent"');
    for (const secret of [p.phone.slice(1), p.id, ...sender.sent.map(tokenIn)]) expect(text).not.toContain(secret);
  });

  it("makes no job for an unknown, a non-eligible or an anonymized phone (nothing is sent), and at most 3 a day per player", async () => {
    const unknown = phoneFor();
    const notEligible = await player({ eligible: false });
    const gone = await player();
    await sql`UPDATE players SET anonymized_at = now() WHERE id = ${gone.id}`;
    for (const phone of [unknown, notEligible.phone, gone.phone, "not a phone"]) expect(await enqueue(phone), phone).toBeNull();
    expect(await sql`SELECT 1 FROM outbox WHERE topic = ${MAGIC_LINK_RESEND_TOPIC} AND payload->>'player_id' IN (${notEligible.id}, ${gone.id})`).toHaveLength(0);

    const p = await player();
    const jobs = [await enqueue(p.phone), await enqueue(p.phone), await enqueue(p.phone), await enqueue(p.phone)];
    expect(jobs.filter((id) => id !== null)).toHaveLength(3);
    expect(jobs[3]).toBeNull();
    expect(await sql`SELECT 1 FROM outbox WHERE topic = ${MAGIC_LINK_RESEND_TOPIC} AND payload->>'player_id' = ${p.id}`).toHaveLength(3);
    // Only public_rw may ask; worker_rw issues, it does not ask.
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE worker_rw");
        await tx`SELECT public.enqueue_magic_link_resend(${p.phone})`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("sends WhatsApp only when no e-mail is stored; drops the job of a player refunded meanwhile", async () => {
    const p = await player({ email: null });
    const sender = recordingSender();
    expect(await processorFor(sender)({ id: await enqueue(p.phone) })).toBe("processed");
    expect(sender.sent.map((m) => m.channel)).toEqual(["whatsapp"]);

    const refunded = await player();
    const outboxId = await enqueue(refunded.phone);
    await sql`UPDATE player_programs SET eligible = false, first_paid_at = NULL WHERE player_id = ${refunded.id}`;
    const late = recordingSender();
    expect(await processorFor(late)({ id: outboxId })).toBe("processed");
    expect(late.sent).toEqual([]);
    expect(await sql`SELECT 1 FROM magic_links WHERE player_id = ${refunded.id}`).toHaveLength(0);
  });

  it("finishes when one channel got through, keeping a failed channel's previous link; fails (to be retried) only when every channel failed", async () => {
    const p = await player();
    const before = issueMagicLink({ channel: "email" });
    await sql`SELECT issue_magic_link(${p.id}, 'email', ${before.tokenHash})`;
    const partial = recordingSender(["email"]);
    expect(await processorFor(partial)({ id: await enqueue(p.phone) })).toBe("processed");
    expect(partial.sent.map((m) => m.channel)).toEqual(["whatsapp"]);
    // The e-mail could not be sent: its previous link was not replaced, it still works (code review MINOR-10).
    expect(await wouldLogIn(before.token, "email")).not.toBeNull();

    const q = await player();
    const outboxId = await enqueue(q.phone);
    await expect(processorFor(recordingSender(["whatsapp", "email"]))({ id: outboxId })).rejects.toMatchObject({ code: "no_session" });
    expect(first(await sql<{ processed: boolean; last_error: string | null; attempts: number }[]>`
      SELECT processed_at IS NOT NULL AS processed, last_error, attempts FROM outbox WHERE id = ${outboxId}`)).toEqual({ processed: false, last_error: "magic link send failed: no_session", attempts: 1 });
  });

  it("takes its copy and the brand from packages/i18n (common.appName)", () => {
    const message = magicLinkMessage(`${PLAY_ORIGIN}/masuk#c=email&t=${"a".repeat(43)}`);
    expect(message.subject).toBe(`Tautan masuk ${messages.id.common.appName}`);
    expect(message.text.startsWith(`Tautan masuk ${messages.id.common.appName} kamu: ${PLAY_ORIGIN}/masuk#c=email&t=`)).toBe(true);
    expect(message.html).toContain(`>Masuk ke ${messages.id.common.appName}</a>`);
  });

  // Security review LOW-1: the resend's global breaker, otp.global_send_cap jobs per 10 minutes over all players.
  it("stops at otp.global_send_cap resend jobs in 10 minutes (NULL, nothing enqueued) and raises ONE critical alert", async () => {
    const [cap] = await sql<{ value: unknown }[]>`SELECT value FROM app_settings WHERE key = 'otp.global_send_cap'`;
    await sql`UPDATE app_settings SET value = '50'::jsonb WHERE key = 'otp.global_send_cap'`;
    const filler: string[] = [];
    try {
      const recent = first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE topic = ${MAGIC_LINK_RESEND_TOPIC} AND created_at > now() - interval '10 minutes'`).n;
      for (let i = recent; i < 50; i++) {
        filler.push(first(await sql<{ id: string }[]>`INSERT INTO outbox (topic, dedupe_key, payload) VALUES (${MAGIC_LINK_RESEND_TOPIC}, ${`breaker-test:${suffix()}:${String(i)}`}, '{}') RETURNING id`).id);
      }
      const p = await player();
      expect(await enqueue(p.phone)).toBeNull();
      expect(await enqueue(p.phone)).toBeNull();
      expect(await sql`SELECT 1 FROM outbox WHERE topic = ${MAGIC_LINK_RESEND_TOPIC} AND payload->>'player_id' = ${p.id}`).toHaveLength(0);
      const alerts = await sql<{ severity: string }[]>`SELECT severity FROM alerts WHERE dedupe_key = 'magic_link_resend_breaker' AND resolved_at IS NULL AND created_at > now() - interval '1 hour'`;
      expect(alerts).toEqual([{ severity: "critical" }]);
    } finally {
      await sql`DELETE FROM outbox WHERE id = ANY (${filler}::uuid[])`;
      await sql`UPDATE alerts SET resolved_at = now() WHERE dedupe_key = 'magic_link_resend_breaker' AND resolved_at IS NULL`;
      await sql`UPDATE app_settings SET value = ${JSON.stringify(cap?.value ?? 500)}::text::jsonb WHERE key = 'otp.global_send_cap'`;
    }
  });

  it("is wired only with the messaging key and a DOMAIN, and points the links at https://play.<DOMAIN>", () => {
    const key = generateScopeKeyPair().privateKey.toString("base64url");
    expect(magicLinkResendFromEnv({ DOMAIN: "ebooktrivia.example.test" }, {} as never)).toBeUndefined();
    expect(magicLinkResendFromEnv({ SECRETS_MESSAGING_PRIVATE_KEY: key }, {} as never)).toBeUndefined();
    expect(magicLinkResendFromEnv({ SECRETS_MESSAGING_PRIVATE_KEY: key, DOMAIN: "Ebooktrivia.Example.Test" }, {} as never)?.playOrigin).toBe("https://play.ebooktrivia.example.test");
    expect(() => magicLinkResendFromEnv({ SECRETS_MESSAGING_PRIVATE_KEY: key, DOMAIN: "evil.test/x" }, {} as never)).toThrow(RangeError);
  });
});

describe("magic_link.resend: a send that may have gone out, and a contact at its limit", () => {
  /** A sender that fails WhatsApp once with `error` and records every message it took. */
  function failingWhatsAppOnce(error: MagicLinkSendError): MagicLinkSender & { readonly sent: MagicLinkMessage[]; readonly tried: MagicLinkMessage[] } {
    const sent: MagicLinkMessage[] = [];
    const tried: MagicLinkMessage[] = [];
    let failed = false;
    return {
      sent,
      tried,
      send: (message) => {
        tried.push(message);
        if (message.channel === "whatsapp" && !failed) {
          failed = true;
          return Promise.reject(error);
        }
        sent.push(message);
        return Promise.resolve();
      },
    };
  }
  const row = async (id: string) =>
    first(await sql<{ attempts: number; deferrals: number; processed: boolean; available_at: Date; relayed_at: Date | null; payload: Record<string, unknown> }[]>`
      SELECT attempts, deferrals, processed_at IS NOT NULL AS processed, available_at, relayed_at, payload FROM outbox WHERE id = ${id}`);

  it("a WhatsApp send that MAY have gone out registers its link (it works) and is not sent again", async () => {
    const p = await player();
    const outboxId = (await enqueue(p.phone)) ?? "";
    const sender = failingWhatsAppOnce(new MagicLinkSendError("waha_maybe_sent", { maybeSent: true }));
    expect(await processorFor(sender)({ id: outboxId })).toBe("processed");
    const whatsapp = sender.tried.find((m) => m.channel === "whatsapp");
    expect(whatsapp).toBeDefined();
    // The message may be on the player's phone: its link logs in.
    expect(await wouldLogIn(tokenIn(whatsapp ?? sender.tried[0] ?? ({} as MagicLinkMessage)), "whatsapp")).not.toBeNull();
    expect(await row(outboxId)).toMatchObject({ processed: true, attempts: 1 });
    expect(await processorFor(sender)({ id: outboxId })).toBe("skipped");
    expect(sender.tried.filter((m) => m.channel === "whatsapp")).toHaveLength(1);
  });

  it("a contact at its limit waits for its come-back time without using an attempt, then only its channel goes", async () => {
    const p = await player();
    const outboxId = (await enqueue(p.phone)) ?? "";
    const comeBack = new Date(Date.now() + 45_000);
    const sender = failingWhatsAppOnce(new MagicLinkSendError("contact_limit", { retryAt: comeBack }));
    expect(await processorFor(sender)({ id: outboxId })).toBe("deferred");
    // The e-mail went out now; WhatsApp waits. The claim counts as a deferral (it raises the cap; attempts never goes down), the row is due at
    // the come-back time and goes back to the relay.
    expect(sender.sent.map((m) => m.channel)).toEqual(["email"]);
    const waiting = await row(outboxId);
    expect(waiting).toMatchObject({ processed: false, attempts: 1, deferrals: 1, relayed_at: null });
    expect(Math.abs(waiting.available_at.getTime() - comeBack.getTime())).toBeLessThan(1000);
    expect(waiting.payload).toMatchObject({ player_id: p.id, channels: ["whatsapp"] });
    // Not before its time.
    expect(await processorFor(sender)({ id: outboxId })).toBe("skipped");
    // Its time: only WhatsApp is sent, and its link works.
    await sql`UPDATE outbox SET available_at = now() WHERE id = ${outboxId}`;
    expect(await processorFor(sender)({ id: outboxId })).toBe("processed");
    expect(sender.sent.map((m) => m.channel)).toEqual(["email", "whatsapp"]);
    expect(await wouldLogIn(tokenIn(sender.sent[1] ?? ({} as MagicLinkMessage)), "whatsapp")).not.toBeNull();
    expect(await row(outboxId)).toMatchObject({ processed: true, attempts: 2, deferrals: 1 });
  });

  it("through the relay and a real BullMQ worker: the deferred job runs again at the come-back time, under a job id of its own", async () => {
    // A topic of this test only (the consumer itself, renamed), so no other resend row of the shared database reaches this worker.
    const topic = "test.magic_link_defer";
    const p = await player();
    const outboxId = first(
      await sql<{ id: string }[]>`INSERT INTO outbox (topic, dedupe_key, payload) VALUES (${topic}, ${`defer:${suffix()}`}, ${sql.json({ player_id: p.id })}) RETURNING id`,
    ).id;
    const comeBack = new Date(Date.now() + 1500);
    const sender = failingWhatsAppOnce(new MagicLinkSendError("contact_limit", { retryAt: comeBack }));
    const log = capturedLog().log;
    const processor = createOutboxProcessor({ ...createMagicLinkResendConsumer({ sql: workerSql, playOrigin: PLAY_ORIGIN, sender, log }), topic }, { sql: workerSql, failpoint: inertFailpoint, log });
    const prefix = uniquePrefix();
    const queue = createQueue(topic, { valkey: testValkey(), prefix });
    const worker = new Worker(topic, (job) => processor(job.data), { connection: redisOptions(testValkey()), prefix });
    const done: { readonly jobId: string; readonly result: unknown; readonly at: number }[] = [];
    worker.on("completed", (job) => {
      done.push({ jobId: job.id ?? "", result: job.returnvalue, at: Date.now() });
    });
    try {
      // The relay loop, as the worker runs it (every few hundred ms): no sweeper, so nothing waits for its stale window.
      const started = Date.now();
      while (done.length < 2 && Date.now() - started < 20_000) {
        await relayOnce({ sql: workerSql, queues: new Map([[topic, queue]]), batchSize: 10, failpoint: inertFailpoint });
        await delay(100);
      }
      expect(done.map((d) => [d.jobId, d.result])).toEqual([
        [outboxId, "deferred"],
        [`${outboxId}-1`, "processed"],
      ]);
      // It ran again once the contact could be written to, not before it and not a stale window (minutes) later.
      expect(done[1]?.at ?? 0).toBeGreaterThanOrEqual(comeBack.getTime() - 50);
      expect((done[1]?.at ?? 0) - comeBack.getTime()).toBeLessThan(5000);
      expect(sender.sent.map((m) => m.channel)).toEqual(["email", "whatsapp"]);
      expect(await row(outboxId)).toMatchObject({ processed: true, attempts: 2, deferrals: 1 });
    } finally {
      await worker.close();
      await obliterate([queue]);
    }
  });
});

// The production sender (US-025's paths): WhatsApp out of the pool, e-mail through the SMTP sender.
describe("the production magic link sender", () => {
  beforeEach(retireSessions);
  afterAll(retireSessions);
  const rig = () => {
    const waha = createWahaFake();
    const mail = recordingMail();
    const sender = createMagicLinkSender({ sql: workerSql, log: silentLog, waha: waha.access, mail, random: () => 0, humanRandom: () => 0, sleep: () => Promise.resolve() });
    return { waha, mail, sender };
  };
  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (error) {
      if (error instanceof MagicLinkSendError) return error.code;
      throw error;
    }
    return "sent";
  };

  it("sends the WhatsApp link from a pool number to the chat check-exists returns, recorded in the ledger, and the e-mail through SMTP", async () => {
    const r = rig();
    const session = await createSession();
    const p = await player();
    const message = magicLinkMessage(`${PLAY_ORIGIN}/masuk#c=whatsapp&t=x`);
    await r.sender.send({ channel: "whatsapp", to: p.phone, ...message }, new AbortController().signal);
    expect(r.waha.sent).toEqual([expect.objectContaining({ kind: "text", session: session.name, chatId: toWaChatId(p.phone as IdMobileE164), text: message.text })]);
    expect(await sql`SELECT kind, delivery_id FROM waha_sends WHERE session_id = ${session.id}`).toEqual([{ kind: "otp", delivery_id: null }]);
    await r.sender.send({ channel: "email", to: "p@example.test", ...message }, new AbortController().signal);
    expect(r.mail.sent).toEqual([{ to: "p@example.test", subject: message.subject, text: message.text, html: message.html }]);
  });

  it("respects the pool's per-contact limit (nothing sent: contact_limit), and skips a number WhatsApp holds back from new contacts", async () => {
    const r = rig();
    const held = await createSession({ weight: 5 });
    const open = await createSession({ weight: 1 });
    await sql`UPDATE waha_sessions SET reachout_until = now() + interval '1 hour' WHERE id = ${held.id}`;
    const p = await player();
    const message = magicLinkMessage(`${PLAY_ORIGIN}/masuk#c=whatsapp&t=x`);
    expect(await codeOf(r.sender.send({ channel: "whatsapp", to: p.phone, ...message }, new AbortController().signal))).toBe("sent");
    expect(r.waha.sent.map((s) => s.session)).toEqual([open.name]);
    // A second link to the same contact inside its 30 to 60 s gap: not sent, and the error says when the contact may be written to.
    const limited: unknown = await r.sender.send({ channel: "whatsapp", to: p.phone, ...message }, new AbortController().signal).catch((error: unknown) => error);
    expect(limited).toMatchObject({ code: "contact_limit", maybeSent: false });
    expect(limited instanceof MagicLinkSendError ? (limited.retryAt?.getTime() ?? 0) : 0).toBeGreaterThan(Date.now());
    expect(r.waha.sent).toHaveLength(1);
    // An SMTP that is not set up: the code only.
    r.mail.failures.push(new MailAccessError("smtp_not_configured"));
    expect(await codeOf(r.sender.send({ channel: "email", to: "p@example.test", ...message }, new AbortController().signal))).toBe("smtp_not_configured");
  });

  it("a WhatsApp send that timed out after the request left says it MAY have gone out (no other number is tried)", async () => {
    const r = rig();
    const flaky = await createSession({ weight: 5 });
    await createSession({ weight: 1 });
    r.waha.fault(flaky.name, "timeout_after_send");
    const p = await player();
    const failure: unknown = await r.sender
      .send({ channel: "whatsapp", to: p.phone, ...magicLinkMessage(`${PLAY_ORIGIN}/masuk#c=whatsapp&t=x`) }, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ maybeSent: true });
    expect(r.waha.sent).toHaveLength(1);
  });
});
