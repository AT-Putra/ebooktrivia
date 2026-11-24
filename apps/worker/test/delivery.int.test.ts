// US-025 criteria 1, 2 and 5: the delivery consumer (src/delivery/deliver.ts) against PostgreSQL as the worker_rw login, the in-process
// WAHA mock (infra/waha-mock behind a fetch that can fail per session) and a recording mail sender.
//   - the pool: weighted round-robin, the per-number daily cap, jitter (the slot a send waits for), a session that is not WORKING;
//   - a killed session fails over (up to 3 numbers); a timeout is `unknown`, found again by the recent-outgoing lookup or left to the
//     Owner, and NEVER sent a second time; nothing of an order that is not paid is ever claimed;
//   - e-mail: the PDF attached, retries, a refused size falls back to a signed link;
//   - exactly once under racing jobs.
import { randomUUID } from "node:crypto";
import { SmtpError, verifyFileUrl } from "@ebooktrivia/adapters";
import { DELIVERY_GAP_MS, EFFECT_CANCELLED, EMAIL_MAX_ATTEMPTS, POOL_MAX_WAIT_MS, WA_MAX_SESSIONS } from "@ebooktrivia/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDelivery, type Delivery, isSizeRejection } from "../src/delivery/deliver.ts";
import { expireOpenerLeases } from "../src/delivery/opener-sweep.ts";
import { expireLeases } from "../src/sweepers.ts";
import {
  createDeliveryShop,
  createSession,
  createWahaFake,
  type DeliveryShop,
  deliveryConfig,
  deliveryOf,
  fakeMagicLinks,
  PDF_BYTES,
  paidOrder,
  recordingMail,
  retireDeliveries,
  retireSessions,
} from "./support/delivery.ts";
import { testFiles } from "./support/files.ts";
import { first, sql } from "./support/db.ts";
import { silentLog, workerPool } from "./support/midtrans.ts";

const workerSql = workerPool(8);
let shop: DeliveryShop;
const shops: DeliveryShop[] = [];

beforeEach(async () => {
  await retireSessions();
  await retireDeliveries();
  shop = await createDeliveryShop();
  shops.push(shop);
});
afterAll(async () => {
  await retireSessions();
  await retireDeliveries();
  await Promise.all(shops.map((s) => s.cleanup()));
});

interface Rig {
  readonly delivery: Delivery;
  readonly waha: ReturnType<typeof createWahaFake>;
  readonly mail: ReturnType<typeof recordingMail>;
  readonly magic: ReturnType<typeof fakeMagicLinks>;
  readonly config: ReturnType<typeof deliveryConfig>;
  readonly enqueued: { channel: string; jobId: string; data: { id: string } }[];
  readonly slept: number[];
  clock: number;
}

function rig(options: { config?: Partial<ReturnType<typeof deliveryConfig>>; random?: () => number; shop?: DeliveryShop } = {}): Rig {
  const waha = createWahaFake();
  const mail = recordingMail();
  const magic = fakeMagicLinks();
  const config = deliveryConfig(options.shop ?? shop, options.config);
  const enqueued: Rig["enqueued"] = [];
  const slept: number[] = [];
  const state = { clock: 1_000_000 };
  const delivery = createDelivery({
    sql: workerSql,
    log: silentLog,
    config,
    waha: waha.access,
    mail,
    files: testFiles(config),
    magicLinks: magic,
    enqueue: (jobs) => {
      enqueued.push(...(jobs as Rig["enqueued"]));
      return Promise.resolve();
    },
    random: options.random ?? (() => 0.5),
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    clock: () => state.clock,
  });
  return {
    delivery,
    waha,
    mail,
    magic,
    config,
    enqueued,
    slept,
    get clock() {
      return state.clock;
    },
    set clock(value: number) {
      state.clock = value;
    },
  };
}

const alertsOf = (kind: string) => sql<{ severity: string; dedupe_key: string }[]>`SELECT severity, dedupe_key FROM alerts WHERE kind = ${kind} AND resolved_at IS NULL`;
const sendsOf = (sessionId: string) => sql<{ kind: string; delivery_id: string | null }[]>`SELECT kind, delivery_id FROM waha_sends WHERE session_id = ${sessionId}`;
const sessionOf = async (id: string) =>
  first(await sql<{ fail_streak: number; cooldown_until: Date | null; next_send_at: Date | null; status: string | null }[]>`SELECT fail_streak, cooldown_until, next_send_at, status FROM waha_sessions WHERE id = ${id}`);

describe("e-mail (criterion 2)", () => {
  it("sends the PDF as an attachment with the rendered template and the e-mail login link, once", async () => {
    const r = rig();
    const order = await paidOrder(shop, { name: `Budi <img src=x onerror=alert(1)> "Santoso" & 'Co'` });
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("sent");
    expect(r.mail.sent).toHaveLength(1);
    const [message] = r.mail.sent;
    expect(message?.to).toBe(order.email);
    expect(message?.attachments).toHaveLength(1);
    expect(Buffer.from(message?.attachments?.[0]?.content ?? new Uint8Array()).equals(PDF_BYTES)).toBe(true);
    expect(message?.attachments?.[0]).toMatchObject({ contentType: "application/pdf" });
    expect(message?.attachments?.[0]?.filename).toMatch(/^Ebook-[0-9a-f]{8}\.pdf$/);
    // The template's variables, every value escaped: a buyer's name cannot add markup (< > " ' &).
    expect(message?.html).not.toContain("<img");
    expect(message?.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(message?.html).toContain(order.code);
    expect(message?.subject).toMatch(/^Ebook Ebook /);
    expect(message?.text).toContain(order.code);
    // The login link (channel e-mail) is in the HTML link and the text, escaped in the attribute.
    expect(r.magic.issued).toHaveLength(1);
    expect(r.magic.issued[0]).toMatchObject({ playerId: order.playerId, channel: "email" });
    const link = r.magic.issued[0]?.url ?? "";
    expect(message?.html).toContain(`href="${link.replaceAll("&", "&amp;")}"`);
    expect(message?.text).toContain(link);
    expect(await deliveryOf(order.deliveries.email)).toMatchObject({ status: "sent", attempts: 1, last_error: null });
    // Replays, a second job and the lease sweeper change nothing.
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("skipped");
    expect(await expireLeases(workerSql)).toMatchObject({ deliveries: expect.any(Number) as number });
    expect(r.mail.sent).toHaveLength(1);
  });

  it("retries a definite failure after the machine's delay, three times, then fails with an alert (criterion 2: 3 retries)", async () => {
    const r = rig();
    const order = await paidOrder(shop);
    const id = order.deliveries.email;
    for (let attempt = 1; attempt <= EMAIL_MAX_ATTEMPTS; attempt++) {
      r.mail.failures.push(new SmtpError("failed", "SMTP send failed"));
      const result = await r.delivery.process({ id });
      expect(result).toBe(attempt < EMAIL_MAX_ATTEMPTS ? "pending" : "failed");
      const row = await deliveryOf(id);
      expect(row.attempts).toBe(attempt);
      expect(row.last_error).toBe("smtp_failed");
      if (attempt < EMAIL_MAX_ATTEMPTS) {
        // Not before its backoff: a job that arrives early is a no-op.
        expect(await r.delivery.process({ id })).toBe("skipped");
        await sql`UPDATE deliveries SET not_before = now() - interval '1 second' WHERE id = ${id}`;
      }
    }
    expect(await deliveryOf(id)).toMatchObject({ status: "failed", attempts: 4 });
    expect(r.mail.sent).toHaveLength(0);
    // A failed row never goes back by itself.
    expect(await r.delivery.process({ id })).toBe("skipped");
    expect((await alertsOf("delivery_failed")).some((a) => a.dedupe_key === `delivery_failed:${id}` && a.severity === "critical")).toBe(true);
    // An e-mail failure carries no personal data in the stored error or the alert.
    const [alert] = await sql<{ message: string; payload: unknown }[]>`SELECT message, payload FROM alerts WHERE dedupe_key = ${`delivery_failed:${id}`}`;
    expect(JSON.stringify(alert)).not.toContain(order.email);
    expect(JSON.stringify(alert)).not.toContain(order.phone);
  });

  it("a permanent rejection (5xx) fails at once; a send that may have gone out is unknown and never resent", async () => {
    const r = rig();
    const rejected = await paidOrder(shop);
    r.mail.failures.push(new SmtpError("rejected", "SMTP send failed"));
    expect(await r.delivery.process({ id: rejected.deliveries.email })).toBe("failed");
    expect(await deliveryOf(rejected.deliveries.email)).toMatchObject({ status: "failed", attempts: 1, last_error: "smtp_rejected" });

    const uncertain = await paidOrder(shop);
    r.mail.failures.push(new SmtpError("maybe_sent", "SMTP send failed"));
    expect(await r.delivery.process({ id: uncertain.deliveries.email })).toBe("unknown");
    expect(await deliveryOf(uncertain.deliveries.email)).toMatchObject({ status: "unknown", attempts: 1, last_error: "smtp_maybe_sent" });
    expect(await r.delivery.process({ id: uncertain.deliveries.email })).toBe("skipped");
    // Even the lease sweeper and a manual UPDATE by the worker cannot put it back (ET130).
    await expect(workerSql`UPDATE public.deliveries SET status = 'pending' WHERE id = ${uncertain.deliveries.email}`).rejects.toMatchObject({ code: "ET130" });
    expect(r.mail.sent).toHaveLength(0);
  });

  it("falls back to a signed link when the server refuses the size (552), without a second copy; a huge PDF goes as a link at once", async () => {
    const r = rig();
    const order = await paidOrder(shop);
    r.mail.failures.push(new SmtpError("rejected", "SMTP send failed", { cause: Object.assign(new Error("552 5.3.4 Message size exceeds fixed limit"), { responseCode: 552 }) }));
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("sent");
    // The first send was refused (recorded as a failure, never delivered); the one that went out has no attachment and a download link.
    expect(r.mail.sent).toHaveLength(1);
    const [fallback] = r.mail.sent;
    expect(fallback?.attachments).toBeUndefined();
    const url = /href="(https:\/\/api\.example\.test\/files\/deliverables\/[^"]+)"/.exec(fallback?.html ?? "")?.[1]?.replaceAll("&amp;", "&") ?? "";
    expect(url).not.toBe("");
    expect(fallback?.text).toContain(url);
    const parsed = new URL(url);
    const checked = verifyFileUrl({ path: parsed.pathname, exp: parsed.searchParams.get("exp"), sig: parsed.searchParams.get("sig"), nonce: parsed.searchParams.get("n"), key: r.config.fileUrlKey, now: new Date() });
    expect(checked).toEqual({ ok: true, path: `/files/${shop.storagePath}` });
    // 72 hours, like the login link.
    const ttl = Number(parsed.searchParams.get("exp")) - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(72 * 3600 - 60);
    expect(ttl).toBeLessThanOrEqual(72 * 3600);
    expect(await deliveryOf(order.deliveries.email)).toMatchObject({ status: "sent", attempts: 1 });

    const big = rig({ config: { emailAttachMaxBytes: 100 } });
    const other = await paidOrder(shop);
    expect(await big.delivery.process({ id: other.deliveries.email })).toBe("sent");
    expect(big.mail.sent).toHaveLength(1);
    expect(big.mail.sent[0]?.attachments).toBeUndefined();
    expect(big.mail.sent[0]?.html).toContain("/files/deliverables/");
    // Only a size refusal falls back: another 5xx is a permanent failure with no second try.
    const refused = await paidOrder(shop);
    r.mail.failures.push(new SmtpError("rejected", "SMTP send failed", { cause: Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 }) }));
    expect(await r.delivery.process({ id: refused.deliveries.email })).toBe("failed");
    expect(r.mail.sent).toHaveLength(1);
    // The size heuristics.
    expect(isSizeRejection(new SmtpError("rejected", "x", { cause: { response: "554 5.3.4 Message too big for system" } }))).toBe(true);
    expect(isSizeRejection(new SmtpError("rejected", "x", { cause: { message: "message size exceeds the maximum" } }))).toBe(true);
    expect(isSizeRejection(new SmtpError("rejected", "x"))).toBe(false);
    expect(isSizeRejection(new SmtpError("rejected", "x", { cause: { responseCode: 550, message: "no such user" } }))).toBe(false);
  });

  it("does not send an order that is not paid, takes the row out with payments' mark and never resurrects it (US-021 follow-up)", async () => {
    const r = rig();
    const order = await paidOrder(shop);
    await sql`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${order.orderId}`;
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("skipped");
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("skipped");
    expect(await deliveryOf(order.deliveries.email)).toMatchObject({ status: "cancelled", last_error: EFFECT_CANCELLED, attempts: 0 });
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "cancelled", last_error: EFFECT_CANCELLED });
    // Cancelled rows are not claimable again, whatever the order does later; only payments revives them.
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("skipped");
    expect(r.mail.sent).toHaveLength(0);
    expect(r.waha.sent).toHaveLength(0);
  });

  it("an order refunded while the e-mail was being sent is not put back to pending on a retry (ET080), it is taken out with the mark", async () => {
    const order = await paidOrder(shop);
    const r = rig();
    const original = r.mail.send.bind(r.mail);
    r.mail.failures.push(new SmtpError("failed", "SMTP send failed"));
    r.mail.send = async (message) => {
      await sql`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${order.orderId}`;
      return original(message);
    };
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("cancelled");
    expect(await deliveryOf(order.deliveries.email)).toMatchObject({ status: "cancelled", last_error: EFFECT_CANCELLED });
  });

  it("a product without a PDF cannot be delivered: both rows fail with an alert, nothing is sent", async () => {
    const bare = await createDeliveryShop({ pdf: null });
    shops.push(bare);
    const r = rig({ shop: bare });
    const order = await paidOrder(bare);
    await createSession();
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("skipped");
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("skipped");
    expect(await deliveryOf(order.deliveries.email)).toMatchObject({ status: "failed", last_error: "no_ebook_file" });
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "failed", last_error: "no_ebook_file" });
    expect((await alertsOf("delivery_failed")).filter((a) => a.dedupe_key.startsWith("delivery_failed:")).length).toBeGreaterThanOrEqual(2);
    expect(r.mail.sent).toHaveLength(0);
  });

  it("exactly once: racing jobs of the same row send one e-mail", async () => {
    const r = rig();
    const order = await paidOrder(shop);
    const results = await Promise.all(Array.from({ length: 8 }, () => r.delivery.process({ id: order.deliveries.email })));
    expect(results.filter((x) => x === "sent")).toHaveLength(1);
    expect(results.filter((x) => x === "skipped")).toHaveLength(7);
    expect(r.mail.sent).toHaveLength(1);
    expect(await deliveryOf(order.deliveries.email)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("a template that cannot render, or a magic link that cannot be issued, fails before anything is sent and is retried", async () => {
    const r = rig();
    const order = await paidOrder(shop);
    r.magic.failing = true;
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("pending");
    // Not an attempt against the budget: the e-mail's four tries are for the mail server, not for our own faults. The attempt NUMBER is never reused (attempts only
    // increases), so the budget is given back by moving attempts_base.
    expect(await deliveryOf(order.deliveries.email)).toMatchObject({ status: "pending", last_error: "magic_link_unavailable", attempts: 1, attempts_base: 1 });
    r.magic.failing = false;
    await sql`UPDATE deliveries SET not_before = now() - interval '1 second' WHERE id = ${order.deliveries.email}`;
    await sql`UPDATE message_templates SET body = body || '{tidak_ada}' WHERE key = 'delivery' AND channel = 'email'`;
    try {
      expect(await r.delivery.process({ id: order.deliveries.email })).toBe("pending");
      expect(await deliveryOf(order.deliveries.email)).toMatchObject({ last_error: "template_invalid", attempts: 2, attempts_base: 2 });
    } finally {
      await sql`UPDATE message_templates SET body = replace(body, '{tidak_ada}', '') WHERE key = 'delivery' AND channel = 'email'`;
    }
    expect(r.mail.sent).toHaveLength(0);
  });
});
const openerOf = async (id: string) =>
  first(
    await sql<{ status: string; attempts: number; session_id: string | null; tried_session_ids: string[]; last_error: string | null; next_attempt_at: Date | null; wa_message_id: string | null }[]>`
      SELECT status, attempts, session_id, tried_session_ids, last_error, next_attempt_at, wa_message_id FROM delivery_openers WHERE delivery_id = ${id}`,
  );
const ledgerOf = (sessionId: string) =>
  sql<{ kind: string; new_contact: boolean; has_key: boolean; outcome: string }[]>`SELECT kind, new_contact, contact_key IS NOT NULL AS has_key, outcome FROM waha_sends WHERE session_id = ${sessionId} ORDER BY created_at`;

describe("WhatsApp: the proactive message is ONE short opener (Owner decision D7)", () => {
  it("sends text only (the buyer's first name, no PDF, no login link) to the chat WAHA returned, through the human-like sequence, and the delivery stays pending", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { name: "Budi <b>Santoso</b>" });
    // WAHA says this phone lives at a @lid: that is where it is written to, never to a <phone>@c.us we build.
    await r.waha.contact(order.phone, { chatId: "98765432101234@lid", pn: order.chatId });
    await r.waha.clearCallLog();
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect(r.waha.sent).toHaveLength(1);
    const [sent] = r.waha.sent;
    expect(sent).toMatchObject({ kind: "text", session: session.name, chatId: "98765432101234@lid" });
    expect(sent?.text).toContain("Budi");
    expect(sent?.text).not.toContain("Santoso");
    expect(sent?.text).not.toContain("<");
    expect(sent?.text).not.toContain("https://");
    // The login path, not the word: an approved opener wording says "sudah masuk" (the payment came in).
    expect(sent?.text).not.toMatch(/\/masuk\b/);
    expect(sent?.url).toBeNull();
    // No PDF, no link: nothing issued, no file sent, no signed URL.
    expect(r.magic.issued).toEqual([]);
    expect(r.waha.sent.filter((s) => s.kind === "file")).toEqual([]);
    // The order: where does it live (check-exists), the WHOLE chat marked as read (the older unread messages of that person too: no message ids, the chat WAHA returned),
    // typing, paused, the message, offline.
    const calls = await r.waha.callLog();
    expect(calls.map((c) => `${c.path.replace(/^\/api\/[^/]+\/presence$/, "/presence")}${typeof c.body["presence"] === "string" ? `:${c.body["presence"]}` : ""}`)).toEqual([
      "/api/contacts/check-exists",
      "/api/sendSeen",
      "/presence:typing",
      "/presence:paused",
      "/api/sendText",
      "/presence:offline",
    ]);
    expect(calls[1]?.body).toEqual({ session: session.name, chatId: "98765432101234@lid" });
    // The delivery itself is untouched: pending, no attempt, no number. The opener is exactly-once on its own row.
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0, session_id: null, tried_session_ids: [] });
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "sent", attempts: 1, session_id: session.id, tried_session_ids: [session.id], last_error: null });
    // The send answer is the raw WEBJS message (an object id, US-005 R11): the id the machine records is its string `_serialized`, and the send is SENT, never maybe_sent
    // (which would have left the opener `unknown`, to be reconciled instead of recorded).
    expect(sent?.id).toMatch(/^true_98765432101234@lid_[0-9A-F]{22}$/);
    expect((await openerOf(order.deliveries.whatsapp)).wa_message_id).toBe(sent?.id);
    expect((await openerOf(order.deliveries.whatsapp)).status).toBe("sent");
    // It spends the number's budget of NEW contacts, and is counted per contact (a digest, never the phone).
    expect(await ledgerOf(session.id)).toEqual([{ kind: "opener", new_contact: true, has_key: true, outcome: "sent" }]);
    // What WAHA said is cached per phone: the chat id to send to, and the lid link.
    expect(await sql`SELECT number_exists, chat_id, lid FROM wa_contacts WHERE phone = ${order.phone}`).toEqual([{ number_exists: true, chat_id: "98765432101234@lid", lid: "98765432101234@lid" }]);
    // Exactly once: a replay, a second job and the sweeper change nothing, and the next sweep finds nothing to do for this delivery.
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("skipped");
    expect(r.waha.sent).toHaveLength(1);
    const due = await sql<{ id: string }[]>`
      SELECT d.id FROM deliveries d WHERE d.id = ${order.deliveries.whatsapp} AND d.status = 'pending' AND d.not_before <= now()
         AND NOT EXISTS (SELECT 1 FROM delivery_openers o WHERE o.delivery_id = d.id AND (o.status <> 'pending' OR o.next_attempt_at > now()))`;
    expect(due).toEqual([]);
  });

  it("varies the wording: one of the Owner's variants, picked at random for each buyer, with the buyer's own first name", async () => {
    const r = rig();
    await createSession({ dailyCap: 1000 });
    await sql`UPDATE waha_sessions SET new_contact_cap = 1000`;
    const texts = new Set<string>();
    for (let i = 0; i < 30; i++) {
      await sql`UPDATE waha_sessions SET next_send_at = NULL`;
      const order = await paidOrder(shop, { name: i % 2 === 0 ? "Siti Aminah" : "Agus Salim" });
      expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
      texts.add((r.waha.sent.at(-1)?.text ?? "").replace(/Siti|Agus/g, "{nama}").replace(/Ebook [^ ]+/g, "{judul}"));
      expect(r.waha.sent.at(-1)?.text).toContain(i % 2 === 0 ? "Siti" : "Agus");
    }
    // Ten seeded wordings (a number never repeats one of its last 3, so 30 buyers cannot all get the same one): they differ, and each is also varied by {sapaan} and [[a|b]].
    expect(texts.size).toBeGreaterThan(3);
  });

  it("holds no lock and no open transaction while it talks to WAHA, and a delivery that is not due is left alone", async () => {
    const r = rig();
    const only = await createSession();
    const order = await paidOrder(shop);
    const probes: string[] = [];
    const watching = createDelivery({
      sql: workerSql,
      log: silentLog,
      config: r.config,
      waha: {
        withSession: async (sessionId, use, options) => {
          // The request is in flight: the claim's transaction is over. Nothing locked, nobody idle in a transaction.
          for (const [table, id] of [["deliveries", order.deliveries.whatsapp], ["orders", order.orderId], ["waha_sessions", only.id], ["delivery_openers", order.deliveries.whatsapp]] as const) {
            const rows = await sql.begin(async (tx) => {
              await tx.unsafe("SET LOCAL lock_timeout = '300ms'");
              return tx.unsafe(`SELECT 1 FROM public.${table} WHERE ${table === "delivery_openers" ? "delivery_id" : "id"} = $1 FOR UPDATE NOWAIT`, [id]);
            });
            probes.push(`${table}:${String(rows.length)}`);
          }
          const idle = first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename LIKE 'ebt_worker%' AND state = 'idle in transaction'`);
          probes.push(`idle:${String(idle.n)}`);
          return r.waha.access.withSession(sessionId, use, options);
        },
      },
      mail: r.mail,
      files: testFiles(r.config),
      magicLinks: r.magic,
      enqueue: () => Promise.resolve(),
      random: () => 0.5,
      sleep: () => Promise.resolve(),
    });
    expect(await watching.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect(probes).toEqual(["deliveries:1", "orders:1", "waha_sessions:1", "delivery_openers:1", "idle:0"]);
    // A WhatsApp delivery whose delay has not passed is not claimed (the buyer may still write first).
    const waiting = await paidOrder(shop, { waNotBefore: new Date(Date.now() + 180_000) });
    expect(await r.delivery.process({ id: waiting.deliveries.whatsapp })).toBe("skipped");
    expect(await deliveryOf(waiting.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
    expect(await sql`SELECT 1 FROM delivery_openers WHERE delivery_id = ${waiting.deliveries.whatsapp}`).toHaveLength(0);
    // Only the first delivery (above) was written to.
    expect(r.waha.sent).toHaveLength(1);
  });

  it("is weighted round-robin: each number's share follows its weight, equal weights rotate", async () => {
    const r = rig({ random: Math.random });
    const light = await createSession({ weight: 1 });
    const heavy = await createSession({ weight: 3 });
    await sql`UPDATE waha_sessions SET new_contact_cap = 1000`;
    for (let i = 0; i < 40; i++) {
      await sql`UPDATE waha_sessions SET next_send_at = NULL`; // the pacing has its own test; here the slots are free
      const order = await paidOrder(shop);
      expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    }
    const lightSends = (await sendsOf(light.id)).length;
    const heavySends = (await sendsOf(heavy.id)).length;
    expect(lightSends + heavySends).toBe(40);
    expect(lightSends).toBeGreaterThanOrEqual(9);
    expect(lightSends).toBeLessThanOrEqual(11);

    await retireSessions();
    const a = await createSession();
    const b = await createSession();
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) {
      await sql`UPDATE waha_sessions SET next_send_at = NULL`;
      const order = await paidOrder(shop);
      await r.delivery.process({ id: order.deliveries.whatsapp });
      picks.push((await openerOf(order.deliveries.whatsapp)).session_id ?? "");
    }
    expect(picks.filter((p) => p === a.id)).toHaveLength(3);
    expect(picks.filter((p) => p === b.id)).toHaveLength(3);
  });

  it("paces each number with a random gap (jitter): the second send waits for its slot, a long queue is busy, never blasted", async () => {
    const r = rig({ random: () => 0.5 });
    const only = await createSession();
    const gap = DELIVERY_GAP_MS[0] + Math.floor(0.5 * (DELIVERY_GAP_MS[1] - DELIVERY_GAP_MS[0] + 1));
    const first_ = await paidOrder(shop);
    const second = await paidOrder(shop);
    await r.delivery.process({ id: first_.deliveries.whatsapp });
    // The first send's waits: its slot, the reading pause (the chat is marked as read first, an opener too), the typing wait and the short pause; the second send's slot comes next.
    const firstSleeps = r.slept.length;
    expect(firstSleeps).toBe(4);
    await r.delivery.process({ id: second.deliveries.whatsapp });
    // The first send starts at once; the second waits one gap (never less than the minimum gap, whatever the concurrency).
    expect(r.slept[0]).toBeLessThanOrEqual(5);
    expect(r.slept[firstSleeps]).toBeGreaterThan(gap - 1000);
    expect(r.slept[firstSleeps]).toBeLessThanOrEqual(gap + 100);
    const slot = (await sessionOf(only.id)).next_send_at;
    expect((slot?.getTime() ?? 0) - Date.now()).toBeGreaterThan(gap * 2 - 1500);
    // Pile up the queue past the wait budget: the next delivery is deferred, not sent, not claimed.
    await sql`UPDATE waha_sessions SET next_send_at = now() + ${POOL_MAX_WAIT_MS + 5000} * interval '1 millisecond' WHERE id = ${only.id}`;
    const busy = await paidOrder(shop);
    expect(await r.delivery.process({ id: busy.deliveries.whatsapp })).toBe("deferred");
    expect(await openerOf(busy.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0, session_id: null });
    expect((await alertsOf("wa_pool_exhausted")).filter((a) => a.dedupe_key.endsWith("all_busy"))).toEqual([]);
  });

  it("respects the per-number daily cap: a number at its cap is out for the day, and the pool says so when all are", async () => {
    const r = rig();
    const capped = await createSession({ dailyCap: 3, sentToday: 3 });
    const open = await createSession({ dailyCap: 3, sentToday: 1 });
    for (let i = 0; i < 2; i++) {
      const order = await paidOrder(shop);
      expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
      expect((await openerOf(order.deliveries.whatsapp)).session_id).toBe(open.id);
    }
    // 1 + 2 = 3 sends: the second number is at its cap too.
    const waiting = await paidOrder(shop);
    expect(await r.delivery.process({ id: waiting.deliveries.whatsapp })).toBe("deferred");
    expect(await openerOf(waiting.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
    expect((await sendsOf(capped.id)).length).toBe(3);
    expect(await alertsOf("wa_pool_exhausted")).toEqual(expect.arrayContaining([expect.objectContaining({ dedupe_key: "wa_pool_exhausted:all_capped", severity: "warning" })]));
    // The cap counts since WIB midnight: yesterday's sends do not count.
    await sql`UPDATE waha_sends SET created_at = now() - interval '2 days' WHERE session_id = ${capped.id}`;
    expect(await r.delivery.process({ id: waiting.deliveries.whatsapp })).toBe("opened");
    expect((await openerOf(waiting.deliveries.whatsapp)).session_id).toBe(capped.id);
  });

  it("skips a number that is not WORKING, or whose status is stale; with none left the opener waits and the pool alert is persisted", async () => {
    const r = rig();
    await createSession({ status: "STOPPED" });
    const stale = await createSession();
    await sql`UPDATE waha_sessions SET status_at = now() - interval '10 minutes' WHERE id = ${stale.id}`;
    await createSession({ status: null });
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("deferred");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0, tried_session_ids: [] });
    expect(r.waha.sent).toHaveLength(0);
    expect(await alertsOf("wa_pool_empty")).toEqual([expect.objectContaining({ severity: "critical", dedupe_key: "wa_pool_empty" })]);
    // The e-mail is unaffected by the pool.
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("sent");
    // A number that comes back is used by the next job.
    const back = await createSession();
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect((await openerOf(order.deliveries.whatsapp)).session_id).toBe(back.id);
  });

  it("with no session configured at all the opener waits (and alerts) instead of failing", async () => {
    const r = rig();
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("deferred");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
    expect(await alertsOf("wa_pool_empty")).toHaveLength(1);
  });

  it("does not write to the buyer of an order that is not paid (the row is taken out with payments' mark), nor when the opener is too old, nor when the buyer wrote first", async () => {
    const r = rig();
    await createSession();
    const refunded = await paidOrder(shop);
    await sql`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${refunded.orderId}`;
    expect(await r.delivery.process({ id: refunded.deliveries.whatsapp })).toBe("skipped");
    expect(await deliveryOf(refunded.deliveries.whatsapp)).toMatchObject({ status: "cancelled", last_error: EFFECT_CANCELLED });
    // Still unsent six hours after its time, an opener is moot (the e-mail has the ebook): dropped, quietly, nothing reserved.
    const late = await paidOrder(shop, { waNotBefore: new Date(Date.now() - 7 * 3_600_000) });
    expect(await r.delivery.process({ id: late.deliveries.whatsapp })).toBe("skipped");
    expect(await openerOf(late.deliveries.whatsapp)).toMatchObject({ status: "expired", last_error: "too_old" });
    // The buyer wrote first (the buyer-first path claimed the row): no opener is ever sent to them.
    const wrote = await paidOrder(shop);
    await sql`UPDATE deliveries SET status = 'sending', attempts = 1, lease_until = now() + interval '1 minute' WHERE id = ${wrote.deliveries.whatsapp}`;
    expect(await r.delivery.process({ id: wrote.deliveries.whatsapp })).toBe("skipped");
    expect(r.waha.sent).toHaveLength(0);
  });
});

describe("WhatsApp: first contact, failover of the opener, and what never happens twice (criteria 1 and 5)", () => {
  it("a killed session fails over to another number at once: one message in all, from the number that works, and the failed attempt is not a message", async () => {
    const r = rig({ random: () => 0 });
    const dead = await createSession({ weight: 5 });
    const alive = await createSession();
    // WAHA stopped the session after the last poll: the DB still says WORKING, WAHA answers 422 to the send.
    await r.waha.status(dead.name, "STOPPED");
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("pending");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 1, session_id: null, last_error: "waha_rejected", tried_session_ids: [dead.id] });
    expect(r.waha.sent).toHaveLength(0);
    // WAHA refused it for sure: nothing went out, so it is neither a send of the number's day nor a message to the contact (the failover is not held for a gap).
    // The ledger keeps the row as the number's FAILED send (the delivery report's failure rate), and every cap and per-contact rule skips it.
    expect(await ledgerOf(dead.id)).toEqual([{ kind: "opener", new_contact: true, has_key: true, outcome: "failed" }]);
    expect(await sql`SELECT 1 FROM waha_sends WHERE session_id = ${dead.id} AND outcome <> 'failed'`).toEqual([]);
    // The failover is queued at once, with its own job id.
    expect(r.enqueued).toEqual([{ channel: "whatsapp", jobId: `${order.deliveries.whatsapp}-1001`, data: { id: order.deliveries.whatsapp } }]);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect(r.waha.sent).toHaveLength(1);
    expect(r.waha.sent[0]?.session).toBe(alive.name);
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "sent", attempts: 2, session_id: alive.id, tried_session_ids: [dead.id, alive.id], last_error: null });
    expect((await sessionOf(dead.id)).fail_streak).toBe(1);
    expect((await sessionOf(alive.id)).fail_streak).toBe(0);
    // The delivery row never moved.
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("tries at most 3 numbers, then gives the opener up QUIETLY (a buyer who never hears from us on WhatsApp has the e-mail): no failed delivery, no alert", async () => {
    const r = rig({ random: () => 0 });
    const sessions = await Promise.all([4, 3, 2, 1].map((weight) => createSession({ weight })));
    for (const s of sessions) await r.waha.status(s.name, "FAILED");
    r.waha.fault(sessions[0]?.name ?? "", "unauthorized");
    const order = await paidOrder(shop);
    const id = order.deliveries.whatsapp;
    expect(await r.delivery.process({ id })).toBe("pending");
    expect((await openerOf(id)).last_error).toBe("waha_unauthorized");
    expect(await r.delivery.process({ id })).toBe("pending");
    expect(await r.delivery.process({ id })).toBe("failed");
    const row = await openerOf(id);
    expect(row).toMatchObject({ status: "failed", attempts: WA_MAX_SESSIONS });
    expect(row.tried_session_ids).toHaveLength(WA_MAX_SESSIONS);
    expect(await r.delivery.process({ id })).toBe("skipped");
    expect(r.waha.sent).toHaveLength(0);
    // The delivery is not failed and nobody is alerted: the e-mail still delivers.
    expect(await deliveryOf(id)).toMatchObject({ status: "pending" });
    expect((await alertsOf("delivery_failed")).some((a) => a.dedupe_key === `delivery_failed:${id}`)).toBe(false);
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("sent");
  });

  it("a one-number pool tries the SAME number again after a backoff (it may be restarting), three attempts in all, then gives up", async () => {
    const r = rig({ random: () => 0 });
    const only = await createSession();
    await r.waha.status(only.name, "STOPPED");
    const id = (await paidOrder(shop)).deliveries.whatsapp;
    expect(await r.delivery.process({ id })).toBe("pending");
    expect(await openerOf(id)).toMatchObject({ status: "pending", attempts: 1, tried_session_ids: [only.id] });
    // Right after the failure the number is left alone (nothing claimed, the opener untouched) ...
    expect(await r.delivery.process({ id })).toBe("deferred");
    expect(await openerOf(id)).toMatchObject({ status: "pending", attempts: 1, tried_session_ids: [only.id] });
    // ... and once the backoff has passed the same number is tried again: once the number is back, the opener goes out through it.
    await sql`UPDATE delivery_openers SET updated_at = now() - interval '2 minutes' WHERE delivery_id = ${id}`;
    await r.waha.status(only.name, "WORKING");
    await sql`UPDATE waha_sessions SET cooldown_until = NULL, fail_streak = 0 WHERE id = ${only.id}`;
    expect(await r.delivery.process({ id })).toBe("opened");
    expect(await openerOf(id)).toMatchObject({ status: "sent", attempts: 2, session_id: only.id });
    expect(r.waha.sent).toHaveLength(1);
  });

  it("a one-number pool that stays down gives up after three attempts on it, never a fourth", async () => {
    const r = rig({ random: () => 0 });
    const only = await createSession();
    await r.waha.status(only.name, "STOPPED");
    const id = (await paidOrder(shop)).deliveries.whatsapp;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await sql`UPDATE delivery_openers SET updated_at = now() - interval '2 minutes' WHERE delivery_id = ${id}`;
      await sql`UPDATE waha_sessions SET cooldown_until = NULL WHERE id = ${only.id}`;
      expect(await r.delivery.process({ id })).toBe(attempt < 3 ? "pending" : "failed");
    }
    expect(await openerOf(id)).toMatchObject({ status: "failed", attempts: 3, tried_session_ids: [only.id, only.id, only.id] });
    expect(await r.delivery.process({ id })).toBe("skipped");
    expect(r.waha.sent).toHaveLength(0);
  });

  it("a timeout is unknown, never resent (not even through a healthy number): the opener may be on its way, and that is all", async () => {
    const r = rig({ random: () => 0 });
    const flaky = await createSession({ weight: 5 });
    const healthy = await createSession();
    r.waha.fault(flaky.name, "timeout_after_send");
    const order = await paidOrder(shop);
    const id = order.deliveries.whatsapp;
    expect(await r.delivery.process({ id })).toBe("unknown");
    expect(await openerOf(id)).toMatchObject({ status: "unknown", attempts: 1, last_error: "waha_maybe_sent", session_id: flaky.id });
    // The number DID send it (the answer was lost): one message exists, and it counts (it may have gone out).
    expect(r.waha.sent).toHaveLength(1);
    expect(await ledgerOf(flaky.id)).toEqual([expect.objectContaining({ kind: "opener", outcome: "unknown" })]);
    // No job, sweep or healthy number sends it again.
    expect(await r.delivery.process({ id })).toBe("skipped");
    await sql`UPDATE delivery_openers SET lease_until = now() - interval '1 second' WHERE delivery_id = ${id}`;
    expect(await expireOpenerLeases(workerSql)).toBe(0);
    expect(await openerOf(id)).toMatchObject({ status: "unknown", attempts: 1 });
    expect(await r.delivery.process({ id })).toBe("skipped");
    expect(r.waha.sent).toHaveLength(1);
    expect((await sendsOf(healthy.id)).length).toBe(0);
    // No alert and no failed delivery: the buyer has the e-mail, and a reply to the opener, if one comes, is handled by the buyer-first path.
    expect(await alertsOf("delivery_unknown")).toEqual([]);
    expect(await deliveryOf(id)).toMatchObject({ status: "pending" });
  });

  it("a connection reset after the request left is uncertain too, and a worker that died holding the claim ends unknown, never resent", async () => {
    const r = rig({ random: () => 0 });
    const reset = await createSession();
    r.waha.fault(reset.name, "reset");
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("unknown");

    // A claim whose process died before it sent: the lease sweeper makes it unknown (the claim is the only thing that happened).
    await retireSessions();
    await createSession();
    const crashed = await paidOrder(shop);
    await sql`INSERT INTO delivery_openers (delivery_id, status, attempts, lease_until) VALUES (${crashed.deliveries.whatsapp}, 'sending', 1, now() - interval '1 second')`;
    expect(await expireOpenerLeases(workerSql)).toBeGreaterThanOrEqual(1);
    expect((await openerOf(crashed.deliveries.whatsapp)).status).toBe("unknown");
    expect(await r.delivery.process({ id: crashed.deliveries.whatsapp })).toBe("skipped");
    expect(r.waha.sent).toHaveLength(0);
    // A lease that is still live is left alone.
    const live = await paidOrder(shop);
    await sql`INSERT INTO delivery_openers (delivery_id, status, attempts, lease_until) VALUES (${live.deliveries.whatsapp}, 'sending', 1, now() + interval '1 minute')`;
    await expireOpenerLeases(workerSql);
    expect((await openerOf(live.deliveries.whatsapp)).status).toBe("sending");
  });

  it("rests a number after three failed sends in a row (cooldown, persisted alert) and uses the others meanwhile", async () => {
    const r = rig({ random: () => 0 });
    const bad = await createSession({ weight: 5 });
    await r.waha.status(bad.name, "STOPPED");
    for (let i = 0; i < 3; i++) {
      const order = await paidOrder(shop);
      expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("pending");
    }
    const health = await sessionOf(bad.id);
    expect(health.fail_streak).toBe(3);
    expect(health.cooldown_until?.getTime() ?? 0).toBeGreaterThan(Date.now() + 5 * 60_000);
    expect((await alertsOf("waha_session_failing")).filter((a) => a.dedupe_key === `waha_session_failing:${bad.id}`)).toEqual([expect.objectContaining({ severity: "critical" })]);
    // WAHA brings it back, but the breaker still rests it; the next opener goes through another number.
    await r.waha.status(bad.name, "WORKING");
    const other = await createSession();
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect((await openerOf(order.deliveries.whatsapp)).session_id).toBe(other.id);
  });

  it("a failure BEFORE anything was sent (no usable template) is nobody's fault but ours: the attempt is given back, the number does not leave the pool or lose health", async () => {
    const r = rig({ random: () => 0 });
    const first = await createSession();
    await createSession();
    await sql`UPDATE message_templates SET key = replace(key, 'delivery_opener_', 'off_opener_') WHERE key LIKE 'delivery_opener_%'`;
    try {
      const id = (await paidOrder(shop)).deliveries.whatsapp;
      // Ten tries (every one after its backoff): a failover slot would be gone after three, a health streak would rest the number after the first few.
      for (let i = 0; i < 10; i++) {
        await sql`UPDATE delivery_openers SET next_attempt_at = now() - interval '1 second' WHERE delivery_id = ${id}`;
        expect(await r.delivery.process({ id })).toBe("pending");
        // The attempt number goes on counting (never reused); what is given back is the number, not the count.
        expect(await openerOf(id)).toMatchObject({ status: "pending", attempts: i + 1, last_error: "template_invalid", session_id: null, tried_session_ids: [] });
      }
      expect(r.waha.sent).toHaveLength(0);
      expect(await sql`SELECT fail_streak, cooldown_until FROM waha_sessions WHERE id = ${first.id}`).toEqual([{ fail_streak: 0, cooldown_until: null }]);
      expect(await ledgerOf(first.id)).toEqual([]);
      // Its backoff is a real wait (the opener is not hot-looped), and a held-back delivery is an alert, once.
      expect((await openerOf(id)).next_attempt_at?.getTime() ?? 0).toBeGreaterThan(Date.now() + 20_000);
      expect(await sql`SELECT count(*)::int AS n FROM alerts WHERE dedupe_key = 'delivery_not_attempted:template_invalid' AND resolved_at IS NULL`).toEqual([{ n: 1 }]);
      // The template is back: the same opener goes out, on its first attempt, through a number that was never marked.
      await sql`UPDATE message_templates SET key = replace(key, 'off_opener_', 'delivery_opener_') WHERE key LIKE 'off_opener_%'`;
      await sql`UPDATE delivery_openers SET next_attempt_at = now() - interval '1 second' WHERE delivery_id = ${id}`;
      expect(await r.delivery.process({ id })).toBe("opened");
      expect(await openerOf(id)).toMatchObject({ status: "sent", attempts: 11, last_error: null });
    } finally {
      await sql`UPDATE message_templates SET key = replace(key, 'off_opener_', 'delivery_opener_') WHERE key LIKE 'off_opener_%'`;
    }
    expect(r.waha.sent).toHaveLength(1);
  });

  it("an opener template that renders to NOTHING is refused before the human-like sequence (WEBJS would send an empty message): no WAHA call at all, so no typing is shown; the attempt and the number are given back", async () => {
    const r = rig({ random: () => 0 });
    const first = await createSession();
    const saved = await sql<{ id: string; body: string }[]>`SELECT id, body FROM message_templates WHERE key LIKE 'delivery\_opener\_%' AND channel = 'whatsapp'`;
    await sql`UPDATE message_templates SET body = '   ' WHERE key LIKE 'delivery\_opener\_%' AND channel = 'whatsapp'`;
    try {
      const id = (await paidOrder(shop)).deliveries.whatsapp;
      await sql`UPDATE delivery_openers SET next_attempt_at = now() - interval '1 second' WHERE delivery_id = ${id}`;
      expect(await r.delivery.process({ id })).toBe("pending");
      expect(await openerOf(id)).toMatchObject({ status: "pending", attempts: 1, last_error: "template_invalid", session_id: null, tried_session_ids: [] });
      // Not one call: no first-contact lookup, no typing, no presence, no send.
      expect(r.waha.calls).toEqual([]);
      expect(r.waha.sent).toHaveLength(0);
      expect(await sql`SELECT fail_streak, cooldown_until FROM waha_sessions WHERE id = ${first.id}`).toEqual([{ fail_streak: 0, cooldown_until: null }]);
      expect(await ledgerOf(first.id)).toEqual([]);
    } finally {
      for (const row of saved) await sql`UPDATE message_templates SET body = ${row.body} WHERE id = ${row.id}`;
    }
  });

  it("a claim that stalled past what its lease can still cover is not sent", async () => {
    const r = rig({ random: () => 0 });
    await createSession();
    const order = await paidOrder(shop);
    // The clock the processor reads jumps an hour between the claim and the send (a GC pause, a suspended VM).
    let reads = 0;
    const stalled = createDelivery({
      sql: workerSql,
      log: silentLog,
      config: r.config,
      waha: r.waha.access,
      mail: r.mail,
      files: testFiles(r.config),
      magicLinks: r.magic,
      enqueue: () => Promise.resolve(),
      random: () => 0,
      sleep: () => Promise.resolve(),
      clock: () => (reads++ === 0 ? 0 : 3_600_000),
    });
    expect(await stalled.process({ id: order.deliveries.whatsapp })).toBe("pending");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 1, last_error: "claim_too_old" });
    expect(r.waha.sent).toHaveLength(0);
  });

  it("racing jobs of one WhatsApp delivery send one opener (the conditional claim, in the database)", async () => {
    const r = rig();
    await createSession();
    await createSession();
    const order = await paidOrder(shop);
    const results = await Promise.all(Array.from({ length: 8 }, () => r.delivery.process({ id: order.deliveries.whatsapp })));
    expect(results.filter((x) => x === "opened")).toHaveLength(1);
    expect(r.waha.sent).toHaveLength(1);
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("an order whose phone WhatsApp cannot take fails without a send, and a stale outcome from a lost lease changes nothing", async () => {
    const r = rig();
    await createSession();
    const foreign = await paidOrder(shop, { phone: "+14155550100" });
    expect(await r.delivery.process({ id: foreign.deliveries.whatsapp })).toBe("skipped");
    expect(await deliveryOf(foreign.deliveries.whatsapp)).toMatchObject({ status: "failed", last_error: "invalid_whatsapp_number" });
    expect(r.waha.sent).toHaveLength(0);
    // A job id of nothing, and a row that does not exist, are no-ops; malformed job data is refused.
    expect(await r.delivery.process({ id: randomUUID() })).toBe("skipped");
    await expect(r.delivery.process({ id: "nope" })).rejects.toThrow(/job data must be/);
  });

  it("a phone that is NOT on WhatsApp ends the opener quietly and for good: no failover, no penalty for any number, no alert; the e-mail still delivers", async () => {
    const r = rig({ random: () => 0 });
    const a = await createSession({ weight: 5 });
    const b = await createSession();
    const order = await paidOrder(shop);
    await r.waha.contact(order.phone, { numberExists: false });
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("no_whatsapp");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "failed", last_error: "no_whatsapp", attempts: 1 });
    expect(r.waha.sent).toHaveLength(0);
    expect(r.enqueued).toEqual([]);
    expect((await sessionOf(a.id)).fail_streak).toBe(0);
    expect((await sessionOf(b.id)).fail_streak).toBe(0);
    expect(await ledgerOf(a.id)).toEqual([]);
    // No alert of any kind about this delivery or these numbers.
    expect(await sql`SELECT kind FROM alerts WHERE dedupe_key LIKE ${`%${order.deliveries.whatsapp}%`} OR dedupe_key LIKE ${`%${a.id}%`} OR dedupe_key LIKE ${`%${b.id}%`}`).toEqual([]);
    expect(await sql`SELECT number_exists, chat_id FROM wa_contacts WHERE phone = ${order.phone}`).toEqual([{ number_exists: false, chat_id: null }]);
    // Final: the next job and the sweeper leave it alone; the delivery row is untouched and the e-mail goes out.
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("skipped");
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("sent");
  });

  it("asks WAHA once per phone: the answer is cached (a month, or a day when the phone is not on WhatsApp) and refreshed when it is old", async () => {
    const r = rig({ random: () => 0 });
    await createSession({ dailyCap: 100 });
    await sql`UPDATE waha_sessions SET new_contact_cap = 100`;
    const phone = "+6281233334444";
    const first_ = await paidOrder(shop, { phone });
    await r.waha.clearCallLog();
    expect(await r.delivery.process({ id: first_.deliveries.whatsapp })).toBe("opened");
    const lookups = async () => (await r.waha.callLog()).filter((c) => c.path === "/api/contacts/check-exists").length;
    expect(await lookups()).toBe(1);
    // A second delivery to the same phone (a repeat buyer) does not ask again ...
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    await sql`DELETE FROM waha_sends`;
    const second = await paidOrder(shop, { phone });
    expect(await r.delivery.process({ id: second.deliveries.whatsapp })).toBe("opened");
    expect(await lookups()).toBe(1);
    // ... until the cached answer is a month old, and for a phone that was not on WhatsApp a day.
    await sql`UPDATE wa_contacts SET checked_at = now() - interval '31 days' WHERE phone = ${phone}`;
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    await sql`DELETE FROM waha_sends`;
    const third = await paidOrder(shop, { phone });
    expect(await r.delivery.process({ id: third.deliveries.whatsapp })).toBe("opened");
    expect(await lookups()).toBe(2);
    const missing = "+6281255556666";
    await r.waha.contact(missing, { numberExists: false });
    const gone = await paidOrder(shop, { phone: missing });
    expect(await r.delivery.process({ id: gone.deliveries.whatsapp })).toBe("no_whatsapp");
    expect(await lookups()).toBe(3);
    await sql`UPDATE wa_contacts SET checked_at = now() - interval '23 hours' WHERE phone = ${missing}`;
    const again = await paidOrder(shop, { phone: missing });
    expect(await r.delivery.process({ id: again.deliveries.whatsapp })).toBe("no_whatsapp");
    expect(await lookups()).toBe(3);
    await r.waha.contact(missing, { numberExists: true });
    await sql`UPDATE wa_contacts SET checked_at = now() - interval '25 hours' WHERE phone = ${missing}`;
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    const installed = await paidOrder(shop, { phone: missing });
    expect(await r.delivery.process({ id: installed.deliveries.whatsapp })).toBe("opened");
    expect(await lookups()).toBe(4);
  });

  it("a failing check-exists (5xx, timeout) sends nothing and is never an uncertain send: the opener waits for a backoff and asks again", async () => {
    const r = rig({ random: () => 0 });
    const session = await createSession();
    const order = await paidOrder(shop);
    await r.waha.presenceFault("http500");
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("pending");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 1, session_id: null, tried_session_ids: [], last_error: "check_exists_failed" });
    expect((await openerOf(order.deliveries.whatsapp)).next_attempt_at?.getTime() ?? 0).toBeGreaterThan(Date.now() + 20_000);
    expect(r.waha.sent).toHaveLength(0);
    expect((await sessionOf(session.id)).fail_streak).toBe(0);
    expect(await ledgerOf(session.id)).toEqual([]);
    expect(await sql`SELECT 1 FROM wa_contacts WHERE phone = ${order.phone}`).toHaveLength(0);
    // WAHA answers again: the same opener goes out.
    await r.waha.presenceFault("ok");
    await sql`UPDATE delivery_openers SET next_attempt_at = now() - interval '1 second' WHERE delivery_id = ${order.deliveries.whatsapp}`;
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect(r.waha.sent).toHaveLength(1);
  });
});

describe("WhatsApp's limits: 463 (reachout timelock) and 475 (message capping) hold a number back from NEW contacts (ban signals)", () => {
  it("a 463 on the first number is a cooldown, not a failure: nothing is sent, the number is held back and alerted (with the counts), and the opener goes to another number", async () => {
    const r = rig({ random: () => 0 });
    const limited = await createSession({ weight: 5 });
    const free = await createSession();
    r.waha.fault(limited.name, "ban463");
    const order = await paidOrder(shop);
    const id = order.deliveries.whatsapp;
    expect(await r.delivery.process({ id })).toBe("pending");
    // Given back as if it had not been claimed: no attempt, no tried number, and the ledger row is taken back (nothing went out).
    expect(await openerOf(id)).toMatchObject({ status: "pending", attempts: 1, session_id: null, tried_session_ids: [], last_error: "reachout_timelock" });
    expect(r.waha.sent).toHaveLength(0);
    expect(await ledgerOf(limited.id)).toEqual([]);
    // The number: WORKING still, no failure streak, no breaker cooldown, but held back from new contacts for an hour (or the end WAHA gives).
    const state = await sql<{ fail_streak: number; cooldown_until: Date | null; reachout_until: Date | null; ban_463_count: number; ban_475_count: number; status: string }[]>`
      SELECT fail_streak, cooldown_until, reachout_until, ban_463_count, ban_475_count, status FROM waha_sessions WHERE id = ${limited.id}`;
    expect(state[0]).toMatchObject({ fail_streak: 0, cooldown_until: null, ban_463_count: 1, ban_475_count: 0, status: "WORKING" });
    expect(Math.abs((state[0]?.reachout_until?.getTime() ?? 0) - (Date.now() + 3_600_000))).toBeLessThan(60_000);
    // The persisted critical alert says which number and how many times; it never restarts or re-pairs anything, and it is not a "fault of ours" alert.
    const alerts = await sql<{ severity: string; payload: Record<string, unknown> }[]>`SELECT severity, payload FROM alerts WHERE dedupe_key = ${`waha_reachout_blocked:${limited.id}`} AND resolved_at IS NULL`;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("critical");
    expect(alerts[0]?.payload).toMatchObject({ session_id: limited.id, signal: "reachout_timelock", refused_463: 1, refused_475: 0 });
    expect((await alertsOf("delivery_not_attempted")).some((a) => a.dedupe_key.endsWith("reachout_timelock"))).toBe(false);
    // After its short backoff the opener goes out through the OTHER number; the held-back one is not asked again for a new contact.
    await sql`UPDATE delivery_openers SET next_attempt_at = now() - interval '1 second' WHERE delivery_id = ${id}`;
    expect(await r.delivery.process({ id })).toBe("opened");
    expect(r.waha.sent).toEqual([expect.objectContaining({ session: free.name })]);
    expect((await openerOf(id)).session_id).toBe(free.id);
  });

  it("a 475 is the same (counted apart); with EVERY number held back the opener WAITS pending (no failure, an alert), and the e-mail still delivers", async () => {
    const r = rig({ random: () => 0 });
    const only = await createSession();
    r.waha.fault(only.name, "ban475");
    const order = await paidOrder(shop);
    const id = order.deliveries.whatsapp;
    expect(await r.delivery.process({ id })).toBe("pending");
    expect(await openerOf(id)).toMatchObject({ status: "pending", attempts: 1, last_error: "message_capping" });
    expect((await sql<{ ban_475_count: number; ban_463_count: number }[]>`SELECT ban_475_count, ban_463_count FROM waha_sessions WHERE id = ${only.id}`)[0]).toEqual({ ban_475_count: 1, ban_463_count: 0 });
    // Every number is excluded from new contacts: the opener is deferred, with its alert, and nothing is sent or failed.
    await sql`UPDATE delivery_openers SET next_attempt_at = now() - interval '1 second' WHERE delivery_id = ${id}`;
    expect(await r.delivery.process({ id })).toBe("deferred");
    expect(await openerOf(id)).toMatchObject({ status: "pending", attempts: 1 });
    expect(await alertsOf("wa_reachout_blocked")).toEqual([expect.objectContaining({ severity: "critical", dedupe_key: "wa_reachout_blocked" })]);
    expect(r.waha.sent).toHaveLength(0);
    expect(await deliveryOf(id)).toMatchObject({ status: "pending" });
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("sent");
    // When the restriction ends (WAHA's end passed) the opener goes out through the same number.
    r.waha.fault(only.name, undefined);
    await sql`UPDATE waha_sessions SET reachout_until = now() - interval '1 second' WHERE id = ${only.id}`;
    expect(await r.delivery.process({ id })).toBe("opened");
  });

  it("a held-back number is not asked to write to a NEW contact, but still answers a chat it already has (a login code to a phone it wrote to)", async () => {
    const r = rig({ random: () => 0 });
    const held = await createSession();
    const order = await paidOrder(shop);
    await sql`UPDATE waha_sessions SET reachout_until = now() + interval '1 hour' WHERE id = ${held.id}`;
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("deferred");
    // This number already has a chat with that phone (it wrote to it last week): not a new contact for it, the ban signal does not apply.
    await sql`INSERT INTO waha_sends (session_id, kind, contact_key, created_at, send_at) VALUES (${held.id}, 'opener', encode(sha256(convert_to('ebooktrivia/contact/v1|' || ${order.phone}, 'UTF8')), 'hex'), now() - interval '7 days', now() - interval '7 days')`;
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect(r.waha.sent).toHaveLength(1);
    expect(await ledgerOf(held.id)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "opener", new_contact: false })]));
  });

  it("a number's daily budget of NEW contacts is separate from its replies: openers stop at the budget (smaller after a warning), replies never count against it", async () => {
    const r = rig({ random: () => 0 });
    const s = await createSession({ dailyCap: 100 });
    await sql`UPDATE waha_sessions SET new_contact_cap = 2 WHERE id = ${s.id}`;
    for (let i = 0; i < 2; i++) {
      await sql`UPDATE waha_sessions SET next_send_at = NULL WHERE id = ${s.id}`;
      expect(await r.delivery.process({ id: (await paidOrder(shop)).deliveries.whatsapp })).toBe("opened");
    }
    const third = await paidOrder(shop);
    expect(await r.delivery.process({ id: third.deliveries.whatsapp })).toBe("deferred");
    expect(await openerOf(third.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
    expect(await alertsOf("wa_new_contact_budget_spent")).toEqual([expect.objectContaining({ severity: "warning" })]);
    // Replies are not new contacts: the budget is full but the daily cap has room (100), so replies are not held by it (see inbound.int.test).
    expect(await ledgerOf(s.id)).toEqual([
      { kind: "opener", new_contact: true, has_key: true, outcome: "sent" },
      { kind: "opener", new_contact: true, has_key: true, outcome: "sent" },
    ]);
    // A FIRST_WARNING halves the budget: 2 sends are already above half of 2, so even a raised cap of 3 allows none.
    await sql`UPDATE waha_sessions SET new_contact_cap = 3, warning_level = 'first' WHERE id = ${s.id}`;
    expect(await r.delivery.process({ id: third.deliveries.whatsapp })).toBe("deferred");
    await sql`UPDATE waha_sessions SET new_contact_cap = 6 WHERE id = ${s.id}`;
    await sql`UPDATE waha_sessions SET next_send_at = NULL WHERE id = ${s.id}`;
    expect(await r.delivery.process({ id: third.deliveries.whatsapp })).toBe("opened");
  });
});
