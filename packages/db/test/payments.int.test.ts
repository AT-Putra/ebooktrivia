// US-021: the DB side of exactly-once PAID effects (unique keys + guards that hold for every writer),
// the fulfillment halt of a flagged winner, and the least-privilege grants of the attempt re-query
// state and the reconciliation tables. Every denial asserts the exact SQLSTATE.
import { beforeAll, describe, expect, it } from "vitest";
import { asRole, first, rolledBack, sql, sqlState, type Tx } from "./db.ts";
import { createLandingPage, createPlayer, createProgram, orderRow } from "./fixtures.ts";

type Id = { id: string };

let base: { landingPageId: string; programId: string; productId: string };
beforeAll(async () => {
  const { productId, programId } = await createProgram();
  base = { landingPageId: await createLandingPage(programId), programId, productId };
});

/** An order as the superuser (bypasses grants, not triggers) in `status`, with one Midtrans attempt. */
async function newOrder(status = "pending"): Promise<{ orderId: string; attemptId: string }> {
  const row = orderRow(base);
  const order = first(await sql<Id[]>`INSERT INTO orders ${sql({ ...row, status: "pending" })} RETURNING id`);
  const attempt = first(
    await sql<Id[]>`INSERT INTO midtrans_attempts (order_id, n, midtrans_order_id, status) VALUES (${order.id}, 1, ${`${row.public_id}-1`}, 'created') RETURNING id`,
  );
  if (status !== "pending") await sql`UPDATE orders SET status = ${status}, paid_at = CASE WHEN ${status} = 'paid' THEN now() END WHERE id = ${order.id}`;
  return { orderId: order.id, attemptId: attempt.id };
}

/** The superuser pool or an asRole transaction. */
type Db = Pick<Tx, "unsafe">;
const insertDelivery = (db: Db, orderId: string, channel = "email") =>
  db.unsafe("INSERT INTO public.deliveries (order_id, channel) VALUES ($1, $2)", [orderId, channel]);
const insertConversion = (db: Db, orderId: string, kind: string, sink = "meta") =>
  db.unsafe("INSERT INTO public.conversion_events (order_id, sink, kind, txid, event_id) VALUES ($1::uuid, $2, $3, $1::text, gen_random_uuid())", [orderId, sink, kind]);

describe("PAID effects exist for paid orders only (ET080), once (unique keys)", () => {
  it.each(["pending", "review", "expired", "gateway_failed", "snap_create_failed", "refunded"])(
    "refuses deliveries and MT rows of a %s order, for the superuser and worker_rw alike",
    async (status) => {
      const { orderId } = await newOrder(status);
      expect(await sqlState(insertDelivery(sql, orderId))).toBe("ET080");
      expect(await sqlState(insertConversion(sql, orderId, "mt"))).toBe("ET080");
      expect(await sqlState(asRole("worker_rw", (tx) => insertDelivery(tx, orderId, "whatsapp")))).toBe("ET080");
      expect(await sqlState(asRole("worker_rw", (tx) => insertConversion(tx, orderId, "mt", "tiktok")))).toBe("ET080");
    },
  );

  it("leaves MO and reversal rows alone (an MO belongs to an unpaid order)", async () => {
    const { orderId } = await newOrder("pending");
    await asRole("worker_rw", (tx) => insertConversion(tx, orderId, "mo", "meta"));
    const refunded = await newOrder("refunded");
    await asRole("worker_rw", (tx) => insertConversion(tx, refunded.orderId, "reversal", "meta"));
  });

  it("refuses to move a delivery or turn a conversion into an MT of an unpaid order", async () => {
    const paid = await newOrder("paid");
    const pending = await newOrder("pending");
    await asRole("worker_rw", (tx) => insertDelivery(tx, paid.orderId));
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET order_id = ${pending.orderId} WHERE order_id = ${paid.orderId}`))).toBe("ET080");
    await insertConversion(sql, pending.orderId, "mo", "meta");
    expect(await sqlState(sql`UPDATE conversion_events SET kind = 'mt' WHERE order_id = ${pending.orderId} AND sink = 'meta'`)).toBe("ET080");
  });

  it("P2-A: a delivery or MT goes (back) to pending or sending only while its order is paid", async () => {
    const { orderId } = await newOrder("paid");
    await asRole("worker_rw", async (tx) => {
      await insertDelivery(tx, orderId, "email");
      await insertConversion(tx, orderId, "mt", "meta");
      await insertConversion(tx, orderId, "mo", "tiktok");
    });
    // While paid: claimed, then due again.
    await asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = 'sending' WHERE order_id = ${orderId}`);
    await asRole("worker_rw", (tx) => tx`UPDATE public.conversion_events SET status = 'sending' WHERE order_id = ${orderId} AND kind = 'mt'`);
    await sql`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${orderId}`;
    for (const status of ["pending", "sending"]) {
      expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = ${status} WHERE order_id = ${orderId}`))).toBe("ET080");
      expect(await sqlState(sql`UPDATE conversion_events SET status = ${status} WHERE order_id = ${orderId} AND kind = 'mt'`)).toBe("ET080");
    }
    // Out of the send path is always allowed, and an MO is not an effect of PAID.
    await asRole("worker_rw", (tx) => tx`UPDATE public.deliveries SET status = 'unknown' WHERE order_id = ${orderId}`);
    await asRole("worker_rw", (tx) => tx`UPDATE public.conversion_events SET status = 'failed' WHERE order_id = ${orderId} AND kind = 'mt'`);
    await asRole("worker_rw", (tx) => tx`UPDATE public.conversion_events SET status = 'sending' WHERE order_id = ${orderId} AND kind = 'mo'`);
  });

  it("one delivery per channel and one MT per sink, whoever writes (23505)", async () => {
    const { orderId } = await newOrder("paid");
    await asRole("worker_rw", async (tx) => {
      await insertDelivery(tx, orderId, "email");
      await insertDelivery(tx, orderId, "whatsapp");
      await insertConversion(tx, orderId, "mt", "meta");
    });
    expect(await sqlState(insertDelivery(sql, orderId, "email"))).toBe("23505");
    expect(await sqlState(insertConversion(sql, orderId, "mt", "meta"))).toBe("23505");
    // The worker's own form is a no-op on replay.
    await asRole("worker_rw", (tx) => tx`INSERT INTO public.deliveries (order_id, channel) VALUES (${orderId}, 'email') ON CONFLICT (order_id, channel) DO NOTHING`);
    const [n] = await sql<{ deliveries: number; mt: number }[]>`
      SELECT (SELECT count(*)::int FROM deliveries WHERE order_id = ${orderId}) AS deliveries,
             (SELECT count(*)::int FROM conversion_events WHERE order_id = ${orderId} AND kind = 'mt') AS mt`;
    expect(n).toEqual({ deliveries: 2, mt: 1 });
  });
});

describe("orders.paid_at and refunded_at are set once (ET081)", () => {
  it("for worker_rw, admin_rw and the superuser", async () => {
    const { orderId } = await newOrder("pending");
    await asRole("worker_rw", (tx) => tx`UPDATE public.orders SET status = 'paid', paid_at = now() WHERE id = ${orderId}`);
    // Re-stamping the same value is no change.
    await asRole("worker_rw", (tx) => tx`UPDATE public.orders SET paid_at = paid_at WHERE id = ${orderId}`);
    for (const role of ["worker_rw", "admin_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`UPDATE public.orders SET paid_at = now() + interval '1 second' WHERE id = ${orderId}`))).toBe("ET081");
      expect(await sqlState(asRole(role, (tx) => tx`UPDATE public.orders SET paid_at = NULL WHERE id = ${orderId}`))).toBe("ET081");
    }
    await asRole("worker_rw", (tx) => tx`UPDATE public.orders SET status = 'refunded', refunded_at = now() WHERE id = ${orderId}`);
    expect(await sqlState(sql`UPDATE orders SET refunded_at = NULL WHERE id = ${orderId}`)).toBe("ET081");
  });
});

describe("a flagged or revoked winner halts fulfillment (ET082)", () => {
  let snapshotId: string;
  let tierId: string;
  let programId: string;
  beforeAll(async () => {
    ({ programId } = await createProgram());
    tierId = first(await sql<Id[]>`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name) VALUES (${programId}, 1, 3, 'Juara') RETURNING id`).id;
    snapshotId = first(await sql<Id[]>`INSERT INTO leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${programId}, now(), '[]') RETURNING id`).id;
  });
  const newWinner = async (rank: number): Promise<string> => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    return first(
      await sql<Id[]>`INSERT INTO winners (program_id, snapshot_id, prize_tier_id, player_id, rank) VALUES (${programId}, ${snapshotId}, ${tierId}, ${playerId}, ${rank}) RETURNING id`,
    ).id;
  };

  it("no new fulfillment, no status or proof change while flagged; notes stay editable; the Owner can lift it", async () => {
    const winner = await newWinner(1);
    await asRole("admin_rw", (tx) => tx`UPDATE public.winners SET status = 'confirmed', confirmed_at = now() WHERE id = ${winner}`);
    const fulfillment = first(await asRole("admin_rw", (tx) => tx<Id[]>`INSERT INTO public.fulfillments (winner_id) VALUES (${winner}) RETURNING id`)).id;
    // The chargeback path: the worker flags the confirmed winner.
    await asRole("worker_rw", (tx) => tx`UPDATE public.winners SET status = 'flagged', flagged_at = now(), flag_reason = 'chargeback' WHERE id = ${winner}`);
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.fulfillments SET status = 'sent' WHERE id = ${fulfillment}`))).toBe("ET082");
    expect(await sqlState(sql`UPDATE fulfillments SET status = 'contacted' WHERE id = ${fulfillment}`)).toBe("ET082");
    await asRole("admin_rw", (tx) => tx`UPDATE public.fulfillments SET notes = 'on hold: chargeback' WHERE id = ${fulfillment}`);
    // The Owner reviews and reinstates the winner: fulfillment goes on.
    await asRole("admin_rw", (tx) => tx`UPDATE public.winners SET status = 'confirmed' WHERE id = ${winner}`);
    await asRole("admin_rw", (tx) => tx`UPDATE public.fulfillments SET status = 'contacted' WHERE id = ${fulfillment}`);
  });

  it("refuses a fulfillment row for a flagged or revoked winner, and moving one to or from it", async () => {
    const flagged = await newWinner(2);
    await sql`UPDATE winners SET status = 'flagged', flagged_at = now(), flag_reason = 'chargeback' WHERE id = ${flagged}`;
    const revoked = await newWinner(3);
    await asRole("admin_rw", (tx) => tx`UPDATE public.winners SET status = 'revoked' WHERE id = ${revoked}`);
    expect(await sqlState(asRole("admin_rw", (tx) => tx`INSERT INTO public.fulfillments (winner_id) VALUES (${flagged})`))).toBe("ET082");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`INSERT INTO public.fulfillments (winner_id) VALUES (${revoked})`))).toBe("ET082");
    const healthy = await newWinner(4);
    await rolledBack("admin_rw", async (tx) => {
      const f = first(await tx<Id[]>`INSERT INTO public.fulfillments (winner_id) VALUES (${healthy}) RETURNING id`);
      expect(await sqlState(tx`UPDATE public.fulfillments SET winner_id = ${flagged} WHERE id = ${f.id}`)).toBe("ET082");
    });
  });
});

describe("grants (US-021 block)", () => {
  it("worker_rw records an attempt's re-queried status and nothing else of the attempt", async () => {
    const { attemptId } = await newOrder("pending");
    await asRole(
      "worker_rw",
      (tx) => tx`UPDATE public.midtrans_attempts SET gateway_status = 'pending', gateway_fraud_status = 'accept', gateway_checked_at = now() WHERE id = ${attemptId}`,
    );
    for (const column of ["midtrans_order_id", "order_id", "n", "status", "snap_token", "redirect_url", "error", "updated_at"]) {
      expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.midtrans_attempts SET ${tx(column)} = ${tx(column)} WHERE id = ${attemptId}`))).toBe("42501");
    }
    // A status without its time (or the reverse) is refused.
    expect(await sqlState(sql`UPDATE midtrans_attempts SET gateway_checked_at = NULL WHERE id = ${attemptId}`)).toBe("23514");
    expect(await sqlState(sql`UPDATE midtrans_attempts SET gateway_status = ${"x".repeat(65)} WHERE id = ${attemptId}`)).toBe("23514");
  });

  it("public_rw cannot read the re-query state, and the notification path needs no order read", async () => {
    for (const column of ["gateway_status", "gateway_fraud_status", "gateway_checked_at"]) {
      expect(await sqlState(asRole("public_rw", (tx) => tx`SELECT ${tx(column)} FROM public.midtrans_attempts LIMIT 1`))).toBe("42501");
    }
    for (const table of ["payment_reconciliation_runs", "payment_reconciliation_findings"]) {
      for (const role of ["public_rw", "internal_rw"] as const) {
        expect(await sqlState(asRole(role, (tx) => tx`SELECT 1 FROM ${tx(`public.${table}`)} LIMIT 1`))).toBe("42501");
      }
    }
  });

  it("worker_rw keeps the reconciliation's report rows append-only", async () => {
    const { orderId } = await newOrder("pending");
    const runId = await asRole("worker_rw", async (tx) => {
      const run = first(await tx<Id[]>`INSERT INTO public.payment_reconciliation_runs (run_date) VALUES ('1999-01-01') RETURNING id`);
      await tx`UPDATE public.payment_reconciliation_runs SET finished_at = now(), attempts_checked = 1 WHERE id = ${run.id}`;
      await tx`INSERT INTO public.payment_reconciliation_findings (run_id, order_id, kind, order_status, attempts) VALUES (${run.id}, ${orderId}, 'settled_not_paid', 'pending', '[]')`;
      return run.id;
    });
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.payment_reconciliation_findings SET kind = 'paid_not_settled' WHERE run_id = ${runId}`))).toBe("42501");
    expect(await sqlState(asRole("worker_rw", (tx) => tx`DELETE FROM public.payment_reconciliation_findings WHERE run_id = ${runId}`))).toBe("42501");
    expect(await sqlState(asRole("worker_rw", (tx) => tx`DELETE FROM public.payment_reconciliation_runs WHERE id = ${runId}`))).toBe("42501");
    // A run reports progress only (code review m6): its day and id never change.
    await asRole("worker_rw", (tx) => tx`UPDATE public.payment_reconciliation_runs SET heartbeat_at = now(), errors = 1 WHERE id = ${runId}`);
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.payment_reconciliation_runs SET run_date = '1999-02-01' WHERE id = ${runId}`))).toBe("42501");
    // admin_rw reads the report, but cannot forge or erase it.
    await asRole("admin_rw", (tx) => tx`SELECT kind, order_status, attempts FROM public.payment_reconciliation_findings WHERE run_id = ${runId}`);
    for (const statement of [
      `DELETE FROM public.payment_reconciliation_findings WHERE run_id = '${runId}'`,
      `UPDATE public.payment_reconciliation_runs SET findings = 0 WHERE id = '${runId}'`,
      `INSERT INTO public.payment_reconciliation_runs (run_date) VALUES ('1999-01-02')`,
    ]) {
      expect(await sqlState(asRole("admin_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
    }
    expect(await sqlState(sql`INSERT INTO payment_reconciliation_runs (run_date) VALUES ('1999-01-01')`)).toBe("23505");
    expect(await sqlState(sql`INSERT INTO payment_reconciliation_findings (run_id, order_id, kind, order_status) VALUES (${runId}, ${orderId}, 'lost', 'pending')`)).toBe("23514");
  });
});
