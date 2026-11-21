// US-025 criteria 3 and 5: buyer-first inbound WhatsApp (src/delivery/inbound.ts) against PostgreSQL as the worker_rw login and the
// in-process WAHA mock. The webhook is untrusted: the message is re-fetched from WAHA, and WHO wrote decides, never the order code
// alone. Phone match: the same WhatsApp delivery row is claimed and the PDF and a login link go back from that chat and number. An @lid
// that cannot be resolved: the PDF without the link. A confirmed mismatch, or a row that is not pending: a text only, and the
// proactive send is not cancelled. Races between the reply and the proactive send send one PDF.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createEbookFiles } from "../src/delivery/access.ts";
import { createDelivery, type Delivery } from "../src/delivery/deliver.ts";
import { createInboundConsumer, INBOUND_TOPIC } from "../src/delivery/inbound.ts";
import { pdfOnlyCaption, replyText } from "../src/delivery/messages.ts";
import { inertFailpoint } from "../src/failpoint.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
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
  recordingMail,
  retireDeliveries,
  retireSessions,
  storeInbound,
  unpaidOrder,
} from "./support/delivery.ts";
import { first, sql } from "./support/db.ts";
import { silentLog, uniquePhone, workerPool } from "./support/midtrans.ts";

/** A chat of its own per use: a reply to the same chat within the hour is skipped, whichever file sent it. */
const strangerChat = (): string => `${uniquePhone().slice(1)}@c.us`;

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

function rig(options: { random?: () => number; clock?: () => number } = {}) {
  const waha = createWahaFake();
  const mail = recordingMail();
  const magic = fakeMagicLinks();
  const config = deliveryConfig(shop);
  /** One injected clock for the delivery AND the inbound consumer: the claim's age is measured on the same clock it was stamped on. */
  const clock = options.clock === undefined ? {} : { clock: options.clock };
  const delivery: Delivery = createDelivery({
    sql: workerSql,
    log: silentLog,
    config,
    waha: waha.access,
    mail,
    files: createEbookFiles(config),
    magicLinks: magic,
    enqueue: () => Promise.resolve(),
    random: options.random ?? (() => 0.5),
    sleep: () => Promise.resolve(),
    ...clock,
  });
  const consumer = createInboundConsumer({ sql: workerSql, log: silentLog, config, waha: waha.access, delivery, files: createEbookFiles(config), random: options.random ?? (() => 0.5), sleep: () => Promise.resolve(), ...clock });
  const process = createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
  /** A buyer's message: registered in WAHA, stored as the webhook route would, and handled by the consumer. */
  async function hear(input: { session: string; chatId: string; body: string; orderCode?: string }) {
    const messageId = await waha.inbound({ session: input.session, chatId: input.chatId, body: input.body });
    const stored = await storeInbound({ sessionName: input.session, messageId, fromJid: input.chatId });
    return { ...stored, messageId, run: () => process({ id: stored.outboxId }) };
  }
  const files = () => waha.sent.filter((s) => s.kind === "file");
  const texts = () => waha.sent.filter((s) => s.kind === "text");
  return { waha, mail, magic, delivery, consumer, process, hear, files, texts, config };
}

/** The pool number that sent the order's opener (the buyer replies to that one). */
const openerSession = async (order: { deliveries: { whatsapp: string } }): Promise<{ name: string; id: string }> =>
  first(await sql<{ name: string; id: string }[]>`SELECT s.session_name AS name, s.id FROM delivery_openers o JOIN waha_sessions s ON s.id = o.session_id WHERE o.delivery_id = ${order.deliveries.whatsapp}`);

const askingFor = (order: Pick<PaidOrder, "code">): string => `Halo, ini kode pesanan saya ${order.code} untuk Ebook.`;
const proactiveLater = (): Date => new Date(Date.now() + 180_000);

describe("buyer-first: the sender is the buyer (criterion 3)", () => {
  it("a phone match claims the SAME delivery row and replies with the PDF and a login link from that chat and number; the proactive send then does nothing", async () => {
    const r = rig();
    const session = await createSession();
    await createSession({ weight: 1 });
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order) });
    expect(await heard.run()).toBe("processed");
    expect(await inboundOf(heard.inboundId)).toEqual({ processed: true, outcome: "delivered", replied: false });
    expect(r.files()).toHaveLength(1);
    expect(r.files()[0]).toMatchObject({ session: session.name, chatId: order.chatId });
    expect(r.files()[0]?.text).toContain("https://play.example.test/masuk#c=whatsapp&t=");
    expect(r.files()[0]?.text).toContain(order.code);
    expect(r.magic.issued).toEqual([expect.objectContaining({ playerId: order.playerId, channel: "whatsapp" })]);
    const row = await deliveryOf(order.deliveries.whatsapp);
    expect(row).toMatchObject({ status: "sent", attempts: 1, session_id: session.id, tried_session_ids: [session.id], wa_chat_id: order.chatId });
    // The opener job (the delay passed) finds a row that is not pending: the buyer wrote first, so no opener is ever sent to them, and one PDF in all.
    await sql`UPDATE deliveries SET not_before = now() - interval '1 second' WHERE id = ${order.deliveries.whatsapp}`;
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("skipped");
    expect(r.files()).toHaveLength(1);
    expect(r.texts()).toEqual([]);
    // The e-mail is a different channel: untouched by the buyer-first claim.
    expect((await deliveryOf(order.deliveries.email)).status).toBe("pending");
  });

  it("an @lid that WAHA resolves to the order's phone is the buyer: the same full reply, to that chat", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const lid = "98765432101234@lid";
    await r.waha.lid(lid, order.chatId);
    const heard = await r.hear({ session: session.name, chatId: lid, body: askingFor(order) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.files()).toEqual([expect.objectContaining({ chatId: lid })]);
    expect(r.files()[0]?.text).toContain("masuk#c=whatsapp");
    // wa_chat_id keeps the ORDER's chat, never the @lid.
    expect((await deliveryOf(order.deliveries.whatsapp)).wa_chat_id).toBe(order.chatId);
  });

  it("D6: an @lid that cannot be resolved gets the PDF as an EXTRA reply, with no name and no login link, and the delivery row is NOT claimed: the proactive send still goes out", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { name: "Budi Pembeli", waNotBefore: proactiveLater() });
    const lid = "55555555555555@lid";
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: askingFor(order) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "pdf_only_sent", replied: true });
    // The reply: the file, to the @lid chat, from the number the sender wrote to, with the fixed caption and nothing of the order.
    expect(r.files()).toEqual([expect.objectContaining({ chatId: lid, session: session.name, text: pdfOnlyCaption() })]);
    const [reply] = r.files();
    expect(reply?.url).toMatch(/\/files\/deliverables\/[0-9a-f-]{36}\.pdf\?exp=\d+&sig=/);
    for (const forbidden of ["masuk", "Budi", order.code, order.phone, order.email]) expect(JSON.stringify(reply)).not.toContain(forbidden);
    expect(r.magic.issued).toEqual([]);
    // The row is untouched (never claimed, no attempt, no number recorded) ...
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0, session_id: null, tried_session_ids: [] });
    // ... so the buyer's own proactive send still goes out on schedule: the short opener, with the first name, no file and no link.
    await sql`UPDATE deliveries SET not_before = now() - interval '1 second' WHERE id = ${order.deliveries.whatsapp}`;
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect(r.files()).toHaveLength(1);
    expect(r.texts()).toHaveLength(1);
    expect(r.texts()[0]?.text).toContain("Budi");
    expect(r.texts()[0]?.text).not.toContain("https://");
    expect(r.magic.issued).toEqual([]);
  });

  it("D6: the PDF for an unresolved @lid is limited like every extra reply: once an hour per sender, and an order that is not paid gets one neutral text instead", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const lid = "55555555555556@lid";
    await r.waha.lid(lid, null);
    const first_ = await r.hear({ session: session.name, chatId: lid, body: askingFor(order) });
    await first_.run();
    const again = await r.hear({ session: session.name, chatId: lid, body: askingFor(order) });
    await again.run();
    expect(await inboundOf(again.inboundId)).toMatchObject({ outcome: "pdf_skipped", replied: false });
    expect(r.files()).toHaveLength(1);
    // Not paid: no PDF to give, and no word about the order's state to a sender nobody has confirmed: the one generic text.
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    const unpaid = await unpaidOrder(shop);
    const lid2 = "55555555555557@lid";
    await r.waha.lid(lid2, null);
    const stranger = await r.hear({ session: session.name, chatId: lid2, body: askingFor(unpaid) });
    await stranger.run();
    expect(await inboundOf(stranger.inboundId)).toMatchObject({ outcome: "text_generic", replied: true });
    expect(r.files()).toHaveLength(1);
    expect(r.texts()).toEqual([expect.objectContaining({ chatId: lid2, text: replyText("generic") })]);
    expect(r.texts()[0]?.text).not.toBe(replyText("not_paid"));
  });

  it("an @lid that resolves to ANOTHER phone is a stranger", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const lid = "44444444444444@lid";
    await r.waha.lid(lid, "6281999900001@c.us");
    const heard = await r.hear({ session: session.name, chatId: lid, body: askingFor(order) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "text_mismatch", replied: true });
    expect(r.files()).toEqual([]);
    expect(r.magic.issued).toEqual([]);
    expect((await deliveryOf(order.deliveries.whatsapp)).status).toBe("pending");
  });

  it("a stranger who knows an order code gets a text only: no PDF, no login link, and the buyer's delivery is not cancelled", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const stranger = "6281999900002@c.us";
    const heard = await r.hear({ session: session.name, chatId: stranger, body: askingFor(order) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toEqual({ processed: true, outcome: "text_mismatch", replied: true });
    expect(r.files()).toEqual([]);
    expect(r.texts()).toEqual([expect.objectContaining({ chatId: stranger, text: replyText("mismatch") })]);
    // The reply tells the stranger nothing about the order: no code, no name, no number.
    expect(r.texts()[0]?.text).not.toContain(order.code);
    expect(r.texts()[0]?.text).not.toContain(order.phone.slice(-4));
    expect(r.magic.issued).toEqual([]);
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0, session_id: null });
    // The proactive opener still goes to the real buyer, from the pool.
    await sql`UPDATE deliveries SET not_before = now() - interval '1 second' WHERE id = ${order.deliveries.whatsapp}`;
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect(r.files()).toEqual([]);
    expect(r.texts().at(-1)).toMatchObject({ chatId: order.chatId });
  });

  it("answers a stranger once an hour at most, from a number under its cap", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const stranger = "6281999900003@c.us";
    const first_ = await r.hear({ session: session.name, chatId: stranger, body: askingFor(order) });
    await first_.run();
    const second = await r.hear({ session: session.name, chatId: stranger, body: askingFor(order) });
    await second.run();
    expect(r.texts()).toHaveLength(1);
    expect(await inboundOf(second.inboundId)).toMatchObject({ processed: true, outcome: "text_skipped", replied: false });
    // After the hour another stranger message is answered again.
    await sql`UPDATE waha_inbound SET replied_at = now() - interval '2 hours' WHERE id = ${first_.inboundId}`;
    const third = await r.hear({ session: session.name, chatId: stranger, body: askingFor(order) });
    await third.run();
    expect(r.texts()).toHaveLength(2);
    // A number at its daily cap sends nothing, not even the reply, and the right to reply is not spent.
    await retireSessions();
    const full = await createSession({ dailyCap: 1, sentToday: 1 });
    const other = "6281999900004@c.us";
    const capped = await r.hear({ session: full.name, chatId: other, body: askingFor(order) });
    await capped.run();
    expect(r.texts()).toHaveLength(2);
    expect(await inboundOf(capped.inboundId)).toMatchObject({ outcome: "text_no_number", replied: false });
  });

  it("a verified buyer's row that is not pending gets a text that follows its state (on its way / needs help) and is left alone", async () => {
    const r = rig();
    const session = await createSession();
    const expected: Record<string, [string, string]> = {
      sending: ["text_already_sent", replyText("already_sent")],
      sent: ["text_already_sent", replyText("already_sent")],
      unknown: ["text_already_sent", replyText("already_sent")],
      // A failed delivery is NOT "already sent": the buyer is told to check e-mail or ask, the Owner has an alert.
      failed: ["text_needs_help", replyText("needs_help")],
    };
    for (const [state, [outcome, text]] of Object.entries(expected)) {
      await sql`UPDATE waha_sessions SET next_send_at = NULL`;
      const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
      await sql`UPDATE deliveries SET status = ${state}, attempts = 1 WHERE id = ${order.deliveries.whatsapp}`;
      const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order) });
      await heard.run();
      expect(await inboundOf(heard.inboundId), state).toMatchObject({ outcome, replied: true });
      expect(r.texts().at(-1)?.text, state).toBe(text);
      expect(await deliveryOf(order.deliveries.whatsapp), state).toMatchObject({ status: state, attempts: 1 });
    }
    expect(r.files()).toEqual([]);
    expect(r.texts()).toHaveLength(4);
  });

  it("the state of an order is told only to its verified buyer: not paid yet, refunded or cancelled each get their own text, an unverified sender gets the neutral one", async () => {
    const r = rig();
    const session = await createSession();
    const hear = async (order: { code: string; chatId: string }, from = order.chatId) => {
      await sql`UPDATE waha_sessions SET next_send_at = NULL`;
      const heard = await r.hear({ session: session.name, chatId: from, body: askingFor(order) });
      await heard.run();
      return { outcome: (await inboundOf(heard.inboundId)).outcome, text: r.texts().at(-1)?.text };
    };
    // Not paid yet: the order has no delivery; "waiting for payment" is the truth and the verified buyer may be told.
    const pending = await unpaidOrder(shop, "pending");
    expect(await hear(pending)).toEqual({ outcome: "text_not_paid", text: replyText("not_paid") });
    // Refunded (it WAS paid): "waiting for payment" would be a lie. The text says it cannot be processed here.
    const refunded = await paidOrder(shop);
    await sql`UPDATE deliveries SET status = 'cancelled' WHERE order_id = ${refunded.orderId}`;
    await sql`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${refunded.orderId}`;
    expect(await hear(refunded)).toEqual({ outcome: "text_not_available", text: replyText("not_available") });
    expect(replyText("not_available")).not.toBe(replyText("not_paid"));
    // The same orders asked about by somebody else: nothing about their state, only the neutral text.
    expect(await hear(pending, "6281999900301@c.us")).toEqual({ outcome: "text_mismatch", text: replyText("mismatch") });
    expect(await hear(refunded, "6281999900302@c.us")).toEqual({ outcome: "text_mismatch", text: replyText("mismatch") });
    expect(r.files()).toEqual([]);
  });
});

describe("buyer-first: the webhook is not trusted (criterion 3, 5)", () => {
  it("a message WAHA does not know is forged: nothing is sent, whatever the stored row says", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const forged = await storeInbound({ sessionName: session.name, messageId: `false_${order.chatId}_FORGED0001`, fromJid: order.chatId });
    expect(await r.process({ id: forged.outboxId })).toBe("processed");
    expect(await inboundOf(forged.inboundId)).toMatchObject({ processed: true, outcome: "unverified" });
    // Not even shaped like a WAHA message id.
    const odd = await storeInbound({ sessionName: session.name, messageId: "not-a-waha-id", fromJid: order.chatId });
    expect(await r.process({ id: odd.outboxId })).toBe("processed");
    expect(await inboundOf(odd.inboundId)).toMatchObject({ outcome: "unverified" });
    expect(r.waha.sent).toEqual([]);
    expect((await deliveryOf(order.deliveries.whatsapp)).status).toBe("pending");
  });

  it("the sender and the text are the re-fetched ones: a row that lies about who wrote does not change who is answered", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    // WAHA holds a message from a stranger; the stored row claims the buyer wrote it.
    const stranger = "6281999900005@c.us";
    const messageId = await r.waha.inbound({ session: session.name, chatId: stranger, body: askingFor(order) });
    const stored = await storeInbound({ sessionName: session.name, messageId, fromJid: order.chatId });
    await r.process({ id: stored.outboxId });
    expect(r.files()).toEqual([]);
    expect(r.texts()).toEqual([expect.objectContaining({ chatId: stranger })]);
  });

  it("a duplicate inbound message is handled once: a re-claimed outbox row sends nothing more", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order) });
    expect(await heard.run()).toBe("processed");
    expect(r.files()).toHaveLength(1);
    // The same message id again: the database refuses the second row (the webhook route answers 200 and moves on) ...
    await expect(storeInbound({ sessionName: session.name, messageId: heard.messageId, fromJid: order.chatId })).rejects.toMatchObject({ code: "23505" });
    // ... and an outbox row that is re-claimed (a crash before its processed_at, a re-relay) finds the inbound handled.
    await sql`UPDATE outbox SET processed_at = NULL, available_at = now() WHERE id = ${heard.outboxId}`;
    expect(await heard.run()).toBe("processed");
    expect(r.files()).toHaveLength(1);
    expect(r.texts()).toEqual([]);
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("ignores what is not a buyer asking: no code, a code of no order, our own message, a group; none is answered", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const noCode = await r.hear({ session: session.name, chatId: order.chatId, body: "halo, ebooknya mana?" });
    await noCode.run();
    expect(await inboundOf(noCode.inboundId)).toMatchObject({ outcome: "no_code" });
    const unknownCode = await r.hear({ session: session.name, chatId: order.chatId, body: "kode saya 7K3M9XQ2PA" });
    await unknownCode.run();
    expect(await inboundOf(unknownCode.inboundId)).toMatchObject({ outcome: "unknown_code" });
    const ours = await storeInbound({ sessionName: session.name, messageId: `true_${order.chatId}_OWNMSG0001`, fromJid: order.chatId });
    await r.process({ id: ours.outboxId });
    expect(await inboundOf(ours.inboundId)).toMatchObject({ outcome: "unverified" });
    expect(r.waha.sent).toEqual([]);
    expect((await deliveryOf(order.deliveries.whatsapp)).status).toBe("pending");
  });

  it("an outage while asking WAHA is retried, not called forged; the message is answered once WAHA is back", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order) });
    r.waha.outage(session.name, true);
    await expect(heard.run()).rejects.toThrow(/could not be asked/);
    expect((await inboundOf(heard.inboundId)).processed).toBe(false);
    expect(r.waha.sent).toEqual([]);
    r.waha.outage(session.name, false);
    await sql`UPDATE outbox SET available_at = now() WHERE id = ${heard.outboxId}`;
    expect(await heard.run()).toBe("processed");
    expect(r.files()).toHaveLength(1);
  });

  it("payloads that are not an inbound id are refused; a deleted row is a no-op", async () => {
    const r = rig();
    const bad = first(await sql<{ id: string }[]>`INSERT INTO outbox (topic, dedupe_key, payload) VALUES (${INBOUND_TOPIC}, ${`bad:${randomUUID()}`}, '{"inbound_id": "nope"}'::jsonb) RETURNING id`);
    await expect(r.process({ id: bad.id })).rejects.toThrow(/no valid inbound_id/);
    const gone = first(await sql<{ id: string }[]>`INSERT INTO outbox (topic, dedupe_key, payload) VALUES (${INBOUND_TOPIC}, ${`gone:${randomUUID()}`}, ${sql.json({ inbound_id: randomUUID(), message_id: "x" })}) RETURNING id`);
    expect(await r.process({ id: gone.id })).toBe("processed");
    // A row whose payload names another message than the stored one is inconsistent: nothing is done.
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order) });
    await sql`UPDATE outbox SET payload = payload || '{"message_id": "other"}'::jsonb WHERE id = ${heard.outboxId}`;
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "inconsistent" });
    expect(r.waha.sent).toEqual([]);
  });
});

describe("buyer-first races and failures (criterion 5)", () => {
  it("whoever wins the row, ONE PDF goes out: the opener first (the buyer's reply, with no code, gets the PDF), the buyer first (the opener is never sent)", async () => {
    // Both orders, forced: the outcome of the race below does not depend on the scheduler.
    const r = rig();
    const session = await createSession();
    await createSession();
    const openerFirst = await paidOrder(shop);
    expect(await r.delivery.process({ id: openerFirst.deliveries.whatsapp })).toBe("opened");
    const answer = await r.hear({ session: (await openerSession(openerFirst)).name, chatId: openerFirst.chatId, body: "ok kak, kirim ya" });
    await answer.run();
    expect(await inboundOf(answer.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.files().filter((f) => f.chatId === openerFirst.chatId)).toHaveLength(1);
    expect(await deliveryOf(openerFirst.deliveries.whatsapp)).toMatchObject({ status: "sent", attempts: 1 });

    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    const buyerFirst = await paidOrder(shop);
    const second = await r.hear({ session: session.name, chatId: buyerFirst.chatId, body: askingFor(buyerFirst) });
    await second.run();
    expect(await inboundOf(second.inboundId)).toMatchObject({ outcome: "delivered" });
    // The opener job finds the delivery claimed: no opener to a buyer who already wrote.
    expect(await r.delivery.process({ id: buyerFirst.deliveries.whatsapp })).toBe("skipped");
    expect(r.files().filter((f) => f.chatId === buyerFirst.chatId)).toHaveLength(1);
    expect(r.texts().filter((t) => t.chatId === buyerFirst.chatId)).toEqual([]);
    expect(await sql`SELECT status FROM delivery_openers WHERE delivery_id = ${buyerFirst.deliveries.whatsapp}`).toEqual([]);
  });

  it("the buyer's reply and the opener released at the same instant (a barrier) send at most ONE opener and ONE PDF, on either winner", async () => {
    const r = rig();
    const session = await createSession();
    await createSession();
    for (let i = 0; i < 12; i++) {
      await sql`UPDATE waha_sessions SET next_send_at = NULL`;
      const order = await paidOrder(shop);
      const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order) });
      const filesBefore = r.files().length;
      const textsBefore = r.texts().length;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const racing = [gate.then(() => r.delivery.process({ id: order.deliveries.whatsapp })), gate.then(() => heard.run())] as const;
      release();
      const [opener] = await Promise.all(racing);
      const row = await deliveryOf(order.deliveries.whatsapp);
      expect(row.status, `race ${String(i)}`).toBe("sent");
      expect(row.attempts, `race ${String(i)}`).toBe(1);
      expect(r.files().length - filesBefore, `race ${String(i)}`).toBe(1);
      // The opener either won first (it went out, and the reply then got the PDF) or lost (skipped, never sent): never two.
      expect(r.texts().length - textsBefore, `race ${String(i)}`).toBe(opener === "opened" ? 1 : 0);
      expect(["opened", "skipped"]).toContain(opener);
    }
    expect(new Set(r.files().map((f) => f.chatId)).size).toBe(12);
  });

  it("two messages from one sender at the same instant get ONE reply (the advisory lock on the sender), for a text and for the PDF of an unresolved @lid", async () => {
    const r = rig();
    const session = await createSession({ dailyCap: 1000 });
    for (let i = 0; i < 8; i++) {
      await sql`UPDATE waha_sessions SET next_send_at = NULL`;
      const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
      const stranger = `62819999004${String(i).padStart(2, "0")}@c.us`;
      const lid = `5555555500${String(i).padStart(4, "0")}@lid`;
      await r.waha.lid(lid, null);
      const texts = r.texts().length;
      const files = r.files().length;
      const heard = await Promise.all([
        r.hear({ session: session.name, chatId: stranger, body: askingFor(order) }),
        r.hear({ session: session.name, chatId: stranger, body: askingFor(order) }),
        r.hear({ session: session.name, chatId: lid, body: askingFor(order) }),
        r.hear({ session: session.name, chatId: lid, body: askingFor(order) }),
      ]);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = heard.map((h) => gate.then(() => h.run()));
      release();
      await Promise.all(running);
      expect(r.texts().length - texts, `text ${String(i)}`).toBe(1);
      expect(r.files().length - files, `pdf ${String(i)}`).toBe(1);
    }
  });

  it("text replies stop at 80 % of a number's daily cap, so they can never take the proactive deliveries' share; the buyer's own PDF may use the rest", async () => {
    const r = rig();
    // 10 a day, 8 used: 80 % of it is reached. A stranger's text is not sent, and the right to reply is not spent.
    const busy = await createSession({ dailyCap: 10, sentToday: 8 });
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const stranger = await r.hear({ session: busy.name, chatId: strangerChat(), body: askingFor(order) });
    await stranger.run();
    expect(await inboundOf(stranger.inboundId)).toMatchObject({ outcome: "text_no_number", replied: false });
    expect(r.texts()).toEqual([]);
    // One below the line it is sent.
    await retireSessions();
    const calmer = await createSession({ dailyCap: 10, sentToday: 7 });
    const again = await r.hear({ session: calmer.name, chatId: strangerChat(), body: askingFor(order) });
    await again.run();
    expect(await inboundOf(again.inboundId)).toMatchObject({ outcome: "text_mismatch", replied: true });
    // The verified buyer's PDF is the delivery itself, not an extra: it is held to the full cap (7 of 10 used), not to the share.
    const buyer = await r.hear({ session: calmer.name, chatId: order.chatId, body: askingFor(order) });
    await buyer.run();
    expect(await inboundOf(buyer.inboundId)).toMatchObject({ outcome: "delivered" });
  });

  it("the claim's age is measured on the injected clock, the same one that stamped it (not a wall clock): a stalled claim is not sent", async () => {
    let reads = 0;
    const r = rig({ clock: () => (reads++ === 0 ? 0 : 3_600_000) });
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order) });
    await heard.run();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivery_pending" });
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", last_error: "claim_too_old", attempts: 1, attempts_base: 1, tried_session_ids: [] });
    expect(r.waha.sent).toEqual([]);
  });

  it("a reply that fails for sure leaves the delivery pending, and the opener (through another number) is the buyer's way back to the PDF", async () => {
    const r = rig();
    const writtenTo = await createSession({ weight: 1 });
    await createSession({ weight: 5 });
    const later = proactiveLater();
    const order = await paidOrder(shop, { waNotBefore: later });
    r.waha.fault(writtenTo.name, "unauthorized");
    const heard = await r.hear({ session: writtenTo.name, chatId: order.chatId, body: askingFor(order) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivery_pending" });
    const row = await deliveryOf(order.deliveries.whatsapp);
    expect(row).toMatchObject({ status: "pending", attempts: 1, session_id: null, tried_session_ids: [writtenTo.id] });
    expect(Math.abs(row.not_before.getTime() - later.getTime())).toBeLessThan(5);
    // WAHA refused it for sure: nothing went out, so the failed attempt is not a message to the buyer: the ledger keeps it only as the number's failed send.
    expect(await sql`SELECT outcome FROM waha_sends WHERE session_id = ${writtenTo.id} AND kind = 'reply'`).toEqual([{ outcome: "failed" }]);
    // Nobody sent a PDF; when due, the text-only opener goes out through the OTHER number, and the buyer's answer to it gets the PDF.
    await sql`UPDATE deliveries SET not_before = now() - interval '1 second' WHERE id = ${order.deliveries.whatsapp}`;
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect(r.files()).toEqual([]);
    expect(r.texts()).toEqual([expect.objectContaining({ chatId: order.chatId })]);
    expect(r.texts()[0]?.session).not.toBe(writtenTo.name);
  });

  it("a reply that may have gone out is unknown and never sent again, by the proactive path either", async () => {
    const r = rig();
    const session = await createSession();
    await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    r.waha.fault(session.name, "timeout_after_send");
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivery_unknown" });
    expect((await deliveryOf(order.deliveries.whatsapp)).status).toBe("unknown");
    // The PDF is never sent again: not by a second reply, and not by anything the proactive path does (the opener sends no file).
    await sql`UPDATE deliveries SET not_before = now() - interval '1 second' WHERE id = ${order.deliveries.whatsapp}`;
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("skipped");
    expect(r.files()).toHaveLength(1);
  });

  it("a number at its daily cap does not reply, and the row stays pending for the proactive send", async () => {
    const r = rig();
    const full = await createSession({ dailyCap: 2, sentToday: 2 });
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: full.name, chatId: order.chatId, body: askingFor(order) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "pool_unavailable" });
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
    expect(r.waha.sent).toEqual([]);
  });
});

describe("the buyer's reply to the opener (Owner decision D7): the PDF and the login link follow it", () => {
  it("a code-less reply from the buyer's phone, to the number that sent the opener, claims the SAME delivery and gets the PDF and the link: seen, reading, typing, paused, the file, offline", async () => {
    const r = rig();
    await createSession();
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    const number = await openerSession(order);
    await r.waha.clearCallLog();
    const heard = await r.hear({ session: number.name, chatId: order.chatId, body: "iya kak, kirim ya" });
    expect(await heard.run()).toBe("processed");
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.files()).toEqual([expect.objectContaining({ session: number.name, chatId: order.chatId })]);
    expect(r.files()[0]?.text).toContain("https://play.example.test/masuk#c=whatsapp&t=");
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "sent", attempts: 1, session_id: number.id });
    // The human-like order of a REPLY: the buyer's message is marked as read first (with its id), then typing, paused, the file, offline.
    const calls = await r.waha.callLog();
    expect(calls.map((c) => `${c.path.replace(/^\/api\/[^/]+\/presence$/, "/presence")}${typeof c.body["presence"] === "string" ? `:${c.body["presence"]}` : ""}`)).toEqual([
      "/api/sendSeen",
      "/presence:typing",
      "/presence:paused",
      "/api/sendFile",
      "/presence:offline",
    ]);
    expect(calls[0]?.body["messageIds"]).toEqual([heard.messageId]);
    // The same delivery is never claimed twice: another "ok" is told it is on its way, not sent again.
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    await sql`UPDATE waha_inbound SET replied_at = NULL`;
    const again = await r.hear({ session: number.name, chatId: order.chatId, body: "ok" });
    await again.run();
    expect(r.files()).toHaveLength(1);
  });

  it("the PDF reply waits out the contact gap after the opener (a random 30 to 60 s), and the pair counts as two messages to that contact", async () => {
    const r = rig();
    await createSession();
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    const number = await openerSession(order);
    const heard = await r.hear({ session: number.name, chatId: order.chatId, body: "ok" });
    await heard.run();
    const sends = await sql<{ kind: string; send_at: Date }[]>`SELECT kind, send_at FROM waha_sends WHERE session_id = ${number.id} AND contact_key IS NOT NULL ORDER BY send_at`;
    expect(sends.map((s) => s.kind)).toEqual(["opener", "reply"]);
    const gap = (sends[1]?.send_at.getTime() ?? 0) - (sends[0]?.send_at.getTime() ?? 0);
    expect(gap).toBeGreaterThanOrEqual(30_000);
    expect(gap).toBeLessThanOrEqual(61_000);
  });

  it("at most 4 messages an hour to one contact: a buyer who has had four is not answered again until the hour passes, and the delivery stays pending", async () => {
    const r = rig();
    await createSession();
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    const number = await openerSession(order);
    const key = "encode(sha256(convert_to('ebooktrivia/contact/v1|' || " + `'${order.phone}'` + ", 'UTF8')), 'hex')";
    for (let i = 1; i <= 3; i++) await sql.unsafe(`INSERT INTO waha_sends (session_id, kind, contact_key, send_at) VALUES ('${number.id}', 'reply', ${key}, now() - interval '${String(i * 10)} minutes')`);
    const heard = await r.hear({ session: number.name, chatId: order.chatId, body: "ok" });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "contact_capped" });
    expect(r.files()).toEqual([]);
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("a reply from a @lid the opener went to (check-exists taught us the lid) is matched without asking WAHA, and the PDF goes to that chat", async () => {
    const r = rig();
    await createSession();
    const order = await paidOrder(shop);
    const lid = "98765432101299@lid";
    await r.waha.contact(order.phone, { chatId: lid, pn: order.chatId });
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect(r.waha.sent[0]?.chatId).toBe(lid);
    const number = await openerSession(order);
    await r.waha.clearCallLog();
    const heard = await r.hear({ session: number.name, chatId: lid, body: "ok kak" });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.files()).toEqual([expect.objectContaining({ chatId: lid })]);
    // The lid -> phone link was already known: WAHA's lid lookup was never called.
    expect((await r.waha.callLog()).some((c) => c.path.includes("/lids/"))).toBe(false);
    expect(r.waha.calls.filter((c) => c.path.includes("/lids/"))).toEqual([]);
  });

  it("a reply from a @lid we do not know yet is resolved through WAHA, and remembered for the next message", async () => {
    const r = rig();
    await createSession();
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    const number = await openerSession(order);
    const lid = "12345678901234@lid";
    await r.waha.lid(lid, order.chatId);
    const heard = await r.hear({ session: number.name, chatId: lid, body: "ok" });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.waha.calls.filter((c) => c.path.includes("/lids/"))).toHaveLength(1);
    expect(await sql`SELECT lid FROM wa_contacts WHERE phone = ${order.phone}`).toEqual([{ lid }]);
    // An @lid WAHA cannot put a number to, with no code: nothing to match, no reply (D6 needs a code to know which order).
    const stranger = await r.hear({ session: number.name, chatId: "55555555555599@lid", body: "ok" });
    await r.waha.lid("55555555555599@lid", null);
    await stranger.run();
    expect(await inboundOf(stranger.inboundId)).toMatchObject({ outcome: "no_code" });
  });

  it("a code-less message that does not answer an opener is not answered: another phone, another number, a phone nobody wrote to, or a delivery already served", async () => {
    const r = rig();
    await createSession();
    await createSession();
    const order = await paidOrder(shop);
    // Before any opener: nothing is expected.
    const early = await r.hear({ session: (await sql<{ session_name: string }[]>`SELECT session_name FROM waha_sessions WHERE active LIMIT 1`)[0]?.session_name ?? "", chatId: order.chatId, body: "halo" });
    await early.run();
    expect(await inboundOf(early.inboundId)).toMatchObject({ outcome: "no_code" });
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    const number = await openerSession(order);
    const otherNumber = (await sql<{ session_name: string }[]>`SELECT session_name FROM waha_sessions WHERE active AND id <> ${number.id} LIMIT 1`)[0]?.session_name ?? "";
    for (const [session, chat] of [[number.name, "6281999900777@c.us"], [otherNumber, order.chatId]] as const) {
      const heard = await r.hear({ session, chatId: chat, body: "ok" });
      await heard.run();
      expect(await inboundOf(heard.inboundId), `${session} ${chat}`).toMatchObject({ outcome: "no_code" });
    }
    expect(r.files()).toEqual([]);
    // Served once, a further "ok" matches nothing any more.
    const heard = await r.hear({ session: number.name, chatId: order.chatId, body: "ok" });
    await heard.run();
    expect(r.files()).toHaveLength(1);
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    const after = await r.hear({ session: number.name, chatId: order.chatId, body: "makasih" });
    await after.run();
    expect(await inboundOf(after.inboundId)).toMatchObject({ outcome: "no_code" });
    expect(r.files()).toHaveLength(1);
  });

  it("an opener that may have gone out (unknown) is answered like one that did; the reply to it still claims the delivery once", async () => {
    const r = rig();
    const flaky = await createSession();
    r.waha.fault(flaky.name, "timeout_after_send");
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("unknown");
    r.waha.fault(flaky.name, undefined);
    const heard = await r.hear({ session: flaky.name, chatId: order.chatId, body: "ok" });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.files()).toHaveLength(1);
  });
});
