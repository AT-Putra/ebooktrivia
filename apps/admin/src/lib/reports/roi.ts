// The profit / ROI report (AC-A8): per landing page, adnet or utm_campaign,
//   net = revenue - CPA - gateway fee - ad spend          (core netProfitIdr, whole rupiah, may be negative)
// over the orders CREATED in the range (WIB days) and the ad spend dated in the range. Revenue, CPA and the gateway fee
// are per-order figures from the rollup (sql/reports.sql defines each: revenue = paid orders only, so refunds,
// chargebacks and orders in review are out of it and no part of a partial refund is counted; the fee is flat + the
// percentage rounded UP, charged for every order that was ever paid; CPA = the payout the S2S MT reported when the
// sink may have counted it, less the reversal the sink acknowledged). Ad spend is the Owner's ad_spend rows, read live.
// Spend that names no landing page / adnet / campaign is not lost, and is not charged to anyone: it has a row of its own (its key is
// NULL, which no order has: Organic is the key '' and "no campaign" too), so the total spend is the same whichever grouping is chosen
// and the Organic row shows what Organic really earned.
// utm_campaign is compared lower-cased and trimmed on both sides.
import { netProfitIdr } from "@ebooktrivia/core";
import type { Sql } from "../db.ts";
import { idrOf, PAGE_SIZE } from "./common.ts";

export const ROI_GROUPS = ["landing_page", "adnet", "utm_campaign"] as const;
export type RoiGroup = (typeof ROI_GROUPS)[number];
export const ROI_GROUP_LABELS: Readonly<Record<RoiGroup, string>> = { landing_page: "Landing page", adnet: "Adnet", utm_campaign: "Campaign (utm_campaign)" };

export const isRoiGroup = (value: string): value is RoiGroup => (ROI_GROUPS as readonly string[]).includes(value);

export interface RoiRow {
  /** The grouping key: an id or the campaign; "" = Organic (adnet) or no campaign; null = spend that names none (the unassigned row). */
  readonly key: string | null;
  readonly label: string;
  readonly paidOrders: number;
  readonly revenueIdr: number;
  readonly payoutIdr: number;
  readonly gatewayFeeIdr: number;
  readonly adSpendIdr: number;
  readonly netIdr: number;
  /** Paid orders whose payment method has no gateway fee configured (their ROI is overstated). */
  readonly feeMissingOrders: number;
}

export interface RoiReport {
  readonly rows: readonly RoiRow[];
  readonly totals: RoiRow;
  readonly rowCount: number;
  readonly page: number;
}

interface Parts {
  readonly paid: number;
  readonly revenue: string;
  readonly payout: string;
  readonly fee: string;
  readonly spend: string;
  readonly fee_missing: number;
}

function rowOf(key: string | null, label: string, p: Parts): RoiRow {
  const revenueIdr = idrOf(p.revenue);
  const payoutIdr = idrOf(p.payout);
  const gatewayFeeIdr = idrOf(p.fee);
  const adSpendIdr = idrOf(p.spend);
  return { key, label, paidOrders: p.paid, revenueIdr, payoutIdr, gatewayFeeIdr, adSpendIdr, netIdr: netProfitIdr({ revenueIdr, payoutIdr, gatewayFeeIdr, adSpendIdr }), feeMissingOrders: p.fee_missing };
}

/** The row of the spend that names no landing page / adnet / campaign. */
export const UNASSIGNED_LABELS: Readonly<Record<RoiGroup, string>> = {
  landing_page: "Spend with no landing page",
  adnet: "Spend with no adnet",
  utm_campaign: "Spend with no campaign",
};
const NO_KEY_LABELS: Readonly<Record<RoiGroup, string>> = { landing_page: "", adnet: "Organic", utm_campaign: "No campaign" };

export async function roiReport(sql: Sql, input: { readonly from: string; readonly to: string; readonly group: RoiGroup; readonly page: number }): Promise<RoiReport> {
  const { from, to, group, page } = input;
  const orderKey = group === "landing_page" ? sql`r.landing_page_id::text` : group === "adnet" ? sql`coalesce(r.adnet_id::text, '')` : sql`r.utm_campaign`;
  // NULL = unassigned spend; an order's key is never NULL ('' is Organic / no campaign), so the two never share a row.
  const spendKey =
    group === "landing_page"
      ? sql`s.landing_page_id::text`
      : group === "adnet"
        ? sql`s.adnet_id::text`
        : sql`nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(s.utm_campaign, ''))), '')`;
  const label =
    group === "landing_page"
      ? sql`(SELECT lp.name FROM public.landing_pages lp WHERE lp.id = nullif(k.key, '')::uuid)`
      : group === "adnet"
        ? sql`public.report_source_label(nullif(k.key, '')::uuid)`
        : sql`k.key`;
  // A fresh fragment per query (the page and its count share the same groups).
  const groups = () => sql`
    WITH o AS (
      SELECT ${orderKey} AS key, sum(r.mt)::int AS paid, sum(r.revenue_idr) AS revenue, sum(r.payout_idr) AS payout, sum(r.fee_idr) AS fee, sum(r.fee_missing)::int AS fee_missing
        FROM public.report_orders_daily r WHERE r.day BETWEEN ${from}::date AND ${to}::date GROUP BY 1
    ), sp AS (
      SELECT ${spendKey} AS key, sum(s.amount_idr) AS spend FROM public.ad_spend s WHERE s.spend_date BETWEEN ${from}::date AND ${to}::date GROUP BY 1
    ), k AS (SELECT key FROM o UNION SELECT key FROM sp)`;
  const [rows, [count], [totals]] = await Promise.all([
    sql<(Parts & { key: string | null; label: string | null })[]>`
      ${groups()}
      SELECT k.key, ${label} AS label, coalesce(o.paid, 0)::int AS paid, coalesce(o.revenue, 0)::text AS revenue, coalesce(o.payout, 0)::text AS payout,
             coalesce(o.fee, 0)::text AS fee, coalesce(sp.spend, 0)::text AS spend, coalesce(o.fee_missing, 0)::int AS fee_missing
        FROM k LEFT JOIN o ON o.key IS NOT DISTINCT FROM k.key LEFT JOIN sp ON sp.key IS NOT DISTINCT FROM k.key
       ORDER BY coalesce(o.revenue, 0) DESC, coalesce(sp.spend, 0) DESC, k.key NULLS LAST
       LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
    // The count is its own query: a page past the end still reports how many groups there are.
    sql<{ n: number }[]>`${groups()} SELECT count(*)::int AS n FROM k`,
    sql<Parts[]>`
      SELECT (SELECT coalesce(sum(r.mt), 0)::int FROM public.report_orders_daily r WHERE r.day BETWEEN ${from}::date AND ${to}::date) AS paid,
             (SELECT coalesce(sum(r.revenue_idr), 0)::text FROM public.report_orders_daily r WHERE r.day BETWEEN ${from}::date AND ${to}::date) AS revenue,
             (SELECT coalesce(sum(r.payout_idr), 0)::text FROM public.report_orders_daily r WHERE r.day BETWEEN ${from}::date AND ${to}::date) AS payout,
             (SELECT coalesce(sum(r.fee_idr), 0)::text FROM public.report_orders_daily r WHERE r.day BETWEEN ${from}::date AND ${to}::date) AS fee,
             (SELECT coalesce(sum(s.amount_idr), 0)::text FROM public.ad_spend s WHERE s.spend_date BETWEEN ${from}::date AND ${to}::date) AS spend,
             (SELECT coalesce(sum(r.fee_missing), 0)::int FROM public.report_orders_daily r WHERE r.day BETWEEN ${from}::date AND ${to}::date) AS fee_missing`,
  ]);
  return {
    rows: rows.map((r) => rowOf(r.key, r.key === null ? UNASSIGNED_LABELS[group] : (r.label ?? "") === "" ? NO_KEY_LABELS[group] : (r.label ?? ""), r)),
    totals: rowOf("", "Total", totals ?? { paid: 0, revenue: "0", payout: "0", fee: "0", spend: "0", fee_missing: 0 }),
    rowCount: count?.n ?? 0,
    page,
  };
}
