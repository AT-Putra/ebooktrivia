// What every report shares (US-029): whole-rupiah amounts out of the database, the "as of" time of the rollups and
// how stale they may be before the page says so, and the filters of a page read from its query string.
import { addDays, isUuid, ORDER_STATUSES, type OrderStatus, REPORT_DEFAULT_DAYS, reportRange, WIB_OFFSET_MS, wibDateOf } from "@ebooktrivia/core";
import type { Sql } from "../db.ts";

/**
 * A whole-rupiah amount from the database (a bigint comes back as text so nothing is rounded on the way): a JS safe
 * integer, or a RangeError. A report never shows a float it made up.
 */
export function idrOf(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError("an amount is not a whole number of rupiah in the safe range");
  return n;
}

/** The instants a range of WIB days covers: from 00:00 WIB of the first day up to (not including) 00:00 WIB of the day after the last. */
export function wibInstants(range: { readonly from: string; readonly to: string }): { readonly start: Date; readonly end: Date } {
  const day = (date: string): number => Date.parse(`${date}T00:00:00Z`) - WIB_OFFSET_MS;
  return { start: new Date(day(range.from)), end: new Date(day(range.to) + 86_400_000) };
}

/** The rollups are refreshed every 5 minutes: older than this, a page says the figures are behind. */
export const ROLLUP_STALE_MS = 15 * 60_000;

/** When the rollups were last computed (the "as of" of every report built on them), or null before the first run. */
export async function rollupAsOf(sql: Sql): Promise<Date | null> {
  const [row] = await sql<{ as_of: Date }[]>`SELECT as_of FROM public.report_rollup_state`;
  return row?.as_of ?? null;
}

export const isStale = (asOf: Date | null, now: Date): boolean => asOf === null || now.getTime() - asOf.getTime() > ROLLUP_STALE_MS;

/** Rows per page of every list (a page never loads an unbounded list), and the furthest page a list can be asked for. */
export const PAGE_SIZE = 50;
export const MAX_PAGE = 200;

export type Query = Readonly<Record<string, string | string[] | undefined>>;

/** One value of a query parameter: the first when it was given more than once, "" when absent. */
export const param = (query: Query, name: string): string => {
  const value = query[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
};

export function pageOf(query: Query): number {
  const raw = Number(param(query, "page"));
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= MAX_PAGE ? raw : 1;
}

/** The sales filters (AC-A5): date range, program, landing page, adnet (or Organic), gateway and order status. */
export interface SalesFilters {
  readonly from: string;
  readonly to: string;
  readonly programId: string | null;
  readonly landingPageId: string | null;
  /** An adnet id, "organic" (no click id) or null (all). */
  readonly adnet: string | null;
  readonly gateway: string | null;
  readonly status: OrderStatus | null;
}

export const NO_FILTERS = { programId: null, landingPageId: null, adnet: null, gateway: null, status: null } as const;

/**
 * The filters of a sales page from its query string. A value that is not one of ours is an error for the page to
 * show (and then the default is used), never something that reaches a query.
 */
export function parseSalesFilters(query: Query, now: Date): { readonly filters: SalesFilters; readonly error: string | null } {
  const today = wibDateOf(now);
  const range = reportRange({ from: param(query, "from"), to: param(query, "to") }, today);
  const base = range.ok ? { from: range.from, to: range.to } : { from: addDays(today, 1 - REPORT_DEFAULT_DAYS), to: today };
  const errors: string[] = range.ok ? [] : [range.error];
  const id = (name: string): string | null => {
    const value = param(query, name);
    if (value === "") return null;
    if (isUuid(value)) return value;
    errors.push("A filter value is not valid.");
    return null;
  };
  const adnetRaw = param(query, "adnet");
  const adnet = adnetRaw === "organic" ? "organic" : id("adnet");
  const gatewayRaw = param(query, "gateway");
  let gateway: string | null = null;
  if (gatewayRaw !== "") {
    if (/^[a-z_]{1,32}$/.test(gatewayRaw)) gateway = gatewayRaw;
    else errors.push("A filter value is not valid.");
  }
  const statusRaw = param(query, "status");
  const status = ORDER_STATUSES.find((s) => s === statusRaw) ?? null;
  if (statusRaw !== "" && status === null) errors.push("A filter value is not valid.");
  return { filters: { ...base, programId: id("program"), landingPageId: id("lp"), adnet, gateway, status }, error: errors[0] ?? null };
}

export interface FilterOptions {
  readonly programs: readonly { readonly id: string; readonly name: string }[];
  readonly landingPages: readonly { readonly id: string; readonly name: string }[];
  readonly adnets: readonly { readonly id: string; readonly name: string }[];
  readonly gateways: readonly string[];
}

/** The choices of the sales filter bar (small tables: programs, landing pages, adnets). */
export async function filterOptions(sql: Sql): Promise<FilterOptions> {
  const [programs, landingPages, adnets, gateways] = await Promise.all([
    sql<{ id: string; name: string }[]>`SELECT id, name FROM public.programs ORDER BY created_at DESC LIMIT 200`,
    sql<{ id: string; name: string }[]>`SELECT id, name FROM public.landing_pages ORDER BY created_at DESC LIMIT 500`,
    sql<{ id: string; name: string }[]>`SELECT id, name FROM public.adnets ORDER BY name LIMIT 500`,
    sql<{ gateway: string }[]>`SELECT DISTINCT gateway FROM public.landing_pages ORDER BY gateway`,
  ]);
  return { programs, landingPages, adnets, gateways: gateways.map((g) => g.gateway) };
}
