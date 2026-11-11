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
  (t) => [check("waha_servers_base_url_host_check", sql`${t.baseUrlHost} = lower(${t.baseUrlHost})`)],
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
    e164Check("waha_sessions_phone_check", t.phone),
    check("waha_sessions_weight_check", sql`${t.weight} > 0`),
    nonNegative("waha_sessions_daily_cap_check", t.dailyCap),
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
