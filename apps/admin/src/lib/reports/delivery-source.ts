// The delivery report's queries (AC-A6): per-order WhatsApp and e-mail status with the sender number and the retries, the volume and failure
// rate of every pool number, and the failed deliveries a Staff or Owner can resend. ONE small module on purpose: it is the one place that knows where
// deliveries are recorded.
//
// Per number, from the SEND LEDGER (waha_sends, US-025: one row per claimed send of a number, whatever the kind: opener, reply, text, OTP) over the sends
// CLAIMED in the range (WIB): `outcome` says how each ended. volume = sent + failed + unknown, failure rate = failed / volume (core rateBps). A `failed`
// send is one WAHA refused for sure (the number's own failure: the delivery went on to another number); `unknown` may have gone out; `reserved` is in
// flight and in no rate. What is not the number's doing (a phone that is not on WhatsApp, WhatsApp's own limit on new contacts, a fault of ours) takes its row
// back and is in no figure. The ledger keeps 31 days: a longer range shows the last 31.
// Buyers are shown masked (SQL mask_name / mask_phone), and an error is shown as its CODE only: `last_error` is a short code by design, but the report does not
// trust a column that a future writer could fill with a message (security review US-029 L2): anything that is not a lower-case code is shown as `other`.
import { DELIVERED_WRONG_FILE, DELIVERY_CHANNELS, DELIVERY_STATUSES, type DeliveryStatus, isUuid, rateBps, reportRange, wibDateOf, addDays, REPORT_DEFAULT_DAYS } from "@ebooktrivia/core";
import type { Sql } from "../db.ts";
import { WRONG_FILE_HANDLED_ACTION } from "../settings/deliveries.ts";
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
    SELECT s.id, s.session_name, s.phone, s.active,
           (count(x.id) FILTER (WHERE x.outcome = 'sent'))::int AS sent,
           (count(x.id) FILTER (WHERE x.outcome = 'failed'))::int AS failed,
           (count(x.id) FILTER (WHERE x.outcome = 'unknown'))::int AS unknown,
           (count(x.id) FILTER (WHERE x.outcome = 'reserved'))::int AS in_flight
      FROM public.waha_sessions s
      LEFT JOIN public.waha_sends x ON x.session_id = s.id AND x.created_at >= ${start} AND x.created_at < ${end}
     GROUP BY s.id
     ORDER BY (count(x.id) FILTER (WHERE x.outcome IN ('sent', 'failed', 'unknown'))) DESC, s.session_name`;
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
  /** The error as a CODE (`other` for anything that is not one), never the stored text. */
  readonly errorCode: string | null;
  /** The state of the short WhatsApp opener (Owner decision D7) of a WhatsApp delivery: pending, sending, sent (no reply yet), unknown, failed (given up, or the phone is not on WhatsApp), expired. */
  readonly opener: string | null;
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
    ${f.sessionId === null ? sql`` : sql`AND EXISTS (SELECT 1 FROM public.waha_sends x WHERE x.delivery_id = d.id AND x.session_id = ${f.sessionId}::uuid)`}`;
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
        error_code: string | null;
        opener: string | null;
        sent_at: Date | null;
      }[]
    >`
      WITH page AS (
        SELECT d.id FROM public.deliveries d WHERE ${where()}
         ORDER BY d.created_at DESC, d.id DESC
         LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
      )
      SELECT d.id, d.created_at, o.order_code, public.mask_name(o.buyer_name) AS buyer_name, public.mask_phone(o.buyer_phone) AS buyer_phone, d.channel, d.status,
             s.phone AS sender, d.attempts, cardinality(d.tried_session_ids) AS numbers_tried, d.wa_ack,
             CASE WHEN d.last_error IS NULL THEN NULL WHEN d.last_error ~ '^[a-z0-9_]{1,64}$' THEN d.last_error ELSE 'other' END AS error_code, op.status AS opener, d.sent_at
        FROM page
        JOIN public.deliveries d ON d.id = page.id
        JOIN public.orders o ON o.id = d.order_id
        LEFT JOIN public.delivery_openers op ON op.delivery_id = d.id
        LEFT JOIN public.waha_sessions s ON s.id = coalesce(d.session_id, op.session_id, d.tried_session_ids[cardinality(d.tried_session_ids)])
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
      errorCode: r.error_code,
      opener: r.opener,
      sentAt: r.sent_at,
    })),
    count: total?.n ?? 0,
  };
}

/**
 * A delivery that needs a person: failed for good, a send that may have gone out (unknown), or a WhatsApp file that arrived WRONG (`sent` with the code
 * `delivered_wrong_file`, US-005 R11: the report only shows it; a `sent` row stays final, so it has no resend).
 */
export interface AttentionRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly orderCode: string;
  readonly buyerName: string;
  readonly buyerPhone: string | null;
  readonly channel: "whatsapp" | "email";
  readonly status: "failed" | "unknown" | "sent";
  readonly errorCode: string | null;
  readonly attempts: number;
  readonly sender: string | null;
}

/**
 * How many failed, unknown and wrong-file deliveries of PAID orders wait for a person, and the newest of them (the resend list; the wrong-file ones are shown, never
 * resent).
 */
export async function attentionList(
  sql: Sql,
  limit = PAGE_SIZE,
): Promise<{ readonly rows: AttentionRow[]; readonly failed: number; readonly unknown: number; readonly wrongFile: number }> {
  // A wrong-file delivery leaves the list when the Owner marked it handled (an audit entry, lib/settings/deliveries.ts): the delivery itself never changes.
  const needsAttention = () => sql`
    (d.status IN ('failed', 'unknown')
     OR (d.status = 'sent' AND d.last_error = ${DELIVERED_WRONG_FILE}
         AND NOT EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = ${WRONG_FILE_HANDLED_ACTION} AND a.entity_type = 'delivery' AND a.entity_id = d.id::text)))
    AND o.status = 'paid'`;
  const [rows, [counts]] = await Promise.all([
    sql<
      { id: string; created_at: Date; order_code: string; buyer_name: string; buyer_phone: string | null; channel: "whatsapp" | "email"; status: "failed" | "unknown" | "sent"; error_code: string | null; attempts: number; sender: string | null }[]
    >`
      SELECT d.id, d.created_at, o.order_code, public.mask_name(o.buyer_name) AS buyer_name, public.mask_phone(o.buyer_phone) AS buyer_phone, d.channel, d.status::text AS status,
             CASE WHEN d.last_error IS NULL THEN NULL WHEN d.last_error ~ '^[a-z0-9_]{1,64}$' THEN d.last_error ELSE 'other' END AS error_code, d.attempts, s.phone AS sender
        FROM public.deliveries d
        JOIN public.orders o ON o.id = d.order_id
        LEFT JOIN public.waha_sessions s ON s.id = coalesce(d.session_id, d.tried_session_ids[cardinality(d.tried_session_ids)])
       WHERE ${needsAttention()}
       ORDER BY d.updated_at DESC, d.id DESC
       LIMIT ${limit}`,
    sql<{ failed: number; unknown: number; wrong_file: number }[]>`
      SELECT (count(*) FILTER (WHERE d.status = 'failed'))::int AS failed, (count(*) FILTER (WHERE d.status = 'unknown'))::int AS unknown,
             (count(*) FILTER (WHERE d.status = 'sent'))::int AS wrong_file
        FROM public.deliveries d JOIN public.orders o ON o.id = d.order_id
       WHERE ${needsAttention()}`,
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
      errorCode: r.error_code,
      attempts: r.attempts,
      sender: r.sender,
    })),
    failed: counts?.failed ?? 0,
    unknown: counts?.unknown ?? 0,
    wrongFile: counts?.wrong_file ?? 0,
  };
}
