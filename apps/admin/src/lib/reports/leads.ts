// The Leads Report (the Owner's request of 2026-11-25): per WIB day, leads, purchases, success rate, revenue, active players,
// play rate and the WhatsApp ebook sends, for one program or all. Read LIVE from the tables (not the 5-minute rollups):
// the "Today" cards say "live", and the table must add up with them. The order figures use the rollups' own definitions
// (sql/reports.sql refresh_report_rollups), so the Sales report agrees once its rollups have run:
//   lead      = an order with a payment page (MO): mo_outbox_id set, or paid_at set, or status 'paid';
//   purchase  = an order whose status is 'paid' now (MT; a refund or chargeback takes it away again);
//   revenue   = the amounts of those paid orders;
//   a day     = the WIB day the ORDER was created (a payment that arrives tomorrow raises today's purchases).
// Active (the Owner's choice) = the distinct players who STARTED at least one trivia set that WIB day, whenever they bought,
// so the play rate (active / leads) can pass 100%. WhatsApp (the Owner's choice) = the WhatsApp ebook deliveries of the
// day's orders: one per order (deliveries_order_id_channel_key); a cancelled one (a refund, an erasure, a cancelled demo
// run) is not counted, and one still waiting (or unknown) is in the total but neither sent nor failed.
import { addDays, isUuid, rateBps, reportRange, wibDateOf } from "@ebooktrivia/core";
import type { Sql } from "../db.ts";
import { idrOf, param, type Query, wibInstants } from "./common.ts";

/** The table's default range: the 10 days before today (the "Today" cards cover today). */
export const LEADS_DEFAULT_DAYS = 10;

export interface LeadsDay {
  readonly day: string;
  readonly leads: number;
  readonly purchase: number;
  readonly revenueIdr: number;
  readonly active: number;
  readonly waTotal: number;
  readonly waSent: number;
  readonly waFailed: number;
}

export interface LeadsFilters {
  readonly from: string;
  readonly to: string;
  readonly programId: string | null;
  /** The range is the default one (nothing was asked). */
  readonly isDefault: boolean;
}

/** The filters from the query string: a bad value is an error for the page to show, and the default is used instead. */
export function parseLeadsFilters(query: Query, now: Date): { readonly filters: LeadsFilters; readonly error: string | null } {
  const today = wibDateOf(now);
  const yesterday = addDays(today, -1);
  const fallback = { from: addDays(yesterday, 1 - LEADS_DEFAULT_DAYS), to: yesterday };
  const fromRaw = param(query, "from");
  const toRaw = param(query, "to");
  const errors: string[] = [];
  let range = fallback;
  if (fromRaw !== "" || toRaw !== "") {
    const to = toRaw === "" ? yesterday : toRaw;
    // Only an end date: the 10 days ending there (reportRange's own default is 30). A bad end date is reportRange's to refuse.
    const from = fromRaw !== "" ? fromRaw : /^\d{4}-\d{2}-\d{2}$/.test(to) ? safeAddDays(to, 1 - LEADS_DEFAULT_DAYS) : undefined;
    const r = reportRange({ from, to }, today);
    if (r.ok) range = { from: r.from, to: r.to };
    else errors.push(r.error);
  }
  const programRaw = param(query, "program");
  let programId: string | null = null;
  if (programRaw !== "") {
    if (isUuid(programRaw)) programId = programRaw;
    else errors.push("A filter value is not valid.");
  }
  const isDefault = range.from === fallback.from && range.to === fallback.to;
  return { filters: { ...range, programId, isDefault }, error: errors[0] ?? null };
}

/** `addDays`, or undefined for a date that is shaped right but is not a calendar day (reportRange then refuses it with its message). */
function safeAddDays(date: string, days: number): string | undefined {
  try {
    return addDays(date, days);
  } catch {
    return undefined;
  }
}

/** One row per WIB day of the range, NEWEST first; a day without anything is a row of zeros. */
export async function leadsByDay(sql: Sql, f: { readonly from: string; readonly to: string; readonly programId: string | null }): Promise<LeadsDay[]> {
  const { start, end } = wibInstants(f);
  const orderProgram = f.programId === null ? sql`` : sql`AND o.program_id = ${f.programId}::uuid`;
  // The set's program is needed only to filter by one.
  const setJoin = f.programId === null ? sql`` : sql`JOIN public.trivia_sets ts ON ts.id = sa.set_id`;
  const setProgram = f.programId === null ? sql`` : sql`AND ts.program_id = ${f.programId}::uuid`;
  const rows = await sql<{ day: string; leads: number; purchase: number; revenue: string; active: number; wa_total: number; wa_sent: number; wa_failed: number }[]>`
    WITH days AS (SELECT d::date AS day FROM generate_series(${f.from}::date, ${f.to}::date, interval '1 day') AS d),
    o AS (
      SELECT public.wib_day(o.created_at) AS day,
             (count(*) FILTER (WHERE o.mo_outbox_id IS NOT NULL OR o.paid_at IS NOT NULL OR o.status = 'paid'))::int AS leads,
             (count(*) FILTER (WHERE o.status = 'paid'))::int AS purchase,
             coalesce(sum(o.amount_idr) FILTER (WHERE o.status = 'paid'), 0)::text AS revenue,
             (count(d.id) FILTER (WHERE d.status <> 'cancelled'))::int AS wa_total,
             (count(d.id) FILTER (WHERE d.status = 'sent'))::int AS wa_sent,
             (count(d.id) FILTER (WHERE d.status = 'failed'))::int AS wa_failed
        FROM public.orders o
        LEFT JOIN public.deliveries d ON d.order_id = o.id AND d.channel = 'whatsapp'
       WHERE o.created_at >= ${start} AND o.created_at < ${end} ${orderProgram}
       GROUP BY 1
    ),
    a AS (
      SELECT public.wib_day(sa.started_at) AS day, (count(DISTINCT sa.player_id))::int AS active
        FROM public.set_attempts sa ${setJoin}
       WHERE sa.started_at >= ${start} AND sa.started_at < ${end} ${setProgram}
       GROUP BY 1
    )
    SELECT days.day::text AS day, coalesce(o.leads, 0) AS leads, coalesce(o.purchase, 0) AS purchase, coalesce(o.revenue, '0') AS revenue,
           coalesce(a.active, 0) AS active, coalesce(o.wa_total, 0) AS wa_total, coalesce(o.wa_sent, 0) AS wa_sent, coalesce(o.wa_failed, 0) AS wa_failed
      FROM days LEFT JOIN o ON o.day = days.day LEFT JOIN a ON a.day = days.day
     ORDER BY days.day DESC`;
  return rows.map((r) => ({
    day: r.day,
    leads: r.leads,
    purchase: r.purchase,
    revenueIdr: idrOf(r.revenue),
    active: r.active,
    waTotal: r.wa_total,
    waSent: r.wa_sent,
    waFailed: r.wa_failed,
  }));
}

/** The TOTAL row: every column added up (Active too: a player who played on 3 days counts 3 times), the rates from the sums. */
export function leadsTotals(days: readonly LeadsDay[]): Omit<LeadsDay, "day"> {
  const sum = (k: keyof Omit<LeadsDay, "day">): number => days.reduce((n, d) => n + d[k], 0);
  return { leads: sum("leads"), purchase: sum("purchase"), revenueIdr: sum("revenueIdr"), active: sum("active"), waTotal: sum("waTotal"), waSent: sum("waSent"), waFailed: sum("waFailed") };
}

export const successRateBps = (d: Pick<LeadsDay, "leads" | "purchase">): number | null => rateBps(d.purchase, d.leads);
export const playRateBps = (d: Pick<LeadsDay, "leads" | "active">): number | null => rateBps(d.active, d.leads);

export const SORT_KEYS = ["day", "leads", "purchase", "successRate", "revenue", "active", "playRate", "waTotal", "waSent", "waFailed"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export interface Sort {
  readonly key: SortKey;
  readonly dir: "asc" | "desc";
}

/** The table's order from the query string (?sort=leads&dir=asc); newest day first when absent or not one of ours. */
export function parseSort(query: Query): Sort {
  const key = SORT_KEYS.find((k) => k === param(query, "sort")) ?? "day";
  const dir = param(query, "dir") === "asc" ? "asc" : "desc";
  return { key, dir };
}

const sortValue = (d: LeadsDay, key: SortKey): number | string => {
  switch (key) {
    case "day":
      return d.day;
    case "successRate":
      return successRateBps(d) ?? -1;
    case "playRate":
      return playRateBps(d) ?? -1;
    case "revenue":
      return d.revenueIdr;
    default:
      return d[key];
  }
};

/** The rows in the asked order; ties keep the newest day first. */
export function sortDays(days: readonly LeadsDay[], sort: Sort): LeadsDay[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...days].sort((x, y) => {
    const a = sortValue(x, sort.key);
    const b = sortValue(y, sort.key);
    if (a !== b) return (a < b ? -1 : 1) * sign;
    return x.day < y.day ? 1 : x.day > y.day ? -1 : 0;
  });
}
