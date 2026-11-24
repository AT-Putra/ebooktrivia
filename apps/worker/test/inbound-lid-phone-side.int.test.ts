// Inbound WhatsApp from an @lid sender, matched from the PHONE side (src/delivery/inbound.ts phoneSideMatch; contacts.ts askContact, lidCacheOf). WAHA's lid -> phone store is
// local to a session and often has no number (measured on the Owner's WAHA 2026.10.1), while check-exists is a WhatsApp server query that answers for any phone. So when
// the link we hold is missing or older than a day and WAHA has no number either, the consumer asks check-exists, on the receiving session, about a few of OUR buyers'
// phones (the PAID orders whose codes the message carries, a stale link's phone, the openers this number sent that still await the reply) and the phone whose lid equals the
// sender's is the sender. Real PostgreSQL and Valkey (the limits), the in-process WAHA mock of infra/waha-mock.
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { WahaError } from "@ebooktrivia/adapters";
import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { lidCacheOf } from "../src/delivery/contacts.ts";
import { createDelivery, type Delivery } from "../src/delivery/deliver.ts";
import {
  createInboundConsumer,
  INBOUND_EXTRA_LEASE_MS,
  INBOUND_TOPIC,
  LID_CHECK_MAX,
  LID_ROUND_TTL_SECONDS,
  LID_SESSION_CHECK_CEILING,
  type LidGate,
  lidGateFromValkey,
  PHONE_SIDE_BUDGET_MS,
  PHONE_SIDE_MAX_MS,
} from "../src/delivery/inbound.ts";
import { pdfOnlyCaption, replyText } from "../src/delivery/messages.ts";
import type { WahaAccess } from "../src/delivery/ports.ts";
import { inertFailpoint } from "../src/failpoint.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { redisOptions } from "../src/queues.ts";
import {
  createDeliveryShop,
  createSession,
  createWahaFake,
  type DeliveryShop,
  deliveryConfig,
  deliveryOf,
  fakeMagicLinks,
  inboundOf,
  type PaidOrder,
  paidOrder,
  retireDeliveries,
  retireSessions,
  storeInbound,
  unpaidOrder,
} from "./support/delivery.ts";
import { first, sql } from "./support/db.ts";
import { testFiles } from "./support/files.ts";
import { silentLog, uniquePhone, workerPool } from "./support/midtrans.ts";
import { testValkey, uniquePrefix } from "./support/valkey.ts";

const workerSql = workerPool(8);
const valkey = new Redis({ ...redisOptions(testValkey()), maxRetriesPerRequest: 1 });
const prefix = uniquePrefix();
/** The secret the gate's key is derived from (production: the worker's file-URL key). */
const SECRET = randomBytes(32);
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
  valkey.disconnect();
});

/** A lid of its own per use: the hourly budget is per lid, and Valkey keeps it for an hour. */
const newLid = (): string => `${String(randomInt(10_000_000_000_000, 99_999_999_999_999))}@lid`;
const askingFor = (order: Pick<PaidOrder, "code">): string => `Halo, ini kode pesanan saya ${order.code} untuk Ebook.`;
const proactiveLater = (): Date => new Date(Date.now() + 180_000);
const digits = (phone: string): string => phone.slice(1);
const gateOf = (secret: Uint8Array = SECRET): LidGate => lidGateFromValkey(valkey, prefix, secret);

/**
 * A Valkey that fails (as a Valkey that is down would) for the commands named, until `state.down` is set false; the others go to the real one. The commands of the
 * gate are overloaded, so the stand-in is typed loosely.
 */
function valkeyDown(commands: readonly ("set" | "incr")[]): { readonly state: { down: boolean }; readonly gate: LidGate } {
  const state = { down: true };
  const through = (name: "get" | "set" | "incr" | "expire") => {
    const real = (valkey[name] as unknown as (...args: unknown[]) => Promise<unknown>).bind(valkey);
    return (...args: unknown[]) => (state.down && (commands as readonly string[]).includes(name) ? Promise.reject(new Error("valkey down")) : real(...args));
  };
  const client = { get: through("get"), set: through("set"), incr: through("incr"), expire: through("expire") } as unknown as Pick<Redis, "get" | "set" | "incr" | "expire">;
  return { state, gate: lidGateFromValkey(client, prefix, SECRET) };
}

interface RigOptions {
  /** The limits of the phone side; default: the real ones in Valkey. `null`: none wired. */
  readonly gate?: LidGate | null;
  /** Called with the phone (E.164) every time the consumer asks WhatsApp about one, before the answer. */
  readonly onCheck?: (phone: string) => void;
  readonly clock?: () => number;
}

/** The consumer under test, over a WAHA mock the test can read. `faults`: phones (E.164) whose check-exists fails with this error. `attempted`: every phone the consumer asked about. */
function rig(options: RigOptions = {}) {
  const waha = createWahaFake();
  const magic = fakeMagicLinks();
  const config = deliveryConfig(shop);
  const faults = new Map<string, WahaError>();
  const attempted: string[] = [];
  const consumerAccess: WahaAccess = {
    withSession: (id, use, opts) =>
      waha.access.withSession(
        id,
        ({ sessionName, client }) =>
          use({
            sessionName,
            client: {
              ...client,
              checkExists: (s, p) => {
                attempted.push(p);
                options.onCheck?.(p);
                const fault = faults.get(p);
                return fault === undefined ? client.checkExists(s, p) : Promise.reject(fault);
              },
            },
          }),
        opts,
      ),
  };
  const delivery: Delivery = createDelivery({
    sql: workerSql,
    log: silentLog,
    config,
    waha: waha.access,
    mail: { send: () => Promise.resolve() },
    files: testFiles(config),
    magicLinks: magic,
    enqueue: () => Promise.resolve(),
    random: () => 0.5,
    sleep: () => Promise.resolve(),
  });
  const gate = options.gate === undefined ? gateOf() : options.gate;
  const consumer = createInboundConsumer({
    sql: workerSql,
    log: silentLog,
    config,
    waha: consumerAccess,
    delivery,
    files: testFiles(config),
    random: () => 0.5,
    sleep: () => Promise.resolve(),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(gate === null ? {} : { lidGate: gate }),
  });
  const process = createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
  async function hear(input: { session: string; chatId: string; body: string }) {
    const messageId = await waha.inbound(input);
    const stored = await storeInbound({ sessionName: input.session, messageId, fromJid: input.chatId });
    return { ...stored, messageId, run: () => process({ id: stored.outboxId }) };
  }
  /** The phones (digits) the consumer asked WhatsApp about so far, in order (the openers' own lookups are not the consumer's). */
  const asked = (): string[] => attempted.map(digits);
  const files = () => waha.sent.filter((s) => s.kind === "file");
  const texts = () => waha.sent.filter((s) => s.kind === "text");
  /** Makes the job's retry due now (the failed attempt backed it off). */
  const retryNow = async (outboxId: string): Promise<void> => {
    await sql`UPDATE outbox SET available_at = now() WHERE id = ${outboxId}`;
  };
  return { waha, magic, delivery, consumer, hear, asked, attempted, faults, files, texts, config, retryNow };
}

/** The opener of the order goes out (to `lid` when the phone's contact lives there), and is then made `days` old. */
async function openerSent(r: ReturnType<typeof rig>, order: PaidOrder, days: number, lid?: string): Promise<void> {
  if (lid !== undefined) await r.waha.contact(order.phone, { chatId: lid });
  await sql`UPDATE waha_sessions SET next_send_at = NULL`;
  expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
  await sql`UPDATE delivery_openers SET sent_at = now() - ${days} * interval '1 day' WHERE delivery_id = ${order.deliveries.whatsapp}`;
}

/** The opener's own answer is cached by the delivery: forget it, so what the consumer finds is what IT asked. */
const forgetContacts = async (): Promise<void> => {
  await sql`DELETE FROM wa_contacts`;
};

describe("an @lid sender matched from the phone side", () => {
  it("a code-less reply, the opener two days old and the lid link stale: the opener's phone is asked of WhatsApp, its lid matches, and the buyer-first path runs with the link refreshed", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop);
    const lid = newLid();
    await openerSent(r, order, 2, lid);
    // What check-exists taught us at the opener is two days old (the answer and the link): not trusted on its own.
    await sql`UPDATE wa_contacts SET checked_at = now() - interval '2 days', lid_checked_at = now() - interval '2 days' WHERE phone = ${order.phone}`;
    await r.waha.lid(lid, null);
    await r.waha.clearCallLog();
    const heard = await r.hear({ session: session.name, chatId: lid, body: "iya kak, kirim ya" });
    expect(await heard.run()).toBe("processed");
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    // WAHA's own lid lookup was asked first (and had no number), then the phone side: ONE check-exists, for the opener's phone, on the receiving session.
    expect(r.waha.calls.filter((c) => c.path.includes("/lids/"))).toHaveLength(1);
    expect(r.asked()).toEqual([digits(order.phone)]);
    expect(await r.waha.callLog().then((log) => log.filter((c) => c.path === "/api/contacts/check-exists").map((c) => c.body["session"]))).toEqual([session.name]);
    // The buyer-first path: the PDF and the login link, to the @lid chat.
    expect(r.files()).toEqual([expect.objectContaining({ session: session.name, chatId: lid })]);
    expect(r.files()[0]?.text).toContain("masuk#c=whatsapp");
    expect(r.magic.issued).toHaveLength(1);
    // The link is confirmed again, and is the only one this lid has.
    expect(await sql`SELECT phone, lid, lid_checked_at > now() - interval '1 minute' AS fresh FROM wa_contacts WHERE lid = ${lid}`).toEqual([{ phone: order.phone, lid, fresh: true }]);
  });

  it("the same with no link at all in wa_contacts: the opener's phone alone is the candidate, and a later message from that lid needs no WhatsApp call", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop);
    const lid = newLid();
    await openerSent(r, order, 2, lid);
    await forgetContacts();
    const heard = await r.hear({ session: session.name, chatId: lid, body: "ok" });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.files()).toEqual([expect.objectContaining({ chatId: lid })]);
    // The answer was cached with the lid: the next message of this lid is matched by the fresh link, before WAHA is asked anything.
    const callsBefore = r.waha.calls.length;
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    await sql`UPDATE waha_inbound SET replied_at = NULL`;
    const again = await r.hear({ session: session.name, chatId: lid, body: "makasih" });
    await again.run();
    expect(await inboundOf(again.inboundId)).toMatchObject({ outcome: "no_code" });
    expect(r.asked()).toEqual([digits(order.phone)]);
    expect(r.waha.calls.slice(callsBefore).filter((c) => c.path.includes("/lids/"))).toEqual([]);
  });

  it("a message with the order code from an unknown @lid: the order's buyer phone matches, so it is the buyer (the login link is allowed), not a PDF-only reply", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const lid = newLid();
    await r.waha.contact(order.phone, { chatId: lid });
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: askingFor(order) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.asked()).toEqual([digits(order.phone)]);
    expect(r.files()).toEqual([expect.objectContaining({ chatId: lid })]);
    expect(r.files()[0]?.text).toContain("masuk#c=whatsapp");
    expect(r.files()[0]?.text).not.toBe(pdfOnlyCaption());
    expect(r.magic.issued).toEqual([expect.objectContaining({ playerId: order.playerId, channel: "whatsapp" })]);
    expect(await sql`SELECT phone FROM wa_contacts WHERE lid = ${lid}`).toEqual([{ phone: order.phone }]);
  });

  it("Owner decision: a sender who knows the code but whose lid is NOT the one WhatsApp gives the order's phone is a stranger: the neutral text, no PDF, nothing issued, the buyer's delivery untouched, and the stranger is never stored", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const buyerLid = newLid();
    const strangerLid = newLid();
    await r.waha.contact(order.phone, { chatId: buyerLid });
    await r.waha.lid(strangerLid, null);
    const heard = await r.hear({ session: session.name, chatId: strangerLid, body: askingFor(order) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "text_mismatch", replied: true });
    expect(r.files()).toEqual([]);
    expect(r.texts()).toEqual([expect.objectContaining({ chatId: strangerLid, text: replyText("mismatch") })]);
    expect(r.magic.issued).toEqual([]);
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0, session_id: null });
    // Only OUR buyer's row exists, with the buyer's own lid; nothing of the stranger.
    expect(await sql`SELECT phone, lid FROM wa_contacts`).toEqual([{ phone: order.phone, lid: buyerLid }]);
    expect(await sql`SELECT 1 FROM wa_contacts WHERE lid = ${strangerLid}`).toEqual([]);
    // Another stranger, a moment later: the order's phone has a lid confirmed within the day, so WhatsApp is not asked again, and it is the same answer.
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    const another = newLid();
    await r.waha.lid(another, null);
    const second = await r.hear({ session: session.name, chatId: another, body: askingFor(order) });
    await second.run();
    expect(await inboundOf(second.inboundId)).toMatchObject({ outcome: "text_mismatch" });
    expect(r.asked()).toEqual([digits(order.phone)]);
    expect(r.files()).toEqual([]);
  });

  it("the PDF-only reply stays for an order whose phone has NO known lid: a plain chat, a refusal and a number not on WhatsApp are not a lid that is someone else's", async () => {
    const r = rig();
    const session = await createSession();
    const plain = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const refused = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const absent = await paidOrder(shop, { waNotBefore: proactiveLater() });
    r.faults.set(refused.phone, new WahaError("rejected", "WAHA rejected the request (422)"));
    await r.waha.contact(absent.phone, { numberExists: false });
    for (const order of [plain, refused, absent]) {
      await sql`UPDATE waha_sessions SET next_send_at = NULL`;
      const lid = newLid();
      await r.waha.lid(lid, null);
      const heard = await r.hear({ session: session.name, chatId: lid, body: askingFor(order) });
      await heard.run();
      expect(await inboundOf(heard.inboundId), order.phone).toMatchObject({ outcome: "pdf_only_sent" });
      expect(r.files().at(-1)).toMatchObject({ chatId: lid, text: pdfOnlyCaption() });
    }
    expect(r.magic.issued).toEqual([]);
    expect(r.texts()).toEqual([]);
    expect(r.asked()).toEqual([digits(plain.phone), digits(refused.phone), digits(absent.phone)]);
  });

  it("a sender who matches ANOTHER buyer's opener while quoting someone else's code is a mismatch: the neutral text, and nobody's delivery is touched", async () => {
    const r = rig();
    const session = await createSession();
    const quoted = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const own = await paidOrder(shop);
    const lid = newLid();
    await openerSent(r, own, 1, lid);
    await forgetContacts();
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: askingFor(quoted) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "text_mismatch" });
    expect(r.files()).toEqual([]);
    expect(r.magic.issued).toEqual([]);
    expect(await sql`SELECT status::text AS status FROM deliveries WHERE id = ${quoted.deliveries.whatsapp}`).toEqual([{ status: "pending" }]);
  });

  it("with more than 5 candidates exactly 5 check-exists calls are made, the newest openers first", async () => {
    const r = rig();
    const session = await createSession();
    const orders: PaidOrder[] = [];
    for (let i = 0; i < LID_CHECK_MAX + 2; i++) {
      const order = await paidOrder(shop);
      await openerSent(r, order, 0);
      // Oldest first: order i was sent (LID_CHECK_MAX + 2 - i) hours ago.
      await sql`UPDATE delivery_openers SET sent_at = now() - ${LID_CHECK_MAX + 2 - i} * interval '1 hour' WHERE delivery_id = ${order.deliveries.whatsapp}`;
      orders.push(order);
    }
    await forgetContacts();
    const lid = newLid();
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: "ok" });
    await heard.run();
    // None of them is the sender: unresolved, no reply for a message without a code.
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "no_code" });
    expect(r.asked()).toEqual([...orders].reverse().slice(0, LID_CHECK_MAX).map((o) => digits(o.phone)));
  });

  it("a second message from the same lid within the hour makes no second phone-side round, while another lid still gets its own", async () => {
    const r = rig();
    const session = await createSession();
    const a = await paidOrder(shop);
    await openerSent(r, a, 1);
    await forgetContacts();
    // WhatsApp refuses the question: nothing is cached about the phone, so only the budget keeps a second message from asking again.
    r.faults.set(a.phone, new WahaError("rejected", "WAHA rejected the request (422)"));
    const lid = newLid();
    await r.waha.lid(lid, null);
    const first_ = await r.hear({ session: session.name, chatId: lid, body: "ok" });
    await first_.run();
    expect(r.asked()).toEqual([digits(a.phone)]);
    expect(await sql`SELECT 1 FROM wa_contacts`).toEqual([]);
    const again = await r.hear({ session: session.name, chatId: lid, body: "halo?" });
    await again.run();
    expect(await inboundOf(again.inboundId)).toMatchObject({ outcome: "no_code" });
    expect(r.asked()).toEqual([digits(a.phone)]);
    // Another lid has a round of its own.
    const other = newLid();
    await r.waha.lid(other, null);
    const third = await r.hear({ session: session.name, chatId: other, body: "halo" });
    await third.run();
    expect(r.asked()).toEqual([digits(a.phone), digits(a.phone)]);
  });

  it("a check-exists that fails (5xx) retries the job: nothing is sent, no cache row is written, and the same message takes its round again on the retry", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop);
    const lid = newLid();
    await openerSent(r, order, 1, lid);
    await forgetContacts();
    await r.waha.lid(lid, null);
    const sentBefore = r.waha.sent.length;
    await r.waha.presenceFault("http500");
    const heard = await r.hear({ session: session.name, chatId: lid, body: "ok kak" });
    await expect(heard.run()).rejects.toThrow("WAHA error 500");
    expect(await inboundOf(heard.inboundId)).toMatchObject({ processed: false, outcome: null, replied: false });
    expect(r.waha.sent).toHaveLength(sentBefore);
    expect(await sql`SELECT 1 FROM wa_contacts`).toEqual([]);
    expect(await sql`SELECT status::text AS status FROM deliveries WHERE id = ${order.deliveries.whatsapp}`).toEqual([{ status: "pending" }]);
    // WAHA is back: the job's retry (the same inbound row) is allowed to take the round the failed attempt held, and the buyer is served.
    await r.waha.presenceFault("ok");
    await r.retryNow(heard.outboxId);
    expect(await heard.run()).toBe("processed");
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.files()).toEqual([expect.objectContaining({ chatId: lid })]);
  });

  it("M3: one candidate that fails does not stop the others: the newer opener's question fails, the older one is the sender, and it is served", async () => {
    const r = rig();
    const session = await createSession();
    const older = await paidOrder(shop);
    const newer = await paidOrder(shop);
    const lid = newLid();
    await openerSent(r, older, 2, lid);
    await openerSent(r, newer, 1);
    await forgetContacts();
    r.faults.set(newer.phone, new WahaError("failed", "WAHA error 500"));
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: "iya kak" });
    expect(await heard.run()).toBe("processed");
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.asked()).toEqual([digits(newer.phone), digits(older.phone)]);
    expect(r.files()).toEqual([expect.objectContaining({ chatId: lid })]);
    expect((await deliveryOf(older.deliveries.whatsapp)).status).toBe("sent");
    expect((await deliveryOf(newer.deliveries.whatsapp)).status).toBe("pending");
  });

  it("M3: a candidate fails AFTER an earlier one was asked and nothing matched: the job is retried (never answered as unresolved), the earlier answer stays cached, and the retry finishes the round", async () => {
    const r = rig();
    const session = await createSession();
    const older = await paidOrder(shop);
    const newer = await paidOrder(shop);
    const lid = newLid();
    await openerSent(r, older, 2, lid);
    await openerSent(r, newer, 1);
    await forgetContacts();
    r.faults.set(older.phone, new WahaError("failed", "WAHA error 500"));
    await r.waha.lid(lid, null);
    const sentBefore = r.waha.sent.length;
    const heard = await r.hear({ session: session.name, chatId: lid, body: "iya kak" });
    await expect(heard.run()).rejects.toThrow("WAHA error 500");
    expect(r.asked()).toEqual([digits(newer.phone), digits(older.phone)]);
    expect(await inboundOf(heard.inboundId)).toMatchObject({ processed: false, outcome: null });
    expect(r.waha.sent).toHaveLength(sentBefore);
    expect(await sql`SELECT phone FROM wa_contacts`).toEqual([{ phone: newer.phone }]);
    // The retry: the failing phone answers now; the newer one is cached (a plain chat), so only the older is asked.
    r.faults.clear();
    await r.retryNow(heard.outboxId);
    expect(await heard.run()).toBe("processed");
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.asked()).toEqual([digits(newer.phone), digits(older.phone), digits(older.phone)]);
  });

  it("a lid that moved to another phone: the stale link is cleared, and the lid stays on ONE phone", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop);
    const lid = newLid();
    const formerPhone = uniquePhone();
    // The phone the lid used to belong to is a buyer of ours too (a paid order has it), so its stale link is worth asking about.
    await paidOrder(shop, { phone: formerPhone, waNotBefore: proactiveLater() });
    await openerSent(r, order, 1, lid);
    await forgetContacts();
    // Three days ago the lid was confirmed on that phone; it answers check-exists with a plain chat now.
    await sql`
      INSERT INTO wa_contacts (phone, number_exists, chat_id, lid, checked_at, lid_checked_at)
      VALUES (${formerPhone}, true, ${lid}, ${lid}, now() - interval '3 days', now() - interval '3 days')`;
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: "ok kak" });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    // The stale link's phone is asked first, then the opener's.
    expect(r.asked()).toEqual([digits(formerPhone), digits(order.phone)]);
    expect(await sql`SELECT phone FROM wa_contacts WHERE lid = ${lid}`).toEqual([{ phone: order.phone }]);
    expect(first(await sql<{ lid: string | null }[]>`SELECT lid FROM wa_contacts WHERE phone = ${formerPhone}`).lid).toBeNull();
  });

  it("L2/M1: the phone of a stale link is a candidate only when a PAID order has it: a test number or a stranger's row, and a phone of a pending order, are never asked", async () => {
    const r = rig();
    const session = await createSession();
    const buyer = await paidOrder(shop);
    await openerSent(r, buyer, 1);
    const strangerPhone = uniquePhone();
    const pending = await unpaidOrder(shop);
    const lidA = newLid();
    const lidB = newLid();
    await forgetContacts();
    for (const [phone, lid] of [[strangerPhone, lidA], [pending.phone, lidB]] as const) {
      await sql`
        INSERT INTO wa_contacts (phone, number_exists, chat_id, lid, checked_at, lid_checked_at)
        VALUES (${phone}, true, ${lid}, ${lid}, now() - interval '3 days', now() - interval '3 days')`;
      await r.waha.lid(lid, null);
      const heard = await r.hear({ session: session.name, chatId: lid, body: "halo" });
      await heard.run();
      expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "no_code" });
    }
    // Only the buyer (once: the second round finds its plain chat cached) was ever asked about.
    expect(r.asked()).toEqual([digits(buyer.phone)]);
  });

  it("M1: only PAID orders named by code are candidates: the code of a pending order makes WhatsApp no question, and the sender gets the one neutral text", async () => {
    const r = rig();
    const session = await createSession();
    const pending = await unpaidOrder(shop);
    const buyer = await paidOrder(shop);
    await openerSent(r, buyer, 1);
    await forgetContacts();
    const lid = newLid();
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: askingFor(pending) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "text_generic" });
    // The pending order's phone was never asked about; the awaiting opener's was (that is not a reason from the message).
    expect(r.asked()).toEqual([digits(buyer.phone)]);
    expect(await sql`SELECT 1 FROM wa_contacts WHERE phone = ${pending.phone}`).toEqual([]);
    expect(r.files()).toEqual([]);
  });

  it("a candidate that is not on WhatsApp, one WhatsApp refuses the question for, and one whose lid is already known as another do not match; the next candidate still can", async () => {
    const r = rig();
    const session = await createSession();
    const lid = newLid();
    const matching = await paidOrder(shop);
    const absent = await paidOrder(shop);
    const refused = await paidOrder(shop);
    const known = await paidOrder(shop);
    // Oldest first: the matching phone is asked last.
    for (const [i, order] of [matching, absent, refused, known].entries()) {
      await openerSent(r, order, 0);
      await sql`UPDATE delivery_openers SET sent_at = now() - ${10 - i} * interval '1 hour' WHERE delivery_id = ${order.deliveries.whatsapp}`;
    }
    await forgetContacts();
    await r.waha.contact(matching.phone, { chatId: lid });
    await r.waha.contact(absent.phone, { numberExists: false });
    r.faults.set(refused.phone, new WahaError("rejected", "WAHA rejected the request (422)"));
    // `known` has another lid, confirmed an hour ago: answered from the cache, WhatsApp is not asked.
    const knownLid = newLid();
    await sql`
      INSERT INTO wa_contacts (phone, number_exists, chat_id, lid, checked_at, lid_checked_at)
      VALUES (${known.phone}, true, ${knownLid}, ${knownLid}, now() - interval '1 hour', now() - interval '1 hour')`;
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: "ok kak" });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    // Newest first: `known` (cache, no question), the refused one (a refusal: not a match, not an error), the one not on WhatsApp, and the match.
    expect(r.asked()).toEqual([digits(refused.phone), digits(absent.phone), digits(matching.phone)]);
    expect(r.files()).toEqual([expect.objectContaining({ chatId: lid })]);
    expect(await sql`SELECT phone, number_exists FROM wa_contacts WHERE phone = ${absent.phone}`).toEqual([{ phone: absent.phone, number_exists: false }]);
  });

  it("L1: a negative answer is cached for the day: a number not on WhatsApp and a plain chat are not asked again, an answer older than a day is", async () => {
    const r = rig();
    const session = await createSession();
    const absent = await paidOrder(shop);
    const plain = await paidOrder(shop);
    const old = await paidOrder(shop);
    for (const [i, order] of [old, plain, absent].entries()) {
      await openerSent(r, order, 0);
      await sql`UPDATE delivery_openers SET sent_at = now() - ${10 - i} * interval '1 hour' WHERE delivery_id = ${order.deliveries.whatsapp}`;
    }
    await forgetContacts();
    await sql`INSERT INTO wa_contacts (phone, number_exists) VALUES (${absent.phone}, false)`;
    await sql`INSERT INTO wa_contacts (phone, number_exists, chat_id) VALUES (${plain.phone}, true, ${plain.chatId})`;
    await sql`INSERT INTO wa_contacts (phone, number_exists, chat_id, checked_at) VALUES (${old.phone}, true, ${old.chatId}, now() - interval '2 days')`;
    const lid = newLid();
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: "ok" });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "no_code" });
    expect(r.asked()).toEqual([digits(old.phone)]);
  });

  it("no candidate, no round: a message nobody's phone can be matched to leaves the lid's budget unspent", async () => {
    const r = rig();
    const session = await createSession();
    const lid = newLid();
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: "halo" });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "no_code" });
    expect(r.asked()).toEqual([]);
    expect(await gateOf().round(lid, "someone-else")).toBe(true);
  });

  it("an opener older than a week, or one sent from another number, is not a candidate", async () => {
    const r = rig();
    const session = await createSession();
    const old = await paidOrder(shop);
    await openerSent(r, old, 8);
    const recent = await paidOrder(shop);
    await openerSent(r, recent, 1);
    // A second number that sent no opener at all.
    const other = await createSession();
    await forgetContacts();
    const lid = newLid();
    await r.waha.lid(lid, null);
    const fromOther = await r.hear({ session: other.name, chatId: lid, body: "ok" });
    await fromOther.run();
    expect(await inboundOf(fromOther.inboundId)).toMatchObject({ outcome: "no_code" });
    expect(r.asked()).toEqual([]);
    // On the number that sent them, only the opener of the last week is asked about.
    const otherLid = newLid();
    await r.waha.lid(otherLid, null);
    const heard = await r.hear({ session: session.name, chatId: otherLid, body: "ok" });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "no_code" });
    expect(r.asked()).toEqual([digits(recent.phone)]);
  });

  it("without the limits wired (no Valkey) there is no phone-side match: an unresolved @lid stays unresolved", async () => {
    const r = rig({ gate: null });
    const session = await createSession();
    const order = await paidOrder(shop);
    const lid = newLid();
    await openerSent(r, order, 1, lid);
    await forgetContacts();
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: "ok kak" });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "no_code" });
    expect(r.asked()).toEqual([]);
  });

  it("an @c.us sender is unchanged: the reply is matched by its phone and check-exists is never asked from this path", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop);
    await openerSent(r, order, 0);
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: "ok kak" });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.asked()).toEqual([]);
    expect(r.files()).toEqual([expect.objectContaining({ chatId: order.chatId })]);
  });
});

describe("the limits of the phone side", () => {
  it("the number's hourly ceiling: the question over it is not asked, the sender stays unresolved, and nothing is thrown", async () => {
    const r = rig();
    const session = await createSession();
    const older = await paidOrder(shop);
    const newer = await paidOrder(shop);
    const lid = newLid();
    await openerSent(r, older, 2, lid);
    await openerSent(r, newer, 1);
    await forgetContacts();
    // The number has been asked LID_SESSION_CHECK_CEILING - 1 questions this hour: one more fits, the next does not.
    const counter = `${prefix}:lid-checks:${session.id}`;
    await valkey.set(counter, String(LID_SESSION_CHECK_CEILING - 1), "EX", 3600);
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: "iya kak" });
    expect(await heard.run()).toBe("processed");
    // The sender is the OLDER opener's phone, but that question is over the ceiling: unresolved, no reply for a message without a code.
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "no_code" });
    expect(r.asked()).toEqual([digits(newer.phone)]);
    expect(r.files()).toEqual([]);
    expect(Number(await valkey.get(counter))).toBe(LID_SESSION_CHECK_CEILING + 1);
    expect(await valkey.ttl(counter)).toBeGreaterThan(0);
  });

  it("the ceiling counts the questions asked of WhatsApp only: an answer from the cache costs nothing", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop);
    await openerSent(r, order, 1);
    // The opener's own answer is cached (a plain chat, a minute old): the round asks nothing and spends nothing.
    const lid = newLid();
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: "ok" });
    await heard.run();
    expect(r.asked()).toEqual([]);
    expect(await valkey.get(`${prefix}:lid-checks:${session.id}`)).toBeNull();
  });

  it("a Valkey that fails on the lid's round retries the job: nothing is asked or sent, and it is never answered as unresolved (PDF-only); the retry serves the buyer", async () => {
    const down = valkeyDown(["set"]);
    const r = rig({ gate: down.gate });
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const lid = newLid();
    await r.waha.contact(order.phone, { chatId: lid });
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: askingFor(order) });
    await expect(heard.run()).rejects.toThrow("valkey down");
    expect(await inboundOf(heard.inboundId)).toMatchObject({ processed: false, outcome: null, replied: false });
    expect(r.asked()).toEqual([]);
    expect(r.waha.sent).toEqual([]);
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
    down.state.down = false;
    await r.retryNow(heard.outboxId);
    expect(await heard.run()).toBe("processed");
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.files()).toEqual([expect.objectContaining({ chatId: lid })]);
  });

  it("a Valkey that fails on the number's counter retries the job the same way: no question, nothing sent, no PDF-only", async () => {
    const down = valkeyDown(["incr"]);
    const r = rig({ gate: down.gate });
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const lid = newLid();
    await r.waha.contact(order.phone, { chatId: lid });
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: askingFor(order) });
    await expect(heard.run()).rejects.toThrow("valkey down");
    expect(await inboundOf(heard.inboundId)).toMatchObject({ processed: false, outcome: null });
    expect(r.asked()).toEqual([]);
    expect(r.waha.sent).toEqual([]);
    down.state.down = false;
    await r.retryNow(heard.outboxId);
    expect(await heard.run()).toBe("processed");
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
  });

  it("L6: the job's signal ending between two candidates retries the job: the second candidate is not asked and nothing is sent", async () => {
    const controller = new AbortController();
    const r = rig({
      onCheck: () => {
        controller.abort();
      },
    });
    const session = await createSession();
    const older = await paidOrder(shop);
    const newer = await paidOrder(shop);
    const lid = newLid();
    await openerSent(r, older, 2, lid);
    await openerSent(r, newer, 1);
    await forgetContacts();
    await r.waha.lid(lid, null);
    const sentBefore = r.waha.sent.length;
    const heard = await r.hear({ session: session.name, chatId: lid, body: "iya kak" });
    const row = { id: heard.outboxId, topic: INBOUND_TOPIC, payload: { inbound_id: heard.inboundId, message_id: heard.messageId }, sealed: null, attempts: 1, deferrals: 0 };
    await expect(r.consumer.perform(row, controller.signal)).rejects.toThrow("cut short");
    expect(r.asked()).toEqual([digits(newer.phone)]);
    expect(r.waha.sent).toHaveLength(sentBefore);
  });

  it("L6: the whole round has PHONE_SIDE_BUDGET_MS: when it is spent before the last candidate and nothing matched, the job is retried (not answered as unresolved)", async () => {
    let now = 0;
    const r = rig({ clock: () => now, onCheck: () => { now += PHONE_SIDE_BUDGET_MS + 1; } });
    const session = await createSession();
    const older = await paidOrder(shop);
    const newer = await paidOrder(shop);
    const lid = newLid();
    await openerSent(r, older, 2, lid);
    await openerSent(r, newer, 1);
    await forgetContacts();
    await r.waha.lid(lid, null);
    const sentBefore = r.waha.sent.length;
    const heard = await r.hear({ session: session.name, chatId: lid, body: "iya kak" });
    await expect(heard.run()).rejects.toThrow("ran out of time");
    expect(r.asked()).toEqual([digits(newer.phone)]);
    expect(r.waha.sent).toHaveLength(sentBefore);
    expect(await inboundOf(heard.inboundId)).toMatchObject({ processed: false, outcome: null });
  });

  it("L6: the job's lease covers the delivery lease, the re-fetch and lookups, the read mark and the whole phone-side round", () => {
    const r = rig();
    expect(r.consumer.leaseMs).toBe(r.config.leaseMs + INBOUND_EXTRA_LEASE_MS);
    expect(INBOUND_EXTRA_LEASE_MS).toBeGreaterThanOrEqual(30_000 + PHONE_SIDE_MAX_MS);
    // The budget, the one request (10 s) in flight when it ends, and the Valkey calls around it.
    expect(PHONE_SIDE_MAX_MS).toBeGreaterThanOrEqual(PHONE_SIDE_BUDGET_MS + 10_000);
    // The signal handed to perform is 90 % of the lease: still more than the delivery lease alone.
    expect(r.consumer.leaseMs * 0.9).toBeGreaterThan(r.config.leaseMs);
  });
});

describe("a link we already hold is not renewed by its own sender (L3)", () => {
  it("a message matched by the fresh link leaves lid_checked_at as it was; one WAHA just resolved, or check-exists just confirmed, renews it", async () => {
    const r = rig();
    const session = await createSession();
    // 1. The link is an hour old and fresh: the cache answers, and the link is NOT touched.
    const held = await paidOrder(shop);
    const heldLid = newLid();
    await openerSent(r, held, 0, heldLid);
    await sql`UPDATE wa_contacts SET checked_at = now() - interval '1 hour', lid_checked_at = now() - interval '1 hour' WHERE phone = ${held.phone}`;
    const first_ = await r.hear({ session: session.name, chatId: heldLid, body: "ok" });
    await first_.run();
    expect(await inboundOf(first_.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(await sql`SELECT lid_checked_at < now() - interval '50 minutes' AS untouched FROM wa_contacts WHERE phone = ${held.phone}`).toEqual([{ untouched: true }]);
    // 2. WAHA's own lookup answers (nothing held): the sender is confirmed now.
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    const looked = await paidOrder(shop);
    await openerSent(r, looked, 0);
    const lookedLid = newLid();
    await r.waha.lid(lookedLid, looked.chatId);
    const second = await r.hear({ session: session.name, chatId: lookedLid, body: "ok" });
    await second.run();
    expect(await inboundOf(second.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(await sql`SELECT lid, lid_checked_at > now() - interval '1 minute' AS fresh FROM wa_contacts WHERE phone = ${looked.phone}`).toEqual([{ lid: lookedLid, fresh: true }]);
  });
});

describe("what the cache says about a phone's lid (lidCacheOf)", () => {
  it("answers from a fresh link or a fresh negative answer, and says 'ask' otherwise", async () => {
    const hour = 3_600_000;
    const row = async (input: { exists: boolean; lid: boolean; checkedAgo: number; lidCheckedAgo: number | null }): Promise<string> => {
      const phone = uniquePhone();
      const lid = newLid();
      await sql`
        INSERT INTO wa_contacts (phone, number_exists, chat_id, lid, checked_at, lid_checked_at)
        VALUES (${phone}, ${input.exists}, ${input.exists ? lid : null}, ${input.lid ? lid : null}, ${new Date(Date.now() - input.checkedAgo)},
                ${input.lidCheckedAgo === null ? null : new Date(Date.now() - input.lidCheckedAgo)})`;
      return phone;
    };
    const lidOf = async (phone: string): Promise<string | null | undefined> => {
      const cached = await lidCacheOf(workerSql, phone);
      return cached === null ? undefined : cached.lid === null ? null : "lid";
    };
    expect(await lidOf(uniquePhone())).toBeUndefined();
    // A link confirmed with the last answer, within the day.
    expect(await lidOf(await row({ exists: true, lid: true, checkedAgo: hour, lidCheckedAgo: hour }))).toBe("lid");
    // A link confirmed after the last answer (rememberLid): the link is the later news, even if the answer is old.
    expect(await lidOf(await row({ exists: true, lid: true, checkedAgo: 3 * 24 * hour, lidCheckedAgo: hour }))).toBe("lid");
    // A link and an answer older than a day: ask.
    expect(await lidOf(await row({ exists: true, lid: true, checkedAgo: 2 * 24 * hour, lidCheckedAgo: 2 * 24 * hour }))).toBeUndefined();
    // The last answer (today) carried no lid: a plain chat, whatever an older link says.
    expect(await lidOf(await row({ exists: true, lid: false, checkedAgo: hour, lidCheckedAgo: null }))).toBeNull();
    expect(await lidOf(await row({ exists: true, lid: true, checkedAgo: hour, lidCheckedAgo: 3 * hour }))).toBeNull();
    // Not on WhatsApp, answered today: nothing to ask; answered two days ago: ask.
    expect(await lidOf(await row({ exists: false, lid: false, checkedAgo: hour, lidCheckedAgo: null }))).toBeNull();
    expect(await lidOf(await row({ exists: false, lid: false, checkedAgo: 2 * 24 * hour, lidCheckedAgo: null }))).toBeUndefined();
  });
});

describe("the limits in Valkey (lidGateFromValkey)", () => {
  it("one holder takes a lid's round once an hour; the same holder may take it again (a retried job), another may not; the key is an HMAC of the lid, not the lid or its plain hash", async () => {
    const gate = gateOf();
    const lid = newLid();
    expect(await gate.round(lid, "inbound-1")).toBe(true);
    expect(await gate.round(lid, "inbound-1")).toBe(true);
    expect(await gate.round(lid, "inbound-2")).toBe(false);
    expect(await gate.round(newLid(), "inbound-2")).toBe(true);
    // Another secret gives another key for the same lid: it is keyed, so a guessed lid cannot be tested against the keys without the secret.
    expect(await gateOf(randomBytes(32)).round(lid, "inbound-3")).toBe(true);
    // The worker's ACL has no KEYS: scan.
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, found] = await valkey.scan(cursor, "MATCH", `${prefix}:lid-round:*`, "COUNT", 1000);
      keys.push(...found);
      cursor = next;
    } while (cursor !== "0");
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const key of keys) {
      expect(key).not.toContain(lid.split("@")[0]);
      expect(key).not.toContain(createHash("sha256").update(lid).digest("hex"));
      expect(key).toMatch(/^[a-z0-9]+:lid-round:[0-9a-f]{64}$/);
      const ttl = await valkey.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(LID_ROUND_TTL_SECONDS);
    }
  });

  it("a number's counter allows LID_SESSION_CHECK_CEILING questions an hour, keeps its hour, and gets one even when its first EXPIRE never ran", async () => {
    const gate = gateOf();
    const session = randomUUID();
    for (let i = 1; i <= LID_SESSION_CHECK_CEILING; i++) expect(await gate.question(session), `question ${String(i)}`).toBe(true);
    expect(await gate.question(session)).toBe(false);
    const ttl = await valkey.ttl(`${prefix}:lid-checks:${session}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(LID_ROUND_TTL_SECONDS);
    // A counter left without a TTL (the process died between INCR and EXPIRE) is given its hour by the next question.
    const stuck = randomUUID();
    await valkey.set(`${prefix}:lid-checks:${stuck}`, "3");
    expect(await valkey.ttl(`${prefix}:lid-checks:${stuck}`)).toBe(-1);
    expect(await gate.question(stuck)).toBe(true);
    expect(await valkey.ttl(`${prefix}:lid-checks:${stuck}`)).toBeGreaterThan(0);
  });
});
