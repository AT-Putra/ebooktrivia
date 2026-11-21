// Report rollups (US-029, plan M10; AC-A4, AC-A5, AC-A8). Every `rollupIntervalMs` (5 minutes) each worker asks
// PostgreSQL to recompute the rollups the reports read: public.refresh_report_rollups (packages/db sql/reports.sql),
// which defines every metric and does the whole refresh in the caller's one transaction. A refresh is BOUNDED: it rebuilds the WIB
// days of a trailing 120-day window and the older days an order, payment or conversion touched since the last run (everything on the
// first run and when the gateway fee setting changed), so its cost follows what changed, not the size of the history.
//
// Idempotent and safe under concurrency: the function holds a transactional advisory lock, so when several workers
// tick at once one refreshes and the others get `refreshed = false` at once and change nothing; a run that fails
// rolls back whole, and the next tick (5 minutes later) tries again. The run is bounded (statement_timeout), so a
// pathological table cannot hold the lock for ever.
import type postgres from "postgres";
import type { Logger } from "./log.ts";

/** The longest a refresh may take: it rebuilds a bounded set of days, so a minute is generous; more is a fault. */
export const ROLLUP_STATEMENT_TIMEOUT_MS = 60_000;

export type RollupOutcome = { readonly refreshed: false } | { readonly refreshed: true; readonly orderRows: number; readonly visitRows: number };

export async function refreshReportRollups(sql: postgres.Sql, log: Logger): Promise<RollupOutcome> {
  const result = await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${String(ROLLUP_STATEMENT_TIMEOUT_MS)}`);
    const [row] = await tx<{ r: { refreshed: boolean; order_rows?: number; visit_rows?: number } }[]>`SELECT public.refresh_report_rollups() AS r`;
    return row?.r;
  });
  if (result?.refreshed !== true) {
    log.debug("report rollups: another worker is refreshing, skipped");
    return { refreshed: false };
  }
  const outcome = { refreshed: true as const, orderRows: result.order_rows ?? 0, visitRows: result.visit_rows ?? 0 };
  log.debug({ orderRows: outcome.orderRows, visitRows: outcome.visitRows }, "report rollups refreshed");
  return outcome;
}
