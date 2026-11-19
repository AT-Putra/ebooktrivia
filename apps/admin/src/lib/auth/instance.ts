// The Better Auth admin instance (plan M5a.1; spike R13): schema admin_auth, e-mail + password with
// argon2id, TOTP second factor, sessions of 12 h absolute (never refreshed) with the 30 min idle
// limit kept in admin_auth.session_state (lib/auth/session.ts).
//
// Better Auth's HTTP handler is NOT mounted anywhere: the console calls `auth.api.*` from its own
// server actions (lib/auth/service.ts), so the only reachable flows are the ones written there,
// each behind the Origin check, the throttle and the audit log. A test (src/app/guards.test.ts)
// fails if a route handler mounts the handler.
//
// Cookies (R13 recipe B): `useSecureCookies: false` plus explicit `__Host-` names and Secure +
// Path=/ + no Domain, so the names keep their `__Host-` prefix; SameSite=Strict on every cookie.
// Not used: Better Auth's backup codes (stored encrypted, not hashed; our own hashed recovery codes
// replace them), trusted devices (the service never sets trustDevice and refuses it), the OTP
// second factor, sign-up (accounts are created by the Owner or the CLI) and its in-memory rate
// limiter (the PostgreSQL throttle in lib/auth/throttle.ts covers every flow).
// Secrets are versioned (ADMIN_AUTH_SECRETS, newest first): the first signs cookies and encrypts
// new TOTP secrets, older versions still decrypt, so rotating keeps enrolled authenticators.
// Better Auth's own log lines and API errors go through lib/log.ts (masked, no error messages).
import { schema } from "@ebooktrivia/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { expireCookie, setSessionCookie } from "better-auth/cookies";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { AdminConfig } from "../config.ts";
import type { Db, Sql } from "../db.ts";
import { betterAuthApiError, betterAuthLog } from "../log.ts";
import { hashSecret, MAX_SECRET_LENGTH, verifySecret } from "./argon2.ts";
import { consumeRecoveryCode } from "./recovery-codes.ts";

export const SESSION_COOKIE = "__Host-admin_session";
export const TWO_FACTOR_COOKIE = "__Host-admin_2fa";
export const ADMIN_COOKIE_NAMES = {
  session_token: SESSION_COOKIE,
  session_data: "__Host-admin_session_data",
  dont_remember: "__Host-admin_dont_remember",
  account_data: "__Host-admin_account_data",
  two_factor: TWO_FACTOR_COOKIE,
  trust_device: "__Host-admin_trust_device",
} as const;

export const SESSION_ABSOLUTE_SECONDS = 12 * 60 * 60;
export const SESSION_IDLE_SECONDS = 30 * 60;
/** How long the password step's second-factor challenge stays valid. */
export const TWO_FACTOR_CHALLENGE_SECONDS = 5 * 60;
export const TOTP_ISSUER = "ebooktrivia admin";

export interface AuthDeps {
  readonly config: AdminConfig;
  readonly sql: Sql;
  readonly db: Db;
}

const invalidChallenge = () => APIError.from("UNAUTHORIZED", { code: "INVALID_TWO_FACTOR_COOKIE", message: "Invalid two factor cookie" });

/** `{ code: string }` (at most 64 characters), as a Standard Schema for the endpoint body. */
const codeBody = {
  "~standard": {
    version: 1,
    vendor: "ebooktrivia",
    validate: (value: unknown) =>
      typeof value === "object" && value !== null && "code" in value && typeof value.code === "string" && value.code.length <= 64
        ? { value: { code: value.code } }
        : { issues: [{ message: "code must be a string of at most 64 characters" }] },
    types: undefined as unknown as { readonly input: { code: string }; readonly output: { code: string } },
  },
} as const;

/**
 * Our second-factor endpoints, inside the instance so they share its signed cookies and session
 * creation. Both are server-only (no HTTP path even if a handler were mounted).
 */
function adminSecondFactor(deps: AuthDeps) {
  return {
    id: "admin-second-factor",
    endpoints: {
      /** The user a pending second-factor challenge (the __Host-admin_2fa cookie) belongs to. */
      adminPendingSecondFactor: createAuthEndpoint.serverOnly({ method: "POST" }, async (ctx) => {
        const cookie = ctx.context.createAuthCookie("two_factor");
        const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
        if (!identifier) return ctx.json({ userId: null });
        const pending = await ctx.context.internalAdapter.findVerificationValue(identifier);
        if (!pending || pending.expiresAt.getTime() <= Date.now()) return ctx.json({ userId: null });
        return ctx.json({ userId: pending.value });
      }),
      /**
       * Completes a pending sign-in with a recovery code: the code is consumed (single use, audited
       * in the same transaction), the challenge is consumed, and a session is created.
       */
      adminVerifyRecoveryCode: createAuthEndpoint.serverOnly({ method: "POST", body: codeBody }, async (ctx) => {
        const { code } = ctx.body;
        const cookie = ctx.context.createAuthCookie("two_factor");
        const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
        if (!identifier) throw invalidChallenge();
        const pending = await ctx.context.internalAdapter.findVerificationValue(identifier);
        if (!pending || pending.expiresAt.getTime() <= Date.now()) throw invalidChallenge();
        const userId = pending.value;
        // Checked before the code is used up: a user who may not get a session keeps the code.
        if (!(await isActiveAdmin(deps.sql, userId))) throw invalidChallenge();
        if (!(await consumeRecoveryCode(deps.sql, userId, code))) {
          throw APIError.from("UNAUTHORIZED", { code: "INVALID_BACKUP_CODE", message: "Invalid backup code" });
        }
        const consumed = await ctx.context.internalAdapter.consumeVerificationValue(identifier);
        if (!consumed || consumed.value !== userId) {
          expireCookie(ctx, cookie);
          throw invalidChallenge();
        }
        const user = await ctx.context.internalAdapter.findUserById(userId);
        if (!user) throw invalidChallenge();
        const session = (await ctx.context.internalAdapter.createSession(userId, false)) as Awaited<ReturnType<typeof ctx.context.internalAdapter.createSession>> | null;
        if (session === null) throw APIError.from("UNAUTHORIZED", { code: "FAILED_TO_CREATE_SESSION", message: "Failed to create session" });
        await setSessionCookie(ctx, { session, user });
        expireCookie(ctx, cookie);
        return ctx.json({ token: session.token });
      }),
    },
  };
}

/**
 * Gate for every new session: the auth user has an admin profile that is not disabled, and either
 * has TOTP enrolled or is still within the enrollment deadline (`enroll_by`, 72 h after the
 * account or its last reset; afterwards only an Owner reset lets it sign in).
 */
export async function isActiveAdmin(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql<{ ok: boolean }[]>`
    SELECT true AS ok
      FROM public.admin_profiles p JOIN admin_auth."user" u ON u.id = p.auth_user_id
     WHERE p.auth_user_id = ${userId} AND p.disabled_at IS NULL AND p.role IN ('owner', 'staff')
       AND (u."twoFactorEnabled" IS TRUE OR p.enroll_by > clock_timestamp())`;
  return rows.length === 1;
}

export function createAdminAuth(deps: AuthDeps) {
  const { config, sql, db } = deps;
  return betterAuth({
    appName: TOTP_ISSUER,
    baseURL: config.origin,
    basePath: "/api/auth",
    secrets: config.authSecrets.map((s) => ({ version: s.version, value: s.value })),
    logger: {
      level: "info",
      log: (level, message) => {
        betterAuthLog(level, message);
      },
    },
    onAPIError: {
      throw: false,
      onError: (error) => {
        betterAuthApiError(error);
      },
    },
    trustedOrigins: [config.origin],
    telemetry: { enabled: false },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.adminAuthUser,
        session: schema.adminAuthSession,
        account: schema.adminAuthAccount,
        verification: schema.adminAuthVerification,
        twoFactor: schema.adminAuthTwoFactor,
      },
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      password: {
        hash: (password) => hashSecret(password),
        verify: ({ hash, password }) => (password.length > MAX_SECRET_LENGTH ? Promise.resolve(false) : verifySecret(hash, password)),
      },
    },
    session: {
      expiresIn: SESSION_ABSOLUTE_SECONDS,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    account: { accountLinking: { enabled: false } },
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: false,
      defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: "strict", path: "/" },
      cookies: Object.fromEntries(Object.entries(ADMIN_COOKIE_NAMES).map(([key, name]) => [key, { name }])),
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    databaseHooks: {
      session: {
        create: {
          // No session at all for a disabled user or an auth user without an admin profile.
          before: async (session) => ((await isActiveAdmin(sql, session.userId)) ? undefined : false),
        },
      },
    },
    plugins: [
      twoFactor({
        issuer: TOTP_ISSUER,
        twoFactorCookieMaxAge: TWO_FACTOR_CHALLENGE_SECONDS,
        totpOptions: { digits: 6, period: 30 },
        backupCodeOptions: { customBackupCodesGenerate: () => [] },
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 15 * 60 },
      }),
      adminSecondFactor(deps),
    ],
  });
}

export type AdminAuth = ReturnType<typeof createAdminAuth>;
