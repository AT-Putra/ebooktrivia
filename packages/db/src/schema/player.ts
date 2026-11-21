// Player profile (E.164 phone identity), per-program eligibility, OTP store, magic links.
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { playerAuthUser } from "./auth.ts";
import { programs } from "./catalog.ts";
import { bytea, createdAt, e164Check, id, inCheck, nonNegative, tstz, updatedAt } from "./columns.ts";

export const players = pgTable(
  "players",
  {
    id: id(),
    /** player_auth.user row, created by our code once the player is eligible (R13). */
    authUserId: text("auth_user_id")
      .unique("players_auth_user_id_key")
      .references(() => playerAuthUser.id, { onDelete: "set null" }),
    /** NULL only after anonymization (deletion request). */
    phone: text("phone").unique("players_phone_key"),
    name: text("name").notNull(),
    email: text("email"),
    anonymizedAt: tstz("anonymized_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    e164Check("players_phone_check", t.phone),
    check("players_phone_present_check", sql`${t.phone} IS NOT NULL OR ${t.anonymizedAt} IS NOT NULL`),
  ],
);

/**
 * `eligible` = has a paid, non-refunded order for the program. Maintained inside the PAID /
 * refund transaction from an EXISTS check (no materialized view). enqueue_otp gates on it.
 */
export const playerPrograms = pgTable(
  "player_programs",
  {
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "restrict" }),
    firstPaidAt: tstz("first_paid_at"),
    eligible: boolean("eligible").notNull().default(false),
    /**
     * US-027, the unlock floor of core unlock.ts: the highest number of sets the schedule formula has unlocked for
     * this player so far, so an extend-only reschedule (more grace days) never locks again a set the player was
     * shown as open. Raised (never lowered) only by public.play_note_unlocked (sql/play.sql).
     */
    unlockFloor: integer("unlock_floor").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "player_programs_pkey", columns: [t.playerId, t.programId] }),
    index("player_programs_program_eligible_idx").on(t.programId, t.eligible),
    check("player_programs_eligible_paid_check", sql`NOT ${t.eligible} OR ${t.firstPaidAt} IS NOT NULL`),
    nonNegative("player_programs_unlock_floor_check", t.unlockFloor),
  ],
);

/**
 * Our OTP store (R13: Better Auth's own verification row would hold the plaintext code).
 * `mac` = HMAC-SHA256(pepper, phone:code); the pepper is never in the DB. `sealed_code` is the
 * code sealed by the app to the messaging public key; enqueue_otp MOVES it into the outbox (it sets
 * the column NULL in the same statement sequence, US-026), and the worker wipes the outbox copy
 * after the send, so after the send only the HMAC is left. The worker deletes expired rows.
 * Single use: verification deletes the row (DELETE ... RETURNING). A trigger (sql/triggers.sql)
 * stamps created_at from the clock and clamps expires_at to `otp.code_ttl_seconds`.
 */
export const playerOtps = pgTable(
  "player_otps",
  {
    id: id(),
    phone: text("phone").notNull(),
    mac: bytea("mac").notNull(),
    sealedCode: bytea("sealed_code"),
    expiresAt: tstz("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    e164Check("player_otps_phone_check", t.phone),
    check("player_otps_mac_check", sql`octet_length(${t.mac}) = 32`),
    // @ebooktrivia/crypto sealed box (US-011): 32-byte ephemeral public key + AES-256-GCM
    // ciphertext + 16-byte tag, so the 6-digit code seals to exactly 6 + 48 = 54 bytes.
    check("player_otps_sealed_code_check", sql`octet_length(${t.sealedCode}) = 54`),
    nonNegative("player_otps_attempts_check", t.attempts),
    index("player_otps_phone_idx").on(t.phone, t.createdAt),
  ],
);

/**
 * Ledger of OTP sends, written only by enqueue_otp (SECURITY DEFINER); no app role can write
 * it, so the per-phone cap cannot be reset from the public app. No FKs: it must outlive the
 * single-use player_otps row and outbox pruning.
 */
export const otpEnqueues = pgTable(
  "otp_enqueues",
  {
    otpId: uuid("otp_id").primaryKey(),
    phone: text("phone").notNull(),
    outboxId: uuid("outbox_id").notNull(),
    enqueuedAt: tstz("enqueued_at").notNull().defaultNow(),
  },
  (t) => [
    e164Check("otp_enqueues_phone_check", t.phone),
    index("otp_enqueues_phone_idx").on(t.phone, t.enqueuedAt),
    // US-026: the global send breaker's 10-minute count, and the daily prune (public.prune_otp_enqueues).
    index("otp_enqueues_enqueued_at_idx").on(t.enqueuedAt),
  ],
);

/**
 * One token per delivery channel, 72 h, single use; only the SHA-256 of the token is stored.
 * Written only by public.issue_magic_link (worker, US-025) and consumed only by
 * public.consume_magic_link (apps/public, US-026), both SECURITY DEFINER (sql/functions.sql): the
 * expiry is the database's clock + 72 h, and a player has at most ONE live (unconsumed) link per
 * channel, a new one replacing the previous (magic_links_player_channel_live_key).
 */
export const magicLinks = pgTable(
  "magic_links",
  {
    id: id(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    tokenHash: bytea("token_hash").notNull().unique("magic_links_token_hash_key"),
    expiresAt: tstz("expires_at").notNull(),
    consumedAt: tstz("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    inCheck("magic_links_channel_check", t.channel, ["whatsapp", "email"]),
    check("magic_links_token_hash_check", sql`octet_length(${t.tokenHash}) = 32`),
    uniqueIndex("magic_links_player_channel_live_key").on(t.playerId, t.channel).where(sql`${t.consumedAt} IS NULL`),
  ],
);
