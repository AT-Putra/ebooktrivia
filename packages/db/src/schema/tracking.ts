// Tracking: adnets, conversion events (S2S postbacks + CAPI) and their per-call log.
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgEnum, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, idr, inCheck, nonNegative, tstz, updatedAt } from "./columns.ts";
import { orders } from "./funnel.ts";

export const adnets = pgTable(
  "adnets",
  {
    id: id(),
    slug: text("slug").notNull().unique("adnets_slug_key"),
    name: text("name").notNull(),
    /** URL param carrying this adnet's click id. */
    clickidParam: text("clickid_param").notNull(),
    moUrlTemplate: text("mo_url_template"),
    mtUrlTemplate: text("mt_url_template"),
    reversalUrlTemplate: text("reversal_url_template"),
    /** Fixed payout (CPA) per MT. */
    payoutIdr: idr("payout_idr").notNull().default(0),
    /** Postback endpoint host; `{secret:name}` resolves only secrets bound to this host. */
    endpointHost: text("endpoint_host"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("adnets_slug_check", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("adnets_clickid_param_check", sql`${t.clickidParam} ~ '^[A-Za-z0-9_.-]{1,64}$'`),
    // The SDK captures, stores and sends whatever this parameter carries: no personal-data WORD in its name
    // (whole words delimited by _ . - or the ends of the name; the same pattern as SDK_PATTERNS.personalParamName
    // in @ebooktrivia/core, which a core test pins equal, so the JS RegExp and this ~* agree).
    check("adnets_clickid_param_personal_check", sql`${t.clickidParam} !~* '(^|[_.-])(phone|hp|wa|whatsapp|nama|name|email|mail|token|otp|kode|nik|ktp|card|kartu|pass|password|pwd|secret|auth|session)($|[_.-])'`),
    nonNegative("adnets_payout_idr_check", t.payoutIdr),
    check("adnets_endpoint_host_check", sql`${t.endpointHost} IS NULL OR ${t.endpointHost} = lower(${t.endpointHost})`),
  ],
);

export const conversionStatus = pgEnum("conversion_status", ["pending", "sending", "sent", "failed"]);

/**
 * One row per (order, sink, kind); claim/lease `pending -> sending -> sent|failed`, retries
 * owned by PostgreSQL via next_attempt_at. `txid` is stable per order so adnets can dedupe.
 */
export const conversionEvents = pgTable(
  "conversion_events",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    sink: text("sink").notNull(),
    kind: text("kind").notNull(),
    status: conversionStatus("status").notNull().default("pending"),
    adnetId: uuid("adnet_id").references(() => adnets.id, { onDelete: "restrict" }),
    txid: text("txid").notNull(),
    eventId: uuid("event_id").notNull(),
    valueIdr: idr("value_idr"),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: tstz("lease_until"),
    nextAttemptAt: tstz("next_attempt_at").notNull().defaultNow(),
    lastHttpStatus: integer("last_http_status"),
    lastError: text("last_error"),
    sentAt: tstz("sent_at"),
    failedAt: tstz("failed_at"),
    /**
     * US-024: the sink MAY have counted this conversion (a 2xx, or an uncertain send: a timeout, a refused redirect,
     * an expired lease). Sticky: nothing clears it (not a re-fire, not payments), so a refund still reverses an MT
     * that an Owner re-fire has put back to pending.
     */
    maybeCounted: boolean("maybe_counted").notNull().default(false),
    /** US-024: the payout the S2S MT reported (set at the claim); a reversal takes the same back, whatever the adnet's setting is by then. */
    reportedPayoutIdr: idr("reported_payout_idr"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("conversion_events_order_id_sink_kind_key").on(t.orderId, t.sink, t.kind),
    inCheck("conversion_events_sink_check", t.sink, ["s2s", "meta", "tiktok", "google"]),
    inCheck("conversion_events_kind_check", t.kind, ["mo", "mt", "reversal"]),
    check("conversion_events_s2s_adnet_check", sql`${t.sink} <> 's2s' OR ${t.adnetId} IS NOT NULL`),
    check("conversion_events_value_idr_check", sql`${t.valueIdr} IS NULL OR ${t.valueIdr} >= 0`),
    check("conversion_events_reported_payout_idr_check", sql`${t.reportedPayoutIdr} IS NULL OR ${t.reportedPayoutIdr} >= 0`),
    nonNegative("conversion_events_attempts_check", t.attempts),
    index("conversion_events_due_idx").on(t.status, t.nextAttemptAt),
    // US-029: the postback report lists and counts a date range, newest first (keyset by (created_at, id)).
    index("conversion_events_created_at_id_idx").on(t.createdAt, t.id),
    // US-029: as orders_updated_at_idx, for the days a conversion touched.
    index("conversion_events_updated_at_idx").on(t.updatedAt),
  ],
);

/**
 * Every postback / CAPI call (AC-T7): redacted URL, status, response truncated to 4 KB, latency. One row per
 * (event, attempt number): a claim bumps conversion_events.attempts, so an attempt is logged at most once.
 */
export const conversionAttempts = pgTable(
  "conversion_attempts",
  {
    id: id(),
    conversionEventId: uuid("conversion_event_id")
      .notNull()
      .references(() => conversionEvents.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    requestUrlRedacted: text("request_url_redacted"),
    httpStatus: integer("http_status"),
    responseExcerpt: text("response_excerpt"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    check("conversion_attempts_attempt_check", sql`${t.attempt} >= 1`),
    check(
      "conversion_attempts_response_excerpt_check",
      sql`${t.responseExcerpt} IS NULL OR char_length(${t.responseExcerpt}) <= 4096`,
    ),
    // The unique key's index serves every lookup by event (the former plain index on the event id was redundant).
    unique("conversion_attempts_event_attempt_key").on(t.conversionEventId, t.attempt),
  ],
);
