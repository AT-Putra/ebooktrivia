// The delivery report's queries (AC-A6): per-order WhatsApp and e-mail status with the sender number and the retries, and the
// volume and failure rate of every pool number. ONE small module on purpose: today it reads the `deliveries` table (the numbers a
// delivery tried are its tried_session_ids), and when US-025's send ledger (waha_sends: one row per send attempt per number) is
// merged, only this file changes (the page and the figures it shows stay).
//
// Per number, over the WhatsApp deliveries CREATED in the range (WIB): an attempt is one entry of tried_session_ids. A number that is
// not the LAST one tried was left after a retryable failure (the next number is only tried after one), so it counts as a FAILED
// attempt; the last number's attempt is the delivery's own outcome (sent, failed, unknown, or still in flight). volume = sent + failed
// + unknown, failure rate = failed / volume (core rateBps), so a number that keeps failing over to the next one shows it.
// An attempt still pending or sending is "in flight" and in no rate. Buyers are shown masked (SQL mask_name / mask_phone).
import { DELIVERY_CHANNELS, DELIVERY_STATUSES, type DeliveryStatus, isUuid, rateBps, reportRange, wibDateOf, addDays, REPORT_DEFAULT_DAYS } from "@ebooktrivia/core";
import type { Sql } from "../db.ts";
import { PAGE_SIZE, param, type Query, wibInstants } from "./common.ts";

export interface DeliveryFilters {
  readonly from: string;
  readonly to: string;
  readonly channel: "whatsapp" | "email" | null;
  readonly status: DeliveryStatus | null;
  /** A pool number (waha_sessions.id): only deliveries that tried it. */
  readonly sessionId: string | null;
}

export function parseDeliveryFilters(query: Query, now: Date): { readonly filters: DeliveryFilters; readonly error: string | null } {
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
  const numberRaw = param(query, "number");
  if (numberRaw !== "" && !isUuid(numberRaw)) errors.push("A filter value is not valid.");
  const resolved = range.ok ? range : { from: addDays(today, 1 - REPORT_DEFAULT_DAYS), to: today };
  return {
    filters: {
      from: resolved.from,
      to: resolved.to,
      channel: pick("channel", DELIVERY_CHANNELS),
      status: pick("status", DELIVERY_STATUSES),
      sessionId: numberRaw !== "" && isUuid(numberRaw) ? numberRaw : null,
    },
    error: errors[0] ?? null,
  };
}

export interface NumberStats {
  readonly sessionId: string;
  readonly session: string;
  /** The pool number (the Owner's own sender number, not buyer data), null until paired. */
  readonly phone: string | null;
  readonly active: boolean;
  readonly sent: number;
  readonly failed: number;
  readonly unknown: number;
  readonly inFlight: number;
  readonly volume: number;
  /** failed / volume in basis points; null when the number made no attempt that ended. */
  readonly failureBps: number | null;
}

export async function perNumberStats(sql: Sql, f: Pick<DeliveryFilters, "from" | "to">): Promise<NumberStats[]> {
  const { start, end } = wibInstants(f);
  const rows = await sql<{ id: string; session_name: string; phone: string | null; active: boolean; sent: number; failed: number; unknown: number; in_flight: number }[]>`
    WITH att AS (
      SELECT t.sid,
             CASE WHEN t.ord < cardinality(d.tried_session_ids) THEN 'failed' ELSE d.status::text END AS outcome
        FROM public.deliveries d
        CROSS JOIN LATERAL unnest(d.tried_session_ids) WITH ORDINALITY AS t(sid, ord)
       WHERE d.channel = 'whatsapp' AND d.created_at >= ${start} AND d.created_at < ${end}
    )
    SELECT s.id, s.session_name, s.phone, s.active,
           (count(att.sid) FILTER (WHERE att.outcome = 'sent'))::int AS sent,
           (count(att.sid) FILTER (WHERE att.outcome = 'failed'))::int AS failed,
           (count(att.sid) FILTER (WHERE att.outcome = 'unknown'))::int AS unknown,
           (count(att.sid) FILTER (WHERE att.outcome IN ('pending', 'sending')))::int AS in_flight
      FROM public.waha_sessions s LEFT JOIN att ON att.sid = s.id
     GROUP BY s.id
     ORDER BY (count(att.sid) FILTER (WHERE att.outcome IN ('sent', 'failed', 'unknown'))) DESC, s.session_name`;
  return rows.map((r) => {
    const volume = r.sent + r.failed + r.unknown;
    return { sessionId: r.id, session: r.session_name, phone: r.phone, active: r.active, sent: r.sent, failed: r.failed, unknown: r.unknown, inFlight: r.in_flight, volume, failureBps: rateBps(r.failed, volume) };
  });
}

export interface ChannelCounts {
  readonly channel: "whatsapp" | "email";
  readonly total: number;
  readonly sent: number;
  readonly failed: number;
  readonly unknown: number;
  readonly pending: number;
}

/** Deliveries by channel and end state over the range (the order count behind the per-number figures, and the e-mail side). */
export async function channelCounts(sql: Sql, f: Pick<DeliveryFilters, "from" | "to">): Promise<ChannelCounts[]> {
  const { start, end } = wibInstants(f);
  const rows = await sql<{ channel: "whatsapp" | "email"; total: number; sent: number; failed: number; unknown: number; pending: number }[]>`
    SELECT d.channel, count(*)::int AS total, (count(*) FILTER (WHERE d.status = 'sent'))::int AS sent, (count(*) FILTER (WHERE d.status = 'failed'))::int AS failed,
           (count(*) FILTER (WHERE d.status = 'unknown'))::int AS unknown, (count(*) FILTER (WHERE d.status IN ('pending', 'sending')))::int AS pending
      FROM public.deliveries d WHERE d.created_at >= ${start} AND d.created_at < ${end}
     GROUP BY d.channel ORDER BY d.channel DESC`;
  return rows;
}

export interface DeliveryRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly orderCode: string;
  /** Masked in SQL (public.mask_name / mask_phone): the report holds no raw buyer data. */
  readonly buyerName: string;
  readonly buyerPhone: string | null;
  readonly channel: "whatsapp" | "email";
  readonly status: DeliveryStatus;
  /** The number the WhatsApp message was (last) sent from. */
  readonly sender: string | null;
  readonly attempts: number;
  readonly numbersTried: number;
  readonly ack: string | null;
  readonly lastError: string | null;
  readonly sentAt: Date | null;
}

/**
 * The deliveries of the range, newest first, one page, with the count of all that match. The page of ids is chosen first, on the
 * (created_at, id) index and the filters alone; the order and the sender number are joined to those rows only, and the count is its
 * own query (a page past the end still reports the real total).
 */
export async function deliveryList(sql: Sql, f: DeliveryFilters, page: number): Promise<{ readonly rows: DeliveryRow[]; readonly count: number }> {
  const { start, end } = wibInstants(f);
  const where = () => sql`
    d.created_at >= ${start} AND d.created_at < ${end}
    ${f.channel === null ? sql`` : sql`AND d.channel = ${f.channel}`}
    ${f.status === null ? sql`` : sql`AND d.status = ${f.status}`}
    ${f.sessionId === null ? sql`` : sql`AND ${f.sessionId}::uuid = ANY (d.tried_session_ids)`}`;
  const [rows, [total]] = await Promise.all([
    sql<
      {
        id: string;
        created_at: Date;
        order_code: string;
        buyer_name: string;
        buyer_phone: string | null;
        channel: "whatsapp" | "email";
        status: DeliveryStatus;
        sender: string | null;
        attempts: number;
        numbers_tried: number;
        wa_ack: string | null;
        last_error: string | null;
        sent_at: Date | null;
      }[]
    >`
      WITH page AS (
        SELECT d.id FROM public.deliveries d WHERE ${where()}
         ORDER BY d.created_at DESC, d.id DESC
         LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
      )
      SELECT d.id, d.created_at, o.order_code, public.mask_name(o.buyer_name) AS buyer_name, public.mask_phone(o.buyer_phone) AS buyer_phone, d.channel, d.status,
             s.phone AS sender, d.attempts, cardinality(d.tried_session_ids) AS numbers_tried, d.wa_ack, left(d.last_error, 200) AS last_error, d.sent_at
        FROM page
        JOIN public.deliveries d ON d.id = page.id
        JOIN public.orders o ON o.id = d.order_id
        LEFT JOIN public.waha_sessions s ON s.id = coalesce(d.session_id, d.tried_session_ids[cardinality(d.tried_session_ids)])
       ORDER BY d.created_at DESC, d.id DESC`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM public.deliveries d WHERE ${where()}`,
  ]);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      orderCode: r.order_code,
      buyerName: r.buyer_name,
      buyerPhone: r.buyer_phone,
      channel: r.channel,
      status: r.status,
      sender: r.sender,
      attempts: r.attempts,
      numbersTried: r.numbers_tried,
      ack: r.wa_ack,
      lastError: r.last_error,
      sentAt: r.sent_at,
    })),
    count: total?.n ?? 0,
  };
}
