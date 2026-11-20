// US-021 criterion 5: the nightly reconciliation (src/reconciliation.ts) re-queries EVERY
// midtrans_attempts row of the orders active in the last 7 days, reports and alerts on each mismatch,
// and applies what Midtrans says exactly as a notification would.
import { afterAll, describe, expect, it } from "vitest";
import { reconcile, reconcileIfDue, RECONCILE_STALE_RUN_MS } from "../src/reconciliation.ts";
import { first, sql } from "./support/db.ts";
import { alertsFor, createOrder, createShop, effectsOf, midtransStub, type MidtransStub, retireEffects, type Shop, silentLog, WA_DELAY_MS, workerPool } from "./support/midtrans.ts";

const shop: Shop = await createShop();
const workerSql = workerPool(4);
afterAll(() => retireEffects(shop));

/** A run claimed for a day no other test uses (run_date is UNIQUE). */
let day = 0;
async function newRun(): Promise<{ id: string; runDate: string }> {
  day++;
  const runDate = `2001-01-${String(day).padStart(2, "0")}`;
  const row = first(await sql<{ id: string }[]>`INSERT INTO payment_reconciliation_runs (run_date) VALUES (${runDate}) RETURNING id`);
  return { id: row.id, runDate };
}

const deps = (stub: MidtransStub, clock?: () => Date) => ({ sql: workerSql, midtrans: stub.source, log: silentLog, waDelayMs: WA_DELAY_MS, ...(clock === undefined ? {} : { clock }) });
const findingsOf = (runId: string, orderId: string) =>
  sql<{ kind: string; order_status: string; attempts: unknown }[]>`
    SELECT kind, order_status::text AS order_status, attempts FROM payment_reconciliation_findings WHERE run_id = ${runId} AND order_id = ${orderId} ORDER BY kind`;

describe("nightly reconciliation (criterion 5)", () => {
  it("alerts on a seeded mismatch (a lost settlement notification) and then pays the order, once", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop);
    await stub.create(order.midtransId());
    await stub.setState(order.midtransId(), { transaction_status: "settlement" });
    const run = await newRun();
    const summary = await reconcile(deps(stub), run);

    expect(await findingsOf(run.id, order.id)).toEqual([{ kind: "settled_not_paid", order_status: "pending", attempts: [{ n: 1, verdict: "paid", transaction_status: "settlement" }] }]);
    expect(await alertsFor(order.id)).toEqual([
      expect.objectContaining({ kind: "reconciliation_mismatch", severity: "critical", payload: { order_id: order.id, kind: "settled_not_paid", order_status: "pending", run_date: run.runDate } }),
    ]);
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", deliveries: 2, mt: ["meta", "s2s", "tiktok"], order_paid_outbox: 1, paid_transitions: 1 });
    expect(first(await sql<{ finished: boolean; attempts_checked: number; findings: number }[]>`
      SELECT finished_at IS NOT NULL AS finished, attempts_checked, findings FROM payment_reconciliation_runs WHERE id = ${run.id}`)).toEqual({
      finished: true,
      attempts_checked: summary.attemptsChecked,
      findings: summary.findings,
    });
    // The next night finds nothing to report about it, and pays nothing twice.
    const next = await newRun();
    await reconcile(deps(stub), next);
    expect(await findingsOf(next.id, order.id)).toEqual([]);
    expect(await effectsOf(order.id)).toMatchObject({ deliveries: 2, paid_transitions: 1 });
  });

  it("checks EVERY attempt: requested (Snap timeout), superseded created, failed and the latest", async () => {
    const stub = midtransStub();
    const order = await createOrder(shop, { attempts: ["requested", "created", "failed", "created"] });
    // Attempt 1 timed out at our end but Midtrans created it, and the buyer paid it.
    await stub.create(order.midtransId(1));
    await stub.create(order.midtransId(2));
    await stub.setState(order.midtransId(1), { transaction_status: "settlement" });
    const run = await newRun();
    await reconcile(deps(stub), run);
    expect(stub.statusCalls.filter((id) => id.startsWith(`${order.publicId}-`)).sort()).toEqual([1, 2, 3, 4].map((n) => order.midtransId(n)));
    expect((await findingsOf(run.id, order.id)).map((f) => f.kind)).toEqual(["settled_not_paid"]);
    expect(await effectsOf(order.id)).toMatchObject({ status: "paid", paid_transitions: 1 });
    const recorded = await sql<{ n: number; gateway_status: string | null }[]>`SELECT n, gateway_status FROM midtrans_attempts WHERE order_id = ${order.id} ORDER BY n`;
    expect(recorded).toEqual([
      { n: 1, gateway_status: "settlement" },
      { n: 2, gateway_status: "pending" },
      { n: 3, gateway_status: null },
      { n: 4, gateway_status: null },
    ]);
  });

  it("reports a paid order with nothing settled, and a double settlement", async () => {
    const stub = midtransStub();
    const paid = await createOrder(shop, { status: "paid" });
    await stub.create(paid.midtransId());
    const double = await createOrder(shop, { attempts: ["created", "created"] });
    await stub.create(double.midtransId(1));
    await stub.create(double.midtransId(2));
    await stub.setState(double.midtransId(1), { transaction_status: "settlement" });
    await stub.setState(double.midtransId(2), { transaction_status: "settlement" });
    const run = await newRun();
    await reconcile(deps(stub), run);
    expect((await findingsOf(run.id, paid.id)).map((f) => f.kind)).toEqual(["paid_not_settled"]);
    expect((await effectsOf(paid.id)).status).toBe("paid");
    expect((await findingsOf(run.id, double.id)).map((f) => f.kind)).toEqual(["double_settlement", "settled_not_paid"]);
    // Applied like two notifications: one PAID, and the second settlement alerts as a double charge.
    expect(await effectsOf(double.id)).toMatchObject({ status: "paid", paid_transitions: 1 });
    expect((await alertsFor(double.id)).map((a) => a.kind).sort()).toEqual(["payment_double_settlement", "reconciliation_mismatch", "reconciliation_mismatch"]);
  });

  it("leaves out orders inactive for 7 days; reports an unchecked attempt as an error, never as money missing", async () => {
    const stub = midtransStub();
    const old = await createOrder(shop, { ageDays: 8 });
    const failing = await createOrder(shop, { status: "paid" });
    await stub.create(failing.midtransId());
    stub.hold = () => {
      if (stub.statusCalls.at(-1) === failing.midtransId()) stub.failures.unshift("503");
      return Promise.resolve();
    };
    const run = await newRun();
    const summary = await reconcile(deps(stub), run);
    expect(stub.statusCalls).not.toContain(old.midtransId());
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(await findingsOf(run.id, failing.id)).toEqual([]);
    expect(first(await sql<{ errors: number }[]>`SELECT errors FROM payment_reconciliation_runs WHERE id = ${run.id}`).errors).toBe(summary.errors);
    expect(await sql`SELECT severity FROM alerts WHERE dedupe_key = ${`reconciliation_incomplete:${run.runDate}`}`).toEqual([{ severity: "warning" }]);
  });

  it("runs once per WIB day from 02:00 WIB, across workers; a stale unfinished run is claimed again", async () => {
    const stub = midtransStub();
    // 2030-06-15 01:59 WIB: not due yet. 02:30 WIB: due.
    expect(await reconcileIfDue(deps(stub, () => new Date("2030-06-14T18:59:00.000Z")))).toBeNull();
    const at = () => new Date("2030-06-14T19:30:00.000Z");
    const [a, b] = await Promise.all([reconcileIfDue(deps(stub, at)), reconcileIfDue(deps(stub, at))]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect([a, b].find((r) => r !== null)?.runDate).toBe("2030-06-15");
    expect(await reconcileIfDue(deps(stub, at))).toBeNull();

    // A worker that died mid-run: once its heartbeat is stale its day is claimed again.
    await sql`INSERT INTO payment_reconciliation_runs (run_date, started_at, heartbeat_at) VALUES ('2030-06-16', now() - interval '5 hours', now() - ${RECONCILE_STALE_RUN_MS + 60_000} * interval '1 millisecond')`;
    const resumed = await reconcileIfDue(deps(stub, () => new Date("2030-06-15T20:00:00.000Z")));
    expect(resumed?.runDate).toBe("2030-06-16");
    expect(first(await sql<{ finished: boolean }[]>`SELECT finished_at IS NOT NULL AS finished FROM payment_reconciliation_runs WHERE run_date = '2030-06-16'`).finished).toBe(true);
    // A slow run that started long ago but still beats is never claimed twice (P2-5).
    await sql`INSERT INTO payment_reconciliation_runs (run_date, started_at, heartbeat_at) VALUES ('2030-06-17', now() - interval '5 hours', now())`;
    expect(await reconcileIfDue(deps(stub, () => new Date("2030-06-16T20:00:00.000Z")))).toBeNull();
  });

  it("P2-5: refreshes the run's heartbeat as it goes", async () => {
    const stub = midtransStub();
    for (let i = 0; i < 3; i++) await createOrder(shop);
    const run = await newRun();
    await sql`UPDATE payment_reconciliation_runs SET heartbeat_at = now() - interval '1 hour' WHERE id = ${run.id}`;
    const beats: Date[] = [];
    const watching = { ...deps(stub), heartbeatEvery: 1 };
    stub.hold = async () => {
      beats.push(first(await sql<{ heartbeat_at: Date }[]>`SELECT heartbeat_at FROM payment_reconciliation_runs WHERE id = ${run.id}`).heartbeat_at);
    };
    await reconcile(watching, run);
    // Before the first order the claim's beat (an hour old here), then fresh beats while it runs.
    expect(beats.some((b) => Date.now() - b.getTime() < 60_000)).toBe(true);
    expect(beats.some((b) => Date.now() - b.getTime() > 30 * 60_000)).toBe(true);
  });

  it("P2-5: stops after K re-query errors in a row (a Midtrans brownout), alerts, and stays claimable", async () => {
    const stub = midtransStub();
    await createOrder(shop, { attempts: ["created", "created"] });
    await createOrder(shop, { attempts: ["created", "created"] });
    stub.failures.push(...Array.from({ length: 50 }, () => "503" as const));
    const brownout = { ...deps(stub, () => new Date("2030-08-01T20:00:00.000Z")), maxConsecutiveErrors: 3 };
    await expect(reconcileIfDue(brownout)).rejects.toThrow(/3 failed Midtrans re-queries in a row/);
    expect(stub.statusCalls).toHaveLength(3);
    expect(await sql`SELECT severity, payload FROM alerts WHERE dedupe_key = 'reconciliation_aborted:2030-08-02'`).toEqual([{ severity: "critical", payload: { run_date: "2030-08-02", consecutive_errors: 3 } }]);
    expect(first(await sql<{ finished: boolean; errors: number }[]>`SELECT finished_at IS NOT NULL AS finished, errors FROM payment_reconciliation_runs WHERE run_date = '2030-08-02'`)).toEqual({ finished: false, errors: 3 });
  });

  it("r2: permanent re-query failures are findings and never stop the run", async () => {
    const stub = midtransStub();
    const refusedA = await createOrder(shop, { attempts: ["created", "created"] });
    const refusedB = await createOrder(shop, { attempts: ["created", "created"] });
    for (const n of [1, 2]) {
      stub.refuse.set(refusedA.midtransId(n), "bad_signature");
      stub.refuse.set(refusedB.midtransId(n), "bad_response");
    }
    const run = await newRun();
    const summary = await reconcile({ ...deps(stub), maxConsecutiveErrors: 3 }, run);
    expect(summary.errors).toBeGreaterThanOrEqual(4);
    expect(first(await sql<{ finished: boolean }[]>`SELECT finished_at IS NOT NULL AS finished FROM payment_reconciliation_runs WHERE id = ${run.id}`).finished).toBe(true);
    expect(await findingsOf(run.id, refusedA.id)).toEqual([
      {
        kind: "requery_refused",
        order_status: "pending",
        attempts: [
          { n: 1, verdict: "refused", code: "bad_signature" },
          { n: 2, verdict: "refused", code: "bad_signature" },
        ],
      },
    ]);
    expect((await findingsOf(run.id, refusedB.id)).map((f) => f.kind)).toEqual(["requery_refused"]);
  });

  it("M1: one order whose work fails does not stop the others; its finding is reported first", async () => {
    const stub = midtransStub();
    const poison = await createOrder(shop);
    const healthy = await createOrder(shop);
    for (const order of [poison, healthy]) {
      await stub.create(order.midtransId());
      await stub.setState(order.midtransId(), { transaction_status: "settlement" });
    }
    // Any change of the poisoned order's status fails (a test-only trigger, dropped below).
    await sql.unsafe(`CREATE FUNCTION public.us021_test_poison() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RAISE EXCEPTION 'poisoned order'; END $$`);
    await sql.unsafe(`CREATE TRIGGER us021_test_poison BEFORE UPDATE OF status ON public.orders FOR EACH ROW WHEN (NEW.id = '${poison.id}') EXECUTE FUNCTION public.us021_test_poison()`);
    let summary;
    const run = await newRun();
    try {
      summary = await reconcile(deps(stub), run);
    } finally {
      await sql.unsafe("DROP TRIGGER us021_test_poison ON public.orders");
      await sql.unsafe("DROP FUNCTION public.us021_test_poison()");
    }
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect((await findingsOf(run.id, poison.id)).map((f) => f.kind)).toEqual(["settled_not_paid"]);
    expect((await effectsOf(poison.id)).status).toBe("pending");
    expect((await effectsOf(healthy.id)).status).toBe("paid");
    expect(first(await sql<{ finished: boolean }[]>`SELECT finished_at IS NOT NULL AS finished FROM payment_reconciliation_runs WHERE id = ${run.id}`).finished).toBe(true);
  });

  it("a run that cannot reach Midtrans alerts and stays claimable", async () => {
    const broken = { ...deps(midtransStub(), () => new Date("2030-07-01T20:00:00.000Z")), midtrans: () => Promise.reject(new Error("the Midtrans server key is unavailable (missing)")) };
    await expect(reconcileIfDue(broken)).rejects.toThrow(/server key/);
    expect(await sql`SELECT severity FROM alerts WHERE dedupe_key = 'reconciliation_failed:2030-07-02'`).toEqual([{ severity: "critical" }]);
    expect(first(await sql<{ finished: boolean }[]>`SELECT finished_at IS NOT NULL AS finished FROM payment_reconciliation_runs WHERE run_date = '2030-07-02'`).finished).toBe(false);
  });
});
