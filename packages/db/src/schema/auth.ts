// Better Auth 1.7.19 tables for the two auth instances, each in its own schema (spike R13).
//
// How this was derived (not hand-guessed): `pnpm --filter @ebooktrivia/db auth:ddl` runs
// scripts/better-auth-ddl.ts, which feeds the plugin sets in scripts/better-auth-options.ts
// (player: phoneNumber; admin: emailAndPassword + twoFactor) to Better Auth's own migration
// planner (`getMigrations(...).compileMigrations()` from better-auth/db/migration, the plan its
// CLI runs) against an empty database. Columns, types, nullability, defaults, unique columns,
// foreign keys (ON DELETE CASCADE) and index names below are transcribed from that output; the
// constraint names are the PostgreSQL defaults that DDL would get.
// test/better-auth.int.test.ts runs the same planner against the migrated database and fails
// if Better Auth would still create or add anything. Better Auth never migrates at runtime:
// drizzle owns this DDL.
//
// The player OTP code is NOT stored by Better Auth (R13): see player_otps in player.ts.
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgSchema, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const tsDefaultNow = (name: string) => ts(name).notNull().default(sql`CURRENT_TIMESTAMP`);

const userColumns = () => ({
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique("user_email_key"),
  emailVerified: boolean("emailVerified").notNull(),
  image: text("image"),
  createdAt: tsDefaultNow("createdAt"),
  updatedAt: tsDefaultNow("updatedAt"),
});

const sessionColumns = () => ({
  id: text("id").primaryKey(),
  expiresAt: ts("expiresAt").notNull(),
  token: text("token").notNull().unique("session_token_key"),
  createdAt: tsDefaultNow("createdAt"),
  updatedAt: ts("updatedAt").notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId").notNull(),
});

const accountColumns = () => ({
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: ts("accessTokenExpiresAt"),
  refreshTokenExpiresAt: ts("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: tsDefaultNow("createdAt"),
  updatedAt: ts("updatedAt").notNull(),
});

const verificationColumns = () => ({
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expiresAt").notNull(),
  createdAt: tsDefaultNow("createdAt"),
  updatedAt: tsDefaultNow("updatedAt"),
});

// ---- player_auth (phoneNumber plugin) ----
export const playerAuth = pgSchema("player_auth");

export const playerAuthUser = playerAuth.table("user", {
  ...userColumns(),
  phoneNumber: text("phoneNumber").unique("user_phoneNumber_key"),
  phoneNumberVerified: boolean("phoneNumberVerified"),
});

export const playerAuthSession = playerAuth.table("session", sessionColumns(), (t) => [
  foreignKey({ name: "session_userId_fkey", columns: [t.userId], foreignColumns: [playerAuthUser.id] }).onDelete(
    "cascade",
  ),
  index("session_userId_idx").on(t.userId),
]);

export const playerAuthAccount = playerAuth.table("account", accountColumns(), (t) => [
  foreignKey({ name: "account_userId_fkey", columns: [t.userId], foreignColumns: [playerAuthUser.id] }).onDelete(
    "cascade",
  ),
  index("account_userId_idx").on(t.userId),
]);

export const playerAuthVerification = playerAuth.table("verification", verificationColumns(), (t) => [
  index("verification_identifier_idx").on(t.identifier),
]);

/**
 * The player app's own session state (US-026; not a Better Auth table, its planner ignores it): when the
 * LOGIN that started a session's rotation chain happened. A login (OTP or magic link) writes it, a rotation
 * copies it to the new session, and no session is used past login_at + 90 days (the absolute cap) or
 * without this row (fail closed). Deleted with its session.
 */
export const playerAuthSessionState = playerAuth.table(
  "session_state",
  {
    sessionId: text("session_id").primaryKey(),
    loginAt: ts("login_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "session_state_session_id_fkey", columns: [t.sessionId], foreignColumns: [playerAuthSession.id] }).onDelete("cascade"),
  ],
);

// ---- admin_auth (emailAndPassword + twoFactor plugin) ----
export const adminAuth = pgSchema("admin_auth");

export const adminAuthUser = adminAuth.table("user", {
  ...userColumns(),
  twoFactorEnabled: boolean("twoFactorEnabled"),
});

export const adminAuthSession = adminAuth.table("session", sessionColumns(), (t) => [
  foreignKey({ name: "session_userId_fkey", columns: [t.userId], foreignColumns: [adminAuthUser.id] }).onDelete(
    "cascade",
  ),
  index("session_userId_idx").on(t.userId),
]);

export const adminAuthAccount = adminAuth.table("account", accountColumns(), (t) => [
  foreignKey({ name: "account_userId_fkey", columns: [t.userId], foreignColumns: [adminAuthUser.id] }).onDelete(
    "cascade",
  ),
  index("account_userId_idx").on(t.userId),
]);

export const adminAuthVerification = adminAuth.table("verification", verificationColumns(), (t) => [
  index("verification_identifier_idx").on(t.identifier),
]);

export const adminAuthTwoFactor = adminAuth.table(
  "twoFactor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backupCodes").notNull(),
    userId: text("userId").notNull(),
    verified: boolean("verified"),
    failedVerificationCount: integer("failedVerificationCount"),
    lockedUntil: ts("lockedUntil"),
  },
  (t) => [
    foreignKey({ name: "twoFactor_userId_fkey", columns: [t.userId], foreignColumns: [adminAuthUser.id] }).onDelete(
      "cascade",
    ),
    index("twoFactor_secret_idx").on(t.secret),
    index("twoFactor_userId_idx").on(t.userId),
  ],
);

// ---- admin_auth: the admin app's own auth state (US-016, M5a) ----
// Not Better Auth tables (its migration planner ignores them); same schema, so public_rw, which has
// no USAGE on admin_auth, cannot reach them either. Read and written by apps/admin only.

/**
 * One row per admin session, inserted when Better Auth creates the session (databaseHooks) and
 * deleted with it. `requireAdmin` accepts a session only through this row: it moves `last_seen_at`
 * forward (the last use; there is no idle limit) in the same statement that checks the absolute limit, and an
 * enrolled user's session counts as signed in only once `mfa_verified_at` is set by the second
 * factor (TOTP or a recovery code) that created it. A password-only session is never promoted.
 */
export const adminAuthSessionState = adminAuth.table(
  "session_state",
  {
    sessionId: text("session_id").primaryKey(),
    lastSeenAt: ts("last_seen_at").notNull(),
    mfaMethod: text("mfa_method"),
    mfaVerifiedAt: ts("mfa_verified_at"),
  },
  (t) => [
    foreignKey({ name: "session_state_session_id_fkey", columns: [t.sessionId], foreignColumns: [adminAuthSession.id] }).onDelete(
      "cascade",
    ),
    check("session_state_mfa_method_check", sql`${t.mfaMethod} IN ('totp', 'recovery_code')`),
    check("session_state_mfa_check", sql`(${t.mfaMethod} IS NULL) = (${t.mfaVerifiedAt} IS NULL)`),
  ],
);

/**
 * Recovery codes (10 per enrollment). Only an argon2id hash of the whole code is stored; `selector`
 * is its first 4 characters, so a check costs one hash verification. Single use: `used_at` is set
 * by a guarded UPDATE. Better Auth's own backup codes (stored encrypted, not hashed) are not used.
 */
export const adminAuthRecoveryCode = adminAuth.table(
  "recovery_code",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    selector: text("selector").notNull(),
    codeHash: text("code_hash").notNull(),
    createdAt: tsDefaultNow("created_at"),
    usedAt: ts("used_at"),
  },
  (t) => [
    foreignKey({ name: "recovery_code_user_id_fkey", columns: [t.userId], foreignColumns: [adminAuthUser.id] }).onDelete(
      "cascade",
    ),
    unique("recovery_code_user_id_selector_key").on(t.userId, t.selector),
    check("recovery_code_selector_check", sql`${t.selector} ~ '^[0-9A-HJKMNP-TV-Z]{4}$'`),
    check("recovery_code_code_hash_check", sql`${t.codeHash} LIKE '$argon2id$%'`),
  ],
);

/**
 * Login throttle (5 failures per 15 min, then a 15 min lockout) per account and per client IP
 * (IPv6 by /64). `key` is the SHA-256 hex of "<kind>:<value>", so no e-mail address or IP is
 * stored. Attempts are counted before the password is checked and refunded on success, so
 * concurrent guesses cannot exceed the budget. Second-factor keys also count `consecutive`
 * failures across windows (only a successful sign-in or the recovery CLI resets it); at 20 the
 * key is hard-locked (`hard_locked_at`) until the recovery CLI clears it.
 */
export const adminAuthLoginThrottle = adminAuth.table(
  "login_throttle",
  {
    key: text("key").primaryKey(),
    failures: integer("failures").notNull(),
    windowStartedAt: ts("window_started_at").notNull(),
    lockedUntil: ts("locked_until"),
    consecutive: integer("consecutive").notNull().default(0),
    hardLockedAt: ts("hard_locked_at"),
  },
  (t) => [
    check("login_throttle_key_check", sql`${t.key} ~ '^[0-9a-f]{64}$'`),
    check("login_throttle_failures_check", sql`${t.failures} >= 0`),
    check("login_throttle_consecutive_check", sql`${t.consecutive} >= 0`),
  ],
);

/**
 * TOTP codes already used at sign-in, kept for 2 minutes (a code is valid for its 30 s step +- one
 * step), so an observed code cannot be replayed (ASVS 2.8.4). `code_hash` = SHA-256 hex of
 * "<user id>:<code>".
 */
export const adminAuthTotpUsed = adminAuth.table(
  "totp_used",
  {
    userId: text("user_id").notNull(),
    codeHash: text("code_hash").notNull(),
    usedAt: ts("used_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "totp_used_pkey", columns: [t.userId, t.codeHash] }),
    foreignKey({ name: "totp_used_user_id_fkey", columns: [t.userId], foreignColumns: [adminAuthUser.id] }).onDelete("cascade"),
    check("totp_used_code_hash_check", sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
