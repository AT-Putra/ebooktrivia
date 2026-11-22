// Funnel: landing pages + domains + versions, visits, orders, Midtrans attempts, notification
// inbox, payments.
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
  bigint,
} from "drizzle-orm/pg-core";
import { products, programs } from "./catalog.ts";
import {
  bytea,
  createdAt,
  e164Check,
  id,
  idr,
  inCheck,
  jsonObject,
  nonNegative,
  tstz,
  updatedAt,
} from "./columns.ts";
import { uploads } from "./governance.ts";
import { players } from "./player.ts";
import { adnets } from "./tracking.ts";

export const landingPages = pgTable(
  "landing_pages",
  {
    id: id(),
    /** Public key used in the snippet (`data-lp="lp_..."`) and the checkout path. */
    lpKey: text("lp_key").notNull().unique("landing_pages_lp_key_key"),
    name: text("name").notNull(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "restrict" }),
    gateway: text("gateway").notNull().default("midtrans"),
    hosting: text("hosting").notNull().default("external"),
    /** Browser pixel ids, e.g. {"meta": "...", "tiktok": "...", "gtag": "..."}. */
    pixels: jsonb("pixels").notNull().default({}),
    currentVersionId: uuid("current_version_id").references((): AnyPgColumn => lpVersions.id, {
      onDelete: "set null",
    }),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("landing_pages_lp_key_check", sql`${t.lpKey} ~ '^lp_[0-9A-Za-z]{8,40}$'`),
    inCheck("landing_pages_gateway_check", t.gateway, ["midtrans"]),
    inCheck("landing_pages_hosting_check", t.hosting, ["external", "zip"]),
    jsonObject("landing_pages_pixels_check", t.pixels),
  ],
);

/** Adnets allowed on a landing page (AC-S1). */
export const landingPageAdnets = pgTable(
  "landing_page_adnets",
  {
    landingPageId: uuid("landing_page_id")
      .notNull()
      .references(() => landingPages.id, { onDelete: "cascade" }),
    adnetId: uuid("adnet_id")
      .notNull()
      .references(() => adnets.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ name: "landing_page_adnets_pkey", columns: [t.landingPageId, t.adnetId] })],
);

/** Registered LP hosts (lowercase / punycode). Read by internal_rw for Caddy on-demand TLS. */
export const lpDomains = pgTable(
  "lp_domains",
  {
    id: id(),
    landingPageId: uuid("landing_page_id")
      .notNull()
      .references(() => landingPages.id, { onDelete: "cascade" }),
    host: text("host").notNull().unique("lp_domains_host_key"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "lp_domains_host_check",
      sql`${t.host} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' AND char_length(${t.host}) <= 253`,
    ),
  ],
);

/** Uploaded LP ZIP versions, served from /srv/lp/hosts/{host}/current (symlink swap). */
export const lpVersions = pgTable(
  "lp_versions",
  {
    id: id(),
    landingPageId: uuid("landing_page_id")
      .notNull()
      .references((): AnyPgColumn => landingPages.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => uploads.id, { onDelete: "restrict" }),
    fileCount: integer("file_count").notNull(),
    uncompressedBytes: bigint("uncompressed_bytes", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("lp_versions_landing_page_id_version_key").on(t.landingPageId, t.version),
    check("lp_versions_version_check", sql`${t.version} >= 1`),
    nonNegative("lp_versions_file_count_check", t.fileCount),
    nonNegative("lp_versions_uncompressed_bytes_check", t.uncompressedBytes),
  ],
);

/** Attribution captured by the SDK (clickid, sub params, UTM, ad-platform click ids). */
const attributionColumns = () => ({
  adnetId: uuid("adnet_id").references(() => adnets.id, { onDelete: "set null" }),
  clickid: text("clickid"),
  subId: text("sub_id"),
  pub: text("pub"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  fbclid: text("fbclid"),
  fbp: text("fbp"),
  fbc: text("fbc"),
  ttclid: text("ttclid"),
  gclid: text("gclid"),
});

export const visits = pgTable(
  "visits",
  {
    id: id(),
    landingPageId: uuid("landing_page_id")
      .notNull()
      .references(() => landingPages.id, { onDelete: "restrict" }),
    occurredAt: tstz("occurred_at").notNull().defaultNow(),
    ...attributionColumns(),
    ip: inet("ip"),
    uaHash: bytea("ua_hash"),
  },
  (t) => [
    index("visits_landing_page_occurred_idx").on(t.landingPageId, t.occurredAt),
    // US-029: the report rollup reads the last two days of visits whatever the landing page; BRIN is a few KB and costs
    // an insert almost nothing, since visits are appended in time order.
    index("visits_occurred_at_brin_idx").using("brin", t.occurredAt),
  ],
);

export const orderStatus = pgEnum("order_status", [
  "pending",
  "paid",
  "review",
  "expired",
  "gateway_failed",
  "snap_create_failed",
  "refunded",
]);

export const orders = pgTable(
  "orders",
  {
    id: id(),
    /** Opaque id for `order.<dom>/{publicId}` and `midtrans_order_id = {publicId}-{n}`. */
    publicId: text("public_id").notNull().unique("orders_public_id_key"),
    /** Random >= 40 bits, Crockford base32 (generated in app code); matched in buyer-first WA. */
    orderCode: text("order_code").notNull().unique("orders_order_code_key"),
    landingPageId: uuid("landing_page_id")
      .notNull()
      .references(() => landingPages.id, { onDelete: "restrict" }),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "restrict" }),
    /** '' after anonymization (US-030), like buyer_email. */
    buyerName: text("buyer_name").notNull(),
    /** NULL only after anonymization (a deletion request, US-030: orders_buyer_phone_present_check). */
    buyerPhone: text("buyer_phone"),
    buyerEmail: text("buyer_email").notNull(),
    /**
     * The checkout's "same buyer" (Owner decision D1, US-020): SHA-256 of the normalised phone, name and
     * e-mail (@ebooktrivia/core buyerKey). Dedupe reuses an open order only for the same buyer_key.
     */
    buyerKey: bytea("buyer_key").notNull(),
    /** Computed server-side (AC-S5). */
    amountIdr: idr("amount_idr").notNull(),
    currency: text("currency").notNull().default("IDR"),
    status: orderStatus("status").notNull().default("pending"),
    /** n of the latest midtrans_attempts row. */
    snapAttemptCount: integer("snap_attempt_count").notNull().default(0),
    snapRedirectUrl: text("snap_redirect_url"),
    snapExpiresAt: tstz("snap_expires_at"),
    expiresAt: tstz("expires_at").notNull(),
    /** Shared by browser pixel and CAPI events for dedupe. */
    eventId: uuid("event_id").notNull().defaultRandom().unique("orders_event_id_key"),
    visitId: uuid("visit_id").references(() => visits.id, { onDelete: "set null" }),
    ...attributionColumns(),
    ip: inet("ip"),
    uaHash: bytea("ua_hash"),
    /** Set by enqueue_mo(); app roles cannot write it, so MO is enqueued at most once. */
    moOutboxId: uuid("mo_outbox_id"),
    browserMtFiredAt: tstz("browser_mt_fired_at"),
    paidAt: tstz("paid_at"),
    refundedAt: tstz("refunded_at"),
    /**
     * US-030 (UU PDP deletion = anonymization, plan §10 item 6): set by public.erase_data_subject (sql/privacy.sql),
     * which empties the buyer's name, phone, e-mail, device and ad-platform click ids and replaces buyer_key, and
     * keeps the pseudonymous financial row (ids, amounts, status, timestamps, product, program, attribution keys).
     * Never cleared again (orders_anonymized_guard).
     */
    anonymizedAt: tstz("anonymized_at"),
    /**
     * US-033: when the order last entered `review` (NULL in every other status). Kept by the trigger
     * orders_review_since (sql/triggers.sql), whoever moves the status: the Owner's review queue sorts by it
     * and the minute sweeper warns once about an order stuck there for more than 24 hours.
     */
    reviewSince: tstz("review_since"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("orders_public_id_check", sql`${t.publicId} ~ '^[0-9A-Za-z]{16,40}$'`),
    check("orders_buyer_phone_present_check", sql`${t.buyerPhone} IS NOT NULL OR ${t.anonymizedAt} IS NOT NULL`),
    check(
      "orders_anonymized_check",
      sql`${t.anonymizedAt} IS NULL OR (${t.buyerPhone} IS NULL AND ${t.buyerName} = '' AND ${t.buyerEmail} = '' AND ${t.ip} IS NULL AND ${t.uaHash} IS NULL
          AND ${t.fbclid} IS NULL AND ${t.fbp} IS NULL AND ${t.fbc} IS NULL AND ${t.ttclid} IS NULL AND ${t.gclid} IS NULL)`,
    ),
    check("orders_review_since_check", sql`(${t.status} = 'review') = (${t.reviewSince} IS NOT NULL)`),
    // Crockford base32 alphabet (no I, L, O, U); 8 chars = 40 bits.
    check("orders_order_code_check", sql`${t.orderCode} ~ '^[0-9A-HJKMNP-TV-Z]{8,16}$'`),
    e164Check("orders_buyer_phone_check", t.buyerPhone),
    check("orders_amount_idr_check", sql`${t.amountIdr} > 0`),
    check("orders_currency_check", sql`${t.currency} = 'IDR'`),
    check("orders_buyer_key_check", sql`octet_length(${t.buyerKey}) = 32`),
    nonNegative("orders_snap_attempt_count_check", t.snapAttemptCount),
    // Checkout dedupe: the open order of the same buyer (phone + buyer_key) on the LP within the window (AC-T8, D1).
    index("orders_dedupe_idx").on(t.landingPageId, t.buyerPhone, t.buyerKey, t.createdAt),
    index("orders_status_created_idx").on(t.status, t.createdAt),
    // US-029: the sales export pages through a date range by (created_at, id) (keyset), and the postback reconciliation reads the range.
    index("orders_created_at_id_idx").on(t.createdAt, t.id),
    // US-029: the rollup finds the days an old order was touched on (updated_at since the last refresh).
    index("orders_updated_at_idx").on(t.updatedAt),
    index("orders_program_status_idx").on(t.programId, t.status),
    index("orders_player_idx").on(t.playerId),
    // US-030: a deletion request finds the data subject's orders by phone, and the stranger retention of wa_contacts asks whether a phone is a buyer's.
    index("orders_buyer_phone_idx").on(t.buyerPhone),
    // US-033: the Owner's review queue, its count (dashboard, navigation badge) and the stuck-in-review sweep.
    index("orders_review_since_idx").on(t.reviewSince).where(sql`${t.reviewSince} IS NOT NULL`),
  ],
);

/** One row per Snap create; `midtrans_order_id = {publicId}-{n}`. */
export const midtransAttempts = pgTable(
  "midtrans_attempts",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    n: integer("n").notNull(),
    midtransOrderId: text("midtrans_order_id").notNull().unique("midtrans_attempts_midtrans_order_id_key"),
    status: text("status").notNull().default("requested"),
    snapToken: text("snap_token"),
    redirectUrl: text("redirect_url"),
    error: text("error"),
    /**
     * The attempt's last RE-QUERIED Midtrans status (US-021, written by the worker only): transaction_status
     * and fraud_status as the signed status answer gave them, and when the re-query was made (a re-query
     * older than this one is never applied). NULL until the first re-query. The order machine counts
     * the order's other settled attempts from these (double payments).
     */
    gatewayStatus: text("gateway_status"),
    gatewayFraudStatus: text("gateway_fraud_status"),
    gatewayCheckedAt: tstz("gateway_checked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("midtrans_attempts_order_id_n_key").on(t.orderId, t.n),
    check("midtrans_attempts_n_check", sql`${t.n} >= 1`),
    check("midtrans_attempts_midtrans_order_id_check", sql`char_length(${t.midtransOrderId}) <= 50`),
    inCheck("midtrans_attempts_status_check", t.status, ["requested", "created", "failed"]),
    check(
      "midtrans_attempts_gateway_check",
      sql`(${t.gatewayStatus} IS NULL) = (${t.gatewayCheckedAt} IS NULL) AND char_length(${t.gatewayStatus}) <= 64 AND char_length(${t.gatewayFraudStatus}) <= 64`,
    ),
  ],
);

/** Raw notification inbox: INSERT ... ON CONFLICT DO NOTHING, then enqueue_notification(id). */
export const paymentNotifications = pgTable(
  "payment_notifications",
  {
    id: id(),
    midtransOrderId: text("midtrans_order_id").notNull(),
    transactionStatus: text("transaction_status").notNull(),
    statusCode: text("status_code").notNull(),
    signature: text("signature").notNull(),
    raw: jsonb("raw").notNull(),
    receivedAt: tstz("received_at").notNull().defaultNow(),
    /** Set by enqueue_notification(); app roles cannot write it. */
    outboxId: uuid("outbox_id"),
    processedAt: tstz("processed_at"),
  },
  (t) => [
    unique("payment_notifications_dedupe_key").on(t.midtransOrderId, t.transactionStatus, t.statusCode, t.signature),
    jsonObject("payment_notifications_raw_check", t.raw),
  ],
);

/** Gateway transactions; status, amount and currency come from the server re-query. */
export const payments = pgTable(
  "payments",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    midtransAttemptId: uuid("midtrans_attempt_id").references(() => midtransAttempts.id, { onDelete: "restrict" }),
    gatewayTxnId: text("gateway_txn_id").notNull().unique("payments_gateway_txn_id_key"),
    paymentType: text("payment_type"),
    transactionStatus: text("transaction_status").notNull(),
    fraudStatus: text("fraud_status"),
    grossAmountIdr: idr("gross_amount_idr").notNull(),
    currency: text("currency").notNull().default("IDR"),
    feeIdr: idr("fee_idr"),
    settledAt: tstz("settled_at"),
    raw: jsonb("raw").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    nonNegative("payments_gross_amount_idr_check", t.grossAmountIdr),
    check("payments_fee_idr_check", sql`${t.feeIdr} IS NULL OR ${t.feeIdr} >= 0`),
    check("payments_currency_check", sql`${t.currency} = 'IDR'`),
    index("payments_order_idx").on(t.orderId),
    // US-029: as orders_updated_at_idx, for the days a payment touched.
    index("payments_updated_at_idx").on(t.updatedAt),
  ],
);

/**
 * The nightly payment reconciliation (US-021, plan M6.5): one run per WIB day (@ebooktrivia/core
 * reconciliationDay), claimed by one worker. It re-queries EVERY midtrans_attempts row of the orders
 * active in the last 7 days.
 */
export const paymentReconciliationRuns = pgTable(
  "payment_reconciliation_runs",
  {
    id: id(),
    runDate: date("run_date", { mode: "string" }).notNull().unique("payment_reconciliation_runs_run_date_key"),
    startedAt: tstz("started_at").notNull().defaultNow(),
    /** Refreshed while the run makes progress; a run whose heartbeat is stale is claimed again. */
    heartbeatAt: tstz("heartbeat_at").notNull().defaultNow(),
    finishedAt: tstz("finished_at"),
    attemptsChecked: integer("attempts_checked").notNull().default(0),
    findings: integer("findings").notNull().default(0),
    /** Re-queries that failed (the attempt was not checked). */
    errors: integer("errors").notNull().default(0),
  },
  (t) => [
    nonNegative("payment_reconciliation_runs_attempts_checked_check", t.attemptsChecked),
    nonNegative("payment_reconciliation_runs_findings_check", t.findings),
    nonNegative("payment_reconciliation_runs_errors_check", t.errors),
  ],
);

/** @ebooktrivia/core RECONCILE_FINDINGS (a core test pins them equal). */
export const RECONCILE_FINDING_KINDS = ["settled_not_paid", "paid_not_settled", "double_settlement", "settlement_review", "refunded_but_settled", "requery_refused"] as const;

/**
 * The report rows of a reconciliation: one per run, order and kind of mismatch, each also raised as an
 * alert. `attempts` = what Midtrans said about each attempt ([{n, verdict, transaction_status}]); no PII.
 */
export const paymentReconciliationFindings = pgTable(
  "payment_reconciliation_findings",
  {
    id: id(),
    runId: uuid("run_id").notNull(),
    orderId: uuid("order_id").notNull(),
    kind: text("kind").notNull(),
    /** Our order status before the reconciliation applied anything. */
    orderStatus: orderStatus("order_status").notNull(),
    attempts: jsonb("attempts").notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    // Named here: the generated names would pass PostgreSQL's 63-byte identifier limit.
    foreignKey({ name: "payment_reconciliation_findings_run_id_fk", columns: [t.runId], foreignColumns: [paymentReconciliationRuns.id] }).onDelete("restrict"),
    foreignKey({ name: "payment_reconciliation_findings_order_id_fk", columns: [t.orderId], foreignColumns: [orders.id] }).onDelete("restrict"),
    unique("payment_reconciliation_findings_run_id_order_id_kind_key").on(t.runId, t.orderId, t.kind),
    inCheck("payment_reconciliation_findings_kind_check", t.kind, [...RECONCILE_FINDING_KINDS]),
    check("payment_reconciliation_findings_attempts_check", sql`jsonb_typeof(${t.attempts}) = 'array'`),
    index("payment_reconciliation_findings_order_idx").on(t.orderId),
  ],
);

/** US-033: the Owner's decisions on an order in review (@ebooktrivia/core OWNER_DECISIONS; a core test pins them equal). */
export const OWNER_DECISION_KINDS = ["paid", "not_paid"] as const;

/**
 * The Owner's decision ledger for orders in `review` (US-033): one row per decision, written only by the SECURITY
 * DEFINER public.order_review_decide (sql/order-review.sql), append-only for EVERY writer (ET187). `attempts` is the
 * fingerprint the Owner decided on: every Midtrans attempt of the order with its last re-queried status
 * ([{n, status, fraud}], status NULL before the first re-query). The payment code honours the latest decision while an
 * attempt's re-queried status is still the one in it (no new Midtrans event); a different status is processed normally.
 * `request_key` makes a double click or a replayed POST a no-op with the same answer. No PII: the reason is refused
 * when it looks like an e-mail address or a phone number.
 */
export const orderOwnerDecisions = pgTable(
  "order_owner_decisions",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    fromStatus: orderStatus("from_status").notNull(),
    toStatus: orderStatus("to_status").notNull(),
    attempts: jsonb("attempts").notNull(),
    reason: text("reason").notNull(),
    /** admin_auth.user id of the Owner (no FK, like audit_log: the ledger never blocks or cascades). */
    decidedByAdminUserId: text("decided_by_admin_user_id").notNull(),
    requestKey: uuid("request_key").notNull().unique("order_owner_decisions_request_key_key"),
    /** What the decision did (counts and the eligibility after it); returned again on a replay. */
    effects: jsonb("effects").notNull().default({}),
    decidedAt: tstz("decided_at").notNull().defaultNow(),
  },
  (t) => [
    inCheck("order_owner_decisions_decision_check", t.decision, [...OWNER_DECISION_KINDS]),
    check("order_owner_decisions_status_check", sql`${t.fromStatus} = 'review' AND ${t.toStatus} IN ('paid', 'gateway_failed')`),
    check("order_owner_decisions_attempts_check", sql`jsonb_typeof(${t.attempts}) = 'array'`),
    check("order_owner_decisions_reason_check", sql`char_length(${t.reason}) BETWEEN 10 AND 500`),
    jsonObject("order_owner_decisions_effects_check", t.effects),
    index("order_owner_decisions_order_idx").on(t.orderId, t.decidedAt),
  ],
);
