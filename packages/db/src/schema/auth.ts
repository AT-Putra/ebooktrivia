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
import { boolean, foreignKey, index, integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

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
