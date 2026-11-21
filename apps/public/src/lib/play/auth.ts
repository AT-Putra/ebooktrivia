// The Better Auth PLAYER instance (plan M9.1, §3; spike R13 decision, docs/spikes/R13.md): schema
// player_auth, the stock phone-number plugin for /phone-number/verify and the user / session model, with
// the R13 workarounds:
//   - the OTP lifecycle is ours (lib/play/otp.ts): the stock plugin stores the code in plaintext, so its
//     send-otp is short-circuited in hooks.before (it never runs and never writes a verification row), and
//     verifyOTP is bound to our HMAC table player_otps (attempts counted atomically, constant-time compare,
//     single use);
//   - /sign-in/phone-number, /phone-number/request-password-reset and /phone-number/reset-password are
//     disabled (disabledPaths), and sign-up on verification is off: player_auth users are created by the
//     database for eligible players only (public.prepare_player_login / consume_magic_link), before any code
//     or link can be used;
//   - every new session is gated by public.player_for_login (a non-anonymized player eligible for at least
//     one program): the session.create hook below.
// Better Auth's HTTP handler is NOT mounted anywhere (a guard test enforces it): the play API routes
// (lib/play/handlers.ts) call `auth.api.*` behind their own Origin check, rate limits and uniform answers,
// so no stock route is reachable at all; disabledPaths is the second line.
//
// Cookies (R13 recipe B): `useSecureCookies: false` plus explicit `__Host-` names with Secure, HttpOnly,
// Path=/ and no Domain, so the names keep the `__Host-` prefix. SameSite=Lax (a link from WhatsApp or an
// e-mail opens the play page signed in; every mutation is POST + an exact Origin check). Sessions last 30
// days; Better Auth's own refresh is off, and ROTATION is ours (the playerSession endpoint below): a session
// older than SESSION_ROTATE_AFTER_SECONDS is replaced by a new one (a new token, a fresh 30 days) on its next
// use, and every login revokes the session it replaces. ABSOLUTE CAP (security review L3): the login that
// started a rotation chain is recorded in player_auth.session_state; a rotation carries it over, never lets
// the new session (nor its cookie) outlive login + SESSION_ABSOLUTE_SECONDS, and a session past the cap, or
// without that row, is anonymous (fail closed) and is deleted. No cookie cache, no secondary storage
// (sessions stay in PostgreSQL; nothing of the player login lives in Valkey), no Better Auth rate limiter
// (ours in Valkey).
import { isMagicLinkChannel, type MagicLinkChannel } from "@ebooktrivia/core";
import { schema } from "@ebooktrivia/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";
import { phoneNumber } from "better-auth/plugins/phone-number";
import type { PlayConfig } from "../config.ts";
import type { Sql } from "../db.ts";
import type { Logger } from "../log.ts";
import type { PlayDb } from "./db.ts";
import { verifyStoredOtp } from "./otp.ts";

export const PLAY_SESSION_COOKIE = "__Host-play_session";
export const PLAY_COOKIE_NAMES = {
  session_token: PLAY_SESSION_COOKIE,
  session_data: "__Host-play_session_data",
  dont_remember: "__Host-play_dont_remember",
  account_data: "__Host-play_account_data",
} as const;

/** Every player cookie's attributes (R13 recipe B: Secure + Path=/ + no Domain keeps the `__Host-` prefix valid). */
export const PLAY_COOKIE_ATTRIBUTES: { readonly secure: boolean; readonly httpOnly: boolean; readonly sameSite: "lax" | "strict"; readonly path: string } = {
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
};

/** The expired session cookie (logout), with the attributes it was set with. */
export const EXPIRED_SESSION_COOKIE = [
  `${PLAY_SESSION_COOKIE}=`,
  "Max-Age=0",
  `Path=${PLAY_COOKIE_ATTRIBUTES.path}`,
  ...(PLAY_COOKIE_ATTRIBUTES.httpOnly ? ["HttpOnly"] : []),
  ...(PLAY_COOKIE_ATTRIBUTES.secure ? ["Secure"] : []),
  `SameSite=${PLAY_COOKIE_ATTRIBUTES.sameSite === "lax" ? "Lax" : "Strict"}`,
].join("; ");

export const SESSION_SECONDS = 30 * 24 * 60 * 60;
/** A session token is replaced by a new one on its first use after this age. */
export const SESSION_ROTATE_AFTER_SECONDS = 24 * 60 * 60;
/** How long a rotated-out token keeps working (requests already in flight with it). */
export const SESSION_ROTATION_GRACE_SECONDS = 60;
/** No session lives longer than this after the login that started its rotation chain (security review L3). */
export const SESSION_ABSOLUTE_SECONDS = 90 * 24 * 60 * 60;

/** The stock send-otp's answer, should anything ever call it: nothing is stored or sent. */
const SEND_OTP_SHORT_CIRCUIT = { status: true } as const;

/** Records the login of a new session (OTP verify, magic link): the start of its rotation chain. */
export async function recordLogin(sql: Sql, session: { readonly id: string } | { readonly token: string }): Promise<void> {
  if ("id" in session) {
    await sql`INSERT INTO player_auth.session_state (session_id, login_at) SELECT s.id, s."createdAt" FROM player_auth.session s WHERE s.id = ${session.id} ON CONFLICT (session_id) DO NOTHING`;
  } else {
    await sql`INSERT INTO player_auth.session_state (session_id, login_at) SELECT s.id, s."createdAt" FROM player_auth.session s WHERE s.token = ${session.token} ON CONFLICT (session_id) DO NOTHING`;
  }
}

/** When the session's chain started, if it is still inside the absolute cap; null otherwise (or no state row). */
export async function chainStart(sql: Sql, sessionId: string): Promise<Date | null> {
  const [row] = await sql<{ login_at: Date }[]>`
    SELECT login_at FROM player_auth.session_state
     WHERE session_id = ${sessionId} AND login_at > clock_timestamp() - make_interval(secs => ${SESSION_ABSOLUTE_SECONDS})`;
  return row?.login_at ?? null;
}

export interface PlayAuthDeps {
  readonly config: PlayConfig;
  /** The app pool (postgres.js defaults): our own queries. */
  readonly sql: Sql;
  /** Better Auth's own small pool behind the drizzle wrapper (lib/play/db.ts). */
  readonly db: PlayDb;
  readonly log: Logger;
  /** otp.max_attempts at the time of the verify. */
  readonly maxAttempts: () => Promise<number>;
}

/** The player behind a player_auth user who may log in, else null (public.player_for_login). */
export async function playerForLogin(sql: Sql, authUserId: string): Promise<string | null> {
  const [row] = await sql<{ player_id: string | null }[]>`SELECT public.player_for_login(${authUserId}) AS player_id`;
  return row?.player_id ?? null;
}

/** `{ tokenHash: 64 hex, channel }`, as a Standard Schema for the magic-link endpoint body. */
const magicLinkBody = {
  "~standard": {
    version: 1,
    vendor: "ebooktrivia",
    validate: (value: unknown) => {
      const body = value as { tokenHash?: unknown; channel?: unknown } | null;
      return typeof body === "object" && body !== null && typeof body.tokenHash === "string" && /^[0-9a-f]{64}$/.test(body.tokenHash) && isMagicLinkChannel(body.channel)
        ? { value: { tokenHash: body.tokenHash, channel: body.channel } }
        : { issues: [{ message: "tokenHash (64 hex) and a magic link channel are required" }] };
    },
    types: undefined as unknown as { readonly input: { tokenHash: string; channel: MagicLinkChannel }; readonly output: { tokenHash: string; channel: MagicLinkChannel } },
  },
} as const;

const invalidLink = () => APIError.from("BAD_REQUEST", { code: "INVALID_LINK", message: "invalid link" });

/**
 * Our session endpoints, inside the instance so they share its signed cookies and session creation. All are
 * server-only (no HTTP path even if a handler were mounted).
 */
function playerSessions(deps: PlayAuthDeps) {
  return {
    id: "player-sessions",
    endpoints: {
      /**
       * The player of the request's session (null: anonymous). Rotates a session older than
       * SESSION_ROTATE_AFTER_SECONDS: one request claims the rotation (the old token then works for the
       * grace period only, for requests already in flight), creates the new session and sets its cookie;
       * a concurrent request keeps the old token for that grace period.
       */
      playerSession: createAuthEndpoint.serverOnly({ method: "POST" }, async (ctx) => {
        const found = await getSessionFromCtx(ctx, { disableRefresh: true, disableCookieCache: true });
        if (found === null) return ctx.json({ authUserId: null, rotated: false });
        const loginAt = await chainStart(deps.sql, found.session.id);
        if (loginAt === null) {
          // Past the absolute cap, or a session no login recorded: it ends now, and so does its cookie.
          await ctx.context.internalAdapter.deleteSession(found.session.token);
          deleteSessionCookie(ctx);
          return ctx.json({ authUserId: null, rotated: false });
        }
        const age = Date.now() - new Date(found.session.createdAt).getTime();
        if (age < SESSION_ROTATE_AFTER_SECONDS * 1000) return ctx.json({ authUserId: found.user.id, rotated: false });
        const claimed = await deps.sql`
          UPDATE player_auth.session
             SET "expiresAt" = LEAST("expiresAt", clock_timestamp() + make_interval(secs => ${SESSION_ROTATION_GRACE_SECONDS})), "updatedAt" = clock_timestamp()
           WHERE id = ${found.session.id} AND "expiresAt" > clock_timestamp() + make_interval(secs => ${SESSION_ROTATION_GRACE_SECONDS})
          RETURNING id`;
        if (claimed.length === 0) return ctx.json({ authUserId: found.user.id, rotated: false });
        const next = (await ctx.context.internalAdapter.createSession(found.user.id)) as Awaited<ReturnType<typeof ctx.context.internalAdapter.createSession>> | null;
        if (next === null) {
          // The player may no longer log in (session.create hook): the old session ends with the grace period.
          return ctx.json({ authUserId: null, rotated: false });
        }
        // The chain's login carries over, and neither the new session nor its cookie outlives the cap.
        const capEnd = new Date(loginAt.getTime() + SESSION_ABSOLUTE_SECONDS * 1000);
        await deps.sql`INSERT INTO player_auth.session_state (session_id, login_at) VALUES (${next.id}, ${loginAt})`;
        const [bounded] = await deps.sql<{ expires_at: Date }[]>`
          UPDATE player_auth.session SET "expiresAt" = LEAST("expiresAt", ${capEnd}) WHERE id = ${next.id} RETURNING "expiresAt" AS expires_at`;
        const expiresAt = bounded?.expires_at ?? capEnd;
        const maxAge = Math.max(1, Math.min(SESSION_SECONDS, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));
        await setSessionCookie(ctx, { session: { ...next, expiresAt }, user: found.user }, false, { maxAge });
        return ctx.json({ authUserId: found.user.id, rotated: true });
      }),
      /** Deletes the request's session (logout, and every login replacing one). Cookies are the caller's. */
      playerRevokeSession: createAuthEndpoint.serverOnly({ method: "POST" }, async (ctx) => {
        const found = await getSessionFromCtx(ctx, { disableRefresh: true, disableCookieCache: true });
        if (found === null) return ctx.json({ revoked: false });
        await ctx.context.internalAdapter.deleteSession(found.session.token);
        return ctx.json({ revoked: true });
      }),
      /**
       * "Keluar dari semua perangkat" (US-026 follow-up, US-027): deletes EVERY session of the request's player
       * (their session_state rows go with them, ON DELETE CASCADE), so a phone left signed in elsewhere is signed
       * out too. Only a valid session can ask, and only for its own player. Cookies are the caller's.
       */
      playerRevokeAllSessions: createAuthEndpoint.serverOnly({ method: "POST" }, async (ctx) => {
        const found = await getSessionFromCtx(ctx, { disableRefresh: true, disableCookieCache: true });
        if (found === null) return ctx.json({ revoked: false });
        await ctx.context.internalAdapter.deleteUserSessions(found.user.id);
        return ctx.json({ revoked: true });
      }),
      /**
       * Logs in with a magic link (single use, channel-bound, 72 h). The link is used up LAST: its login is
       * looked up (magic_link_login_user), the session and its state are created, and only then does
       * consume_magic_link spend the link, so a failure before that leaves the link valid; a consume that
       * loses (a concurrent use) or fails deletes the session it would have opened.
       */
      playerMagicLinkLogin: createAuthEndpoint.serverOnly({ method: "POST", body: magicLinkBody }, async (ctx) => {
        const hash = Buffer.from(ctx.body.tokenHash, "hex");
        const [peek] = await deps.sql<{ auth_user_id: string | null }[]>`SELECT public.magic_link_login_user(${hash}, ${ctx.body.channel}) AS auth_user_id`;
        const authUserId = peek?.auth_user_id ?? null;
        if (authUserId === null) throw invalidLink();
        const user = await ctx.context.internalAdapter.findUserById(authUserId);
        if (user === null) throw invalidLink();
        const session = (await ctx.context.internalAdapter.createSession(authUserId)) as Awaited<ReturnType<typeof ctx.context.internalAdapter.createSession>> | null;
        if (session === null) throw invalidLink();
        let consumed: string | null;
        try {
          await recordLogin(deps.sql, { id: session.id });
          const [row] = await deps.sql<{ auth_user_id: string | null }[]>`SELECT public.consume_magic_link(${hash}, ${ctx.body.channel}) AS auth_user_id`;
          consumed = row?.auth_user_id ?? null;
        } catch (error) {
          await ctx.context.internalAdapter.deleteSession(session.token).catch(() => undefined);
          throw error;
        }
        if (consumed !== authUserId) {
          await ctx.context.internalAdapter.deleteSession(session.token);
          throw invalidLink();
        }
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ authUserId });
      }),
    },
  };
}

export function createPlayAuth(deps: PlayAuthDeps) {
  const { config, sql, db, log } = deps;
  return betterAuth({
    appName: "ebooktrivia player",
    baseURL: config.playOrigin,
    basePath: "/api/auth",
    secrets: config.playerAuthSecrets.map((s) => ({ version: s.version, value: s.value })),
    logger: {
      level: "warn",
      // Better Auth's own messages can quote a phone number or a token: only the level is logged.
      log: (level) => {
        log(level === "error" ? "error" : "warn", "play.auth_library", { kind: level });
      },
    },
    onAPIError: { throw: true },
    trustedOrigins: [config.playOrigin],
    telemetry: { enabled: false },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.playerAuthUser,
        session: schema.playerAuthSession,
        account: schema.playerAuthAccount,
        verification: schema.playerAuthVerification,
      },
      transaction: true,
    }),
    disabledPaths: ["/sign-in/phone-number", "/phone-number/request-password-reset", "/phone-number/reset-password"],
    session: {
      expiresIn: SESSION_SECONDS,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    account: { accountLinking: { enabled: false } },
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: false,
      defaultCookieAttributes: { ...PLAY_COOKIE_ATTRIBUTES },
      cookies: Object.fromEntries(Object.entries(PLAY_COOKIE_NAMES).map(([key, name]) => [key, { name }])),
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    hooks: {
      // R13: the stock send-otp writes the plaintext code before it sends; it is answered here instead.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/phone-number/send-otp") return ctx.json(SEND_OTP_SHORT_CIRCUIT);
        return undefined;
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // No session for a player who may not log in (anonymized, eligible for no program, no player).
          before: async (session) => ((await playerForLogin(sql, session.userId)) === null ? false : undefined),
        },
      },
    },
    plugins: [
      phoneNumber({
        otpLength: 6,
        sendOTP: () => {
          throw new Error("the stock OTP sender is never used (lib/play/otp.ts issues codes)");
        },
        verifyOTP: async ({ phoneNumber: phone, code }) => verifyStoredOtp({ sql, pepper: config.otpPepper, maxAttempts: await deps.maxAttempts() }, phone, code),
      }),
      playerSessions(deps),
    ],
  });
}

export type PlayAuth = ReturnType<typeof createPlayAuth>;
