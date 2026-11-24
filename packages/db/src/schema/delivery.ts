// Delivery: per-order WA/email deliveries, WAHA servers and sessions, inbound WA messages.
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    /** US-025 pool pacing: the end of this number's last reserved send slot (the next send starts then). */
    nextSendAt: tstz("next_send_at"),
    /** US-025 pool health: sends in a row that failed or were uncertain; cleared by a send that went out. */
    failStreak: integer("fail_streak").notNull().default(0),
    /** US-025: the breaker rests the number until here after repeated failures. */
    cooldownUntil: tstz("cooldown_until"),
    /**
     * US-025 ban signals: WhatsApp refused a message to a NEW contact (WAHA "server returned error 463" reachout timelock, "475" message
     * capping; the session stays WORKING and a restart resets neither). Until here the number sends no new-contact message (an opener,
     * an OTP); it still answers a buyer who wrote first. Set by the worker from the error and from the session's timelock / capping state.
     */
    reachoutUntil: tstz("reachout_until"),
    /** US-025: WAHA's message-capping warning (FIRST_WARNING / SECOND_WARNING): the number's openers are slowed down. */
    warningLevel: text("warning_level").notNull().default("none"),
    /** US-025: the number's daily budget of NEW contacts (an opener or a login code to a chat it has no history with), separate from replies. */
    newContactCap: integer("new_contact_cap").notNull().default(30),
    /**
     * When this number's warm-up started (core delivery-pool WARMUP_DAYS): its daily budget of NEW contacts is held down for the first 21 WIB days. NULL = an
     * established number, no warm-up. Set by the console (a new session, or an established number switched back to warming up); migration 0026 started it for
     * the numbers that existed then.
     */
    warmupStartedAt: tstz("warmup_started_at"),
    /**
     * US-025: WhatsApp's limits on this number as WAHA reports them (docs, Sessions: Reachout timelock, Message capping), persisted from the health poll, the
     * session.status webhook and every 463 / 475. The shapes are RECORDED (US-005, WAHA 2026.10.1: an unrestricted account); 463 / 475 are documented only. `capping_status` is an open set (NONE, FIRST_WARNING, SECOND_WARNING, CAPPED).
     */
    timelockActive: boolean("timelock_active").notNull().default(false),
    timelockEndsAt: tstz("timelock_ends_at"),
    cappingStatus: text("capping_status"),
    cappingTotalQuota: integer("capping_total_quota"),
    cappingUsedQuota: integer("capping_used_quota"),
    cappingCycleEnd: tstz("capping_cycle_end"),
    limitsCheckedAt: tstz("limits_checked_at"),
    /** US-025: how many sends WhatsApp refused with error 463 (reachout timelock) / 475 (message capping), for the alerts. */
    ban463Count: integer("ban_463_count").notNull().default(0),
    ban475Count: integer("ban_475_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("waha_sessions_server_id_session_name_key").on(t.serverId, t.sessionName),
    nonNegative("waha_sessions_fail_streak_check", t.failStreak),
    nonNegative("waha_sessions_new_contact_cap_check", t.newContactCap),
    inCheck("waha_sessions_warning_level_check", t.warningLevel, ["none", "first", "second"]),
    check("waha_sessions_capping_status_check", sql`${t.cappingStatus} IS NULL OR ${t.cappingStatus} ~ '^[A-Z_]{1,32}$'`),
    nonNegative("waha_sessions_ban_463_count_check", t.ban463Count),
    nonNegative("waha_sessions_ban_475_count_check", t.ban475Count),
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
    /** The WhatsApp opener (US-025, D7) waits until here (the buyer-first window); a buyer-first reply claims the row at once. */
    notBefore: tstz("not_before").notNull().defaultNow(),
    leaseUntil: tstz("lease_until"),
    sessionId: uuid("session_id").references(() => wahaSessions.id, { onDelete: "restrict" }),
    waChatId: text("wa_chat_id"),
    filename: text("filename"),
    /** Only ever increases (a claim, a retry; a resend and a not-attempted claim keep counting): a stale finisher of an old claim can never record onto a newer one. */
    attempts: integer("attempts").notNull().default(0),
    /** The attempts that no longer count against the retry budget (a resend, or a claim that sent nothing for a reason of ours): the budget is attempts - attempts_base. */
    attemptsBase: integer("attempts_base").notNull().default(0),
    /** The chat the buyer-first reply (the PDF) was sent to: it may be a @lid chat, not the order's phone chat; the unknown-send lookup asks there too. */
    replyChatId: text("reply_chat_id"),
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
    check("deliveries_attempts_base_check", sql`${t.attemptsBase} >= 0 AND ${t.attemptsBase} <= ${t.attempts}`),
    // US-030: the dot escaped (0018 had `c.us` match any character); the same shape for the delivery's chat (the erasure matches the
    // subject's chat ids by it).
    check("deliveries_reply_chat_id_check", sql`${t.replyChatId} IS NULL OR ${t.replyChatId} ~ '^[0-9]{5,20}@(c\\.us|lid)$'`),
    check("deliveries_wa_chat_id_check", sql`${t.waChatId} IS NULL OR ${t.waChatId} ~ '^[0-9]{5,20}@(c\\.us|lid)$'`),
    index("deliveries_due_idx").on(t.status, t.notBefore),
    // US-029: the delivery report lists and counts a date range, newest first (keyset by (created_at, id)).
    index("deliveries_created_at_id_idx").on(t.createdAt, t.id),
    // US-025: a WAHA ack webhook finds its delivery by the message id the send returned.
    index("deliveries_wa_message_id_idx").on(t.waMessageId),
  ],
);

/**
 * The short opener of a WhatsApp delivery (US-025, Owner decision D7). The proactive WhatsApp message to a buyer who has not written first is ONE
 * short text (no PDF, no link) that asks the buyer to reply; the PDF and the login link go out when the buyer replies (the buyer-first claim of the
 * SAME deliveries row), so the opener has a life of its own and the delivery's `status` stays `pending` until that reply (or the buyer never
 * replies and gets the PDF by e-mail only: not a failure, no alert). Exactly once, like the delivery: `sending` holds a lease, an uncertain send is
 * `unknown` and never resent, and sent / failed / expired are final (the guard trigger, ET131). The row is created by the worker at the first claim;
 * a delivery without one is a `pending` opener that is due at deliveries.not_before.
 */
export const deliveryOpeners = pgTable(
  "delivery_openers",
  {
    deliveryId: uuid("delivery_id")
      .primaryKey()
      .references(() => deliveries.id, { onDelete: "cascade" }),
    /** pending (due at next_attempt_at / the delivery's not_before) | sending | sent (awaiting the reply) | unknown | failed | expired. */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    sessionId: uuid("session_id").references(() => wahaSessions.id, { onDelete: "restrict" }),
    /** Failover history (up to 3 numbers). */
    triedSessionIds: uuid("tried_session_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** A retry (another number, after a fault of ours) is due from here; null = the delivery's not_before. */
    nextAttemptAt: tstz("next_attempt_at"),
    leaseUntil: tstz("lease_until"),
    waMessageId: text("wa_message_id"),
    sentAt: tstz("sent_at"),
    lastError: text("last_error"),
    /**
     * The key of the wording (message_templates.key, `delivery_opener_N`) this opener was claimed with: a number does not repeat the wordings of its last 3
     * openers (core pickOpenerWording). Text, no foreign key: the Owner may remove a wording, and the row keeps saying which one it used. NULL before 0026.
     */
    variantKey: text("variant_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    inCheck("delivery_openers_status_check", t.status, ["pending", "sending", "sent", "unknown", "failed", "expired"]),
    nonNegative("delivery_openers_attempts_check", t.attempts),
    // The reply finds the opener its sender is answering: the number that sent it, while it awaits the reply.
    index("delivery_openers_awaiting_idx").on(t.sessionId, t.status),
  ],
);

/**
 * What WhatsApp said about a phone the first time we looked (US-025: first-contact delivery; WAHA docs, Contacts: check-exists, and LIDs). Before the first
 * WhatsApp message to a phone the worker asks WAHA `GET /api/contacts/check-exists?phone=<digits>&session=<name>` and sends to the chat id it RETURNS (it can be
 * `<lid>@lid`, never built as `<phone>@c.us` by us). The answer is cached here per phone with a refresh age: a number that is on WhatsApp is not asked again
 * for a month, one that is not for a day (it may install it). The lid -> phone link also answers an inbound @lid sender without another WAHA call.
 * Personal data (the phone, the chat id) lives in this table only; logs and alerts never carry them. The shapes are RECORDED (US-005): a first contact is a @lid with no phone.
 */
export const waContacts = pgTable(
  "wa_contacts",
  {
    /** E.164, with the plus (orders.buyer_phone, players.phone). */
    phone: text("phone").primaryKey(),
    numberExists: boolean("number_exists").notNull(),
    /** The chat id WAHA returned: what every send to this phone goes to (`<digits>@c.us` or `<lid>@lid`). Null when the number is not on WhatsApp. */
    chatId: text("chat_id"),
    /** The `<lid>@lid` of the contact when WAHA knows it (the key of the inbound @lid match). */
    lid: text("lid"),
    /** When the number's existence and chat id were last asked of WAHA (the refresh age of the cache). */
    checkedAt: tstz("checked_at").notNull().defaultNow(),
    /**
     * When the lid -> phone link was last CONFIRMED (a check-exists answer that carried that lid, or a message from the lid that matched an order or an opener). A check-exists
     * that carries no lid refreshes checked_at but never this: an old link is not made young by an answer that said nothing about it. Null while there is no lid.
     */
    lidCheckedAt: tstz("lid_checked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    e164Check("wa_contacts_phone_check", t.phone),
    check("wa_contacts_chat_id_check", sql`${t.chatId} IS NULL OR ${t.chatId} ~ '^[0-9]{5,20}@(c\\.us|lid)$'`),
    check("wa_contacts_lid_check", sql`${t.lid} IS NULL OR ${t.lid} ~ '^[0-9]{5,20}@lid$'`),
    check("wa_contacts_exists_chat_check", sql`NOT ${t.numberExists} OR ${t.chatId} IS NOT NULL`),
    // One phone per lid (NULLs are distinct): a lid is re-pointed by clearing it from the old row first (contacts.ts), never left on two phones.
    uniqueIndex("wa_contacts_lid_key").on(t.lid),
  ],
);

/**
 * Every claimed send of a pool number (US-025), one row per claim: openers, buyer-first replies and text replies, and the
 * player's OTPs. It is what the per-number daily cap and the weighted round-robin count (a failed over delivery leaves
 * deliveries.session_id, so the deliveries alone cannot say what a number sent), and, by contact_key, what the per-contact rules
 * count (a second message to one contact waits 30 to 60 s, at most 4 an hour). No personal data: ids, a kind and a digest of the
 * chat id. The worker appends and prunes it; no other role writes it.
 */
export const wahaSends = pgTable(
  "waha_sends",
  {
    id: id(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => wahaSessions.id, { onDelete: "restrict" }),
    /** Null for an OTP or a text reply; kept (null) when the delivery is ever deleted. */
    deliveryId: uuid("delivery_id").references(() => deliveries.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    /** SHA-256 (hex) of the recipient's chat id, whichever number sends: the contact the per-contact rules count. Null for a send nobody counts. */
    contactKey: text("contact_key"),
    /** When the send starts (its reserved slot): the per-contact gap is measured from here. */
    sendAt: tstz("send_at").notNull().defaultNow(),
    /** A message to a chat this number had no history with: it counts against the number's daily budget of NEW contacts (waha_sessions.new_contact_cap). */
    newContact: boolean("new_contact").notNull().default(false),
    /**
     * How the send ended on the number (the delivery report's per-number volume and failure rate): `reserved` while in flight, `sent`, `unknown` (it may have
     * gone out: never resent) or `failed` (WAHA refused it for sure: not a message to the contact and not a send of the number's day, so the caps and the
     * per-contact rules do not count it). A claim that ended with nothing sent for a reason that is not the number's (a phone that is not on WhatsApp, a
     * lookup that failed, an abort, a fault of ours) takes its row back instead.
     */
    outcome: text("outcome").notNull().default("reserved"),
    createdAt: createdAt(),
  },
  (t) => [
    inCheck("waha_sends_kind_check", t.kind, ["opener", "reply", "text", "otp"]),
    inCheck("waha_sends_outcome_check", t.outcome, ["reserved", "sent", "unknown", "failed"]),
    check("waha_sends_contact_key_check", sql`${t.contactKey} IS NULL OR ${t.contactKey} ~ '^[0-9a-f]{64}$'`),
    index("waha_sends_session_created_idx").on(t.sessionId, t.createdAt),
    index("waha_sends_contact_idx").on(t.contactKey, t.sendAt),
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
    /** US-025: what the worker did with it (a code, no personal data): delivered, text_only, ignored, unverified, ... */
    outcome: text("outcome"),
    /** US-025: when the worker claimed the right to send its one text reply (at most one reply per inbound message). */
    repliedAt: tstz("replied_at"),
  },
  (t) => [
    jsonObject("waha_inbound_raw_check", t.raw),
    check("waha_inbound_outcome_check", sql`${t.outcome} IS NULL OR ${t.outcome} ~ '^[a-z_]{1,64}$'`),
    // US-025: a sender gets at most one text reply per hour (the lookup by sender).
    index("waha_inbound_from_replied_idx").on(t.fromJid, t.repliedAt),
  ],
);
