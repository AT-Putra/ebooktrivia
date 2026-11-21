// The sales report and the dashboard (AC-A4, AC-A5), read from the rollups (report_orders_daily,
// report_visits_daily): visits, MO, MT, MO to MT %, gross revenue, a daily series, and the split by landing page and
// source. Every metric is defined once in sql/reports.sql (packages/db): MO = an order with a Snap payment page,
// MT = a paid order, revenue = the amount of paid orders (refunds, chargebacks and orders in review are not
// revenue), a day = the WIB day the order was created. Organic = no click id (order_source_label).
// The status filter keeps the orders of that status in MO / MT / revenue; visits have no status and stay.
import { rateBps } from "@ebooktrivia/core";
import type { Sql } from "../db.ts";
import { idrOf, type SalesFilters } from "./common.ts";

/** The all-zero UUID: the "Organic" key inside a GROUP BY that must not see a NULL. */
const NIL = "00000000-0000-0000-0000-000000000000";

export interface SalesTotals {
  readonly visits: number;
  readonly orders: number;
  readonly mo: number;
  readonly mt: number;
  /** MT / MO in basis points, null when there is no MO. */
  readonly conversionBps: number | null;
  readonly revenueIdr: number;
}

export interface SalesDay {
  readonly day: string;
  readonly visits: number;
  readonly mo: number;
  readonly mt: number;
  readonly revenueIdr: number;
}

export interface SalesRow {
  readonly landingPageId: string;
  readonly landingPage: string;
  /** The adnet id, null = Organic. */
  readonly adnetId: string | null;
  readonly source: string;
  readonly visits: number;
  readonly mo: number;
  readonly mt: number;
  readonly conversionBps: number | null;
  readonly revenueIdr: number;
}

/** The WHERE of the orders rollup (alias r, with landing_pages as lp) and of the visits rollup (alias v, lp). */
function orderWhere(sql: Sql, f: SalesFilters) {
  return sql`
    r.day BETWEEN ${f.from}::date AND ${f.to}::date
    ${f.programId === null ? sql`` : sql`AND r.program_id = ${f.programId}`}
    ${f.landingPageId === null ? sql`` : sql`AND r.landing_page_id = ${f.landingPageId}`}
    ${f.adnet === null ? sql`` : f.adnet === "organic" ? sql`AND r.adnet_id IS NULL` : sql`AND r.adnet_id = ${f.adnet}`}
    ${f.gateway === null ? sql`` : sql`AND lp.gateway = ${f.gateway}`}
    ${f.status === null ? sql`` : sql`AND r.status = ${f.status}`}`;
}

function visitWhere(sql: Sql, f: SalesFilters) {
  return sql`
    v.day BETWEEN ${f.from}::date AND ${f.to}::date
    ${f.programId === null ? sql`` : sql`AND lp.program_id = ${f.programId}`}
    ${f.landingPageId === null ? sql`` : sql`AND v.landing_page_id = ${f.landingPageId}`}
    ${f.adnet === null ? sql`` : f.adnet === "organic" ? sql`AND v.adnet_id IS NULL` : sql`AND v.adnet_id = ${f.adnet}`}
    ${f.gateway === null ? sql`` : sql`AND lp.gateway = ${f.gateway}`}`;
}

const totalsOf = (t: { visits: number; orders: number; mo: number; mt: number; revenue: string }): SalesTotals => ({
  visits: t.visits,
  orders: t.orders,
  mo: t.mo,
  mt: t.mt,
  conversionBps: rateBps(t.mt, t.mo),
  revenueIdr: idrOf(t.revenue),
});

export async function salesTotals(sql: Sql, f: SalesFilters): Promise<SalesTotals> {
  const [row] = await sql<{ visits: number; orders: number; mo: number; mt: number; revenue: string }[]>`
    SELECT (SELECT coalesce(sum(v.visits), 0)::int FROM public.report_visits_daily v JOIN public.landing_pages lp ON lp.id = v.landing_page_id WHERE ${visitWhere(sql, f)}) AS visits,
           coalesce(sum(r.orders), 0)::int AS orders, coalesce(sum(r.mo), 0)::int AS mo, coalesce(sum(r.mt), 0)::int AS mt,
           coalesce(sum(r.revenue_idr), 0)::text AS revenue
      FROM public.report_orders_daily r JOIN public.landing_pages lp ON lp.id = r.landing_page_id
     WHERE ${orderWhere(sql, f)}`;
  return totalsOf(row ?? { visits: 0, orders: 0, mo: 0, mt: 0, revenue: "0" });
}

/** One row per WIB day of the range (a day without anything is a row of zeros: the chart has no gaps). */
export async function salesByDay(sql: Sql, f: SalesFilters): Promise<SalesDay[]> {
  const rows = await sql<{ day: string; visits: number; mo: number; mt: number; revenue: string }[]>`
    WITH days AS (SELECT d::date AS day FROM generate_series(${f.from}::date, ${f.to}::date, interval '1 day') AS d),
    facts AS (
      SELECT r.day, 0 AS visits, r.mo, r.mt, r.revenue_idr AS revenue
        FROM public.report_orders_daily r JOIN public.landing_pages lp ON lp.id = r.landing_page_id WHERE ${orderWhere(sql, f)}
      UNION ALL
      SELECT v.day, v.visits, 0, 0, 0
        FROM public.report_visits_daily v JOIN public.landing_pages lp ON lp.id = v.landing_page_id WHERE ${visitWhere(sql, f)}
    )
    SELECT days.day::text AS day, coalesce(sum(facts.visits), 0)::int AS visits, coalesce(sum(facts.mo), 0)::int AS mo,
           coalesce(sum(facts.mt), 0)::int AS mt, coalesce(sum(facts.revenue), 0)::text AS revenue
      FROM days LEFT JOIN facts ON facts.day = days.day
     GROUP BY days.day ORDER BY days.day`;
  return rows.map((r) => ({ day: r.day, visits: r.visits, mo: r.mo, mt: r.mt, revenueIdr: idrOf(r.revenue) }));
}

/** The landing pages and sources of the range, biggest revenue first (at most `limit`; the totals above cover all of them). */
export async function salesBySource(sql: Sql, f: SalesFilters, limit = 100): Promise<SalesRow[]> {
  const rows = await sql<{ landing_page_id: string; landing_page: string; adnet_id: string | null; source: string; visits: number; mo: number; mt: number; revenue: string }[]>`
    WITH facts AS (
      SELECT r.landing_page_id, coalesce(r.adnet_id, ${NIL}::uuid) AS ak, 0 AS visits, r.mo, r.mt, r.revenue_idr AS revenue
        FROM public.report_orders_daily r JOIN public.landing_pages lp ON lp.id = r.landing_page_id WHERE ${orderWhere(sql, f)}
      UNION ALL
      SELECT v.landing_page_id, coalesce(v.adnet_id, ${NIL}::uuid), v.visits, 0, 0, 0
        FROM public.report_visits_daily v JOIN public.landing_pages lp ON lp.id = v.landing_page_id WHERE ${visitWhere(sql, f)}
    ), grouped AS (
      SELECT landing_page_id, ak, sum(visits)::int AS visits, sum(mo)::int AS mo, sum(mt)::int AS mt, sum(revenue) AS revenue
        FROM facts GROUP BY landing_page_id, ak
    )
    SELECT g.landing_page_id, lp.name AS landing_page, nullif(g.ak, ${NIL}::uuid) AS adnet_id,
           public.report_source_label(nullif(g.ak, ${NIL}::uuid)) AS source, g.visits, g.mo, g.mt, g.revenue::text AS revenue
      FROM grouped g JOIN public.landing_pages lp ON lp.id = g.landing_page_id
     ORDER BY g.revenue DESC, g.visits DESC, lp.name, g.ak
     LIMIT ${limit}`;
  return rows.map((r) => ({
    landingPageId: r.landing_page_id,
    landingPage: r.landing_page,
    adnetId: r.adnet_id,
    source: r.source,
    visits: r.visits,
    mo: r.mo,
    mt: r.mt,
    conversionBps: rateBps(r.mt, r.mo),
    revenueIdr: idrOf(r.revenue),
  }));
}

/** Orders in review (a partial refund or chargeback, a challenge): the money is undecided, so it is in no revenue figure. */
export async function reviewOrders(sql: Sql, f: SalesFilters): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT coalesce(sum(r.orders), 0)::int AS n FROM public.report_orders_daily r JOIN public.landing_pages lp ON lp.id = r.landing_page_id
     WHERE ${orderWhere(sql, { ...f, status: "review" })}`;
  return row?.n ?? 0;
}
