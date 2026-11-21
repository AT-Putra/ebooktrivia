// The dashboard (AC-A4): today's visits, MO, MT, conversion % and revenue, read from the rollups like every other
// report (so it says "as of" when they were computed), with yesterday beside it and the last two weeks as a series.
import { addDays, wibDateOf } from "@ebooktrivia/core";
import type { Sql } from "../db.ts";
import { isStale, NO_FILTERS, rollupAsOf } from "./common.ts";
import { reviewOrders, salesByDay, type SalesDay, salesTotals, type SalesTotals } from "./sales.ts";

export const DASHBOARD_DAYS = 14;

export interface Dashboard {
  /** The WIB day "today" is. */
  readonly today: string;
  readonly yesterday: string;
  readonly asOf: Date | null;
  /** The rollups have not run for a while (or never): the numbers are behind. */
  readonly stale: boolean;
  readonly todayTotals: SalesTotals;
  readonly yesterdayTotals: SalesTotals;
  readonly series: readonly SalesDay[];
  /** Orders in review over the series' days (the money is undecided, in no revenue). */
  readonly reviewOrders: number;
}

export async function loadDashboard(sql: Sql, now: Date): Promise<Dashboard> {
  const today = wibDateOf(now);
  const yesterday = addDays(today, -1);
  const seriesFrom = addDays(today, 1 - DASHBOARD_DAYS);
  const day = (d: string) => ({ ...NO_FILTERS, from: d, to: d });
  const range = { ...NO_FILTERS, from: seriesFrom, to: today };
  const [asOf, todayTotals, yesterdayTotals, series, review] = await Promise.all([
    rollupAsOf(sql),
    salesTotals(sql, day(today)),
    salesTotals(sql, day(yesterday)),
    salesByDay(sql, range),
    reviewOrders(sql, range),
  ]);
  return { today, yesterday, asOf, stale: isStale(asOf, now), todayTotals, yesterdayTotals, series, reviewOrders: review };
}
