// US-033 (M10c): the Owner's review queue in the console, as the admin_rw login: the queue (the buyer in full since 2026-11-25,
// reason, attempts, eligibility), the audited re-query request, and the decision through
// public.order_review_decide (its full effects and races are proven in apps/worker test/order-review.int.test.ts, against the
// real payment code). The policy keeps every one of these to the Owner (Staff: 403, actions.test.ts and guards.test.ts).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can } from "../src/lib/policy.ts";
import { decideReview, decisionMessage, loadRecentDecisions, loadReviewQueue, parseDecision, requestRequery, reviewCount } from "../src/lib/review/review.ts";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { asAdmin, auditRows, createTestAdmin, newRuntime, root, suffix } from "./support.ts";

const rt = newRuntime();
let ownerId = "";
let staffId = "";
let shop: { productId: string; programId: string; landingPageId: string };
const REASON = "Midtrans support confirmed the transfer arrived.";

beforeAll(async () => {
  ownerId = (await createTestAdmin(rt, "owner")).userId;
  staffId = (await createTestAdmin(rt, "staff")).userId;
  const [product] = await root<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`;
  const [program] = await root<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product?.id ?? ""}, ${`rv-${suffix()}`}, 'Review program', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`;
  const [lp] = await root<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${program?.id ?? ""}) RETURNING id`;
  shop = { productId: product?.id ?? "", programId: program?.id ?? "", landingPageId: lp?.id ?? "" };
});
afterAll(async () => {
  await root`UPDATE deliveries SET status = 'cancelled' WHERE status = 'pending' AND order_id IN (SELECT id FROM orders WHERE landing_page_id = ${shop.landingPageId})`;
  await root`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL AND (topic = 'payment.requery' OR dedupe_key LIKE 'order.paid:%')`;
});

/** An order the payment code put in review (a fraud challenge on attempt 1), as the superuser. */
async function reviewOrder(): Promise<{ id: string; publicId: string; phone: string }> {
  const publicId = `${suffix()}${suffix()}${suffix()}`;
  const phone = `+62812${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`;
  const [order] = await root<{ id: string }[]>`
    INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, snap_attempt_count, expires_at)
    VALUES (${publicId}, ${`${suffix()}${suffix()}`.toUpperCase().replace(/[ILOU]/g, "A")}, ${shop.landingPageId}, ${shop.programId}, ${shop.productId}, 'Budi Santoso', ${phone},
            'budi@example.test', sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 49000, 'review', 1, now() + interval '1 day') RETURNING id`;
  const id = order?.id ?? "";
  await root`INSERT INTO midtrans_attempts (order_id, n, midtrans_order_id, status, gateway_status, gateway_fraud_status, gateway_checked_at)
             VALUES (${id}, 1, ${`${publicId}-1`}, 'created', 'settlement', 'challenge', now())`;
  await root`INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, changes)
             VALUES ('system', 'order.status', 'order', ${id}, ${root.json({ status: { before: "pending", after: "review" }, event: "challenge", attempt: 1, source: "notification" })})`;
  await root`INSERT INTO alerts (source, kind, severity, dedupe_key, message, payload)
             VALUES ('worker', 'payment_settlement_review', 'critical', ${`payment_settlement_review:${id}:1`}, 'test', ${root.json({ order_id: id })})`;
  return { id, publicId, phone };
}

const decision = (order: { id: string; publicId: string }, which: "paid" | "not_paid", key = randomUUID()) =>
  parseDecision({ id: order.id, decision: which, confirm: order.publicId, reason: REASON, key });

describe("who may use the review queue", () => {
  it("only the Owner (order.review.resolve)", () => {
    expect(can("owner", "order.review.resolve")).toBe(true);
    expect(can("staff", "order.review.resolve")).toBe(false);
  });

  it("the database refuses a decision in a Staff member's name too (ET182), whatever the console asks", async () => {
    const order = await reviewOrder();
    await expect(asAdmin(staffId, () => decideReview(rt.sql, decision(order, "paid")))).rejects.toThrow(/Only an active Owner/);
    expect((await root<{ status: string }[]>`SELECT status::text AS status FROM orders WHERE id = ${order.id}`)[0]?.status).toBe("review");
  });
});

describe("the queue", () => {
  it("lists the order with why it is there, its attempts, the buyer IN FULL and the eligibility state", async () => {
    const order = await reviewOrder();
    const { total, orders } = await loadReviewQueue(rt.sql);
    expect(total).toBe(await reviewCount(rt.sql));
    const row = orders.find((o) => o.id === order.id);
    expect(row).toMatchObject({
      publicId: order.publicId,
      amountIdr: 49000,
      buyer: { name: "Budi Santoso", phone: order.phone, email: "budi@example.test" },
      eligibility: { state: "no_player", firstPaidAt: null },
      reason: { event: "challenge", from: "pending", attempt: 1, source: "notification" },
      alerts: [expect.objectContaining({ kind: "payment_settlement_review", severity: "critical" })],
      attempts: [expect.objectContaining({ n: 1, gatewayStatus: "settlement", gatewayFraudStatus: "challenge" })],
    });
  });
});

describe("re-query Midtrans now", () => {
  it("queues one payment.requery job for the worker, audited; a second press while it runs, or the same form again, queues nothing", async () => {
    const order = await reviewOrder();
    const key = randomUUID();
    expect(await asAdmin(ownerId, () => requestRequery(rt.sql, order.id, key))).toBe(true);
    expect(await asAdmin(ownerId, () => requestRequery(rt.sql, order.id, key))).toBe(false);
    expect(await asAdmin(ownerId, () => requestRequery(rt.sql, order.id, randomUUID()))).toBe(false);
    expect(await root`SELECT payload FROM outbox WHERE topic = 'payment.requery' AND payload ->> 'order_id' = ${order.id}`).toEqual([{ payload: { order_id: order.id } }]);
    expect(await auditRows(order.id, "order.review.requery")).toHaveLength(1);
    expect((await loadReviewQueue(rt.sql)).orders.find((o) => o.id === order.id)?.requery).toMatchObject({ pending: true });
  });
});

describe("an order whose buyer was erased (US-030 UU PDP)", () => {
  it("shows no contact; mark paid keeps the money without fulfilment", async () => {
    const order = await reviewOrder();
    // An erasure refuses a subject with an order in review (ET178), so the order is closed first and comes back to review the way
    // the payment code routes a settlement of an erased order (apps/worker payments-erased.int.test.ts).
    await root`UPDATE orders SET status = 'expired' WHERE id = ${order.id}`;
    const [request] = await root<{ id: string }[]>`
      INSERT INTO deletion_requests (subject_phone, lookup_kind, note, requested_by_admin_user_id) VALUES (${order.phone}, 'phone', 'Permintaan lewat email.', ${ownerId}) RETURNING id`;
    const requestId = request?.id ?? "";
    await root.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE admin_rw");
      await tx`SELECT public.erase_data_subject(${requestId}::uuid, ${requestId.slice(0, 8)}, ${ownerId}, NULL, NULL)`;
    });
    await root`UPDATE orders SET status = 'review' WHERE id = ${order.id}`;
    const row = (await loadReviewQueue(rt.sql)).orders.find((o) => o.id === order.id);
    expect(row).toMatchObject({ erased: true, buyer: { phone: "" } });
    const result = await asAdmin(ownerId, () => decideReview(rt.sql, decision(order, "paid")));
    expect(result).toMatchObject({ fulfilmentSkipped: true, deliveriesCreated: 0, eligible: false });
    expect(decisionMessage(result)).toContain("without fulfilment");
    expect(await root`SELECT 1 FROM deliveries WHERE order_id = ${order.id}`).toEqual([]);
  });
});

describe("the decision", () => {
  it("mark paid: the order is paid with its effects, the alert resolved, one audit row; the same form again answers the same and changes nothing", async () => {
    const order = await reviewOrder();
    const input = decision(order, "paid");
    const first = await asAdmin(ownerId, () => decideReview(rt.sql, input));
    expect(first).toMatchObject({ decision: "paid", replayed: false, eligible: true, deliveriesCreated: 2, mtCreated: 0, alertsResolved: 1 });
    const again = await asAdmin(ownerId, () => decideReview(rt.sql, input));
    expect(again).toEqual({ ...first, replayed: true });
    expect(decisionMessage(again)).toBe(decisionMessage(first));
    expect(decisionMessage(first)).toContain("Marked paid.");
    expect((await root<{ status: string }[]>`SELECT status::text AS status FROM orders WHERE id = ${order.id}`)[0]?.status).toBe("paid");
    expect(await auditRows(order.id, "order.review.decide")).toHaveLength(1);
    expect(await root`SELECT 1 FROM alerts WHERE payload ->> 'order_id' = ${order.id} AND resolved_at IS NULL`).toEqual([]);
    // The page confirms it under "Decided in the last 24 hours", with the same message.
    const recent = (await loadRecentDecisions(rt.sql)).find((d) => d.orderId === order.id);
    expect(recent).toMatchObject({ publicId: order.publicId, status: "paid" });
    expect(recent === undefined ? "" : decisionMessage(recent.result)).toBe(decisionMessage(first));
    // Another form now: the order is no longer in review.
    await expect(asAdmin(ownerId, () => decideReview(rt.sql, decision(order, "not_paid")))).rejects.toThrow(/no longer in review/);
  });

  it("not paid: closed as failed, with a message the form shows", async () => {
    const order = await reviewOrder();
    const result = await asAdmin(ownerId, () => decideReview(rt.sql, decision(order, "not_paid")));
    expect(decisionMessage(result)).toBe("Marked not paid: the order is closed as failed. The buyer is not eligible.");
    expect((await root<{ status: string }[]>`SELECT status::text AS status FROM orders WHERE id = ${order.id}`)[0]?.status).toBe("gateway_failed");
  });

  it("refuses a confirmation that does not match, and a form that is not one, with fixed messages", async () => {
    const order = await reviewOrder();
    // With the client address the action wrappers pass (the audit row's ip), as in production.
    await expect(asAdmin(ownerId, () => decideReview(rt.sql, { ...decision(order, "paid"), confirm: "not-the-order-id" }), "203.0.113.80")).rejects.toThrow(/confirmation does not match/);
    const base = { id: order.id, decision: "paid", confirm: order.publicId, reason: REASON, key: randomUUID() };
    expect(() => parseDecision({ ...base, decision: "refund" })).toThrow(/mark paid or not paid/);
    expect(() => parseDecision({ ...base, reason: "short" })).toThrow(/10 to 500/);
    expect(() => parseDecision({ ...base, reason: "The buyer called from 081234567890 about it." })).toThrow(/without personal data/);
    expect(() => parseDecision({ ...base, key: "x" })).toThrow(/out of date/);
    expect(() => parseDecision({ ...base, id: "x" })).toThrow(InvalidInput);
    expect((await root<{ status: string }[]>`SELECT status::text AS status FROM orders WHERE id = ${order.id}`)[0]?.status).toBe("review");
  });
});
