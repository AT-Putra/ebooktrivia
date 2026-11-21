// Nightly payment reconciliation (US-021; plan M6.5). Once per WIB day, from 02:00 WIB (core
// reconciliationDay), one worker claims the day's run (payment_reconciliation_runs.run_date is UNIQUE)
// and re-queries EVERY midtrans_attempts row of the orders active in the last 7 days: attempts left
// `requested` (Snap timeouts, snap:unavailable, a 2xx answer that failed our checks), superseded
// `created` ones and `failed` ones alike, since any of them may hold a Midtrans transaction. "Active" =
// the order, one of its attempts or one of its notifications was created or changed in the window (the
// reconciliation's own re-queries do not count).
//
// Pacing: the run refreshes heartbeat_at every `heartbeatEvery` orders, and an unfinished run is claimed
// again only once its heartbeat is RECONCILE_STALE_RUN_MS old (its worker died), so a slow run is never
// run twice. After `maxConsecutiveErrors` RETRYABLE re-query failures in a row (network, timeout, 5xx,
// 429: a Midtrans brownout; or a refused server key, which fails every attempt alike) the run stops with
// a critical alert, keeps its counts, and is claimed again after the stale window. Any other permanent
// failure (a bad signature, a malformed answer, a rejection) does not count toward that: Midtrans
// answered; the attempt is reported as a requery_refused finding.
//
// Per order, after its re-queries:
//   1. one transaction under the order's row lock: core reconcileOrder compares the order status with what
//      Midtrans says about every attempt; each mismatch is a report row (payment_reconciliation_findings)
//      and a critical alert, committed before anything is applied. When a re-query failed, "paid but
//      nothing settled" is not concluded (the unchecked attempt may hold the money);
//   2. a second transaction applies every re-queried status with payments.ts applyRequery, exactly as a
//      notification would: a lost settlement notification still makes the order PAID, once.
// An order whose work fails is counted as an error and logged, and the run goes on with the next one.
import { confirmSettlement, getTransactionStatus, MidtransError, type MidtransStatus } from "@ebooktrivia/adapters";
import { type OrderStatus, RECONCILE_WINDOW_DAYS, type ReconcileFinding, reconcileOrder, type ReconcileVerdict, reconciliationDay } from "@ebooktrivia/core";
import type postgres from "postgres";
import type { Logger } from "./log.ts";
import { applyRequery, type AttemptRef, idr, type MidtransSource, requeryInstant } from "./payments.ts";
import { raiseAlert, raiseAlertIn } from "./sweepers.ts";

/** An unfinished run whose heartbeat is this old is claimed again (its worker died). */
export const RECONCILE_STALE_RUN_MS = 30 * 60_000;
/**
 * The heartbeat is refreshed every this many orders. An order has at most 5 attempts (core
 * MAX_SNAP_ATTEMPTS) of one 5 s re-query each, so 20 orders take at most about 8 minutes.
 */
export const RECONCILE_HEARTBEAT_ORDERS = 20;
/** This many retryable re-query failures in a row stop the run (a Midtrans brownout). */
export const RECONCILE_MAX_CONSECUTIVE_ERRORS = 10;

export interface ReconcileDeps {
  readonly sql: postgres.Sql;
  readonly midtrans: MidtransSource;
  readonly log: Logger;
  readonly waDelayMs: number;
  /** Default the system clock for the run day; the stamp of a re-query is the DATABASE clock unless this is injected (payments.ts requeryInstant). */
  readonly clock?: () => Date;
  readonly heartbeatEvery?: number;
  readonly maxConsecutiveErrors?: number;
}

export interface ReconcileSummary {
  readonly runId: string;
  readonly runDate: string;
  readonly orders: number;
  readonly attemptsChecked: number;
  readonly findings: number;
  readonly errors: number;
}

/** The run stopped after too many failed re-queries in a row. */
export class ReconcileAborted extends Error {
  readonly errors: number;
  constructor(errors: number) {
    super(`payment reconciliation stopped after ${String(errors)} failed Midtrans re-queries in a row`);
    this.name = "ReconcileAborted";
    this.errors = errors;
  }
}

interface Checked {
  readonly attempt: AttemptRef;
  readonly status: MidtransStatus | undefined;
  readonly requeriedAt: Date;
}

/** An attempt whose re-query failed permanently (its MidtransError code, or "error"). */
interface Refused {
  readonly n: number;
  readonly code: string;
}

/** Runs today's reconciliation if it is due and no other worker has it; null otherwise. */
export async function reconcileIfDue(deps: ReconcileDeps): Promise<ReconcileSummary | null> {
  const clock = deps.clock ?? (() => new Date());
  const day = reconciliationDay(clock());
  if (day === null) return null;
  const [run] = await deps.sql<{ id: string }[]>`
    INSERT INTO public.payment_reconciliation_runs (run_date) VALUES (${day})
    ON CONFLICT (run_date) DO UPDATE SET started_at = now(), heartbeat_at = now()
     WHERE payment_reconciliation_runs.finished_at IS NULL
       AND payment_reconciliation_runs.heartbeat_at < now() - ${RECONCILE_STALE_RUN_MS} * interval '1 millisecond'
    RETURNING id`;
  if (run === undefined) return null;
  try {
    return await reconcile(deps, { id: run.id, runDate: day });
  } catch (error) {
    const aborted = error instanceof ReconcileAborted;
    deps.log.error({ runDate: day, err: error }, "payment reconciliation stopped; it is claimed again after the stale window");
    await raiseAlert(deps.sql, {
      kind: aborted ? "reconciliation_aborted" : "reconciliation_failed",
      severity: "critical",
      dedupeKey: `${aborted ? "reconciliation_aborted" : "reconciliation_failed"}:${day}`,
      message: aborted
        ? "the nightly Midtrans reconciliation stopped: Midtrans keeps failing (brownout); it is retried later"
        : "the nightly Midtrans reconciliation could not run (Midtrans key or database); it is retried",
      payload: { run_date: day, ...(aborted ? { consecutive_errors: error.errors } : {}) },
    }).catch((alertError: unknown) => {
      deps.log.error({ err: alertError }, "reconciliation failure alert could not be raised");
    });
    throw error;
  }
}

export async function reconcile(deps: ReconcileDeps, run: { readonly id: string; readonly runDate: string }): Promise<ReconcileSummary> {
  const { sql, log } = deps;
  const heartbeatEvery = deps.heartbeatEvery ?? RECONCILE_HEARTBEAT_ORDERS;
  const maxConsecutive = deps.maxConsecutiveErrors ?? RECONCILE_MAX_CONSECUTIVE_ERRORS;
  const midtrans = await deps.midtrans(sql);
  const orders = await sql<{ id: string }[]>`
    SELECT o.id FROM public.orders o
     WHERE EXISTS (SELECT 1 FROM public.midtrans_attempts a WHERE a.order_id = o.id)
       AND (o.created_at > now() - make_interval(days => ${RECONCILE_WINDOW_DAYS})
            OR o.updated_at > now() - make_interval(days => ${RECONCILE_WINDOW_DAYS})
            OR EXISTS (SELECT 1 FROM public.midtrans_attempts a
                        WHERE a.order_id = o.id AND greatest(a.created_at, a.updated_at) > now() - make_interval(days => ${RECONCILE_WINDOW_DAYS}))
            OR EXISTS (SELECT 1 FROM public.midtrans_attempts a JOIN public.payment_notifications n ON n.midtrans_order_id = a.midtrans_order_id
                        WHERE a.order_id = o.id AND n.received_at > now() - make_interval(days => ${RECONCILE_WINDOW_DAYS})))
     ORDER BY o.created_at, o.id`;
  let attemptsChecked = 0;
  let findings = 0;
  let errors = 0;
  let consecutive = 0;
  const progress = (finished: boolean) => sql`
    UPDATE public.payment_reconciliation_runs
       SET heartbeat_at = now(), attempts_checked = ${attemptsChecked}, findings = ${findings}, errors = ${errors},
           finished_at = CASE WHEN ${finished} THEN now() END
     WHERE id = ${run.id}`;
  for (const [index, { id: orderId }] of orders.entries()) {
    if (index > 0 && index % heartbeatEvery === 0) await progress(false);
    const attempts = await sql<{ id: string; n: number; midtrans_order_id: string }[]>`
      SELECT id, n, midtrans_order_id FROM public.midtrans_attempts WHERE order_id = ${orderId} ORDER BY n`;
    const checked: Checked[] = [];
    const refused: Refused[] = [];
    let incomplete = false;
    for (const a of attempts) {
      const attempt: AttemptRef = { id: a.id, orderId, n: a.n, midtransOrderId: a.midtrans_order_id };
      const requeriedAt = await requeryInstant(sql, deps.clock);
      try {
        checked.push({ attempt, status: await getTransactionStatus(midtrans, a.midtrans_order_id), requeriedAt });
        attemptsChecked++;
        consecutive = 0;
      } catch (error) {
        errors++;
        incomplete = true;
        log.warn({ orderId, attempt: a.n, err: error }, "reconciliation re-query failed; attempt not checked");
        // Code review r2: only a retryable failure is a sign of a brownout, and a refused server key is
        // one for every attempt alike; any other permanent failure is a finding of its attempt.
        if (error instanceof MidtransError && (error.retryable || error.code === "unauthorized")) consecutive++;
        else {
          consecutive = 0;
          refused.push({ n: a.n, code: error instanceof MidtransError ? error.code : "error" });
        }
        if (consecutive >= maxConsecutive) {
          await progress(false).catch(() => undefined);
          throw new ReconcileAborted(consecutive);
        }
      }
    }
    try {
      findings += await report(sql, run, orderId, checked, refused, incomplete);
      await sql.begin(async (tx) => {
        for (const c of checked) {
          if (c.status !== undefined) await applyRequery(tx, c.attempt, c.status, c.requeriedAt, { waDelayMs: deps.waDelayMs, source: "reconciliation" });
        }
      });
    } catch (error) {
      // Code review M1: one order that cannot be reported or applied does not stop the others.
      errors++;
      log.error({ orderId, err: error }, "reconciliation of one order failed; the run goes on");
    }
  }
  await progress(true);
  if (errors > 0) {
    await raiseAlert(sql, {
      kind: "reconciliation_incomplete",
      severity: "warning",
      dedupeKey: `reconciliation_incomplete:${run.runDate}`,
      message: `the nightly Midtrans reconciliation could not check ${String(errors)} attempt(s) or order(s); they are checked again next night`,
      payload: { run_date: run.runDate, errors },
    });
  }
  const summary = { runId: run.id, runDate: run.runDate, orders: orders.length, attemptsChecked, findings, errors };
  log.info(summary, "payment reconciliation finished");
  return summary;
}

/** The order's mismatches as report rows and alerts, in a transaction of their own; returns how many. */
async function report(
  sql: postgres.Sql,
  run: { readonly id: string; readonly runDate: string },
  orderId: string,
  checked: readonly Checked[],
  refused: readonly Refused[],
  incomplete: boolean,
): Promise<number> {
  return sql.begin(async (tx) => {
    const [order] = await tx<{ status: OrderStatus; amount_idr: string }[]>`
      SELECT status::text AS status, amount_idr::text AS amount_idr FROM public.orders WHERE id = ${orderId} FOR UPDATE`;
    if (order === undefined) return 0;
    const amountIdr = idr(order.amount_idr);
    const said = checked.map((c) => {
      const verdict: ReconcileVerdict = c.status === undefined ? "not_found" : confirmSettlement(c.status, { midtransOrderId: c.attempt.midtransOrderId, amountIdr }).kind;
      return { n: c.attempt.n, verdict, transaction_status: c.status?.transactionStatus.slice(0, 64) ?? null };
    });
    const kinds: ReconcileFinding[] = reconcileOrder(
      order.status,
      said.map((s) => s.verdict),
    ).filter((kind) => !(incomplete && kind === "paid_not_settled"));
    if (refused.length > 0) kinds.push("requery_refused");
    const attempts = [...said, ...refused.map((r) => ({ n: r.n, verdict: "refused", code: r.code }))].sort((x, y) => x.n - y.n);
    for (const kind of kinds) {
      await tx`
        INSERT INTO public.payment_reconciliation_findings (run_id, order_id, kind, order_status, attempts)
        VALUES (${run.id}, ${orderId}, ${kind}, ${order.status}, ${JSON.stringify(attempts)}::text::jsonb)
        ON CONFLICT (run_id, order_id, kind) DO NOTHING`;
      await raiseAlertIn(tx, {
        kind: "reconciliation_mismatch",
        severity: "critical",
        dedupeKey: `reconciliation:${kind}:${orderId}`,
        message: `the nightly Midtrans reconciliation found a mismatch (${kind}); see the reconciliation report`,
        payload: { order_id: orderId, kind, order_status: order.status, run_date: run.runDate },
      });
    }
    return kinds.length;
  });
}
