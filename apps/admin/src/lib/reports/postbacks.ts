// The postback report (AC-A7, AC-T3): what was fired to each adnet and CAPI sink (MO, MT, reversals), the HTTP result,
// the retries and the answer, the failed ones with filters and the markers that explain them, the Owner's manual
// re-fire (lib/settings/conversions.ts refireConversion -> public.refire_conversion; admin_rw holds no write on the
// conversion log), and the RECONCILIATION IDENTITY, read from the raw tables (not the rollups): per adnet, the S2S MT rows
// that ended (sent or failed) equal the orders that were PAID with a click id; rows still pending or sending are in
// flight, and whatever neither explains is a lost conversion (core mtReconciliation).
// A source is shown through public.report_source_label / order_source_label ("Organic" = no click id); the CAPI sinks
// have no adnet and are labelled by their platform. A reversal is shown with the payout its MT REPORTED
// (conversion_events.reported_payout_idr, the snapshot taken when the MT was sent), whatever the adnet's setting is now.
import { addDays, CONVERSION_STATUSES, type ConversionStatus, EFFECT_CANCELLED, isUuid, mtReconciliation, type MtReconciliation, NO_MT_TEMPLATE, REPORT_DEFAULT_DAYS, REVERSAL_SKIPPED, reportRange, wibDateOf } from "@ebooktrivia/core";
import type { Sql } from "../db.ts";
import { CAPI_LABELS } from "../settings/conversions.ts";
import { idrOf, PAGE_SIZE, param, type Query, wibInstants } from "./common.ts";

export const SINKS = ["s2s", "meta", "tiktok"] as const;
export type Sink = (typeof SINKS)[number];
/** The CAPI sinks are named once, by US-024 (CAPI_LABELS); an S2S row is named by its adnet (report_source_label). */
export const SINK_LABELS: Readonly<Record<Sink, string>> = { s2s: "Adnet postback (S2S)", ...CAPI_LABELS };
const sourceOf = (sink: Sink, s2sLabel: string | null): string => (sink === "s2s" ? (s2sLabel ?? "Organic") : CAPI_LABELS[sink]);
export const KINDS = ["mo", "mt", "reversal"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABELS: Readonly<Record<Kind, string>> = { mo: "MO (order created)", mt: "MT (paid)", reversal: "Reversal (refund)" };

/** What the failed rows say about themselves: the three marks a row can carry (core) and what each means for the Owner. */
export const MARKERS = {
  order_not_paid: { lastError: EFFECT_CANCELLED, label: "Order not paid", hint: "The order left PAID (refund, chargeback, review) before this MT went out. Re-fire it once the order is paid again." },
  reversal_skipped: { lastError: REVERSAL_SKIPPED, label: "Reversal skipped", hint: "The MT never reached the adnet, so there is nothing to reverse." },
  no_mt_template: { lastError: NO_MT_TEMPLATE, label: "No MT template", hint: "The adnet has no MT postback template: add one on the adnet page, then re-fire." },
} as const;
export type Marker = keyof typeof MARKERS;
export const markerOf = (lastError: string | null): Marker | null => (Object.keys(MARKERS) as Marker[]).find((m) => MARKERS[m].lastError === lastError) ?? null;

export interface PostbackFilters {
  readonly from: string;
  readonly to: string;
  readonly adnet: string | null;
  readonly sink: Sink | null;
  readonly kind: Kind | null;
  readonly status: ConversionStatus | null;
  readonly marker: Marker | null;
}

export function parsePostbackFilters(query: Query, now: Date): { readonly filters: PostbackFilters; readonly error: string | null } {
  const today = wibDateOf(now);
  const range = reportRange({ from: param(query, "from"), to: param(query, "to") }, today);
  const errors: string[] = range.ok ? [] : [range.error];
  const pick = <T extends string>(name: string, values: readonly T[]): T | null => {
    const raw = param(query, name);
    if (raw === "") return null;
    const found = values.find((v) => v === raw);
    if (found === undefined) errors.push("A filter value is not valid.");
    return found ?? null;
  };
  const adnetRaw = param(query, "adnet");
  if (adnetRaw !== "" && !isUuid(adnetRaw)) errors.push("A filter value is not valid.");
  const resolved = range.ok ? range : { from: addDays(today, 1 - REPORT_DEFAULT_DAYS), to: today };
  return {
    filters: {
      from: resolved.from,
      to: resolved.to,
      adnet: adnetRaw !== "" && isUuid(adnetRaw) ? adnetRaw : null,
      sink: pick("sink", SINKS),
      kind: pick("kind", KINDS),
      status: pick("status", CONVERSION_STATUSES),
      marker: pick("marker", Object.keys(MARKERS) as Marker[]),
    },
    error: errors[0] ?? null,
  };
}

export interface PostbackSummaryRow {
  readonly sink: Sink;
  readonly adnetId: string | null;
  /** The adnet's name, or the CAPI platform. */
  readonly source: string;
  readonly mo: StatusCounts;
  readonly mt: StatusCounts;
  readonly reversal: StatusCounts;
}

export interface StatusCounts {
  readonly sent: number;
  readonly failed: number;
  /** pending + sending: still on its way. */
  readonly inFlight: number;
}

/** MO / MT / reversals fired per adnet (and per CAPI sink) over the events created in the range. */
export async function postbackSummary(sql: Sql, f: Pick<PostbackFilters, "from" | "to">): Promise<PostbackSummaryRow[]> {
  const { start, end } = wibInstants(f);
  type Counts = { sent: number; failed: number; in_flight: number };
  const rows = await sql<({ sink: Sink; adnet_id: string | null; s2s_label: string | null } & Record<`${Kind}_${keyof Counts}`, number>)[]>`
    SELECT ce.sink, ce.adnet_id, CASE WHEN ce.sink = 's2s' THEN public.report_source_label(ce.adnet_id) END AS s2s_label,
           (count(*) FILTER (WHERE ce.kind = 'mo' AND ce.status = 'sent'))::int AS mo_sent,
           (count(*) FILTER (WHERE ce.kind = 'mo' AND ce.status = 'failed'))::int AS mo_failed,
           (count(*) FILTER (WHERE ce.kind = 'mo' AND ce.status IN ('pending', 'sending')))::int AS mo_in_flight,
           (count(*) FILTER (WHERE ce.kind = 'mt' AND ce.status = 'sent'))::int AS mt_sent,
           (count(*) FILTER (WHERE ce.kind = 'mt' AND ce.status = 'failed'))::int AS mt_failed,
           (count(*) FILTER (WHERE ce.kind = 'mt' AND ce.status IN ('pending', 'sending')))::int AS mt_in_flight,
           (count(*) FILTER (WHERE ce.kind = 'reversal' AND ce.status = 'sent'))::int AS reversal_sent,
           (count(*) FILTER (WHERE ce.kind = 'reversal' AND ce.status = 'failed'))::int AS reversal_failed,
           (count(*) FILTER (WHERE ce.kind = 'reversal' AND ce.status IN ('pending', 'sending')))::int AS reversal_in_flight
      FROM public.conversion_events ce
     WHERE ce.created_at >= ${start} AND ce.created_at < ${end}
     GROUP BY ce.sink, ce.adnet_id`;
  return rows
    .map((r) => ({
      sink: r.sink,
      adnetId: r.adnet_id,
      source: sourceOf(r.sink, r.s2s_label),
      mo: { sent: r.mo_sent, failed: r.mo_failed, inFlight: r.mo_in_flight },
      mt: { sent: r.mt_sent, failed: r.mt_failed, inFlight: r.mt_in_flight },
      reversal: { sent: r.reversal_sent, failed: r.reversal_failed, inFlight: r.reversal_in_flight },
    }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.sink.localeCompare(b.sink));
}

export interface PostbackRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly orderCode: string;
  readonly sink: Sink;
  readonly kind: Kind;
  readonly status: ConversionStatus;
  readonly source: string;
  readonly attempts: number;
  readonly httpStatus: number | null;
  readonly lastError: string | null;
  readonly marker: Marker | null;
  /** The sink may have counted it (sticky): a refund still reverses it. */
  readonly maybeCounted: boolean;
  /** The S2S payout its MT reported (a reversal shows the one of its MT). */
  readonly payoutIdr: number | null;
  readonly valueIdr: number | null;
  /** The first 300 characters of the last answer, already redacted of secrets. */
  readonly response: string | null;
  readonly latencyMs: number | null;
  readonly nextAttemptAt: Date;
}

export const RESPONSE_PREVIEW = 300;

/**
 * The events of the range, newest first, one page, with the count of all that match. The page of ids is chosen first, on the
 * (created_at, id) index and the filters alone; the order, the MT row of a reversal and the last attempt are joined to those
 * rows only, and the count is its own query (a page past the end still reports the real total).
 */
export async function postbackList(sql: Sql, f: PostbackFilters, page: number): Promise<{ readonly rows: PostbackRow[]; readonly count: number }> {
  const { start, end } = wibInstants(f);
  const where = () => sql`
    ce.created_at >= ${start} AND ce.created_at < ${end}
    ${f.adnet === null ? sql`` : sql`AND ce.adnet_id = ${f.adnet}`}
    ${f.sink === null ? sql`` : sql`AND ce.sink = ${f.sink}`}
    ${f.kind === null ? sql`` : sql`AND ce.kind = ${f.kind}`}
    ${f.status === null ? sql`` : sql`AND ce.status = ${f.status}`}
    ${f.marker === null ? sql`` : sql`AND ce.last_error = ${MARKERS[f.marker].lastError}`}`;
  const [rows, [total]] = await Promise.all([
    sql<
      {
        id: string;
        created_at: Date;
        order_code: string;
        sink: Sink;
        kind: Kind;
        status: ConversionStatus;
        s2s_label: string | null;
        attempts: number;
        last_http_status: number | null;
        last_error: string | null;
        maybe_counted: boolean;
        payout: string | null;
        value: string | null;
        response: string | null;
        latency_ms: number | null;
        next_attempt_at: Date;
      }[]
    >`
      WITH page AS (
        SELECT ce.id FROM public.conversion_events ce WHERE ${where()}
         ORDER BY ce.created_at DESC, ce.id DESC
         LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
      )
      SELECT ce.id, ce.created_at, o.order_code, ce.sink, ce.kind, ce.status,
             CASE WHEN ce.sink = 's2s' THEN public.report_source_label(ce.adnet_id) END AS s2s_label,
             ce.attempts, ce.last_http_status, ce.last_error, ce.maybe_counted,
             (CASE WHEN ce.kind = 'reversal' THEN mt.reported_payout_idr ELSE ce.reported_payout_idr END)::text AS payout, ce.value_idr::text AS value,
             left(la.response_excerpt, ${RESPONSE_PREVIEW}) AS response, la.latency_ms, ce.next_attempt_at
        FROM page
        JOIN public.conversion_events ce ON ce.id = page.id
        JOIN public.orders o ON o.id = ce.order_id
        LEFT JOIN public.conversion_events mt ON ce.kind = 'reversal' AND mt.order_id = ce.order_id AND mt.sink = ce.sink AND mt.kind = 'mt'
        LEFT JOIN LATERAL (
          SELECT a.response_excerpt, a.latency_ms FROM public.conversion_attempts a WHERE a.conversion_event_id = ce.id ORDER BY a.attempt DESC LIMIT 1
        ) la ON true
       ORDER BY ce.created_at DESC, ce.id DESC`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM public.conversion_events ce WHERE ${where()}`,
  ]);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      orderCode: r.order_code,
      sink: r.sink,
      kind: r.kind,
      status: r.status,
      source: sourceOf(r.sink, r.s2s_label),
      attempts: r.attempts,
      httpStatus: r.last_http_status,
      lastError: r.last_error,
      marker: markerOf(r.last_error),
      maybeCounted: r.maybe_counted,
      payoutIdr: r.payout === null ? null : idrOf(r.payout),
      valueIdr: r.value === null ? null : idrOf(r.value),
      response: r.response,
      latencyMs: r.latency_ms,
      nextAttemptAt: r.next_attempt_at,
    })),
    count: total?.n ?? 0,
  };
}

export interface MtReconciliationRow extends MtReconciliation {
  readonly adnetId: string;
  readonly adnet: string;
}

/**
 * The reconciliation identity per adnet over the orders CREATED in the range, from the raw tables: PAID orders with a click id
 * (ever paid: a refunded order still has its MT) against the S2S MT rows by end state.
 */
export async function reconcileMt(sql: Sql, f: Pick<PostbackFilters, "from" | "to">): Promise<MtReconciliationRow[]> {
  const { start, end } = wibInstants(f);
  const rows = await sql<{ adnet_id: string; adnet: string; paid_orders: number; sent: number; failed: number; in_flight: number }[]>`
    WITH paid AS (
      SELECT o.adnet_id, count(*)::int AS paid_orders
        FROM public.orders o
       WHERE o.created_at >= ${start} AND o.created_at < ${end} AND (o.paid_at IS NOT NULL OR o.status = 'paid')
         AND o.clickid IS NOT NULL AND o.clickid <> '' AND o.adnet_id IS NOT NULL
       GROUP BY o.adnet_id
    ), mt AS (
      SELECT ce.adnet_id, (count(*) FILTER (WHERE ce.status = 'sent'))::int AS sent, (count(*) FILTER (WHERE ce.status = 'failed'))::int AS failed,
             (count(*) FILTER (WHERE ce.status IN ('pending', 'sending')))::int AS in_flight
        FROM public.conversion_events ce JOIN public.orders o ON o.id = ce.order_id
       WHERE ce.sink = 's2s' AND ce.kind = 'mt' AND o.created_at >= ${start} AND o.created_at < ${end}
       GROUP BY ce.adnet_id
    ), ids AS (SELECT adnet_id FROM paid UNION SELECT adnet_id FROM mt)
    SELECT ids.adnet_id, public.report_source_label(ids.adnet_id) AS adnet, coalesce(paid.paid_orders, 0) AS paid_orders,
           coalesce(mt.sent, 0) AS sent, coalesce(mt.failed, 0) AS failed, coalesce(mt.in_flight, 0) AS in_flight
      FROM ids LEFT JOIN paid ON paid.adnet_id = ids.adnet_id LEFT JOIN mt ON mt.adnet_id = ids.adnet_id
     ORDER BY adnet, ids.adnet_id`;
  return rows.map((r) => ({ adnetId: r.adnet_id, adnet: r.adnet, ...mtReconciliation({ paidOrders: r.paid_orders, sent: r.sent, failed: r.failed, inFlight: r.in_flight }) }));
}
