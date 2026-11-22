// US-033 (M10c): the Owner's decision on an order in review, "mark paid" / "not paid", through the SECURITY DEFINER
// public.order_review_decide (packages/db sql/order-review.sql) as the console's admin_rw, against the real payment code
// (src/payments.ts applyRequery as the worker_rw login, the Midtrans stub) and the nightly reconciliation. Races use real
// concurrent transactions: one holds the order's row lock while the other is seen waiting on it (pg_locks).
import { randomBytes, randomUUID } from "node:crypto";
import { getTransactionStatus } from "@ebooktrivia/adapters";
import { deliverySchedule, mtSinks, NO_MT_TEMPLATE, reversalSinks, WA_PROACTIVE_DELAY_MS } from "@ebooktrivia/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inertFailpoint } from "../src/failpoint.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { alertStuckReviews } from "../src/owner-decisions.ts";
import { createOwnerRequeryConsumer, OWNER_REQUERY_TOPIC } from "../src/owner-requery.ts";
import { applyRequery, createPaymentNotificationConsumer, EFFECT_CANCELLED } from "../src/payments.ts";
import { reconcile } from "../src/reconciliation.ts";
import { first, sql, suffix, waitFor } from "./support/db.ts";
import {
  alertsFor,
  createOrder,
  createShop,
  crownWinner,
  effectRows,
  effectsOf,
  eligibilityOf,
  midtransStub,
  type MidtransStub,
  notification,
  type Order,
  PRICE_IDR,
  retireEffects,
  type Shop,
  silentLog,
  WA_DELAY_MS,
  winnerOf,
  workerPool,
} from "./support/midtrans.ts";

const shop: Shop = await createShop();
const workerSql = workerPool(8);
afterAll(async () => {
  await retireEffects(shop);
  await sql`UPDATE outbox SET processed_at = now() WHERE topic = ${OWNER_REQUERY_TOPIC} AND processed_at IS NULL`;
});

let ownerId = "";
let staffId = "";
beforeAll(async () => {
  for (const role of ["owner", "staff"] as const) {
    const id = `${role}-${suffix()}`;
    await sql`INSERT INTO admin_auth."user" (id, name, email, "emailVerified") VALUES (${id}, ${role}, ${`${id}@example.test`}, true)`;
    await sql`INSERT INTO admin_profiles (auth_user_id, role, display_name) VALUES (${id}, ${role}, ${role})`;
    if (role === "owner") ownerId = id;
    else staffId = id;
  }
});

const PERMATA = { transaction_status: "settlement", payment_type: "bank_transfer", bank: "permata" } as const;
const REASON = "Confirmed with Midtrans support that the money arrived (ticket 4411).";

function processor(stub: MidtransStub) {
  const consumer = createPaymentNotificationConsumer({ sql: workerSql, midtrans: stub.source, log: silentLog, waDelayMs: WA_DELAY_MS });
  return createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
}

/** Midtrans now says `state` for attempt n, and one notification of it is processed. */
async function settle(stub: MidtransStub, order: Order, state: Record<string, unknown>, n = 1): Promise<void> {
  await stub.setState(order.midtransId(n), state);
  expect(await processor(stub)({ id: await notification(order.midtransId(n), String(state["transaction_status"])) })).toBe("processed");
}

async function paidOrder(stub: MidtransStub, options: Parameters<typeof createOrder>[1] = {}): Promise<Order> {
  const order = await createOrder(shop, options);
  await stub.create(order.midtransId());
  await settle(stub, order, PERMATA);
  return order;
}

/** Owner D9: a paid order whose Permata VA settlement Midtrans flipped to deny: review, suspended, links revoked, critical alert. */
async function reversedOrder(
  stub: MidtransStub,
  options: Parameters<typeof createOrder>[1] = {},
  beforeFlip: (playerId: string) => Promise<unknown> = () => Promise.resolve(),
): Promise<{ order: Order; player: string; paidAt: Date }> {
  const order = await paidOrder(stub, options);
  const { player_id: player, paid_at: paidAt } = await effectsOf(order.id);
  await beforeFlip(player ?? "");
  // Instant delivery: the e-mail went out and the sink counted the S2S MT before the flip.
  await sql`UPDATE deliveries SET status = 'sent', sent_at = now() WHERE order_id = ${order.id} AND channel = 'email'`;
  await sql`UPDATE conversion_events SET status = 'sent', attempts = 1, sent_at = now(), maybe_counted = true WHERE order_id = ${order.id} AND sink = 's2s' AND kind = 'mt'`;
  await settle(stub, order, { ...PERMATA, transaction_status: "deny" });
  expect((await effectsOf(order.id)).status).toBe("review");
  return { order, player: player ?? "", paidAt: paidAt ?? new Date(0) };
}

/** A fraud challenge on the settlement of an order that was never paid: review, no effects. */
async function challengedOrder(stub: MidtransStub): Promise<Order> {
  const order = await createOrder(shop);
  await stub.create(order.midtransId());
  await settle(stub, order, { transaction_status: "settlement", fraud_status: "challenge" });
  expect(await effectsOf(order.id)).toMatchObject({ status: "review", deliveries: 0, mt: [] });
  return order;
}

interface DecideOptions {
  readonly key?: string;
  readonly confirm?: string;
  readonly reason?: string;
  readonly actor?: string;
}
type Decision = Record<string, unknown>;

/** The console's call (admin_rw), in the caller's transaction. */
async function decideIn(tx: postgres.TransactionSql, order: Order, decision: "paid" | "not_paid", options: DecideOptions = {}): Promise<Decision> {
  await tx.unsafe("SET LOCAL ROLE admin_rw");
  const [row] = await tx<{ r: Decision }[]>`
    SELECT public.order_review_decide(${order.id}, ${decision}, ${options.confirm ?? order.publicId}, ${options.reason ?? REASON},
                                      ${options.key ?? randomUUID()}, ${options.actor ?? ownerId}, 'test-request', '198.51.100.7'::inet) AS r`;
  if (row === undefined) throw new Error("order_review_decide returned nothing");
  return row.r;
}
const decide = (order: Order, decision: "paid" | "not_paid", options: DecideOptions = {}) => sql.begin((tx) => decideIn(tx, order, decision, options));

const sqlState = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    return (error as { code?: string }).code ?? "no code";
  }
  throw new Error("expected a refusal");
};

const counts = async (orderId: string) =>
  first(
    await sql<{ deliveries: number; mt: number; reversals: number; outbox: number; decisions: number; audits: number }[]>`
      SELECT (SELECT count(*)::int FROM deliveries WHERE order_id = ${orderId}) AS deliveries,
             (SELECT count(*)::int FROM conversion_events WHERE order_id = ${orderId} AND kind = 'mt') AS mt,
             (SELECT count(*)::int FROM conversion_events WHERE order_id = ${orderId} AND kind = 'reversal') AS reversals,
             (SELECT count(*)::int FROM outbox WHERE dedupe_key = 'order.paid:' || ${orderId}) AS outbox,
             (SELECT count(*)::int FROM order_owner_decisions WHERE order_id = ${orderId}) AS decisions,
             (SELECT count(*)::int FROM audit_log WHERE entity_type = 'order' AND entity_id = ${orderId} AND action = 'order.review.decide') AS audits`,
  );
const openAlerts = async (orderId: string) => (await sql<{ kind: string }[]>`SELECT kind FROM alerts WHERE payload ->> 'order_id' = ${orderId} AND resolved_at IS NULL ORDER BY kind`).map((a) => a.kind);
const liveLinks = async (playerId: string) => first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM magic_links WHERE player_id = ${playerId} AND consumed_at IS NULL`).n;
const addLink = (playerId: string) => sql`INSERT INTO magic_links (player_id, channel, token_hash, expires_at) VALUES (${playerId}, 'email', ${randomBytes(32)}, now() + interval '72 hours')`;
/** The OTP login of the buyer's phone (public_rw): a player_auth user id while the player may log in, NULL otherwise. */
const otpLogin = (phone: string) =>
  sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE public_rw");
    return first(await tx<{ user: string | null }[]>`SELECT public.prepare_player_login(${phone}) AS user`).user;
  });

/**
 * Runs `fn` in a transaction of `pool` and keeps it open (with its locks) until commit() is called. `ready` resolves with fn's
 * value and the holder's backend pid, for waitsOn().
 */
function heldOpen<T>(pool: postgres.Sql, fn: (tx: postgres.TransactionSql) => Promise<T>): { ready: Promise<{ value: T; pid: number }>; commit: () => Promise<T> } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: (held: { value: T; pid: number }) => void = () => undefined;
  const readyP = new Promise<{ value: T; pid: number }>((resolve) => {
    ready = resolve;
  });
  const done = pool.begin(async (tx) => {
    const pid = first(await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`).pid;
    const value = await fn(tx);
    ready({ value, pid });
    await gate;
    return value;
  });
  return {
    ready: Promise.race([readyP, done.then(() => Promise.reject(new Error("the held transaction ended before it was ready")))]),
    commit: () => {
      release();
      return done;
    },
  };
}
/** Some session is blocked by the holder's locks (pg_blocking_pids), i.e. waits on the order row it holds. */
const waitsOn = (holderPid: number) =>
  waitFor(
    "a transaction waiting on the holder's order row lock",
    async () => first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity a WHERE ${holderPid}::int = ANY (pg_blocking_pids(a.pid))`).n > 0,
    15_000,
    20,
  );

describe("mark paid (criterion 2)", () => {
  it("after a D9 reversal: paid again, the order_not_paid rows back on the send path exactly once, eligibility and first_paid_at back, ledger, audit, alerts resolved", async () => {
    const stub = midtransStub();
    let winner = "";
    const { order, player, paidAt } = await reversedOrder(stub, {}, async (playerId) => {
      winner = await crownWinner(shop, playerId, { confirmed: false });
    });
    expect(await winnerOf(winner)).toEqual({ status: "flagged", flag_reason: "no_paid_order" });
    expect(await openAlerts(order.id)).toEqual(["payment_paid_reversed", "winner_flagged"]);
    expect(await liveLinks(player)).toBe(0);
    expect(await otpLogin(order.phone)).toBeNull();
    const before = await counts(order.id);

    const result = await decide(order, "paid");

    expect(result).toMatchObject({ decision: "paid", to_status: "paid", replayed: false, eligible: true, deliveries_created: 0, deliveries_revived: 1, mt_created: 0, mt_revived: 2, order_paid_outbox: 0, alerts_resolved: 1 });
    // paid_at is stamped once: the original payment's instant stands, and so does the D4 tie-break.
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", paid_at: paidAt });
    expect(await eligibilityOf(player, shop.programId)).toEqual({ eligible: true, first_paid_at: paidAt });
    expect(await counts(order.id)).toEqual({ ...before, decisions: 1, audits: 1 });
    expect(await effectRows(order.id)).toEqual({
      deliveries: [
        { channel: "email", status: "sent", last_error: null },
        { channel: "whatsapp", status: "pending", last_error: null },
      ],
      mt: [
        { sink: "meta", status: "pending", last_error: null },
        { sink: "s2s", status: "sent", last_error: null },
        { sink: "tiktok", status: "pending", last_error: null },
      ],
    });
    // The links D9 deleted are not re-created; the buyer is eligible again, so the OTP login (and the self-service resend) works.
    expect(await liveLinks(player)).toBe(0);
    expect(await otpLogin(order.phone)).not.toBeNull();
    // A winner flagged when the order left PAID stays flagged (the contest's own re-award / reinstate decides).
    expect(await winnerOf(winner)).toEqual({ status: "flagged", flag_reason: "no_paid_order" });
    expect(result["winners_flagged"]).toBe(1);
    // The review alert is resolved; the flagged winner keeps its own (the prize is the contest tool's business).
    expect(await openAlerts(order.id)).toEqual(["winner_flagged"]);
    const [ledger] = await sql<{ decision: string; from_status: string; to_status: string; attempts: unknown; reason: string; decided_by_admin_user_id: string }[]>`
      SELECT decision, from_status::text AS from_status, to_status::text AS to_status, attempts, reason, decided_by_admin_user_id FROM order_owner_decisions WHERE order_id = ${order.id}`;
    // The fingerprint is the attempt's recorded re-queried state (the stub keeps the settlement's fraud status on the deny).
    const [stored] = await sql<{ status: string; fraud: string | null }[]>`SELECT gateway_status AS status, gateway_fraud_status AS fraud FROM midtrans_attempts WHERE order_id = ${order.id}`;
    expect(stored?.status).toBe("deny");
    expect(ledger).toEqual({ decision: "paid", from_status: "review", to_status: "paid", attempts: [{ n: 1, ...stored }], reason: REASON, decided_by_admin_user_id: ownerId });
    const [audit] = await sql<{ actor_kind: string; actor_admin_user_id: string; changes: Record<string, unknown>; request_id: string; pii_refs: string[] }[]>`
      SELECT actor_kind, actor_admin_user_id, changes, request_id, pii_refs FROM audit_log WHERE entity_id = ${order.id} AND action = 'order.review.decide'`;
    expect(audit).toMatchObject({ actor_kind: "admin", actor_admin_user_id: ownerId, request_id: "test-request", pii_refs: [] });
    expect(audit?.changes).toMatchObject({ status: { before: "review", after: "paid" }, decision: "paid", reason: REASON });
    expect(JSON.stringify(audit?.changes)).not.toContain(order.phone);
  });

  it("of an order that was never paid (a fraud challenge): the player, eligibility, 2 deliveries, 1 MT per sink and the order.paid outbox, once", async () => {
    const stub = midtransStub();
    const order = await challengedOrder(stub);
    const result = await decide(order, "paid");
    expect(result).toMatchObject({ deliveries_created: 2, mt_created: 3, order_paid_outbox: 1, eligible: true });
    const effects = await effectsOf(order.id);
    expect(effects).toMatchObject({ status: "paid", deliveries: 2, mt: ["meta", "s2s", "tiktok"], order_paid_outbox: 1 });
    expect(await eligibilityOf(effects.player_id ?? "", shop.programId)).toEqual({ eligible: true, first_paid_at: effects.paid_at });
    // The schedule is core deliverySchedule's, with the seeded 180 s; the decision's 180000 ms fallback is core WA_PROACTIVE_DELAY_MS.
    const schedule = await sql<{ channel: string; not_before: Date }[]>`SELECT channel, not_before FROM deliveries WHERE order_id = ${order.id} ORDER BY channel`;
    const email = schedule.find((d) => d.channel === "email")?.not_before ?? new Date(0);
    expect(schedule.map((d) => d.not_before)).toEqual(Object.values(deliverySchedule(email, 180_000)));
    expect(WA_PROACTIVE_DELAY_MS).toBe(180_000);
    expect(await openAlerts(order.id)).toEqual([]);
  });
});

describe("not paid (criterion 3)", () => {
  it("after a D9 reversal: gateway_failed, eligibility from the orders still paid, the reversal row of the MT that reached its sink, links revoked (no paid order left), alerts resolved", async () => {
    const stub = midtransStub();
    const { order, player } = await reversedOrder(stub);
    // A live link left behind (an issue that raced the D9 revoke): no eligible program is left, so it goes.
    await addLink(player);
    const result = await decide(order, "not_paid");
    expect(result).toMatchObject({ decision: "not_paid", to_status: "gateway_failed", eligible: false, reversals_created: 1, magic_links_revoked: 1, first_paid_at: null });
    expect(await effectsOf(order.id)).toMatchObject({ status: "gateway_failed", reversals: ["s2s"] });
    expect(await eligibilityOf(player, shop.programId)).toEqual({ eligible: false, first_paid_at: null });
    expect(await liveLinks(player)).toBe(0);
    expect(await otpLogin(order.phone)).toBeNull();
    expect(await openAlerts(order.id)).toEqual([]);
    expect(await counts(order.id)).toMatchObject({ deliveries: 2, mt: 3, reversals: 1, decisions: 1, audits: 1 });
  });

  it("nothing can go out afterwards: no delivery or MT back to pending, no re-fire, no PAID effect (ET080), whoever asks", async () => {
    const stub = midtransStub();
    const { order } = await reversedOrder(stub);
    await decide(order, "not_paid");
    const as = (role: string, run: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        return run(tx);
      });
    expect(await sqlState(as("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = 'pending' WHERE order_id = ${order.id} AND channel = 'whatsapp'`))).toBe("ET080");
    expect(await sqlState(as("worker_rw", (tx) => tx`UPDATE public.conversion_events SET status = 'pending' WHERE order_id = ${order.id} AND sink = 'meta'`))).toBe("ET080");
    expect(await sqlState(as("worker_rw", (tx) => tx`SELECT public.order_paid_effects(${order.id}, now(), 180000)`))).toBe("ET080");
    const [meta] = await sql<{ id: string }[]>`SELECT id FROM conversion_events WHERE order_id = ${order.id} AND sink = 'meta' AND kind = 'mt'`;
    expect(await sqlState(as("admin_rw", (tx) => tx`SELECT public.refire_conversion(${meta?.id ?? ""})`))).toBe("ET080");
    expect(await sql`SELECT 1 FROM deliveries WHERE order_id = ${order.id} AND status IN ('pending', 'sending')`).toEqual([]);
    expect(await sql`SELECT 1 FROM conversion_events WHERE order_id = ${order.id} AND kind = 'mt' AND status IN ('pending', 'sending')`).toEqual([]);
  });

  it("keeps the buyer eligible and the links when another paid order of the program stands (links revoked only if no longer eligible)", async () => {
    const stub = midtransStub();
    const other = await paidOrder(stub);
    const { order, player } = await reversedOrder(stub, { phone: other.phone });
    await addLink(player);
    const result = await decide(order, "not_paid");
    expect(result).toMatchObject({ eligible: true, magic_links_revoked: 0 });
    expect(await eligibilityOf(player, shop.programId)).toEqual({ eligible: true, first_paid_at: (await effectsOf(other.id)).paid_at });
    expect(await liveLinks(player)).toBe(1);
  });
});

describe("the recorded decision and later Midtrans events (criterion 2: reconciliation does not move it back)", () => {
  it("mark paid: the same deny again (a notification, then the nightly reconciliation) changes nothing and alerts nothing", async () => {
    const stub = midtransStub();
    const { order } = await reversedOrder(stub);
    await decide(order, "paid");
    await settle(stub, order, { ...PERMATA, transaction_status: "deny" });
    expect((await effectsOf(order.id)).status).toBe("paid");
    const runDate = `2002-01-${String(1 + (Number.parseInt(suffix(), 16) % 28)).padStart(2, "0")}`;
    const [run] = await sql<{ id: string }[]>`INSERT INTO payment_reconciliation_runs (run_date) VALUES (${runDate}) ON CONFLICT (run_date) DO UPDATE SET started_at = now() RETURNING id`;
    await reconcile({ sql: workerSql, midtrans: stub.source, log: silentLog, waDelayMs: WA_DELAY_MS }, { id: run?.id ?? "", runDate });
    expect(await sql`SELECT kind FROM payment_reconciliation_findings WHERE order_id = ${order.id}`).toEqual([]);
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid" });
    expect((await effectRows(order.id)).deliveries.map((d) => d.status)).toEqual(["sent", "pending"]);
    expect(await openAlerts(order.id)).toEqual([]);
    expect((await alertsFor(order.id)).filter((a) => a.kind === "payment_paid_reversed")).toHaveLength(1);
  });

  it.each(["refund", "chargeback"])("mark paid, then a NEW Midtrans event (%s): reversed normally, with the reversal row and a critical superseded alert", async (event) => {
    const stub = midtransStub();
    const { order, player } = await reversedOrder(stub);
    await decide(order, "paid");
    await settle(stub, order, { ...PERMATA, transaction_status: event });
    expect(await effectsOf(order.id)).toMatchObject({ status: "refunded", reversals: ["s2s"] });
    expect((await effectsOf(order.id)).refunded_at).not.toBeNull();
    expect((await eligibilityOf(player, shop.programId)).eligible).toBe(false);
    expect((await effectRows(order.id)).deliveries).toEqual([
      { channel: "email", status: "sent", last_error: null },
      { channel: "whatsapp", status: "cancelled", last_error: EFFECT_CANCELLED },
    ]);
    expect(await openAlerts(order.id)).toContain("order_decision_superseded");
  });

  it("mark paid: settled again, then denied again, is a new flip (the decision covered the first deny only): back to review, alerted", async () => {
    const stub = midtransStub();
    const { order } = await reversedOrder(stub);
    await decide(order, "paid");
    await settle(stub, order, PERMATA);
    expect((await effectsOf(order.id)).status).toBe("paid");
    // M1: the attempt left the decided state without moving the order: the Owner is told anyway.
    expect(await openAlerts(order.id)).toEqual(["order_decision_superseded"]);
    await settle(stub, order, { ...PERMATA, transaction_status: "deny" });
    expect((await effectsOf(order.id)).status).toBe("review");
    expect((await alertsFor(order.id)).filter((a) => a.kind === "order_decision_superseded").map((a) => a.payload["event"])).toEqual(["settlement", "deny"]);
    expect(await openAlerts(order.id)).toEqual(["order_decision_superseded", "order_decision_superseded", "payment_paid_reversed"]);
  });

  it.each([
    ["deny", { transaction_status: "capture", fraud_status: "deny" }],
    ["cancel", { transaction_status: "cancel" }],
    ["expire", { transaction_status: "expire" }],
  ])(
    "M1: mark paid on a challenged capture (it never set settled_at), then Midtrans %s: the D9 path (review, links revoked, critical payment_paid_reversed)",
    async (_event, state) => {
      const stub = midtransStub();
      const order = await createOrder(shop);
      await stub.create(order.midtransId());
      await settle(stub, order, { transaction_status: "capture", fraud_status: "challenge", payment_type: "credit_card" });
      expect((await effectsOf(order.id)).status).toBe("review");
      expect(first(await sql<{ settled: boolean }[]>`SELECT bool_or(settled_at IS NOT NULL) AS settled FROM payments WHERE order_id = ${order.id}`).settled).toBe(false);
      await decide(order, "paid");
      const player = (await effectsOf(order.id)).player_id ?? "";
      await addLink(player);
      await settle(stub, order, state);
      expect((await effectsOf(order.id)).status).toBe("review");
      expect((await eligibilityOf(player, shop.programId)).eligible).toBe(false);
      expect(await liveLinks(player)).toBe(0);
      expect(await openAlerts(order.id)).toEqual(["order_decision_superseded", "payment_paid_reversed"]);
      expect((await alertsFor(order.id)).find((a) => a.kind === "payment_paid_reversed")).toMatchObject({ severity: "critical" });
    },
  );

  it("M1: an attempt that showed no money when the Owner marked the order paid does not hold it: its later expiry leaves the order paid", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop, { attempts: ["created", "created"] });
    await stub.create(order.midtransId(1));
    await stub.create(order.midtransId(2));
    await settle(stub, order, { transaction_status: "capture", fraud_status: "challenge", payment_type: "credit_card" }, 2);
    await decide(order, "paid");
    // Attempt 1 was abandoned (never re-queried when the Owner decided); Midtrans expires it later.
    await settle(stub, order, { transaction_status: "expire" }, 1);
    expect((await effectsOf(order.id)).status).toBe("paid");
    expect((await alertsFor(order.id)).filter((a) => a.kind === "payment_paid_reversed")).toEqual([]);
  });

  it("mark paid: a reconciliation that finds a new state reports and applies it as usual", async () => {
    const stub = midtransStub();
    const { order } = await reversedOrder(stub);
    await decide(order, "paid");
    await stub.setState(order.midtransId(), { ...PERMATA, transaction_status: "refund" });
    const runDate = `2003-01-${String(1 + (Number.parseInt(suffix(), 16) % 28)).padStart(2, "0")}`;
    const [run] = await sql<{ id: string }[]>`INSERT INTO payment_reconciliation_runs (run_date) VALUES (${runDate}) ON CONFLICT (run_date) DO UPDATE SET started_at = now() RETURNING id`;
    await reconcile({ sql: workerSql, midtrans: stub.source, log: silentLog, waDelayMs: WA_DELAY_MS }, { id: run?.id ?? "", runDate });
    expect((await sql<{ kind: string }[]>`SELECT kind FROM payment_reconciliation_findings WHERE order_id = ${order.id}`).map((f) => f.kind)).toEqual(["paid_not_settled"]);
    expect(await effectsOf(order.id)).toMatchObject({ status: "refunded", reversals: ["s2s"] });
  });

  it("not paid: the same state again changes nothing; a later real settlement makes the order PAID (late settlement, §10 item 8) and alerts", async () => {
    const stub = midtransStub();
    const { order, player } = await reversedOrder(stub);
    await decide(order, "not_paid");
    await settle(stub, order, { ...PERMATA, transaction_status: "deny" });
    expect((await effectsOf(order.id)).status).toBe("gateway_failed");
    expect(await openAlerts(order.id)).toEqual([]);
    await settle(stub, order, PERMATA);
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", deliveries: 2, order_paid_outbox: 1 });
    expect((await eligibilityOf(player, shop.programId)).eligible).toBe(true);
    expect((await effectRows(order.id)).deliveries.map((d) => d.status)).toEqual(["sent", "pending"]);
    expect(await openAlerts(order.id)).toEqual(["order_decision_superseded"]);
  });

  it("not paid on a settlement of the wrong amount: the same mismatch again neither reopens review nor raises the critical alert again", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    const wrong = { transaction_status: "settlement", gross_amount: `${String(PRICE_IDR + 1)}.00` };
    await settle(stub, order, wrong);
    expect((await effectsOf(order.id)).status).toBe("review");
    await decide(order, "not_paid");
    await settle(stub, order, wrong);
    expect((await effectsOf(order.id)).status).toBe("gateway_failed");
    expect((await alertsFor(order.id)).filter((a) => a.kind === "payment_settlement_review")).toHaveLength(1);
    expect(await openAlerts(order.id)).toEqual([]);
  });
});

describe("idempotency and refusals (criterion 4)", () => {
  it("a double click / replayed POST (same request key) is a no-op with the same answer; another request is refused (ET186)", async () => {
    const stub = midtransStub();
    const order = await challengedOrder(stub);
    const key = randomUUID();
    const once = await decide(order, "paid", { key });
    const again = await decide(order, "paid", { key });
    expect(again).toEqual({ ...once, replayed: true });
    expect(await sqlState(decide(order, "paid"))).toBe("ET186");
    expect(await sqlState(decide(order, "not_paid", { key }))).toBe("ET184");
    expect(await counts(order.id)).toMatchObject({ deliveries: 2, mt: 3, outbox: 1, decisions: 1, audits: 1 });
  });

  it("refuses a wrong confirmation (ET185), a bad reason (ET181), a Staff or unknown actor (ET182), a bad decision (ET180) and an unknown order (ET183), changing nothing", async () => {
    const stub = midtransStub();
    const order = await challengedOrder(stub);
    expect(await sqlState(decide(order, "paid", { confirm: order.publicId.toLowerCase() === order.publicId ? `${order.publicId}x` : order.publicId.toLowerCase() }))).toBe("ET185");
    expect(await sqlState(decide(order, "paid", { reason: "too short" }))).toBe("ET181");
    expect(await sqlState(decide(order, "paid", { reason: "Buyer called from +62 812 3456 7890 to confirm." }))).toBe("ET181");
    expect(await sqlState(decide(order, "paid", { reason: "Buyer wrote from budi@example.test to confirm it." }))).toBe("ET181");
    expect(await sqlState(decide(order, "paid", { actor: staffId }))).toBe("ET182");
    expect(await sqlState(decide(order, "paid", { actor: "nobody" }))).toBe("ET182");
    expect(await sqlState(sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE admin_rw");
      return tx`SELECT public.order_review_decide(${order.id}, 'refund', ${order.publicId}, ${REASON}, ${randomUUID()}, ${ownerId}, NULL, NULL)`;
    }))).toBe("ET180");
    expect(await sqlState(decide({ ...order, id: randomUUID() }, "paid"))).toBe("ET183");
    expect(await sqlState(sql.begin("isolation level repeatable read", (tx) => decideIn(tx, order, "paid")))).toBe("ET180");
    expect(await effectsOf(order.id)).toMatchObject({ status: "review", deliveries: 0 });
    expect(await counts(order.id)).toMatchObject({ decisions: 0, audits: 0 });
  });

  it("only the console may call it, and nobody writes the ledger or the order's state around it (42501 / ET187)", async () => {
    const stub = midtransStub();
    const order = await challengedOrder(stub);
    for (const role of ["worker_rw", "public_rw", "internal_rw"]) {
      expect(await sqlState(sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        return tx`SELECT public.order_review_decide(${order.id}, 'paid', ${order.publicId}, ${REASON}, ${randomUUID()}, ${ownerId}, NULL, NULL)`;
      })), role).toBe("42501");
    }
    const asAdmin = (statement: string) =>
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE admin_rw");
        return tx.unsafe(statement, [order.id]);
      });
    for (const statement of [
      "UPDATE public.orders SET status = 'paid' WHERE id = $1",
      "UPDATE public.orders SET paid_at = now() WHERE id = $1",
      "DELETE FROM public.orders WHERE id = $1",
      "UPDATE public.midtrans_attempts SET gateway_status = 'settlement' WHERE order_id = $1",
      "UPDATE public.payments SET settled_at = now() WHERE order_id = $1",
      "INSERT INTO public.player_programs (player_id, program_id) SELECT gen_random_uuid(), program_id FROM public.orders WHERE id = $1",
      "UPDATE public.order_owner_decisions SET reason = 'x' WHERE order_id = $1",
    ]) expect(await sqlState(asAdmin(statement)), statement).toBe("42501");
    await decide(order, "paid");
    // The ledger is append-only for every writer, the superuser included.
    expect(await sqlState(sql`UPDATE order_owner_decisions SET reason = 'changed afterwards' WHERE order_id = ${order.id}`)).toBe("ET187");
    expect(await sqlState(sql`DELETE FROM order_owner_decisions WHERE order_id = ${order.id}`)).toBe("ET187");
    expect(await sqlState(sql`
      INSERT INTO order_owner_decisions (order_id, decision, from_status, to_status, attempts, reason, decided_by_admin_user_id, request_key)
      VALUES (${order.id}, 'paid', 'review', 'paid', '[]', ${REASON}, ${ownerId}, ${randomUUID()})`)).toBe("ET187");
  });

  it("review_since is the instant the order entered review, kept by the database whoever writes", async () => {
    const stub = midtransStub();
    const order = await challengedOrder(stub);
    const since = async () => first(await sql<{ since: Date | null }[]>`SELECT review_since AS since FROM orders WHERE id = ${order.id}`).since;
    const entered = await since();
    expect(entered).not.toBeNull();
    await sql`UPDATE orders SET review_since = now() - interval '3 days' WHERE id = ${order.id}`;
    expect(await since()).toEqual(entered);
    await decide(order, "paid");
    expect(await since()).toBeNull();
  });
});

describe("races with real concurrent transactions (criterion 4)", () => {
  it("a decision holding the order lock, then a late settlement notification: it waits, then sees not paid and pays the order (late settlement)", async () => {
    const stub = midtransStub();
    const { order } = await reversedOrder(stub);
    await stub.setState(order.midtransId(), PERMATA);
    const outboxId = await notification(order.midtransId(), "settlement");
    const held = heldOpen(sql, (tx) => decideIn(tx, order, "not_paid"));
    const { pid } = await held.ready;
    const late = processor(stub)({ id: outboxId });
    await waitsOn(pid);
    await held.commit();
    expect(await late).toBe("processed");
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", deliveries: 2, order_paid_outbox: 1 });
    expect(await counts(order.id)).toMatchObject({ decisions: 1 });
    expect(await openAlerts(order.id)).toEqual(["order_decision_superseded"]);
  });

  it("a late settlement holding the order lock, then a decision: it waits, then sees the order paid and refuses (ET186); paid once", async () => {
    const stub = midtransStub();
    const order = await challengedOrder(stub);
    await stub.setState(order.midtransId(), { transaction_status: "settlement", fraud_status: "accept" });
    const status = await getTransactionStatus(await stub.source(workerSql), order.midtransId());
    if (status === undefined) throw new Error("no status");
    const attempt = { id: order.attempts.get(1) ?? "", orderId: order.id, n: 1, midtransOrderId: order.midtransId() };
    const held = heldOpen(workerSql, (tx) => applyRequery(tx, attempt, status, new Date(), { waDelayMs: WA_DELAY_MS, source: "notification" }));
    const { value, pid } = await held.ready;
    expect(value).toMatchObject({ from: "review", to: "paid" });
    const decision = sqlState(decide(order, "not_paid"));
    await waitsOn(pid);
    await held.commit();
    expect(await decision).toBe("ET186");
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", deliveries: 2, mt: ["meta", "s2s", "tiktok"], order_paid_outbox: 1 });
    expect(await counts(order.id)).toMatchObject({ decisions: 0 });
  });

  it("a decision holding the order lock while the nightly reconciliation of the same order runs: it waits, then honours the decision (no finding, no move)", async () => {
    const stub = midtransStub();
    const { order } = await reversedOrder(stub);
    const held = heldOpen(sql, (tx) => decideIn(tx, order, "paid"));
    const { pid } = await held.ready;
    const runDate = `2004-01-${String(1 + (Number.parseInt(suffix(), 16) % 28)).padStart(2, "0")}`;
    const [run] = await sql<{ id: string }[]>`INSERT INTO payment_reconciliation_runs (run_date) VALUES (${runDate}) ON CONFLICT (run_date) DO UPDATE SET started_at = now() RETURNING id`;
    const nightly = reconcile({ sql: workerSql, midtrans: stub.source, log: silentLog, waDelayMs: WA_DELAY_MS }, { id: run?.id ?? "", runDate });
    await waitsOn(pid);
    await held.commit();
    await nightly;
    expect(await sql`SELECT kind FROM payment_reconciliation_findings WHERE order_id = ${order.id}`).toEqual([]);
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid" });
    expect(await openAlerts(order.id)).toEqual([]);
  });

  it("two decisions at once: exactly one runs, the other is refused (ET186); the same request twice at once: one decision, the same answer", async () => {
    const stub = midtransStub();
    const order = await challengedOrder(stub);
    const results = await Promise.allSettled([decide(order, "paid"), decide(order, "not_paid")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => (r.reason as { code?: string }).code)).toEqual(["ET186"]);
    expect(await counts(order.id)).toMatchObject({ decisions: 1, audits: 1 });

    const twin = await challengedOrder(stub);
    const key = randomUUID();
    const [a, b] = await Promise.all([decide(twin, "paid", { key }), decide(twin, "paid", { key })]);
    expect(a["decision_id"]).toBe(b["decision_id"]);
    expect([a["replayed"], b["replayed"]].sort()).toEqual([false, true]);
    expect(await counts(twin.id)).toMatchObject({ deliveries: 2, mt: 3, outbox: 1, decisions: 1, audits: 1 });
  });
});

describe("the Owner's re-query runs the normal payment path", () => {
  const requeryRow = async (orderId: string) =>
    first(await sql<{ id: string }[]>`
      INSERT INTO outbox (topic, dedupe_key, payload) VALUES (${OWNER_REQUERY_TOPIC}, ${`${OWNER_REQUERY_TOPIC}:${orderId}:${randomUUID()}`}, ${sql.json({ order_id: orderId })}) RETURNING id`).id;
  const runRequery = (stub: MidtransStub, id: string) =>
    createOutboxProcessor(createOwnerRequeryConsumer({ sql: workerSql, midtrans: stub.source, log: silentLog, waDelayMs: WA_DELAY_MS }), { sql: workerSql, failpoint: inertFailpoint, log: silentLog })({ id });

  it("re-queries every attempt and applies what Midtrans says now (a settled challenge: paid)", async () => {
    const stub = midtransStub();
    const order = await challengedOrder(stub);
    await stub.setState(order.midtransId(), { transaction_status: "settlement", fraud_status: "accept" });
    expect(await runRequery(stub, await requeryRow(order.id))).toBe("processed");
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", deliveries: 2 });
    const [audit] = await sql<{ changes: Record<string, unknown> }[]>`
      SELECT changes FROM audit_log WHERE entity_id = ${order.id} AND action = 'order.status' AND changes -> 'status' ->> 'after' = 'paid'`;
    expect(audit?.changes).toMatchObject({ source: "owner_requery" });
  });

  it("L2: is a no-op (no Midtrans call) once the order left review, and within 60 s of a processed re-query of the same order", async () => {
    const stub = midtransStub();
    const decided = await challengedOrder(stub);
    await decide(decided, "not_paid");
    const calls = stub.statusCalls.length;
    expect(await runRequery(stub, await requeryRow(decided.id))).toBe("processed");
    expect(stub.statusCalls).toHaveLength(calls);

    const order = await challengedOrder(stub);
    expect(await runRequery(stub, await requeryRow(order.id))).toBe("processed");
    const afterFirst = stub.statusCalls.length;
    expect(afterFirst).toBeGreaterThan(calls);
    expect(await runRequery(stub, await requeryRow(order.id))).toBe("processed");
    expect(stub.statusCalls).toHaveLength(afterFirst);
    // A minute later it runs again.
    await sql`UPDATE outbox SET processed_at = now() - interval '61 seconds' WHERE topic = ${OWNER_REQUERY_TOPIC} AND payload ->> 'order_id' = ${order.id}`;
    expect(await runRequery(stub, await requeryRow(order.id))).toBe("processed");
    expect(stub.statusCalls.length).toBeGreaterThan(afterFirst);
  });
});

describe("the stuck-in-review warning (24 h), once per stay", () => {
  it("is raised once for an order in review for more than 24 hours, and not again after the decision resolved it", async () => {
    const stub = midtransStub();
    const order = await challengedOrder(stub);
    const later = new Date(Date.now() + 25 * 3_600_000);
    await alertStuckReviews(workerSql, new Date());
    expect((await alertsFor(order.id)).filter((a) => a.kind === "order_review_stuck")).toHaveLength(0);
    await alertStuckReviews(workerSql, later);
    await alertStuckReviews(workerSql, later);
    expect((await alertsFor(order.id)).filter((a) => a.kind === "order_review_stuck")).toEqual([
      expect.objectContaining({ severity: "warning", payload: expect.objectContaining({ order_id: order.id }) as unknown }),
    ]);
    await decide(order, "not_paid");
    await alertStuckReviews(workerSql, later);
    expect((await alertsFor(order.id)).filter((a) => a.kind === "order_review_stuck")).toHaveLength(1);
    expect(await openAlerts(order.id)).toEqual([]);
  });
});

describe("the shared PAID-effects SQL follows core (oracle)", () => {
  it.each([
    ["attributed, both pixels", true, { meta: "1", tiktok: "T" }, true],
    ["organic", false, { meta: "1", tiktok: "T" }, true],
    ["empty and missing pixels", true, { meta: "", gtag: "AW-1" }, true],
    ["a pixel that is not a string", true, { meta: 1, tiktok: ["T"] }, true],
    ["an adnet without an MT template", true, { tiktok: "T" }, false],
  ])("MT sinks: %s", async (_what, attributed, pixels, mtTemplate) => {
    const lp = first(await sql<{ id: string }[]>`
      INSERT INTO landing_pages (lp_key, name, program_id, pixels) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${shop.programId}, ${sql.json(pixels)}) RETURNING id`);
    const adnet = first(await sql<{ id: string }[]>`
      INSERT INTO adnets (slug, name, clickid_param, mt_url_template, endpoint_host)
      VALUES (${`adn-${suffix()}`}, 'Adnet', 'cid', ${mtTemplate ? "https://pb.example.test/mt?c={clickid}" : null}, 'pb.example.test') RETURNING id`);
    const order = await createOrder({ ...shop, landingPageId: lp.id, adnetId: adnet.id }, { attributed });
    await sql`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order.id}`;
    const now = new Date();
    await workerSql`SELECT public.order_paid_effects(${order.id}, ${now}, 180000)`;
    const rows = await sql<{ sink: string; status: string; last_error: string | null }[]>`
      SELECT sink, status::text AS status, last_error FROM conversion_events WHERE order_id = ${order.id} AND kind = 'mt' ORDER BY sink`;
    const expected = mtSinks({ adnetId: attributed ? adnet.id : null, clickid: attributed ? "click" : null, pixels }).sort();
    expect(rows.map((r) => r.sink)).toEqual(expected);
    for (const r of rows) {
      const unreportable = r.sink === "s2s" && !mtTemplate;
      expect(r, r.sink).toEqual({ sink: r.sink, status: unreportable ? "failed" : "pending", last_error: unreportable ? NO_MT_TEMPLATE : null });
    }
    await sql`UPDATE deliveries SET status = 'cancelled' WHERE order_id = ${order.id} AND status = 'pending'`;
    await sql`UPDATE conversion_events SET status = 'failed', failed_at = now() WHERE order_id = ${order.id} AND status = 'pending'`;
  });

  it.each([
    ["the S2S MT reached the sink, the adnet has a reversal template", { s2s: "sent", meta: "sent" }, true],
    ["only Meta reached its sink", { s2s: "failed", meta: "sent" }, true],
    ["the S2S MT may have counted (maybe_counted) but failed afterwards", { s2s: "maybe", meta: "pending" }, true],
    ["the adnet has no reversal template", { s2s: "sent", meta: "sent" }, false],
  ])("reversal rows: %s (core reversalSinks)", async (_what, mt, reversalTemplate) => {
    const adnet = first(await sql<{ id: string }[]>`
      INSERT INTO adnets (slug, name, clickid_param, mt_url_template, reversal_url_template, endpoint_host)
      VALUES (${`adn-${suffix()}`}, 'Adnet', 'cid', 'https://pb.example.test/mt?c={clickid}', ${reversalTemplate ? "https://pb.example.test/rev?c={clickid}" : null}, 'pb.example.test') RETURNING id`);
    const order = await createOrder({ ...shop, adnetId: adnet.id });
    await sql`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order.id}`;
    await workerSql`SELECT public.order_paid_effects(${order.id}, now(), 180000)`;
    for (const [sink, state] of Object.entries(mt)) {
      if (state === "sent") await sql`UPDATE conversion_events SET status = 'sent', attempts = 1, sent_at = now() WHERE order_id = ${order.id} AND sink = ${sink} AND kind = 'mt'`;
      if (state === "failed") await sql`UPDATE conversion_events SET status = 'failed', failed_at = now() WHERE order_id = ${order.id} AND sink = ${sink} AND kind = 'mt'`;
      if (state === "maybe") await sql`UPDATE conversion_events SET status = 'failed', failed_at = now(), maybe_counted = true WHERE order_id = ${order.id} AND sink = ${sink} AND kind = 'mt'`;
    }
    const reached = (await sql<{ sink: string }[]>`
      SELECT sink FROM conversion_events WHERE order_id = ${order.id} AND kind = 'mt' AND (maybe_counted OR status IN ('sending', 'sent'))`).map((r) => r.sink);
    await sql`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${order.id}`;
    await workerSql`SELECT public.order_reversal_rows(${order.id}, now())`;
    expect((await effectsOf(order.id)).reversals).toEqual(reversalSinks(reached, reversalTemplate));
    await sql`UPDATE deliveries SET status = 'cancelled' WHERE order_id = ${order.id} AND status = 'pending'`;
    await sql`UPDATE conversion_events SET status = 'failed', failed_at = now() WHERE order_id = ${order.id} AND status = 'pending'`;
  });
});
