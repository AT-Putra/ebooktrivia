// Delivery: per-order WA/email deliveries, WAHA servers and sessions, inbound WA messages.
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, e164Check, id, inCheck, jsonObject, nonNegative, tstz, updatedAt } from "./columns.ts";
import { orders } from "./funnel.ts";

export const wahaServers = pgTable(
  "waha_servers",
  {
    id: id(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    /** Host of base_url; the messaging-scope API key is bound to it. */
    baseUrlHost: text("base_url_host").notNull(),
    /** Explicit, audited admin allowlist for a WAHA host on a private IP (safe-fetch). */
    allowPrivateIp: boolean("allow_private_ip").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("waha_servers_base_url_host_check", sql`${t.baseUrlHost} = lower(${t.baseUrlHost})`),
    // Security review US-017 S3: the private-IP allowlist is valid for an IPv4 literal only. A DNS
    // name flagged as private could later resolve to any internal address.
    check("waha_servers_allow_private_ip_check", sql`NOT ${t.allowPrivateIp} OR ${t.baseUrlHost} ~ '^[0-9]{1,3}(\\.[0-9]{1,3}){3}(:[0-9]{1,5})?$'`),
    // Security review US-011 #1: the WAHA key is sealed with bound_host = base_url_host, but the
    // client sends to base_url, so the two must be one fact. One strict grammar: https only,
    // lowercase ASCII host (punycode for IDN), optional non-default port 1..65535 without leading
    // zeros, and a path of printable ASCII starting with "/" (no userinfo, no backslash or "?" in
    // the authority); base_url_host must be exactly that authority. For DNS names and dotted-quad
    // IPv4 this equals new URL(base_url).host. IPv4 shorthands (127.1, 0x7f.1, 2130706433, ...)
    // pass this CHECK but are normalised by the URL parser, so they differ; they fail closed,
    // because a secret cannot be bound to a non-canonical host (crypto isCanonicalHost) and the
    // WAHA client must call @ebooktrivia/crypto assertWahaTarget before sending the key.
    check(
      "waha_servers_base_url_check",
      sql`${t.baseUrl} ~ '^https://[a-z0-9.-]+(:[1-9][0-9]{0,4})?(/[!-~]*)?$' AND ${t.baseUrlHost} = substring(${t.baseUrl} from '^https://([^/]+)') AND ${t.baseUrlHost} !~ ':443$' AND coalesce(substring(${t.baseUrlHost} from ':([0-9]+)$')::integer, 443) <= 65535`,
    ),
  ],
);

export const wahaSessions = pgTable(
  "waha_sessions",
  {
    id: id(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => wahaServers.id, { onDelete: "restrict" }),
    sessionName: text("session_name").notNull(),
    /** Pool number (known once paired); shown as the wa.me target on the order page. */
    phone: text("phone"),
    weight: integer("weight").notNull().default(1),
    dailyCap: integer("daily_cap").notNull().default(200),
    /** Last WAHA session status, e.g. WORKING. */
    status: text("status"),
    statusAt: tstz("status_at"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("waha_sessions_server_id_session_name_key").on(t.serverId, t.sessionName),
    // Same grammar as the WAHA adapter's session check (US-011 carry-over): the name becomes a
    // URL path segment of every WAHA call.
    check("waha_sessions_session_name_check", sql`${t.sessionName} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    e164Check("waha_sessions_phone_check", t.phone),
    check("waha_sessions_weight_check", sql`${t.weight} > 0`),
    nonNegative("waha_sessions_daily_cap_check", t.dailyCap),
  ],
);

/**
 * The SMTP server for e-mail delivery (one row; AC-A3). The messaging-scope secret
 * `smtp.password` is bound to `host` (bound_host): sql/triggers.sql refuses a password bound to
 * another host (ET062) and deletes it when the host changes or the row is deleted, like the WAHA
 * and adnet endpoint bindings. Mail goes out from the worker only (packages/adapters smtp.ts,
 * TLS required: implicit on `tls`, STARTTLS with requireTLS on `starttls`).
 */
export const smtpSettings = pgTable(
  "smtp_settings",
  {
    /** Always true: at most one row. */
    id: boolean("id").primaryKey().default(true),
    /** Lowercase ASCII hostname (punycode for IDN) or dotted-quad IPv4; what the password is bound to. */
    host: text("host").notNull(),
    port: integer("port").notNull(),
    security: text("security").notNull(),
    username: text("username"),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    /** Explicit, audited allowlist entry for an SMTP host on a private network (safe-fetch policy). */
    allowPrivateIp: boolean("allow_private_ip").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("smtp_settings_singleton_check", sql`${t.id}`),
    check(
      "smtp_settings_host_check",
      sql`${t.host} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' AND char_length(${t.host}) <= 253`,
    ),
    check("smtp_settings_port_check", sql`${t.port} BETWEEN 1 AND 65535`),
    inCheck("smtp_settings_security_check", t.security, ["starttls", "tls"]),
    // The SMTP adapter uses implicit TLS on 465 and STARTTLS (required) on any other port (US-017 L6).
    check("smtp_settings_security_port_check", sql`(${t.security} = 'tls') = (${t.port} = 465)`),
    // Security review US-017 S3, as for WAHA servers.
    check("smtp_settings_allow_private_ip_check", sql`NOT ${t.allowPrivateIp} OR ${t.host} ~ '^[0-9]{1,3}(\\.[0-9]{1,3}){3}$'`),
  ],
);

export const deliveryStatus = pgEnum("delivery_status", ["pending", "sending", "sent", "failed", "unknown", "cancelled"]);

/** Exactly one delivery row per order and channel (AC-D8); claim `pending -> sending` with a lease. */
export const deliveries = pgTable(
  "deliveries",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    channel: text("channel").notNull(),
    status: deliveryStatus("status").notNull().default("pending"),
    /** WA proactive send waits until here (buyer-first window). */
    notBefore: tstz("not_before").notNull().defaultNow(),
    leaseUntil: tstz("lease_until"),
    sessionId: uuid("session_id").references(() => wahaSessions.id, { onDelete: "restrict" }),
    waChatId: text("wa_chat_id"),
    filename: text("filename"),
    attempts: integer("attempts").notNull().default(0),
    /** Failover history (up to 3 numbers, AC-D4). */
    triedSessionIds: uuid("tried_session_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    waMessageId: text("wa_message_id"),
    waAck: text("wa_ack"),
    lastError: text("last_error"),
    sentAt: tstz("sent_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("deliveries_order_id_channel_key").on(t.orderId, t.channel),
    inCheck("deliveries_channel_check", t.channel, ["whatsapp", "email"]),
    check(
      "deliveries_wa_ack_check",
      sql`${t.waAck} IS NULL OR ${t.waAck} IN ('queued', 'sent', 'delivered', 'read', 'failed')`,
    ),
    nonNegative("deliveries_attempts_check", t.attempts),
    index("deliveries_due_idx").on(t.status, t.notBefore),
    // US-029: the delivery report lists and counts a date range, newest first (keyset by (created_at, id)).
    index("deliveries_created_at_id_idx").on(t.createdAt, t.id),
  ],
);

/**
 * Inbound WA messages (buyer-first), deduped by message_id. The worker re-fetches the message
 * from WAHA by message_id before acting, so a forged row cannot drive a send.
 */
export const wahaInbound = pgTable(
  "waha_inbound",
  {
    id: id(),
    messageId: text("message_id").notNull().unique("waha_inbound_message_id_key"),
    sessionId: uuid("session_id").references(() => wahaSessions.id, { onDelete: "set null" }),
    sessionName: text("session_name").notNull(),
    fromJid: text("from_jid").notNull(),
    body: text("body"),
    raw: jsonb("raw").notNull(),
    receivedAt: tstz("received_at").notNull().defaultNow(),
    /** Set by enqueue_waha_inbound(); app roles cannot write it. */
    outboxId: uuid("outbox_id"),
    processedAt: tstz("processed_at"),
  },
  (t) => [jsonObject("waha_inbound_raw_check", t.raw)],
);
