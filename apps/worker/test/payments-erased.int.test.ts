// US-030 (UU PDP deletion = anonymization): what the payment consumer does TODAY with Midtrans news about an order whose buyer
// was erased (sql/privacy.sql), pinned until US-033 routes such a payment to the Owner's review (docs/runbooks/privacy.md):
//   - a refund (or chargeback) re-query of an anonymized, paid order is applied as for any order, and no customer data comes back:
//     triggers.sql payment_raw_erased_guard cuts payments.raw and payment_notifications.raw down to the transaction's keys;
//   - a LATE SETTLEMENT of an anonymized order that was never paid fails closed: the PAID effects try to create the buyer's player
//     from the order's emptied phone, players_phone_present_check refuses it (23514), the whole transaction rolls back (no payment
//     row, no status change, no player, no delivery), and the job is retried with a backoff, failing the same way each time, until
//     its cap (PAYMENT_MAX_ATTEMPTS) when the outbox sweeper raises the generic outbox_stuck alert. Nothing is sent to anybody.
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inertFailpoint } from "../src/failpoint.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { createPaymentNotificationConsumer, PAYMENT_MAX_ATTEMPTS } from "../src/payments.ts";
import { first, sql } from "./support/db.ts";
import { createOrder, createShop, effectsOf, midtransStub, type MidtransStub, notification, type Order, retireEffects, type Shop, silentLog, WA_DELAY_MS, workerPool } from "./support/midtrans.ts";

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

describe("Midtrans news of an erased buyer's order (until US-033 routes it to review)", () => {
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

  it("fails closed on a late settlement of an anonymized, never paid order: 23514, nothing written, retried with a backoff", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    await sql`UPDATE orders SET status = 'expired' WHERE id = ${order.id}`;
    await eraseBuyer(order.phone);

    await stub.setState(order.midtransId(), { transaction_status: "settlement", payment_type: "qris" });
    const job = await fullNotification(order, "settlement");
    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(processor(stub)({ id: job })).rejects.toMatchObject({ code: "23514" });
      const row = first(
        await sql<{ attempts: number; processed: boolean; last_error: string | null; later: boolean }[]>`
          SELECT attempts, processed_at IS NOT NULL AS processed, last_error, available_at > now() AS later FROM outbox WHERE id = ${job}`,
      );
      expect(row).toMatchObject({ attempts: attempt, processed: false, later: true });
      expect(row.last_error).toContain("players_phone_present_check");
      // Due again now (a test does not wait for the backoff).
      await sql`UPDATE outbox SET available_at = now() WHERE id = ${job}`;
    }
    // Nothing of the PAID transaction stayed: no ledger row, no status change, no player, no delivery, no conversion.
    expect(await effectsOf(order.id)).toMatchObject({ status: "expired", paid_at: null, player_id: null, deliveries: 0, mt: [] });
    expect(await sql`SELECT 1 FROM payments WHERE order_id = ${order.id}`).toHaveLength(0);
    for (const { raw } of await rawsOf(order)) expect(raw).not.toHaveProperty("customer_details");
    // At the cap the consumer no longer claims it (the sweeper's outbox_stuck alert is then raised, apps/worker sweepers.ts).
    await sql`UPDATE outbox SET attempts = ${PAYMENT_MAX_ATTEMPTS} WHERE id = ${job}`;
    expect(await processor(stub)({ id: job })).not.toBe("processed");
    await sql`UPDATE outbox SET processed_at = now() WHERE id = ${job}`;
  });
});
