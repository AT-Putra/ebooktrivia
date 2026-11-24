// Infra & governance: outbox, admin profiles, audit log, ad spend, templates, legal pages,
// consents, deletion requests, secrets, settings, uploads, alerts, heartbeats.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, inet, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { adminAuthUser } from "./auth.ts";
import { products, programs } from "./catalog.ts";
import { bytea, createdAt, e164Check, id, idr, inCheck, jsonObject, nonNegative, tstz, updatedAt } from "./columns.ts";
import { wahaSessions } from "./delivery.ts";
import { landingPages, orders } from "./funnel.ts";
import { players } from "./player.ts";
import { adnets } from "./tracking.ts";

/**
 * Transactional outbox. Public code never inserts here directly: it calls the SECURITY DEFINER
 * enqueue_* functions (sql/functions.sql). The relay hands only `id` to BullMQ (jobId = id).
 */
export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    topic: text("topic").notNull(),
    /** Idempotency backstop: one outbox row per logical intent. */
    dedupeKey: text("dedupe_key").notNull().unique("outbox_dedupe_key_key"),
    payload: jsonb("payload").notNull().default({}),
    /** Sealed secret material (OTP code sealed to the messaging key); wiped after sending. */
    sealed: bytea("sealed"),
    availableAt: tstz("available_at").notNull().defaultNow(),
    relayedAt: tstz("relayed_at"),
    processedAt: tstz("processed_at"),
    attempts: integer("attempts").notNull().default(0),
    /**
     * US-027: how many claims were deferred (the job was not due yet, worker OutboxDefer): they count in `attempts` like every
     * claim, so every claim keeps a job id and a fencing token of its own, and the claim cap is raised by them instead.
     */
    deferrals: integer("deferrals").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [
    check("outbox_topic_check", sql`${t.topic} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
    jsonObject("outbox_payload_check", t.payload),
    nonNegative("outbox_attempts_check", t.attempts),
    nonNegative("outbox_deferrals_check", t.deferrals),
    index("outbox_unrelayed_idx").on(t.availableAt).where(sql`${t.relayedAt} IS NULL`),
    index("outbox_unprocessed_idx").on(t.createdAt).where(sql`${t.processedAt} IS NULL`),
    // US-027: the login-link resend's global breaker counts its rows of the last 10 minutes.
    index("outbox_magic_link_resend_created_at_idx").on(t.createdAt).where(sql`${t.topic} = 'magic_link.resend'`),
  ],
);

export const adminProfiles = pgTable(
  "admin_profiles",
  {
    id: id(),
    authUserId: text("auth_user_id")
      .notNull()
      .unique("admin_profiles_auth_user_id_key")
      .references(() => adminAuthUser.id, { onDelete: "restrict" }),
    role: text("role").notNull(),
    displayName: text("display_name").notNull(),
    disabledAt: tstz("disabled_at"),
    /** Set while TOTP is not enrolled: after it, the account cannot sign in until an Owner resets it (US-016 SL3). */
    enrollBy: tstz("enroll_by"),
    /**
     * US-031 (ASVS V6.2.12): the breached-password check of the CURRENT password (a new id each time a password is set, the
     * outbox job admin.password_hibp_check carries it), and when the worker found that password in a breach: then the admin
     * must change it before anything else (lib/access.ts). A check of an older password never flags the current one.
     */
    passwordCheckId: uuid("password_check_id"),
    passwordBreachedAt: tstz("password_breached_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    inCheck("admin_profiles_role_check", t.role, ["owner", "staff"]),
    check("admin_profiles_breach_check", sql`${t.passwordBreachedAt} IS NULL OR ${t.passwordCheckId} IS NOT NULL`),
  ],
);

/**
 * Append-only (grants + trigger, sql/). `changes` holds before/after values of NON-PII fields
 * only, e.g. {"price_idr": {"before": 50000, "after": 45000}}; secrets appear as {"set": true}.
 * PII changes are recorded only as references in `pii_refs`, e.g. "player:{id}.phone changed".
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: tstz("occurred_at").notNull().defaultNow(),
    actorKind: text("actor_kind").notNull(),
    /** admin_auth.user id; deliberately no FK, so the log never blocks or cascades. */
    actorAdminUserId: text("actor_admin_user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    changes: jsonb("changes").notNull().default({}),
    piiRefs: text("pii_refs").array().notNull().default(sql`'{}'::text[]`),
    requestId: text("request_id"),
    ip: inet("ip"),
  },
  (t) => [
    inCheck("audit_log_actor_kind_check", t.actorKind, ["admin", "system", "cli"]),
    check("audit_log_admin_actor_check", sql`${t.actorKind} <> 'admin' OR ${t.actorAdminUserId} IS NOT NULL`),
    jsonObject("audit_log_changes_check", t.changes),
    index("audit_log_entity_idx").on(t.entityType, t.entityId, t.occurredAt),
    index("audit_log_occurred_at_idx").on(t.occurredAt),
  ],
);

export const adSpend = pgTable(
  "ad_spend",
  {
    id: id(),
    spendDate: date("spend_date", { mode: "string" }).notNull(),
    platform: text("platform").notNull(),
    landingPageId: uuid("landing_page_id").references(() => landingPages.id, { onDelete: "set null" }),
    adnetId: uuid("adnet_id").references(() => adnets.id, { onDelete: "set null" }),
    utmCampaign: text("utm_campaign"),
    amountIdr: idr("amount_idr").notNull(),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    inCheck("ad_spend_platform_check", t.platform, ["meta", "tiktok", "google", "other"]),
    nonNegative("ad_spend_amount_idr_check", t.amountIdr),
    index("ad_spend_date_idx").on(t.spendDate),
  ],
);

export const messageTemplates = pgTable(
  "message_templates",
  {
    id: id(),
    key: text("key").notNull(),
    channel: text("channel").notNull(),
    locale: text("locale").notNull().default("id"),
    subject: text("subject"),
    body: text("body").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    inCheck("message_templates_channel_check", t.channel, ["whatsapp", "email"]),
    unique("message_templates_key_channel_locale_key").on(t.key, t.channel, t.locale),
  ],
);

/**
 * Template test-sends (AC-A10). The admin app never sends: it inserts this row and an outbox row
 * (topic `template.test_send`, payload `{test_send_id}`) in one transaction, and the worker claims
 * the row (`pending -> sending`), renders the template with sample values and sends it, then
 * records `sent` or `failed`. A crash after the claim leaves it `sending` (never re-sent).
 * `recipient` is PII (E.164 phone for WhatsApp, an address for e-mail): the audit log gets a
 * reference only.
 */
export const templateTestSends = pgTable(
  "template_test_sends",
  {
    id: id(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => messageTemplates.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    recipient: text("recipient").notNull(),
    /** The WhatsApp session to send from (whatsapp only). */
    wahaSessionId: uuid("waha_session_id").references(() => wahaSessions.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    requestedByAdminUserId: text("requested_by_admin_user_id").notNull(),
    /** A short error code from the worker (no PII, no provider text). */
    error: text("error"),
    sentAt: tstz("sent_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    inCheck("template_test_sends_channel_check", t.channel, ["whatsapp", "email"]),
    inCheck("template_test_sends_status_check", t.status, ["pending", "sending", "sent", "failed"]),
    check(
      "template_test_sends_target_check",
      sql`(${t.channel} = 'whatsapp' AND ${t.recipient} ~ '^\\+[1-9][0-9]{7,14}$') OR (${t.channel} = 'email' AND ${t.wahaSessionId} IS NULL AND char_length(${t.recipient}) <= 254 AND ${t.recipient} ~ '^[^@[:space:]]+@[^@[:space:]]+$')`,
    ),
    check("template_test_sends_error_check", sql`${t.error} IS NULL OR ${t.error} ~ '^[a-z_]{1,64}$'`),
    index("template_test_sends_template_idx").on(t.templateId, t.createdAt),
  ],
);

/**
 * WhatsApp numbers template test-sends may go to (security review US-017 S4: the test-send button is
 * not a relay to arbitrary numbers). Owner-managed, at most 5 (apps/admin lib/settings/templates.ts),
 * audited; admin only (no other role has access).
 */
export const testRecipients = pgTable(
  "test_recipients",
  {
    id: id(),
    phone: text("phone").notNull().unique("test_recipients_phone_key"),
    label: text("label").notNull(),
    createdByAdminUserId: text("created_by_admin_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [e164Check("test_recipients_phone_check", t.phone), check("test_recipients_label_check", sql`char_length(${t.label}) BETWEEN 1 AND 60`)],
);

/** Versioned per-program S&K (terms) and privacy pages; consents reference the exact version. */
export const legalPages = pgTable(
  "legal_pages",
  {
    id: id(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    publishedAt: tstz("published_at"),
    createdAt: createdAt(),
  },
  (t) => [
    inCheck("legal_pages_kind_check", t.kind, ["terms", "privacy"]),
    check("legal_pages_version_check", sql`${t.version} >= 1`),
    unique("legal_pages_program_kind_version_key").on(t.programId, t.kind, t.version),
  ],
);

/** UU PDP consent captured at checkout: timestamp + the exact policy version accepted. */
export const consents = pgTable(
  "consents",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    legalPageId: uuid("legal_page_id")
      .notNull()
      .references(() => legalPages.id, { onDelete: "restrict" }),
    consentedAt: tstz("consented_at").notNull().defaultNow(),
    ip: inet("ip"),
    uaHash: bytea("ua_hash"),
  },
  (t) => [unique("consents_order_id_legal_page_id_key").on(t.orderId, t.legalPageId)],
);

/**
 * UU PDP deletion requests (US-030, plan §10 item 6), Owner-only. The Owner records one by phone, e-mail or order
 * public id; the request holds the data subject's phone (the subject's key: one buyer = one phone) only while it is
 * pending. Completed only by public.erase_data_subject (sql/privacy.sql, owner pii_eraser), which anonymizes the
 * subject in one transaction; rejected by the Owner with a reason. Decided requests never change
 * (deletion_requests_guard). `summary` = what the erasure changed (counts, no personal data).
 */
export const deletionRequests = pgTable(
  "deletion_requests",
  {
    id: id(),
    /** The subject's player when there is one (a buyer who never paid has none); kept after completion (an anonymized id). */
    playerId: uuid("player_id").references(() => players.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("pending"),
    requestedAt: tstz("requested_at").notNull().defaultNow(),
    requestedByAdminUserId: text("requested_by_admin_user_id"),
    completedAt: tstz("completed_at"),
    /** The request's reason as the Owner recorded it (no contact details). */
    note: text("note"),
    /** How the requester identified themselves (the value itself is not kept). */
    lookupKind: text("lookup_kind"),
    /** E.164 phone of the subject while the request is pending; NULL once it is decided. */
    subjectPhone: text("subject_phone"),
    rejectedAt: tstz("rejected_at"),
    decidedByAdminUserId: text("decided_by_admin_user_id"),
    /** The rejection's reason (no contact details). */
    decisionNote: text("decision_note"),
    summary: jsonb("summary").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    inCheck("deletion_requests_status_check", t.status, ["pending", "completed", "rejected"]),
    check("deletion_requests_lookup_kind_check", sql`${t.lookupKind} IS NULL OR ${t.lookupKind} IN ('phone', 'email', 'order')`),
    e164Check("deletion_requests_subject_phone_check", t.subjectPhone),
    check(
      "deletion_requests_state_check",
      sql`(${t.status} = 'pending') = (${t.subjectPhone} IS NOT NULL) AND (${t.status} = 'completed') = (${t.completedAt} IS NOT NULL)
          AND (${t.status} = 'rejected') = (${t.rejectedAt} IS NOT NULL AND ${t.decisionNote} IS NOT NULL)
          AND (${t.status} = 'pending') = (${t.decidedByAdminUserId} IS NULL)`,
    ),
    check("deletion_requests_note_check", sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND 500`),
    check("deletion_requests_decision_note_check", sql`${t.decisionNote} IS NULL OR char_length(${t.decisionNote}) BETWEEN 10 AND 500`),
    jsonObject("deletion_requests_summary_check", t.summary),
    index("deletion_requests_status_idx").on(t.status, t.requestedAt),
  ],
);

/**
 * Sealed secrets (M2.3 crypto, @ebooktrivia/crypto): `ciphertext` = AES-256-GCM(DEK, nonce) ||
 * tag with a fresh DEK per write; `sealed_dek` = the DEK sealed (X25519 sealed box) to the scope
 * public key `key_id`. The AAD of both is the canonical encoding of table, column, id, scope,
 * name, adnet_id, bound_host and key_id, so a relabelled row no longer decrypts; the
 * settings_secrets_guard trigger also refuses a relabel without re-encryption (ET060) and an id
 * change (ET061). `bound_host` is the endpoint host the secret was bound to at write time;
 * changing that host deletes the secret (triggers on adnets / waha_servers). `last4` is
 * captured at write time for display.
 * public_rw cannot read this table; it gets payment-scope rows only via get_payment_secret().
 */
export const settingsSecrets = pgTable(
  "settings_secrets",
  {
    id: id(),
    scope: text("scope").notNull(),
    name: text("name").notNull(),
    /** Conversions-scope secrets resolved by `{secret:name}` are bound to one adnet + host. */
    adnetId: uuid("adnet_id").references(() => adnets.id, { onDelete: "cascade" }),
    boundHost: text("bound_host"),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    sealedDek: bytea("sealed_dek").notNull(),
    keyId: text("key_id").notNull(),
    last4: text("last4").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    inCheck("settings_secrets_scope_check", t.scope, ["payment", "messaging", "conversions"]),
    check("settings_secrets_name_check", sql`${t.name} ~ '^[a-z0-9_]+(\\.[a-z0-9_]+)*$'`),
    check("settings_secrets_nonce_check", sql`octet_length(${t.nonce}) = 12`),
    check("settings_secrets_last4_check", sql`char_length(${t.last4}) <= 4`),
    check("settings_secrets_bound_host_check", sql`${t.boundHost} IS NULL OR ${t.boundHost} = lower(${t.boundHost})`),
    // Security review US-011 #3: only conversions secrets carry an adnet, and every conversions
    // secret is bound to a host. get_payment_secret() returns no scope/adnet_id, so the public app
    // rebuilds the AAD with adnet null; this makes that assumption a DB invariant.
    // US-024: the one conversions secret with NO adnet is a CAPI access token of a landing page's pixel
    // (capi.meta.<pixel id>, capi.tiktok.<pixel code, lowercase>): bound to the vendor's fixed API host,
    // which the adapter hard-codes, so no host column or clear-on-change trigger is needed. The adnet
    // `{secret:name}` resolver only reads rows with ITS adnet id, so it can never resolve such a token.
    check(
      "settings_secrets_binding_check",
      sql`(${t.scope} = 'conversions' AND ${t.boundHost} IS NOT NULL AND (${t.adnetId} IS NOT NULL
            OR (${t.name} ~ '^capi\\.meta\\.[0-9]{10,20}$' AND ${t.boundHost} = 'graph.facebook.com')
            OR (${t.name} ~ '^capi\\.tiktok\\.[a-z0-9]{16,32}$' AND ${t.boundHost} = 'business-api.tiktok.com')))
          OR (${t.scope} <> 'conversions' AND ${t.adnetId} IS NULL)`,
    ),
    unique("settings_secrets_scope_name_adnet_key").on(t.scope, t.name, t.adnetId).nullsNotDistinct(),
  ],
);

/**
 * Non-secret admin settings (AC-A3), e.g. OTP, rate-limit and order parameters. Defaults are
 * seeded by sql/seed.sql. Read in SQL by enqueue_otp (`otp.phone_cap`, `otp.phone_window_seconds`),
 * the player_otps trigger (`otp.code_ttl_seconds`) and the orders checkout guard
 * (`orders.expiry_seconds`).
 */
/**
 * Bounds of the OTP and rate-limit parameters (US-018): the admin limits page (apps/admin
 * lib/settings/limits.ts) and the app_settings_bounds_check below both read this one table, so no
 * writer (admin_rw included) can store a value outside them. Inclusive [min, max].
 */
export const APP_SETTING_BOUNDS = {
  // US-031 (ASVS V6.5.5): an out-of-band code lives 10 minutes at most.
  "otp.code_ttl_seconds": [60, 600],
  "otp.max_attempts": [1, 5],
  "otp.phone_cap": [1, 10],
  "otp.phone_window_seconds": [3600, 86_400],
  "otp.ip_cap": [1, 100],
  "otp.ip_window_seconds": [600, 86_400],
  "otp.cooldown_seconds": [15, 600],
  // US-026: the global OTP send breaker, codes sent per 10 minutes over ALL phones (enqueue_otp).
  "otp.global_send_cap": [50, 100_000],
  "orders.expiry_seconds": [900, 86_400],
  // US-020 checkout (AC-S4, AC-S8): checkout closes this long before sales_end_at, and the Valkey
  // rate limits of the public API (N requests per window, per client IP / phone / landing page;
  // the Cap challenge + redeem routes per client IP).
  "orders.sales_close_buffer_minutes": [5, 1440],
  "checkout.ip_cap": [1, 1000],
  "checkout.ip_window_seconds": [60, 86_400],
  "checkout.phone_cap": [1, 100],
  "checkout.phone_window_seconds": [60, 86_400],
  "checkout.lp_cap": [1, 100_000],
  "checkout.lp_window_seconds": [60, 86_400],
  "captcha.ip_cap": [1, 1000],
  "captcha.ip_window_seconds": [60, 86_400],
  // The Cap routes per IPv6 /48 on top of the /64 bucket (Cap itself is stateless, US-020).
  "captcha.ip48_cap": [1, 100_000],
  // US-028: the longest outage the Owner's deadline-extension tool covers: its outage start lies at
  // most this far back (read by SQL, extend_open_question_deadlines).
  "trivia.extension_max_minutes": [1, 1440],
  // US-025: the proactive WhatsApp delivery waits this long after PAID (AC-D8; 0 sends at once). Read by the worker.
  "delivery.wa_delay_seconds": [0, 86_400],
} as const satisfies Readonly<Record<string, readonly [number, number]>>;

const boundsCase = Object.entries(APP_SETTING_BOUNDS)
  .map(([key, [min, max]]) => `WHEN '${key}' THEN (value #>> '{}')::numeric BETWEEN ${String(min)} AND ${String(max)}`)
  .join(" ");

export const appSettings = pgTable(
  "app_settings",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    updatedAt: updatedAt(),
    updatedByAdminUserId: text("updated_by_admin_user_id"),
  },
  (t) => [
    check("app_settings_key_check", sql`${t.key} ~ '^[a-z0-9_]+(\\.[a-z0-9_]+)+$'`),
    // OTP, order, checkout and captcha parameters, and the deadline-extension bound (US-028), are
    // read as positive integers; reject anything else at write time.
    check(
      "app_settings_positive_int_check",
      sql`(${t.key} NOT LIKE 'otp.%' AND ${t.key} NOT LIKE 'orders.%' AND ${t.key} NOT LIKE 'checkout.%' AND ${t.key} NOT LIKE 'captcha.%' AND ${t.key} <> 'trivia.extension_max_minutes') OR (jsonb_typeof(${t.value}) = 'number' AND (${t.value} #>> '{}')::numeric > 0 AND (${t.value} #>> '{}')::numeric = trunc((${t.value} #>> '{}')::numeric))`,
    ),
    // US-025: the proactive WhatsApp delay is a whole number of seconds (0 is allowed, so it is not in the positive-integer check above).
    check(
      "app_settings_wa_delay_whole_check",
      sql`${t.key} <> 'delivery.wa_delay_seconds' OR (jsonb_typeof(${t.value}) = 'number' AND (${t.value} #>> '{}')::numeric = trunc((${t.value} #>> '{}')::numeric))`,
    ),
    // Each bounded key within APP_SETTING_BOUNDS (CASE, so a non-number is never cast).
    check(
      "app_settings_bounds_check",
      sql`CASE WHEN ${t.key} NOT IN (${sql.raw(Object.keys(APP_SETTING_BOUNDS).map((k) => `'${k}'`).join(", "))}) THEN true WHEN jsonb_typeof(${t.value}) <> 'number' THEN false ELSE CASE ${t.key} ${sql.raw(boundsCase)} END END`,
    ),
  ],
);

export const uploads = pgTable(
  "uploads",
  {
    id: id(),
    kind: text("kind").notNull(),
    /** Path relative to the data directory /srv/data, e.g. "deliverables/<id>.pdf". */
    storagePath: text("storage_path").notNull().unique("uploads_storage_path_key"),
    originalFilename: text("original_filename"),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: bytea("sha256").notNull(),
    /** Set when a product's PDF is replaced by another; the upload sweeper deletes it after a grace period. */
    supersededAt: tstz("superseded_at"),
    createdByAdminUserId: text("created_by_admin_user_id"),
    createdAt: createdAt(),
  },
  (t) => [
    inCheck("uploads_kind_check", t.kind, ["pdf", "image", "lp_zip", "import", "proof"]),
    nonNegative("uploads_size_bytes_check", t.sizeBytes),
    check("uploads_sha256_check", sql`octet_length(${t.sha256}) = 32`),
  ],
);

/**
 * Chunked (resumable) admin uploads (US-017). Caddy's read_body timeout is global (30 s), so a
 * large PDF goes up in small chunks: each chunk is hash-checked and written at its offset into a
 * staging file under /srv/data, and `complete` checks the assembled file against the upload
 * policy (packages/uploads) and its declared SHA-256 before it becomes an `uploads` row. Admin
 * only (no other role has access).
 */
export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: id(),
    kind: text("kind").notNull(),
    /** The product of a `pdf` upload. */
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    /** The landing page of an `lp_zip` upload (US-023). */
    landingPageId: uuid("landing_page_id").references(() => landingPages.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: bytea("sha256").notNull(),
    chunkBytes: integer("chunk_bytes").notNull(),
    receivedChunks: integer("received_chunks")
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    /** The Owner / Staff confirmed the large-PDF warning (> 20 MiB) before the upload started. */
    largeConfirmed: boolean("large_confirmed").notNull().default(false),
    createdByAdminUserId: text("created_by_admin_user_id").notNull(),
    uploadId: uuid("upload_id").references(() => uploads.id, { onDelete: "set null" }),
    expiresAt: tstz("expires_at").notNull(),
    /** Set by `complete` when it claims the session; chunk writes are refused from then on. */
    completingAt: tstz("completing_at"),
    completedAt: tstz("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    inCheck("upload_sessions_kind_check", t.kind, ["pdf", "lp_zip"]),
    check(
      "upload_sessions_target_check",
      sql`(${t.kind} = 'pdf' AND ${t.productId} IS NOT NULL AND ${t.landingPageId} IS NULL) OR (${t.kind} = 'lp_zip' AND ${t.landingPageId} IS NOT NULL AND ${t.productId} IS NULL)`,
    ),
    check("upload_sessions_size_bytes_check", sql`${t.sizeBytes} > 0`),
    check("upload_sessions_sha256_check", sql`octet_length(${t.sha256}) = 32`),
    check("upload_sessions_chunk_bytes_check", sql`${t.chunkBytes} > 0`),
  ],
);

export const alerts = pgTable(
  "alerts",
  {
    id: id(),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    severity: text("severity").notNull().default("warning"),
    dedupeKey: text("dedupe_key"),
    message: text("message").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: createdAt(),
    notifiedAt: tstz("notified_at"),
    resolvedAt: tstz("resolved_at"),
  },
  (t) => [
    inCheck("alerts_source_check", t.source, ["internal", "glitchtip", "worker", "monitor", "admin"]),
    inCheck("alerts_severity_check", t.severity, ["info", "warning", "critical"]),
    jsonObject("alerts_payload_check", t.payload),
    index("alerts_dedupe_idx").on(t.dedupeKey, t.createdAt),
    index("alerts_unnotified_idx").on(t.createdAt).where(sql`${t.notifiedAt} IS NULL`),
  ],
);

/**
 * Where the worker's alert relay (apps/worker alert-relay.ts, US-015) sends the Owner's alerts: one WhatsApp number, one e-mail
 * address and the lowest severity that is sent. A singleton row (id = 1). Owner only in the console (alert_recipients.edit),
 * audited; the worker reads it; the public app has no access (the table is in no public_rw grant).
 */
export const alertRecipients = pgTable(
  "alert_recipients",
  {
    id: integer("id").primaryKey().default(1),
    phone: text("phone"),
    email: text("email"),
    minSeverity: text("min_severity").notNull().default("warning"),
    updatedByAdminUserId: text("updated_by_admin_user_id"),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("alert_recipients_singleton_check", sql`${t.id} = 1`),
    check("alert_recipients_phone_check", sql`${t.phone} IS NULL OR ${t.phone} ~ '^\\+[1-9][0-9]{7,14}$'`),
    check("alert_recipients_email_check", sql`${t.email} IS NULL OR (char_length(${t.email}) <= 254 AND ${t.email} ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')`),
    inCheck("alert_recipients_min_severity_check", t.minSeverity, ["info", "warning", "critical"]),
  ],
);

/**
 * What customer-service hours may not contain, as a PostgreSQL regular-expression bracket (the database has no Unicode property classes): the
 * controls (Cc: the C0 range without NUL, DEL and the C1 range), the format characters (Cf: soft hyphen, Arabic and other format marks, the
 * Mongolian vowel separator, zero-width and bidi marks and overrides, the invisible operators, the BOM, the interlinear annotation marks, and the
 * few format characters above the BMP) and the line and paragraph separators (Zl U+2028, Zp U+2029). It is the JavaScript class
 * [\p{Cc}\p{Cf}\p{Zl}\p{Zp}] of core isCsHours, character for character (apps/admin test/cs-contact.int.test.ts compares them over every code point).
 */
export const CS_HOURS_FORBIDDEN =
  "[\\u0001-\\u001f\\u007f-\\u009f\\u00ad\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb\\U000110bd\\U000110cd\\U00013430-\\U0001343f\\U0001bca0-\\U0001bca3\\U0001d173-\\U0001d17a\\U000e0001\\U000e0020-\\U000e007f]";

/**
 * The Owner's customer-service contact (Owner decision 2026-11-24): where a buyer who has a problem reaches a human. One WhatsApp
 * number (an Indonesian mobile number, E.164), one e-mail address and the opening hours as free text; each may be empty, and an
 * empty one is shown nowhere. A singleton row (id = 1). Owner only in the console (cs_contact.edit), audited. public_rw and
 * worker_rw read ONLY whatsapp, email and hours (sql/grants.sql): the buyer site's help block, the worker's fixed WhatsApp replies
 * and the {cs_whatsapp} / {cs_email} template variables. The CS number is never one of the sending numbers (waha_sessions.phone):
 * the triggers cs_contact_not_a_sending_number and waha_sessions_not_the_cs_number (sql/triggers.sql, ET190) hold it for every writer.
 */
export const csContact = pgTable(
  "cs_contact",
  {
    id: integer("id").primaryKey().default(1),
    whatsapp: text("whatsapp"),
    email: text("email"),
    hours: text("hours"),
    updatedByAdminUserId: text("updated_by_admin_user_id"),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("cs_contact_singleton_check", sql`${t.id} = 1`),
    // The Indonesian mobile shape of core normalizeIdMobile (+628, second digit not 4, 9 to 12 digits after +62).
    check("cs_contact_whatsapp_check", sql`${t.whatsapp} IS NULL OR ${t.whatsapp} ~ '^\\+628[1-35-9][0-9]{7,10}$'`),
    // ASCII only (core isCsEmail has the same pattern): no bidi control, space, quote or angle bracket can be in an address a buyer is shown.
    check("cs_contact_email_check", sql`${t.email} IS NULL OR (char_length(${t.email}) <= 254 AND ${t.email} ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$')`),
    // Free text for one line: 1 to 80 characters, none of them invisible or a line break (core isCsHours has the same rule).
    check("cs_contact_hours_check", sql`${t.hours} IS NULL OR (char_length(${t.hours}) BETWEEN 1 AND 80 AND ${t.hours} !~ ${sql.raw(`'${CS_HOURS_FORBIDDEN}'`)})`),
  ],
);

export const heartbeats = pgTable("heartbeats", {
  component: text("component").primaryKey(),
  beatAt: tstz("beat_at").notNull().defaultNow(),
  info: jsonb("info").notNull().default({}),
});
