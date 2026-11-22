// US-030 (UU PDP deletion = anonymization), routed to the Owner by US-033: what the payment consumer does with Midtrans news about
// an order whose buyer was erased (sql/privacy.sql; docs/runbooks/privacy.md and order-review.md):
//   - a refund (or chargeback) re-query of an anonymized, paid order is applied as for any order, and no customer data comes back:
//     triggers.sql payment_raw_erased_guard cuts payments.raw and payment_notifications.raw down to the transaction's keys;
//   - a LATE SETTLEMENT of an anonymized order that was never paid goes to the Owner's review queue instead of PAID (US-033; it used
//     to fail closed on players_phone_present_check, 23514, and retry until its cap): the payments ledger row is kept (its raw cut),
//     no player, delivery, conversion or order.paid job is made, and a critical payment_on_erased_order alert (ids only) is raised.
//     There "mark paid" keeps the money and fulfils nothing (fulfilment = skipped), and the same settlement seen again is honoured.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inertFailpoint } from "../src/failpoint.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { createPaymentNotificationConsumer } from "../src/payments.ts";
import { first, sql } from "./support/db.ts";
import { alertsFor, createOrder, createShop, effectsOf, midtransStub, type MidtransStub, notification, type Order, retireEffects, type Shop, silentLog, WA_DELAY_MS, workerPool } from "./support/midtrans.ts";

const suffix = (): string => randomBytes(4).toString("hex");

const shop: Shop = await createShop();
const workerSql = workerPool(4);
afterAll(() => retireEffects(shop));

const processor = (stub: MidtransStub) =>
  createOutboxProcessor(createPaymentNotificationConsumer({ sql: workerSql, midtrans: stub.source, log: silentLog, waDelayMs: WA_DELAY_MS }), {
    sql: workerSql,
    failpoint: inertFailpoint,
    log: silentLog,
  });

let owner = "";
/** Erases the buyer of `phone` as the Owner does (a deletion request, then erase_data_subject as admin_rw). */
async function eraseBuyer(phone: string): Promise<void> {
  if (owner === "") {
    owner = `owner-${suffix()}`;
    await sql`INSERT INTO admin_auth."user" (id, name, email, "emailVerified") VALUES (${owner}, 'Owner', ${`${owner}@example.test`}, true)`;
    await sql`INSERT INTO admin_profiles (auth_user_id, role, display_name) VALUES (${owner}, 'owner', 'Owner')`;
  }
  const { id } = first(
    await sql<{ id: string }[]>`
      INSERT INTO deletion_requests (subject_phone, lookup_kind, note, requested_by_admin_user_id) VALUES (${phone}, 'phone', 'Permintaan lewat email.', ${owner}) RETURNING id`,
  );
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE admin_rw");
    await tx`SELECT public.erase_data_subject(${id}::uuid, ${id.slice(0, 8)}, ${owner}, NULL, NULL)`;
  });
}

/** A notification as the webhook stores it: Midtrans' whole body, customer data included. */
async function fullNotification(order: Order, status: string): Promise<string> {
  const raw = {
    order_id: order.midtransId(),
    transaction_status: status,
    status_code: "200",
    gross_amount: "49000.00",
    customer_details: { first_name: "Budi Santoso", email: "budi@example.test", phone: order.phone },
  };
  const inbox = first(
    await sql<{ id: string }[]>`
      INSERT INTO payment_notifications (midtrans_order_id, transaction_status, status_code, signature, raw)
      VALUES (${order.midtransId()}, ${status}, '200', ${suffix()}, ${sql.json(raw)}) RETURNING id`,
  );
  return first(await sql<{ id: string }[]>`SELECT public.enqueue_notification(${inbox.id}) AS id`).id;
}

const rawsOf = (order: Order) =>
  sql<{ raw: Record<string, unknown> }[]>`
    SELECT raw FROM payment_notifications WHERE midtrans_order_id = ${order.midtransId()}
    UNION ALL SELECT raw FROM payments WHERE order_id = ${order.id}`;

/** The Owner's decision through the console's login (admin_rw), as order-review.int.test.ts. */
const decide = (order: Order, decision: "paid" | "not_paid", key = randomUUID()) =>
  sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE admin_rw");
    return first(
      await tx<{ r: Record<string, unknown> }[]>`
        SELECT public.order_review_decide(${order.id}, ${decision}, ${order.publicId}, 'Midtrans confirmed the money; the buyer was erased.', ${key}, ${owner}, NULL, NULL) AS r`,
    ).r;
  });

describe("Midtrans news of an erased buyer's order", () => {
  it("applies a refund of an anonymized paid order and keeps no customer data from Midtrans", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    await stub.setState(order.midtransId(), { transaction_status: "settlement", payment_type: "qris" });
    expect(await processor(stub)({ id: await notification(order.midtransId(), "settlement") })).toBe("processed");
    expect((await effectsOf(order.id)).status).toBe("paid");
    await eraseBuyer(order.phone);

    await stub.setState(order.midtransId(), { transaction_status: "refund" });
    expect(await processor(stub)({ id: await fullNotification(order, "refund") })).toBe("processed");
    expect((await effectsOf(order.id)).status).toBe("refunded");
    for (const { raw } of await rawsOf(order)) {
      expect(raw).not.toHaveProperty("customer_details");
      expect(raw).toMatchObject({ erased: true });
    }
    expect(first(await sql<{ phone: string | null }[]>`SELECT buyer_phone AS phone FROM orders WHERE id = ${order.id}`).phone).toBeNull();
  });

  /** An erased buyer's order that was never paid, whose late settlement the consumer has just processed. */
  async function lateSettlementOfErased(stub: MidtransStub): Promise<Order> {
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    await sql`UPDATE orders SET status = 'expired' WHERE id = ${order.id}`;
    await eraseBuyer(order.phone);
    await stub.setState(order.midtransId(), { transaction_status: "settlement", payment_type: "qris" });
    expect(await processor(stub)({ id: await fullNotification(order, "settlement") })).toBe("processed");
    return order;
  }

  it("US-033: a late settlement of an anonymized, never paid order goes to review: ledger kept, no effect, a critical alert with ids only", async () => {
    const stub = midtransStub();
    const order = await lateSettlementOfErased(stub);
    // No player from the emptied phone (it used to fail closed on players_phone_present_check, 23514), no delivery, no conversion.
    expect(await effectsOf(order.id)).toMatchObject({ status: "review", paid_at: null, player_id: null, deliveries: 0, mt: [], order_paid_outbox: 0 });
    expect(await sql`SELECT transaction_status FROM payments WHERE order_id = ${order.id}`).toEqual([{ transaction_status: "settlement" }]);
    for (const { raw } of await rawsOf(order)) expect(raw).not.toHaveProperty("customer_details");
    const alerts = (await alertsFor(order.id)).filter((a) => a.kind === "payment_on_erased_order");
    expect(alerts).toEqual([expect.objectContaining({ severity: "critical" })]);
    expect(Object.keys(alerts[0]?.payload ?? {}).sort()).toEqual(["attempt", "event", "from", "order_id", "source"]);
  });

  it("US-033: mark paid keeps the money and fulfils nothing (fulfilment skipped); the same settlement again is honoured", async () => {
    const stub = midtransStub();
    const order = await lateSettlementOfErased(stub);
    const result = await decide(order, "paid");
    expect(result).toMatchObject({ to_status: "paid", fulfilment: "skipped", eligible: false, player_id: null });
    expect(result).not.toHaveProperty("deliveries_created");
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", player_id: null, deliveries: 0, mt: [], order_paid_outbox: 0 });
    expect((await effectsOf(order.id)).paid_at).not.toBeNull();
    expect(await sql`SELECT 1 FROM alerts WHERE payload ->> 'order_id' = ${order.id} AND resolved_at IS NULL`).toEqual([]);
    const [ledger] = await sql<{ effects: Record<string, unknown> }[]>`SELECT effects FROM order_owner_decisions WHERE order_id = ${order.id}`;
    expect(ledger?.effects).toMatchObject({ fulfilment: "skipped" });
    // Midtrans says the same again: nothing changes, nothing is created, no new alert.
    expect(await processor(stub)({ id: await fullNotification(order, "settlement") })).toBe("processed");
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", deliveries: 0, mt: [], order_paid_outbox: 0 });
    expect(await sql`SELECT 1 FROM alerts WHERE payload ->> 'order_id' = ${order.id} AND resolved_at IS NULL`).toEqual([]);
  });

  it("US-033: not paid closes it as failed, as for any order", async () => {
    const stub = midtransStub();
    const order = await lateSettlementOfErased(stub);
    expect(await decide(order, "not_paid")).toMatchObject({ to_status: "gateway_failed" });
    expect(await effectsOf(order.id)).toMatchObject({ status: "gateway_failed", deliveries: 0, mt: [] });
  });
});
