// US-021 criteria 2-4: the payment.notification consumer (src/payments.ts) against PostgreSQL as the
// worker_rw login and infra/midtrans-stub. Every decision is taken on the RE-QUERIED status; the inbox
// rows here carry no body at all.
import { randomBytes } from "node:crypto";
import { getTransactionStatus } from "@ebooktrivia/adapters";
import { afterAll, describe, expect, it, vi } from "vitest";
import { inertFailpoint } from "../src/failpoint.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { applyRequery, createPaymentNotificationConsumer, EFFECT_CANCELLED, PAYMENT_MAX_ATTEMPTS, type MidtransSource, requeryInstant } from "../src/payments.ts";
import { expireLeases } from "../src/sweepers.ts";
import { first, sql } from "./support/db.ts";
import {
  alertsFor,
  barrier,
  createOrder,
  createShop,
  effectsOf,
  midtransStub,
  type MidtransStub,
  notification,
  type Order,
  PRICE_IDR,
  retireEffects,
  type Shop,
  crownWinner,
  effectRows,
  eligibilityOf,
  winnerOf,
  silentLog,
  uniquePhone,
  WA_DELAY_MS,
  workerPool,
} from "./support/midtrans.ts";

const shop: Shop = await createShop();
const workerSql = workerPool(8);
// Rows left unprocessed on purpose (failure cases) and due effects must not reach later files' relays and sweepers.
afterAll(() => retireEffects(shop));

function processor(stub: MidtransStub, pool = workerSql, source: MidtransSource = stub.source) {
  const consumer = createPaymentNotificationConsumer({ sql: pool, midtrans: source, log: silentLog, waDelayMs: WA_DELAY_MS });
  return createOutboxProcessor(consumer, { sql: pool, failpoint: inertFailpoint, log: silentLog });
}

/** A fresh stub transaction for the order's attempt n, in `state`, then one notification processed. */
async function settle(stub: MidtransStub, order: Order, state: Record<string, unknown>, n = 1): Promise<string> {
  await stub.setState(order.midtransId(n), state);
  const outboxId = await notification(order.midtransId(n), String(state["transaction_status"]));
  expect(await processor(stub)({ id: outboxId })).toBe("processed");
  return outboxId;
}

async function newPaidOrder(stub: MidtransStub, options: Parameters<typeof createOrder>[1] = {}): Promise<Order> {
  const order = await createOrder(shop, options);
  await stub.create(order.midtransId());
  await settle(stub, order, { transaction_status: "settlement", payment_type: "qris" });
  return order;
}

const outboxState = async (id: string) =>
  first(
    await sql<{ attempts: number; processed: boolean; last_error: string | null; backoff_ms: number }[]>`
      SELECT attempts, processed_at IS NOT NULL AS processed, last_error, round(extract(epoch FROM available_at - now()) * 1000)::int AS backoff_ms
        FROM outbox WHERE id = ${id}`,
  );

describe("PAID on a confirmed settlement: one transaction, all effects (AC-S6, criterion 2)", () => {
  it("sets the order, the player, eligibility, deliveries, one MT per sink, the outbox, the ledger and the audit", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    const outboxId = await settle(stub, order, { transaction_status: "settlement", payment_type: "qris" });

    const effects = await effectsOf(order.id);
    expect(effects).toMatchObject({ status: "paid", deliveries: 2, mt: ["meta", "s2s", "tiktok"], reversals: [], order_paid_outbox: 1, paid_transitions: 1 });
    const paidAt = effects.paid_at as Date;
    const player = first(await sql<{ id: string; phone: string; name: string }[]>`SELECT id, phone, name FROM players WHERE id = ${effects.player_id ?? ""}`);
    expect(player).toMatchObject({ phone: order.phone, name: "Budi Santoso" });
    expect(first(await sql<{ eligible: boolean; first_paid_at: Date }[]>`SELECT eligible, first_paid_at FROM player_programs WHERE player_id = ${player.id} AND program_id = ${shop.programId}`)).toEqual({
      eligible: true,
      first_paid_at: paidAt,
    });
    const deliveries = await sql<{ channel: string; status: string; not_before: Date }[]>`SELECT channel, status::text AS status, not_before FROM deliveries WHERE order_id = ${order.id} ORDER BY channel`;
    expect(deliveries).toEqual([
      { channel: "email", status: "pending", not_before: paidAt },
      { channel: "whatsapp", status: "pending", not_before: new Date(paidAt.getTime() + WA_DELAY_MS) },
    ]);
    const mt = await sql<{ sink: string; adnet_id: string | null; txid: string; value_idr: string; status: string; event_id: string }[]>`
      SELECT sink, adnet_id, txid, value_idr::text AS value_idr, status::text AS status, event_id FROM conversion_events WHERE order_id = ${order.id} ORDER BY sink`;
    const eventId = first(await sql<{ event_id: string }[]>`SELECT event_id FROM orders WHERE id = ${order.id}`).event_id;
    expect(mt).toEqual(
      ["meta", "s2s", "tiktok"].map((sink) => ({ sink, adnet_id: sink === "s2s" ? shop.adnetId : null, txid: order.id, value_idr: String(PRICE_IDR), status: "pending", event_id: eventId })),
    );
    expect(first(await sql<{ payload: unknown }[]>`SELECT payload FROM outbox WHERE dedupe_key = ${`order.paid:${order.id}`}`).payload).toEqual({ order_id: order.id });
    expect(await sql`SELECT transaction_status, gross_amount_idr::text AS gross, currency, payment_type, settled_at IS NOT NULL AS settled FROM payments WHERE order_id = ${order.id}`).toEqual([
      { transaction_status: "settlement", gross: String(PRICE_IDR), currency: "IDR", payment_type: "qris", settled: true },
    ]);
    expect(first(await sql<{ gateway_status: string; checked: boolean }[]>`SELECT gateway_status, gateway_checked_at IS NOT NULL AS checked FROM midtrans_attempts WHERE order_id = ${order.id}`)).toEqual({
      gateway_status: "settlement",
      checked: true,
    });
    expect(await sql`SELECT processed_at IS NOT NULL AS processed FROM payment_notifications WHERE outbox_id = ${outboxId}`).toEqual([{ processed: true }]);
    // The program locks at its first PAID order (US-017), and nothing alerted.
    expect(first(await sql<{ locked: boolean }[]>`SELECT locked_at IS NOT NULL AS locked FROM programs WHERE id = ${shop.programId}`).locked).toBe(true);
    expect(await alertsFor(order.id)).toEqual([]);
  });

  it("an organic order gets no S2S row, and a returning buyer keeps one player", async () => {
    const stub = midtransStub();
    const first_ = await newPaidOrder(stub, { attributed: false });
    expect((await effectsOf(first_.id)).mt).toEqual(["meta", "tiktok"]);
    const again = await newPaidOrder(stub, { phone: first_.phone });
    expect((await effectsOf(again.id)).player_id).toBe((await effectsOf(first_.id)).player_id);
  });
});

describe("exactly once (AC-S7, criterion 4, design: enforced in the DB)", () => {
  it("5 notifications of one order, each job run twice: 1 PAID, 1 delivery set, 1 MT per sink, 1 outbox row", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    await stub.setState(order.midtransId(), { transaction_status: "settlement" });
    const outboxIds = [];
    for (const label of ["pending", "settlement", "settlement", "settlement", "unknown"]) outboxIds.push(await notification(order.midtransId(), label));
    const process = processor(stub);
    for (const id of outboxIds) {
      expect(await process({ id })).toBe("processed");
      expect(await process({ id })).toBe("skipped");
    }
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", deliveries: 2, mt: ["meta", "s2s", "tiktok"], order_paid_outbox: 1, paid_transitions: 1 });
    expect(stub.statusCalls.filter((id) => id === order.midtransId())).toHaveLength(5);
  });

  it("two workers processing the same order's notifications at once still give exactly one PAID effect", async () => {
    for (let round = 0; round < 5; round++) {
      const stub = midtransStub();
      const order = await createOrder(shop);
      await stub.create(order.midtransId());
      await stub.setState(order.midtransId(), { transaction_status: "settlement" });
      const [a, b] = [await notification(order.midtransId(), "settlement"), await notification(order.midtransId(), "pending")];
      // Both re-queries are answered only once both are in flight, so both finalizers race for the order.
      stub.hold = barrier(2);
      const results = await Promise.all([processor(stub, workerPool(2))({ id: a }), processor(stub, workerPool(2))({ id: b })]);
      expect(results).toEqual(["processed", "processed"]);
      expect(await effectsOf(order.id)).toMatchObject({ status: "paid", deliveries: 2, mt: ["meta", "s2s", "tiktok"], order_paid_outbox: 1, paid_transitions: 1 });
    }
  });

  it("re-applying a settlement to a paid order (a replay that slipped past the inbox) adds nothing", async () => {
    const stub = midtransStub();
    const order = await newPaidOrder(stub);
    const before = await effectsOf(order.id);
    const attempt = { id: order.attempts.get(1) ?? "", orderId: order.id, n: 1, midtransOrderId: order.midtransId() };
    const status = { orderId: order.midtransId(), statusCode: "200", grossAmount: `${String(PRICE_IDR)}.00`, transactionStatus: "settlement", fraudStatus: "accept", transactionId: undefined, paymentType: undefined, currency: "IDR", transactionTime: undefined };
    const outcome = await workerSql.begin((tx) => applyRequery(tx, attempt, status, new Date(), { waDelayMs: WA_DELAY_MS, source: "notification" }));
    expect(outcome).toMatchObject({ kind: "applied", from: "paid", to: "paid", event: "settlement", alert: null });
    expect(await effectsOf(order.id)).toEqual(before);
  });

  it("a second PAID (review -> paid on another attempt) repeats no effect: the DB keys absorb it", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop, { attempts: ["created", "created"] });
    await stub.create(order.midtransId(1));
    await stub.create(order.midtransId(2));
    await settle(stub, order, { transaction_status: "settlement" }, 1);
    await settle(stub, order, { transaction_status: "partial_refund" }, 1);
    expect((await effectsOf(order.id)).status).toBe("review");
    // In review nothing unsent goes out (P2-2) ...
    const held = await effectRows(order.id);
    expect([...held.deliveries, ...held.mt].map((r) => [r.status, r.last_error])).toEqual([
      ["cancelled", EFFECT_CANCELLED],
      ["cancelled", EFFECT_CANCELLED],
      ["failed", EFFECT_CANCELLED],
      ["failed", EFFECT_CANCELLED],
      ["failed", EFFECT_CANCELLED],
    ]);
    await settle(stub, order, { transaction_status: "settlement" }, 2);
    const effects = await effectsOf(order.id);
    expect(effects).toMatchObject({ status: "paid", deliveries: 2, mt: ["meta", "s2s", "tiktok"], order_paid_outbox: 1, paid_transitions: 2 });
    // ... and back in PAID it goes out again, once.
    const back = await effectRows(order.id);
    expect([...back.deliveries, ...back.mt].map((r) => [r.status, r.last_error])).toEqual(Array.from({ length: 5 }, () => ["pending", null]));
    expect((await eligibilityOf(effects.player_id ?? "", shop.programId)).eligible).toBe(true);
  });

  it("an older re-query never overwrites a newer one (stale: nothing applied)", async () => {
    const stub = midtransStub();
    const order = await newPaidOrder(stub);
    const attempt = { id: order.attempts.get(1) ?? "", orderId: order.id, n: 1, midtransOrderId: order.midtransId() };
    const stale = { orderId: order.midtransId(), statusCode: "200", grossAmount: `${String(PRICE_IDR)}.00`, transactionStatus: "refund", fraudStatus: undefined, transactionId: undefined, paymentType: undefined, currency: "IDR", transactionTime: undefined };
    const outcome = await workerSql.begin((tx) => applyRequery(tx, attempt, stale, new Date(Date.now() - 3_600_000), { waDelayMs: WA_DELAY_MS, source: "notification" }));
    expect(outcome).toEqual({ kind: "stale" });
    expect((await effectsOf(order.id)).status).toBe("paid");
  });
});

describe("the transition table on re-queried statuses (criterion 4)", () => {
  it("deny -> retry with another method -> paid", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    await settle(stub, order, { transaction_status: "deny", payment_type: "credit_card" });
    expect(await effectsOf(order.id)).toMatchObject({ status: "pending", deliveries: 0, mt: [] });
    await settle(stub, order, { transaction_status: "settlement", payment_type: "gopay", new_transaction: true });
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", deliveries: 2, paid_transitions: 1 });
    // Both Midtrans transactions of the attempt are in the ledger.
    const ledger = await sql<{ transaction_status: string }[]>`SELECT transaction_status FROM payments WHERE order_id = ${order.id} ORDER BY created_at`;
    expect(ledger.map((r) => r.transaction_status)).toEqual(["deny", "settlement"]);
  });

  it.each([
    ["cancel", "gateway_failed"],
    ["expire", "expired"],
    ["failure", "gateway_failed"],
  ])("%s -> %s, then a late settlement -> paid (plan §10 item 8)", async (status, closed) => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    await settle(stub, order, { transaction_status: status });
    expect(await effectsOf(order.id)).toMatchObject({ status: closed, deliveries: 0 });
    await settle(stub, order, { transaction_status: "settlement" });
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", deliveries: 2, mt: ["meta", "s2s", "tiktok"], paid_transitions: 1 });
  });

  it("a pending notification changes nothing; a status of an older attempt does not close the order", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop, { attempts: ["created", "created"] });
    await stub.create(order.midtransId(1));
    await stub.create(order.midtransId(2));
    await settle(stub, order, { transaction_status: "pending" }, 2);
    await settle(stub, order, { transaction_status: "expire" }, 1);
    expect((await effectsOf(order.id)).status).toBe("pending");
  });

  it("partial refund -> review: no new effects, eligibility follows the paid orders, the Owner is alerted", async () => {
    const stub = midtransStub();
    const order = await newPaidOrder(stub);
    await settle(stub, order, { transaction_status: "partial_refund" });
    const effects = await effectsOf(order.id);
    expect(effects).toMatchObject({ status: "review", deliveries: 2, mt: ["meta", "s2s", "tiktok"], reversals: [] });
    expect(first(await sql<{ eligible: boolean }[]>`SELECT eligible FROM player_programs WHERE player_id = ${effects.player_id ?? ""} AND program_id = ${shop.programId}`).eligible).toBe(false);
    expect(await alertsFor(order.id)).toEqual([expect.objectContaining({ kind: "payment_review", severity: "warning" })]);
  });

  it("a fraud challenge on the settlement never pays: review, critical alert", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    await settle(stub, order, { transaction_status: "settlement", fraud_status: "challenge" });
    expect(await effectsOf(order.id)).toMatchObject({ status: "review", deliveries: 0, mt: [] });
    expect(await alertsFor(order.id)).toEqual([expect.objectContaining({ kind: "payment_settlement_review", severity: "critical", payload: expect.objectContaining({ reason: "fraud_review" }) as unknown })]);
  });
});

describe("amounts and double payments (design constraints)", () => {
  it.each([
    [{ gross_amount: `${String(PRICE_IDR + 1)}.00` }, "amount_mismatch", [String(PRICE_IDR + 1)]],
    [{ gross_amount: `${String(PRICE_IDR)}.50` }, "amount_mismatch", []],
    [{ currency: "USD" }, "currency_mismatch", []],
  ])("a settlement of the wrong amount or currency is rejected: never PAID, review, critical alert (%o)", async (override, reason, ledger) => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    await settle(stub, order, { transaction_status: "settlement", ...override });
    expect(await effectsOf(order.id)).toMatchObject({ status: "review", paid_at: null, deliveries: 0, mt: [], order_paid_outbox: 0, paid_transitions: 0 });
    expect(await alertsFor(order.id)).toEqual([expect.objectContaining({ kind: "payment_settlement_review", severity: "critical", payload: expect.objectContaining({ reason }) as unknown })]);
    // The ledger records the money that really moved, when an IDR row can hold it.
    expect((await sql<{ gross: string }[]>`SELECT gross_amount_idr::text AS gross FROM payments WHERE order_id = ${order.id}`).map((r) => r.gross)).toEqual(ledger);
  });

  it("a second settlement on another attempt of a paid order is not a second PAID: a double-charge alert", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop, { attempts: ["created", "created"] });
    await stub.create(order.midtransId(1));
    await stub.create(order.midtransId(2));
    await settle(stub, order, { transaction_status: "settlement" }, 1);
    const before = await effectsOf(order.id);
    await settle(stub, order, { transaction_status: "settlement" }, 2);
    expect(await effectsOf(order.id)).toEqual(before);
    expect(await alertsFor(order.id)).toEqual([expect.objectContaining({ kind: "payment_double_settlement", severity: "critical", payload: expect.objectContaining({ attempt: 2 }) as unknown })]);
    // The kept attempt's money stands: a refund of the second one leaves the order paid (and alerts).
    await settle(stub, order, { transaction_status: "refund" }, 2);
    expect((await effectsOf(order.id)).status).toBe("paid");
  });
});

describe("refunds and chargebacks (criterion 3)", () => {
  /** Marks the order's S2S MT as sent by its sink (what US-024 will do). */
  const s2sSent = (orderId: string) => sql`UPDATE conversion_events SET status = 'sent', attempts = 1, sent_at = now() WHERE order_id = ${orderId} AND sink = 's2s' AND kind = 'mt'`;

  it("a refund recomputes eligibility from the remaining paid orders and reverses only an MT that may have reached its sink", async () => {
    const stub = midtransStub();
    const a = await newPaidOrder(stub);
    const b = await newPaidOrder(stub, { phone: a.phone });
    const player = (await effectsOf(a.id)).player_id ?? "";

    await s2sSent(a.id);
    await settle(stub, a, { transaction_status: "refund" });
    const refunded = await effectsOf(a.id);
    expect(refunded).toMatchObject({ status: "refunded", reversals: ["s2s"], mt: ["meta", "s2s", "tiktok"] });
    expect(refunded.refunded_at).not.toBeNull();
    expect((await eligibilityOf(player, shop.programId)).eligible).toBe(true);

    // b's MTs never left: they are cancelled, and nothing needs reversing.
    await settle(stub, b, { transaction_status: "refund" });
    expect(await effectsOf(b.id)).toMatchObject({ status: "refunded", reversals: [] });
    expect((await effectRows(b.id)).mt.map((r) => [r.status, r.last_error])).toEqual([
      ["failed", EFFECT_CANCELLED],
      ["failed", EFFECT_CANCELLED],
      ["failed", EFFECT_CANCELLED],
    ]);
    expect(await eligibilityOf(player, shop.programId)).toEqual({ eligible: false, first_paid_at: null });
    // A replayed refund changes nothing; an organic order (no S2S MT) gets no reversal.
    await settle(stub, a, { transaction_status: "refund" });
    expect((await effectsOf(a.id)).reversals).toEqual(["s2s"]);
    const organic = await newPaidOrder(stub, { attributed: false });
    await settle(stub, organic, { transaction_status: "refund" });
    expect((await effectsOf(organic.id)).reversals).toEqual([]);
  });

  it("P2-2: a refund inside the 3-minute WhatsApp window cancels what was not sent and leaves what was", async () => {
    const stub = midtransStub();
    const order = await newPaidOrder(stub);
    await sql`UPDATE deliveries SET status = 'sent', sent_at = now() WHERE order_id = ${order.id} AND channel = 'email'`;
    expect((await effectRows(order.id)).deliveries.map((d) => d.status)).toEqual(["sent", "pending"]);
    await settle(stub, order, { transaction_status: "refund" });
    expect((await effectRows(order.id)).deliveries).toEqual([
      { channel: "email", status: "sent", last_error: null },
      { channel: "whatsapp", status: "cancelled", last_error: EFFECT_CANCELLED },
    ]);
  });

  it("P2-A: a delivery or MT in flight at refund time never goes out after its lease expires", async () => {
    const stub = midtransStub();
    const order = await newPaidOrder(stub);
    await sql`UPDATE deliveries SET status = 'sending', lease_until = now() - interval '1 second', attempts = 1 WHERE order_id = ${order.id} AND channel = 'email'`;
    await sql`UPDATE conversion_events SET status = 'sending', lease_until = now() - interval '1 second', attempts = 1 WHERE order_id = ${order.id} AND sink = 's2s' AND kind = 'mt'`;
    await settle(stub, order, { transaction_status: "refund" });
    // The S2S MT may have reached its sink: it gets its reversal.
    expect((await effectsOf(order.id)).reversals).toEqual(["s2s"]);
    // The lease sweeper, even for a sink that dedupes (it would retry), makes neither due again.
    await expireLeases(workerSql, () => true);
    const rows = await effectRows(order.id);
    expect(rows.deliveries.find((d) => d.channel === "email")?.status).toBe("unknown");
    expect(rows.mt.find((m) => m.sink === "s2s")).toEqual({ sink: "s2s", status: "failed", last_error: EFFECT_CANCELLED });
    // And the database refuses any retry, claim or re-fire of the refunded order (ET080).
    for (const status of ["pending", "sending"]) {
      const refused = async (statement: Promise<unknown>) => statement.then(() => "updated", (e: unknown) => (e as { code?: string }).code);
      expect(await refused(workerSql`UPDATE public.deliveries SET status = ${status} WHERE order_id = ${order.id} AND channel = 'email'`)).toBe("ET080");
      expect(await refused(workerSql`UPDATE public.conversion_events SET status = ${status} WHERE order_id = ${order.id} AND sink = 'meta' AND kind = 'mt'`)).toBe("ET080");
    }
  });

  it("r1: an MT waiting to retry when the order went to review comes back after review -> paid", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop, { attempts: ["created", "created"] });
    await stub.create(order.midtransId(1));
    await stub.create(order.midtransId(2));
    await settle(stub, order, { transaction_status: "settlement" }, 1);
    await sql`UPDATE conversion_events SET attempts = 1, next_attempt_at = now() + interval '5 minutes' WHERE order_id = ${order.id} AND sink = 'meta' AND kind = 'mt'`;
    await settle(stub, order, { transaction_status: "partial_refund" }, 1);
    expect((await effectRows(order.id)).mt.find((m) => m.sink === "meta")).toEqual({ sink: "meta", status: "failed", last_error: EFFECT_CANCELLED });
    await settle(stub, order, { transaction_status: "settlement" }, 2);
    expect((await effectRows(order.id)).mt.find((m) => m.sink === "meta")).toEqual({ sink: "meta", status: "pending", last_error: null });
    expect(first(await sql<{ attempts: number }[]>`SELECT attempts FROM conversion_events WHERE order_id = ${order.id} AND sink = 'meta' AND kind = 'mt'`).attempts).toBe(1);
  });

  it("D4: first_paid_at is the earliest payment that still stands (pay, refund, buy again later)", async () => {
    const stub = midtransStub();
    const early = await newPaidOrder(stub);
    const player = (await effectsOf(early.id)).player_id ?? "";
    await settle(stub, early, { transaction_status: "refund" });
    expect(await eligibilityOf(player, shop.programId)).toEqual({ eligible: false, first_paid_at: null });
    const later = await newPaidOrder(stub, { phone: early.phone });
    expect(await eligibilityOf(player, shop.programId)).toEqual({ eligible: true, first_paid_at: (await effectsOf(later.id)).paid_at });
  });

  it("a chargeback after the winner is confirmed flags the winner and halts fulfillment, with a critical alert", async () => {
    const stub = midtransStub();
    const order = await newPaidOrder(stub);
    const winner = await crownWinner(shop, (await effectsOf(order.id)).player_id ?? "", { fulfillment: true });

    await settle(stub, order, { transaction_status: "chargeback" });
    expect((await effectsOf(order.id)).status).toBe("refunded");
    expect(await winnerOf(winner)).toEqual({ status: "flagged", flag_reason: "chargeback" });
    expect(await alertsFor(order.id)).toEqual([
      expect.objectContaining({ kind: "payment_chargeback", severity: "critical", payload: expect.objectContaining({ event: "chargeback", to: "refunded" }) as unknown }),
      expect.objectContaining({ kind: "winner_flagged", severity: "critical", payload: expect.objectContaining({ winner_ids: [winner] }) as unknown }),
    ]);
    // Fulfillment is halted until the Owner decides (fulfillments_halt_guard, ET082).
    const halted = await sql
      .begin(async (tx) => {
        await tx`SET LOCAL ROLE admin_rw`;
        await tx`UPDATE public.fulfillments SET status = 'sent' WHERE winner_id = ${winner}`;
      })
      .then(
        () => "updated",
        (e: unknown) => (e as { code?: string }).code,
      );
    expect(halted).toBe("ET082");
  });

  it("D5: a partial chargeback moves a paid order to review, suspends eligibility and flags the winner", async () => {
    const stub = midtransStub();
    const order = await newPaidOrder(stub);
    const player = (await effectsOf(order.id)).player_id ?? "";
    const winner = await crownWinner(shop, player);
    await settle(stub, order, { transaction_status: "partial_chargeback" });
    expect((await effectsOf(order.id)).status).toBe("review");
    expect((await eligibilityOf(player, shop.programId)).eligible).toBe(false);
    expect(await winnerOf(winner)).toEqual({ status: "flagged", flag_reason: "chargeback" });
    expect((await alertsFor(order.id)).map((a) => [a.kind, a.severity])).toEqual([
      ["payment_chargeback", "critical"],
      ["payment_review", "warning"],
      ["winner_flagged", "critical"],
    ]);
  });

  it("D5: a partial refund moves a paid order to review and suspends eligibility (no flag while another order stands)", async () => {
    const stub = midtransStub();
    const order = await newPaidOrder(stub);
    const player = (await effectsOf(order.id)).player_id ?? "";
    await settle(stub, order, { transaction_status: "partial_refund" });
    expect((await effectsOf(order.id)).status).toBe("review");
    expect((await eligibilityOf(player, shop.programId)).eligible).toBe(false);
    // With a second paid order the player stays eligible, and a live winner is not flagged.
    const other = await newPaidOrder(stub);
    const second = await newPaidOrder(stub, { phone: other.phone });
    const otherPlayer = (await effectsOf(other.id)).player_id ?? "";
    const winner = await crownWinner(shop, otherPlayer, { confirmed: false });
    await settle(stub, other, { transaction_status: "partial_refund" });
    expect((await eligibilityOf(otherPlayer, shop.programId)).eligible).toBe(true);
    expect(await winnerOf(winner)).toEqual({ status: "awaiting_confirmation", flag_reason: null });
    expect((await effectsOf(second.id)).status).toBe("paid");
  });

  it("m5: a refund that leaves no paid order flags the winner no_paid_order", async () => {
    const stub = midtransStub();
    const order = await newPaidOrder(stub);
    const winner = await crownWinner(shop, (await effectsOf(order.id)).player_id ?? "");
    await settle(stub, order, { transaction_status: "refund" });
    expect(await winnerOf(winner)).toEqual({ status: "flagged", flag_reason: "no_paid_order" });
  });

  it("P2-3: a chargeback of a double payment keeps the order paid and still raises a critical alert (no winner yet)", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop, { attempts: ["created", "created"] });
    await stub.create(order.midtransId(1));
    await stub.create(order.midtransId(2));
    await settle(stub, order, { transaction_status: "settlement" }, 1);
    await settle(stub, order, { transaction_status: "settlement" }, 2);
    await settle(stub, order, { transaction_status: "chargeback" }, 2);
    expect((await effectsOf(order.id)).status).toBe("paid");
    expect((await alertsFor(order.id)).map((a) => [a.kind, a.severity])).toEqual(
      expect.arrayContaining([
        ["payment_chargeback", "critical"],
        ["payment_double_settlement", "critical"],
      ]),
    );
  });
});

describe("Owner D10: a card capture with fraud accept is PAID (US-005 recorded capture at once, settlement the next day)", () => {
  const paymentRow = async (orderId: string) =>
    first(await sql<{ transaction_status: string; settled_at: Date | null }[]>`SELECT transaction_status, settled_at FROM payments WHERE order_id = ${orderId}`);

  it("pays at the capture and stamps paid_at and payments.settled_at; the next day's settlement changes nothing (no ET081, no alert, no second effect)", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    await settle(stub, order, { transaction_status: "capture", fraud_status: "accept", payment_type: "credit_card" });
    const paid = await effectsOf(order.id);
    expect(paid).toMatchObject({ status: "paid", deliveries: 2, mt: ["meta", "s2s", "tiktok"], paid_transitions: 1, order_paid_outbox: 1 });
    expect(paid.paid_at).not.toBeNull();
    const captured = await paymentRow(order.id);
    expect(captured.transaction_status).toBe("capture");
    expect(captured.settled_at).not.toBeNull();

    await settle(stub, order, { transaction_status: "settlement", payment_type: "credit_card" });
    const later = await effectsOf(order.id);
    expect(later).toMatchObject({ status: "paid", deliveries: 2, mt: ["meta", "s2s", "tiktok"], paid_transitions: 1, order_paid_outbox: 1 });
    // The stamps are set once: the same instants after the settlement.
    expect(later.paid_at).toEqual(paid.paid_at);
    const settled = await paymentRow(order.id);
    expect(settled.transaction_status).toBe("settlement");
    expect(settled.settled_at).toEqual(captured.settled_at);
    expect(await alertsFor(order.id)).toEqual([]);
  });

  it("a capture with challenge never pays (review, warning) and one with deny leaves the order pending", async () => {
    const stub = midtransStub();
    const challenged = await createOrder(shop);
    await stub.create(challenged.midtransId());
    await settle(stub, challenged, { transaction_status: "capture", fraud_status: "challenge", payment_type: "credit_card" });
    expect(await effectsOf(challenged.id)).toMatchObject({ status: "review", deliveries: 0, mt: [], paid_at: null });
    expect(await alertsFor(challenged.id)).toEqual([expect.objectContaining({ kind: "payment_review", severity: "warning" })]);
    expect((await paymentRow(challenged.id)).settled_at).toBeNull();

    const denied = await createOrder(shop);
    await stub.create(denied.midtransId());
    await settle(stub, denied, { transaction_status: "capture", fraud_status: "deny", payment_type: "credit_card" });
    expect(await effectsOf(denied.id)).toMatchObject({ status: "pending", deliveries: 0, mt: [], paid_at: null });
    expect((await paymentRow(denied.id)).settled_at).toBeNull();
  });

  it("a capture of a wrong amount or currency is review, never paid", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    await settle(stub, order, { transaction_status: "capture", fraud_status: "accept", payment_type: "credit_card", gross_amount: "1000.00" });
    expect(await effectsOf(order.id)).toMatchObject({ status: "review", deliveries: 0, paid_at: null });
    expect(await alertsFor(order.id)).toEqual([expect.objectContaining({ kind: "payment_settlement_review", severity: "critical" })]);
  });
});

describe("Owner D9: Midtrans reverses a payment we counted (Permata VA, Mandiri Bill, Indomaret: settlement, then deny within minutes)", () => {
  const PERMATA = { transaction_status: "settlement", payment_type: "bank_transfer", bank: "permata" } as const;
  const liveLinks = async (playerId: string) =>
    first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM magic_links WHERE player_id = ${playerId} AND consumed_at IS NULL`).n;
  const addLinks = (playerId: string) =>
    sql`INSERT INTO magic_links (player_id, channel, token_hash, expires_at)
        VALUES (${playerId}, 'email', ${randomBytes(32)}, now() + interval '72 hours'), (${playerId}, 'whatsapp', ${randomBytes(32)}, now() + interval '72 hours')`;

  async function paidOrder(stub: MidtransStub, state: Record<string, unknown> = PERMATA, options: Parameters<typeof createOrder>[1] = {}): Promise<Order> {
    const order = await createOrder(shop, options);
    await stub.create(order.midtransId());
    await settle(stub, order, state);
    return order;
  }

  it.each(["deny", "expire", "failure", "cancel"])(
    "%s of the paid attempt: review, eligibility suspended, live links revoked, a persisted CRITICAL alert, the sent e-mail is NOT recalled and the unsent WhatsApp is cancelled",
    async (status) => {
      const stub = midtransStub();
      const order = await paidOrder(stub);
      const player = (await effectsOf(order.id)).player_id ?? "";
      expect((await eligibilityOf(player, shop.programId)).eligible).toBe(true);
      const winner = await crownWinner(shop, player, { confirmed: false });
      await addLinks(player);
      expect(await liveLinks(player)).toBe(2);
      // Instant delivery: the e-mail went out already; the WhatsApp opener waits its 3 minutes.
      await sql`UPDATE deliveries SET status = 'sent', sent_at = now() WHERE order_id = ${order.id} AND channel = 'email'`;

      await settle(stub, order, { transaction_status: status });

      expect(await effectsOf(order.id)).toMatchObject({ status: "review", refunded_at: null, reversals: [] });
      expect((await eligibilityOf(player, shop.programId)).eligible).toBe(false);
      expect(await liveLinks(player)).toBe(0);
      expect((await effectRows(order.id)).deliveries).toEqual([
        { channel: "email", status: "sent", last_error: null },
        { channel: "whatsapp", status: "cancelled", last_error: EFFECT_CANCELLED },
      ]);
      // The MTs that may have reached their sinks are NOT reversed (no reversal row): only a later refund does that.
      expect((await effectsOf(order.id)).reversals).toEqual([]);
      expect(await winnerOf(winner)).toEqual({ status: "flagged", flag_reason: "no_paid_order" });
      const alerts = await alertsFor(order.id);
      expect(alerts.filter((a) => a.kind === "payment_paid_reversed")).toEqual([
        expect.objectContaining({ severity: "critical", payload: expect.objectContaining({ from: "paid", to: "review", event: status, magic_links_revoked: 2 }) as unknown }),
      ]);
      expect(alerts.map((a) => a.kind)).not.toContain("payment_review");
    },
  );

  it("review is the Owner's: a repeated notification changes nothing, and a later settlement of the same payment restores the order (effects back, eligibility back)", async () => {
    const stub = midtransStub();
    const order = await paidOrder(stub);
    const player = (await effectsOf(order.id)).player_id ?? "";
    await settle(stub, order, { transaction_status: "deny", payment_type: "bank_transfer", bank: "permata" });
    expect((await effectsOf(order.id)).status).toBe("review");
    // The same deny again (a replay): still review, one alert.
    await settle(stub, order, { transaction_status: "deny", payment_type: "bank_transfer", bank: "permata" });
    expect((await effectsOf(order.id)).status).toBe("review");
    expect((await alertsFor(order.id)).filter((a) => a.kind === "payment_paid_reversed")).toHaveLength(1);
    // Midtrans settles it after all.
    await settle(stub, order, { transaction_status: "settlement", payment_type: "bank_transfer", bank: "permata" });
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", paid_transitions: 2 });
    expect((await eligibilityOf(player, shop.programId)).eligible).toBe(true);
    expect((await effectRows(order.id)).deliveries.map((d) => d.status)).toEqual(["pending", "pending"]);
  });

  it("a deny on an attempt that never held money does not touch a paid order (the buyer retried with another method)", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop, { attempts: ["created", "created"] });
    await stub.create(order.midtransId(1));
    await stub.create(order.midtransId(2));
    await settle(stub, order, { transaction_status: "settlement", payment_type: "qris" }, 1);
    // Attempt 2 (never settled) is denied: it is not the money.
    await settle(stub, order, { transaction_status: "deny", payment_type: "credit_card" }, 2);
    expect((await effectsOf(order.id)).status).toBe("paid");
    expect(await alertsFor(order.id)).toEqual([]);
    // A deny of attempt 1, which DID hold the money, is a reversal.
    await settle(stub, order, { transaction_status: "deny", payment_type: "qris" }, 1);
    expect((await effectsOf(order.id)).status).toBe("review");
  });

  it("fails closed: an intermediate pending or unknown status after the settlement cannot hide a later deny (the held fact is the attempt's payments.settled_at)", async () => {
    const stub = midtransStub();
    const order = await paidOrder(stub);
    const [payment] = await sql<{ settled_at: Date | null }[]>`SELECT settled_at FROM payments WHERE order_id = ${order.id}`;
    expect(payment?.settled_at).not.toBeNull();
    // Midtrans answers pending (a lagging or odd re-query), then a status we do not know, and the attempt's stored status is no longer "settlement".
    await settle(stub, order, { transaction_status: "pending", payment_type: "bank_transfer", bank: "permata" });
    expect((await effectsOf(order.id)).status).toBe("paid");
    await settle(stub, order, { transaction_status: "authorize", payment_type: "bank_transfer", bank: "permata" });
    expect((await effectsOf(order.id)).status).toBe("paid");
    expect(first(await sql<{ gateway_status: string }[]>`SELECT gateway_status FROM midtrans_attempts WHERE id = ${order.attempts.get(1) ?? ""}`).gateway_status).toBe("authorize");
    await settle(stub, order, { transaction_status: "deny", payment_type: "bank_transfer", bank: "permata" });
    expect((await effectsOf(order.id)).status).toBe("review");
    expect((await alertsFor(order.id)).map((a) => [a.kind, a.severity])).toContainEqual(["payment_paid_reversed", "critical"]);
    // The settled_at stamp itself is never cleared by the later statuses.
    expect(first(await sql<{ settled_at: Date | null }[]>`SELECT settled_at FROM payments WHERE order_id = ${order.id}`).settled_at).toEqual(payment?.settled_at);
  });

  it("a cancel is gated on held money too: a cancel of an attempt that never held money leaves a paid order alone (it used to send it to review)", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop, { attempts: ["created", "created"] });
    await stub.create(order.midtransId(1));
    await stub.create(order.midtransId(2));
    await settle(stub, order, { transaction_status: "settlement", payment_type: "qris" }, 1);
    // Attempt 1 holds the money: a cancel of attempt 2 is a doubt on a double payment at most (a warning), never a reversal.
    await settle(stub, order, { transaction_status: "cancel", payment_type: "credit_card" }, 2);
    expect((await effectsOf(order.id)).status).toBe("paid");
    expect((await alertsFor(order.id)).map((a) => a.kind)).not.toContain("payment_paid_reversed");
    // Attempt 1 then answers an intermediate pending (so no OTHER attempt counts as settled any more) and a fresh attempt-2 cancel arrives:
    // it still never held money, so the order stays paid and nothing is raised (it used to go to review).
    await settle(stub, order, { transaction_status: "pending", payment_type: "qris" }, 1);
    await sql`DELETE FROM alerts WHERE payload ->> 'order_id' = ${order.id}`;
    await settle(stub, order, { transaction_status: "failure", payment_type: "credit_card" }, 2);
    await settle(stub, order, { transaction_status: "cancel", payment_type: "credit_card" }, 2);
    expect((await effectsOf(order.id)).status).toBe("paid");
    expect(await alertsFor(order.id)).toEqual([]);
  });

  it("revokes no link while the player still has an eligible program row (another paid order stands), but still alerts critical", async () => {
    const stub = midtransStub();
    const reversed = await paidOrder(stub);
    const standing = await paidOrder(stub, { transaction_status: "settlement", payment_type: "qris" }, { phone: reversed.phone });
    const player = (await effectsOf(reversed.id)).player_id ?? "";
    expect((await effectsOf(standing.id)).player_id).toBe(player);
    await addLinks(player);
    await settle(stub, reversed, { transaction_status: "deny", payment_type: "bank_transfer", bank: "permata" });
    expect((await effectsOf(reversed.id)).status).toBe("review");
    expect((await eligibilityOf(player, shop.programId)).eligible).toBe(true);
    expect(await liveLinks(player)).toBe(2);
    expect((await alertsFor(reversed.id)).filter((a) => a.kind === "payment_paid_reversed")).toEqual([
      expect.objectContaining({ severity: "critical", payload: expect.objectContaining({ magic_links_revoked: 0 }) as unknown }),
    ]);
  });

  it("a double payment: when the OTHER attempt still holds money, the reversal of one only alerts (a warning) and the order stays paid", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop, { attempts: ["created", "created"] });
    await stub.create(order.midtransId(1));
    await stub.create(order.midtransId(2));
    await settle(stub, order, { transaction_status: "settlement", payment_type: "qris" }, 1);
    await settle(stub, order, { transaction_status: "settlement", payment_type: "gopay" }, 2);
    await settle(stub, order, { transaction_status: "deny", payment_type: "qris" }, 1);
    expect((await effectsOf(order.id)).status).toBe("paid");
    const kinds = (await alertsFor(order.id)).map((a) => a.kind);
    expect(kinds).toContain("payment_double_settlement");
    expect(kinds).not.toContain("payment_paid_reversed");
  });

  it("a capture that is later cancelled (the card never settles) also goes to review with the critical alert", async () => {
    const stub = midtransStub();
    const order = await paidOrder(stub, { transaction_status: "capture", fraud_status: "accept", payment_type: "credit_card" });
    expect((await effectsOf(order.id)).status).toBe("paid");
    await settle(stub, order, { transaction_status: "cancel", payment_type: "credit_card" });
    expect((await effectsOf(order.id)).status).toBe("review");
    expect((await alertsFor(order.id)).map((a) => [a.kind, a.severity])).toContainEqual(["payment_paid_reversed", "critical"]);
  });

  it("a re-query by the nightly reconciliation reverses the same way (one code path)", async () => {
    const stub = midtransStub();
    const order = await paidOrder(stub);
    await stub.setState(order.midtransId(), { transaction_status: "deny" });
    const status = await getTransactionStatus(await stub.source(workerSql), order.midtransId());
    if (status === undefined) throw new Error("expected a status");
    const attempt = { id: order.attempts.get(1) ?? "", orderId: order.id, n: 1, midtransOrderId: order.midtransId() };
    const outcome = await workerSql.begin((tx) => applyRequery(tx, attempt, status, new Date(), { waDelayMs: WA_DELAY_MS, source: "reconciliation" }));
    expect(outcome).toMatchObject({ kind: "applied", from: "paid", to: "review", event: "deny" });
    expect((await effectsOf(order.id)).status).toBe("review");
  });
});

describe("the stale guard orders re-queries by the DATABASE clock (security review, US-005)", () => {
  it("a worker whose own clock is years off still stamps gateway_checked_at with the database's instant (an older answer can never look newer)", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2031-06-01T00:00:00Z") });
    try {
      await settle(stub, order, { transaction_status: "pending" });
    } finally {
      vi.useRealTimers();
    }
    const row = first(
      await sql<{ checked: Date; now: Date }[]>`SELECT gateway_checked_at AS checked, clock_timestamp() AS now FROM midtrans_attempts WHERE id = ${order.attempts.get(1) ?? ""}`,
    );
    expect(Math.abs(row.now.getTime() - row.checked.getTime())).toBeLessThan(60_000);
  });

  it("requeryInstant reads the database clock, unless a clock is injected (the tests)", async () => {
    const before = Date.now();
    const instant = await requeryInstant(workerSql);
    expect(Math.abs(instant.getTime() - before)).toBeLessThan(60_000);
    const fixed = new Date("2030-01-01T00:00:00Z");
    expect(await requeryInstant(workerSql, () => fixed)).toBe(fixed);
  });
});

describe("re-query failures (criterion 2, criterion 4)", () => {
  it.each(["503", "network", "404"] as const)("a re-query failure (%s) is retried with backoff, then the order is paid", async (failure) => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    await stub.setState(order.midtransId(), { transaction_status: "settlement" });
    const outboxId = await notification(order.midtransId());
    stub.failures.push(failure);
    const process = processor(stub);
    await expect(process({ id: outboxId })).rejects.toThrow(/re-query/);
    const backedOff = await outboxState(outboxId);
    expect(backedOff).toMatchObject({ attempts: 1, processed: false });
    expect(backedOff.last_error).toMatch(/re-query/);
    expect(backedOff.backoff_ms).toBeGreaterThan(20_000);
    expect((await effectsOf(order.id)).status).toBe("pending");
    // The backoff passes (the outbox sweeper re-relays it): the retry pays the order.
    await sql`UPDATE outbox SET available_at = now() - interval '1 second' WHERE id = ${outboxId}`;
    expect(await process({ id: outboxId })).toBe("processed");
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", paid_transitions: 1 });
    expect(await alertsFor(order.id)).toEqual([]);
  });

  it("keeps retrying past the default outbox cap, and alerts once the notification is 24 h old", async () => {
    expect(PAYMENT_MAX_ATTEMPTS).toBeGreaterThan(30);
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    const outboxId = await notification(order.midtransId());
    const second = await notification(order.midtransId(), "pending");
    const dedupe = `payment_requery_failed:${order.id}`;
    // Past the default cap of 10 claims, still before 24 h: retried, no alert.
    await sql`UPDATE outbox SET attempts = 12 WHERE id = ${outboxId}`;
    stub.failures.push("503");
    await expect(processor(stub)({ id: outboxId })).rejects.toThrow(/re-query/);
    expect(await sql`SELECT 1 FROM alerts WHERE dedupe_key = ${dedupe}`).toEqual([]);
    // 25 h after the notifications arrived: both fail, ONE alert for the order (P2-4).
    await sql`UPDATE payment_notifications SET received_at = now() - interval '25 hours' WHERE midtrans_order_id = ${order.midtransId()}`;
    await sql`UPDATE outbox SET available_at = now() - interval '1 second' WHERE id = ${outboxId}`;
    stub.failures.push("503", "503");
    await expect(processor(stub)({ id: outboxId })).rejects.toThrow(/re-query/);
    await expect(processor(stub)({ id: second })).rejects.toThrow(/re-query/);
    expect(await sql`SELECT severity, payload FROM alerts WHERE dedupe_key = ${dedupe}`).toEqual([
      { severity: "critical", payload: { order_id: order.id, attempt: 1, code: "unavailable" } },
    ]);
    expect((await outboxState(outboxId)).attempts).toBe(14);
  });

  it("m2: a settlement label whose re-query still says pending is retried, never applied as a state", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    const outboxId = await notification(order.midtransId(), "settlement");
    await expect(processor(stub)({ id: outboxId })).rejects.toThrow(/still pending for a settlement notification/);
    expect(await outboxState(outboxId)).toMatchObject({ attempts: 1, processed: false });
    expect((await effectsOf(order.id)).status).toBe("pending");
    // A pending label with a pending status is simply applied (nothing to wait for).
    expect(await processor(stub)({ id: await notification(order.midtransId(), "pending") })).toBe("processed");
    await stub.setState(order.midtransId(), { transaction_status: "settlement" });
    await sql`UPDATE outbox SET available_at = now() - interval '1 second' WHERE id = ${outboxId}`;
    expect(await processor(stub)({ id: outboxId })).toBe("processed");
    expect((await effectsOf(order.id)).status).toBe("paid");
  });

  it("Owner D10: an accepted card capture pays the order at once, without an alert", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    await settle(stub, order, { transaction_status: "capture", fraud_status: "accept", payment_type: "credit_card" });
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", deliveries: 2, mt: ["meta", "s2s", "tiktok"], paid_transitions: 1 });
    expect(await alertsFor(order.id)).toEqual([]);
  });

  it("a refused server key alerts at once (configuration), and is retried", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    const outboxId = await notification(order.midtransId());
    const wrongKey: MidtransSource = async (pool) => ({ ...(await stub.source(pool)), serverKey: "SB-Mid-server-WRONG" });
    await expect(processor(stub, workerSql, wrongKey)({ id: outboxId })).rejects.toThrow(/re-query failed \(unauthorized\)/);
    const noKey: MidtransSource = () => Promise.reject(new Error("the Midtrans server key is unavailable (missing)"));
    await sql`UPDATE outbox SET available_at = now() - interval '1 second' WHERE id = ${outboxId}`;
    await expect(processor(stub, workerSql, noKey)({ id: outboxId })).rejects.toThrow(/re-query failed \(error\)/);
    expect(await sql`SELECT severity FROM alerts WHERE dedupe_key = 'payment_requery_misconfigured' AND resolved_at IS NULL`).toEqual([{ severity: "critical" }]);
    expect((await outboxState(outboxId)).processed).toBe(false);
  });

  it("drops a notification for a Midtrans order id we never created, with an alert", async () => {
    const stub = midtransStub();
    const outboxId = await notification(`${randomBytes(11).toString("hex")}-1`);
    expect(await processor(stub)({ id: outboxId })).toBe("processed");
    expect(stub.statusCalls).toEqual([]);
    expect((await sql`SELECT kind FROM alerts WHERE dedupe_key = 'payment_unknown_order'`).length).toBeGreaterThan(0);
  });

  it("refuses a malformed outbox payload without touching anything", async () => {
    const stub = midtransStub();
    const [row] = await sql<{ id: string }[]>`INSERT INTO outbox (topic, dedupe_key, payload) VALUES ('payment.notification', ${`forged:${randomBytes(4).toString("hex")}`}, '{"inbox_id": "x"}') RETURNING id`;
    await expect(processor(stub)({ id: row?.id })).rejects.toThrow(/no inbox id/);
    expect(stub.statusCalls).toEqual([]);
  });
});

describe("no PII leaves in alerts or the outbox", () => {
  it("payloads carry ids, statuses and reasons only", async () => {
    const stub = midtransStub();
    const phone = uniquePhone();
    const order = await createOrder(shop, { phone });
    await stub.create(order.midtransId());
    await settle(stub, order, { transaction_status: "settlement", gross_amount: "1.00" });
    const text = JSON.stringify([...(await alertsFor(order.id)), ...(await sql`SELECT payload FROM outbox WHERE payload ->> 'order_id' = ${order.id}`)]);
    for (const pii of [phone, "Budi", "budi@example.test"]) expect(text).not.toContain(pii);
  });
});
