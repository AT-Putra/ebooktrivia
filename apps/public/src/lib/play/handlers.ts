// The player login API on play.<DOMAIN> (US-026; plan M9.1, §3). Same-origin JSON routes, no CORS:
//
//   POST /api/v1/play/cap/challenge|redeem   the Cap protocol for the login page (scope PLAY_CAP_SCOPE)
//   POST /api/v1/play/auth/otp               request a code        200 {v:1,status:"sent",resend_after_seconds}
//   POST /api/v1/play/auth/otp/verify        log in with the code  200 {v:1,ok:true,phone_masked} + __Host-play_session
//   POST /api/v1/play/auth/magic-link        log in with a link    200 {v:1,ok:true,phone_masked} + __Host-play_session
//   POST /api/v1/play/auth/magic-link/resend send a new link (US-027) 200 {v:1,status:"sent"} (every phone alike)
//   POST /api/v1/play/auth/logout            end the session       200 {v:1,ok:true}, cookie expired
//   POST /api/v1/play/auth/logout-all        end EVERY session of the player (US-027) 200 {v:1,ok:true}, cookie expired
//   GET  /api/v1/play/auth/session           {v:1,authenticated[,phone_masked]} (rotates a due session)
//
// Every POST first requires Origin == the play origin EXACTLY (403 `origin`, before anything else is read).
// Errors: 400 validation (+fields) | 400 invalid_code | 400 invalid_link | 401 unauthenticated | 403 origin |
// 403 captcha | 429 rate_limited (Retry-After) | 503 unavailable (PostgreSQL, Valkey or a setting missing:
// fail closed). The question flow (lib/play/trivia.ts, US-027) adds 403 forbidden and 409 locked | closed |
// already_answered | not_served | too_late | empty_set. A login answers with the signed-in player's phone MASKED (player_login_label, "0812-3456-****"),
// which the page shows, so that someone who opened another person's forwarded link sees whose account it is
// (login CSRF, security review L5).
//
// ENUMERATION (plan §10, AC "identical response"): the OTP request is answered from what the CLIENT sent
// alone, the phone's format, the Cap token and the rate limits, all of which are the same for every phone;
// whether the phone is known or eligible is looked up only AFTER the answer has been sent (`defer`, Next.js
// after()), by issuePlayerOtp, which logs nothing about the outcome. So the status, the body, the headers,
// the timing of the answer and the request's log line cannot depend on the phone's status. The per-phone
// limits are counted in Valkey for EVERY phone (keyed by a hash, never the number), so a refusal reveals
// nothing either; enqueue_otp enforces the cap again in SQL for the codes actually sent, and the global send
// breaker. The verify does the same work for every phone (the per-phone verify count, one atomic attempts
// UPDATE that does not wait for a WAL flush) and answers one `invalid_code`, sent no earlier than
// PLAY_LIMITS.verifyFloorMs after the request arrived.
//
// Rate limits (Valkey, fixed windows, lib/valkey.ts; fixed numbers in ./limits.ts), in this order:
//   otp       per IPv6 /48 (x PLAY_LIMITS.ip48Factor) and per client IP (an IPv6 /64) otp.ip_cap per
//             otp.ip_window_seconds, BEFORE the Cap check; then, only for a request whose Cap token verified
//             (junk tokens cannot spend a victim's budget), per phone the cooldown (1 per
//             otp.cooldown_seconds) and otp.phone_cap per otp.phone_window_seconds.
//   verify, magic-link   per /48 and per client IP otp.ip_cap x otp.max_attempts per otp.ip_window_seconds
//             (as many tries as the codes that IP may request could take); verify then requires a play-scope
//             Cap token, and only after it counts per phone over all its codes, per (phone, client network)
//             PLAY_LIMITS.verifyPhoneNetworkCap and per phone PLAY_LIMITS.verifyPhoneCap a day (review N1).
//   cap       per IPv6 /48 captcha.ip48_cap, per client IP captcha.ip_cap, per captcha.ip_window_seconds.
//
// US-027 SESSION CONTRACT: a play route that needs the player wraps its work in withPlayer(deps, request,
// (playerId) => ...). It refuses every non-GET request without the exact play Origin (403, before the session is
// read), verifies the signed cookie against player_auth.session, enforces the absolute cap,
// rotates a due session, maps the session to the player through player_for_login (anonymized, or eligible for
// no program: anonymous, 401) and appends the rotation's cookies to EVERY answer, errors included. playerId
// comes from the server only, never from the client: pass it to the SECURITY DEFINER play functions. Server
// components (which cannot set cookies) use readPlayer, read only. guards.test.ts fails a play route that
// reads the session any other way.
import { randomUUID } from "node:crypto";
import type { CapProvider } from "@ebooktrivia/adapters";
import { hashMagicLinkToken, isMagicLinkChannel, normalizeIdMobile } from "@ebooktrivia/core";
import { SDK_LIMITS } from "@ebooktrivia/core/sdk-contract";
import type { SecretSealer } from "@ebooktrivia/crypto";
import { clientIp, throttleBucket, throttleBucket48 } from "@ebooktrivia/edge";
// isAPIError, never `instanceof APIError`: the shared runtime (lib/runtime.ts, one per process on globalThis) is built by whichever bundle asks first (a
// page, the proxy or a route), and each Next.js bundle has its own copy of better-auth, so the auth instance's APIError is often not this module's class.
// better-auth's own check also accepts the error by its name.
import { isAPIError } from "better-auth/api";
import { intSettings, loadCaptchaSettings } from "../checkout/data.ts";
import type { Sql } from "../db.ts";
import { readJsonBody } from "../http.ts";
import type { Logger } from "../log.ts";
import { hitRateLimits, isValkeyUnavailable, phoneKey, type RateDecision, type RateLimit, type Valkey } from "../valkey.ts";
import { chainStart, EXPIRED_SESSION_COOKIE, PLAY_SESSION_COOKIE, type PlayAuth, playerForLogin, recordLogin } from "./auth.ts";
import { PLAY_LIMITS } from "./limits.ts";
import { issuePlayerOtp } from "./otp.ts";

/**
 * The Cap scope of the login page: one fixed UUID that no landing page can have (landing page ids are
 * version-4 UUIDs, this one is version 0), so a token solved on an LP fails here and the reverse.
 */
export const PLAY_CAP_SCOPE = "00000000-0000-0000-0000-00000000a026";

export interface PlayDeps {
  readonly sql: Sql;
  readonly valkey: Valkey;
  readonly auth: PlayAuth;
  /** The Cap provider of a scope (lib/cap-routes.ts capProviders, the same key and token marks as checkout). */
  readonly capFor: (scope: string) => Pick<CapProvider, "challenge" | "redeem" | "verify">;
  readonly sealer: Pick<SecretSealer, "sealOtp">;
  readonly otpPepper: Uint8Array;
  readonly playOrigin: string;
  /** The data directory (default /srv/data): the uploaded images are read from images/<upload id>.webp under it (lib/play/images.ts). */
  readonly dataDir: string;
  readonly log: Logger;
  /** Runs `task` after the answer has been sent (next/server after() in the routes). Never awaited by a handler. */
  readonly defer: (task: () => Promise<void>) => void;
  /** PLAY_LIMITS.verifyFloorMs unless a test sets it. */
  readonly verifyFloorMs?: number;
}

const OTP_KEYS = [
  "otp.ip_cap",
  "otp.ip_window_seconds",
  "otp.cooldown_seconds",
  "otp.phone_cap",
  "otp.phone_window_seconds",
  "otp.code_ttl_seconds",
  "otp.max_attempts",
] as const;
export const loadOtpSettings = (sql: Sql) => intSettings(sql, OTP_KEYS);

const MAX_BODY_BYTES = 8 * 1024;
const MAX_PHONE_INPUT = 32;

const HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-type": "application/json; charset=utf-8",
};

export type PlayErrorCode =
  | "validation"
  | "invalid_code"
  | "invalid_link"
  | "unauthenticated"
  | "origin"
  | "captcha"
  | "forbidden"
  | "locked"
  | "closed"
  | "already_answered"
  | "not_served"
  | "too_late"
  | "empty_set"
  | "rate_limited"
  | "unavailable";
const STATUS: Readonly<Record<PlayErrorCode, number>> = {
  validation: 400,
  invalid_code: 400,
  invalid_link: 400,
  unauthenticated: 401,
  origin: 403,
  captcha: 403,
  forbidden: 403,
  locked: 409,
  closed: 409,
  already_answered: 409,
  not_served: 409,
  too_late: 409,
  empty_set: 409,
  rate_limited: 429,
  unavailable: 503,
};

export function playJson(status: number, body: unknown, options: { readonly setCookies?: readonly string[]; readonly headers?: Readonly<Record<string, string>> } = {}): Response {
  const headers = new Headers({ ...HEADERS, ...options.headers });
  for (const cookie of options.setCookies ?? []) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export function playError(error: PlayErrorCode, extra: { readonly fields?: Record<string, string>; readonly retryAfterSeconds?: number } = {}): Response {
  return playJson(
    STATUS[error],
    { v: 1, error, ...(extra.fields === undefined ? {} : { fields: extra.fields }), ...(extra.retryAfterSeconds === undefined ? {} : { retry_after_seconds: extra.retryAfterSeconds }) },
    extra.retryAfterSeconds === undefined ? {} : { headers: { "retry-after": String(extra.retryAfterSeconds) } },
  );
}

const rateLimited = (decision: Exclude<RateDecision, { allowed: true }>): Response => playError("rate_limited", { retryAfterSeconds: decision.retryAfterSeconds });

/** The exact play origin, nothing else (no Origin, `null`, another port or scheme: refused). */
export const sameOrigin = (deps: Pick<PlayDeps, "playOrigin">, request: Request): boolean => request.headers.get("origin") === deps.playOrigin;

/** What an auth.api call may see of the request: the client address and user agent, and only the session cookie when `withSession`. */
export function authHeaders(source: Headers, withSession: boolean): Headers {
  const headers = new Headers();
  for (const name of ["x-forwarded-for", "user-agent"]) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value.slice(0, 512));
  }
  if (withSession) {
    const kept = (source.get("cookie") ?? "")
      .split(";")
      .map((pair) => pair.trim())
      .filter((pair) => pair.startsWith(`${PLAY_SESSION_COOKIE}=`));
    if (kept.length > 0) headers.set("cookie", kept.join("; "));
  }
  return headers;
}

/** The rate-limit key part of a phone in the player login (its own hash label, never the number). */
export const otpPhoneKey = (e164: string): string => phoneKey(e164, "otp-phone/v1");

/** The per-client limits of a route: its IPv6 /48 (x ip48Factor) first, then the client IP (an IPv6 /64). */
function clientLimits(prefix: string, headers: Headers, limit: number, windowMs: number): RateLimit[] {
  const ip = clientIp(headers);
  const network = throttleBucket48(ip);
  return [
    ...(network === null ? [] : [{ key: `${prefix}:ip48:${network}`, limit: limit * PLAY_LIMITS.ip48Factor, windowMs }]),
    { key: `${prefix}:ip:${throttleBucket(ip)}`, limit, windowMs },
  ];
}

const limitReason = (limits: readonly RateLimit[], decision: Exclude<RateDecision, { allowed: true }>): string =>
  limits[decision.index]?.key.includes(":ip48:") === true ? "rate_limited_ip48" : "rate_limited_ip";

const isValkeyDown = (error: unknown): boolean => isValkeyUnavailable(error);

/**
 * An auth-library refusal for the log: the library's fixed code (INVALID_OTP, FAILED_TO_CREATE_SESSION...) and its HTTP status, never
 * its message. The player gets one generic answer either way. A 5xx is logged as a warning: it is a failure behind that answer (the
 * session store), or our session gate refusing a player who may no longer log in (FAILED_TO_CREATE_SESSION; rare: the eligibility
 * changed between the code and its check).
 */
function logAuthRefusal(log: Logger, route: string, reason: "invalid_code" | "invalid_link", error: unknown): void {
  const { statusCode, body } = error as { readonly statusCode?: unknown; readonly body?: { readonly code?: unknown } };
  const code = body?.code;
  const status = typeof statusCode === "number" ? statusCode : undefined;
  log(status !== undefined && status >= 500 ? "warn" : "info", "play.refused", {
    route,
    reason,
    ...(typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? { code } : {}),
    ...(status === undefined ? {} : { status }),
  });
}

function failure(log: Logger, route: string, error: unknown): Response {
  log("error", "play.failed", { route, reason: isValkeyDown(error) ? "valkey_unavailable" : "internal" }, error);
  return playError("unavailable");
}

const stringField = (body: unknown, key: string, max: number): string | null => {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.length <= max ? value : null;
};

/** Waits until `floorMs` have passed since `startedMs` (performance.now()). */
async function padTo(startedMs: number, floorMs: number): Promise<void> {
  const wait = floorMs - (performance.now() - startedMs);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/** The signed-in player's phone, masked (player_login_label), or null. */
async function loginLabel(sql: Sql, authUserId: string): Promise<string | null> {
  const [row] = await sql<{ label: string | null }[]>`SELECT public.player_login_label(${authUserId}) AS label`;
  return row?.label ?? null;
}

// ---------------------------------------------------------------------------------------------
// OTP

export async function handleOtpRequest(deps: PlayDeps, request: Request): Promise<Response> {
  const route = "play.otp";
  if (!sameOrigin(deps, request)) return playError("origin");
  const requestId = randomUUID();
  try {
    const settings = await loadOtpSettings(deps.sql);
    const ipLimits = clientLimits("otp", request.headers, settings["otp.ip_cap"], settings["otp.ip_window_seconds"] * 1000);
    const perIp = await hitRateLimits(deps.valkey, ipLimits);
    if (!perIp.allowed) {
      deps.log("warn", "play.refused", { requestId, route, reason: limitReason(ipLimits, perIp) });
      return rateLimited(perIp);
    }
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    const rawPhone = body.ok ? stringField(body.value, "phone", MAX_PHONE_INPUT) : null;
    const capToken = body.ok ? stringField(body.value, "cap_token", SDK_LIMITS.capToken) : null;
    const phone = rawPhone === null ? null : normalizeIdMobile(rawPhone);
    if (phone === null || !phone.ok) {
      deps.log("info", "play.refused", { requestId, route, reason: "validation" });
      return playError("validation", { fields: { phone: phone === null ? "invalid" : phone.error } });
    }
    if (capToken === null || capToken === "" || !(await deps.capFor(PLAY_CAP_SCOPE).verify(capToken))) {
      deps.log("info", "play.refused", { requestId, route, reason: "captcha" });
      return playError("captcha");
    }
    const key = otpPhoneKey(phone.e164);
    const perPhone = await hitRateLimits(deps.valkey, [
      { key: `otp:cooldown:${key}`, limit: 1, windowMs: settings["otp.cooldown_seconds"] * 1000 },
      { key: `otp:phone:${key}`, limit: settings["otp.phone_cap"], windowMs: settings["otp.phone_window_seconds"] * 1000 },
    ]);
    if (!perPhone.allowed) {
      deps.log("info", "play.refused", { requestId, route, reason: perPhone.index === 0 ? "cooldown" : "rate_limited_phone" });
      return rateLimited(perPhone);
    }
    const ttlSeconds = settings["otp.code_ttl_seconds"];
    deps.defer(async () => {
      try {
        // The outcome (issued, not eligible, refused by the SQL cap or the breaker) is deliberately not logged.
        await issuePlayerOtp({ sql: deps.sql, sealer: deps.sealer, pepper: deps.otpPepper, ttlSeconds }, phone.e164);
      } catch (error) {
        deps.log("error", "play.otp_issue_failed", { requestId, route, reason: "internal" }, error);
      }
    });
    deps.log("info", "play.otp_requested", { requestId, route });
    return playJson(200, { v: 1, status: "sent", resend_after_seconds: settings["otp.cooldown_seconds"] });
  } catch (error) {
    return failure(deps.log, route, error);
  }
}

/** Counts one verify-or-link attempt per client (/48, IP); a refusal is the answer to return. */
async function attemptLimit(deps: PlayDeps, request: Request, kind: "verify" | "magic"): Promise<Response | null> {
  const settings = await loadOtpSettings(deps.sql);
  const limits = clientLimits(`otp:${kind}`, request.headers, settings["otp.ip_cap"] * settings["otp.max_attempts"], settings["otp.ip_window_seconds"] * 1000);
  const decision = await hitRateLimits(deps.valkey, limits);
  if (decision.allowed) return null;
  deps.log("warn", "play.refused", { route: `play.${kind}`, reason: limitReason(limits, decision) });
  return rateLimited(decision);
}

/** Deletes the session the request came with (a login replaces it: "rotate on login"). */
async function revokeIncoming(deps: PlayDeps, request: Request): Promise<void> {
  await deps.auth.api.playerRevokeSession({ headers: authHeaders(request.headers, true) });
}

export async function handleOtpVerify(deps: PlayDeps, request: Request): Promise<Response> {
  const route = "play.otp_verify";
  if (!sameOrigin(deps, request)) return playError("origin");
  const started = performance.now();
  try {
    const limited = await attemptLimit(deps, request, "verify");
    if (limited !== null) return limited;
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    const rawPhone = body.ok ? stringField(body.value, "phone", MAX_PHONE_INPUT) : null;
    const code = body.ok ? stringField(body.value, "code", 16) : null;
    const capToken = body.ok ? stringField(body.value, "cap_token", SDK_LIMITS.capToken) : null;
    const phone = rawPhone === null ? null : normalizeIdMobile(rawPhone);
    if (phone === null || !phone.ok || code === null || !/^[0-9]{6}$/.test(code)) {
      return playError("validation", { fields: { ...(phone?.ok === true ? {} : { phone: "invalid" }), ...(code !== null && /^[0-9]{6}$/.test(code) ? {} : { code: "invalid" }) } });
    }
    // A proof of work before anything is counted for the phone (security review N1): without it, a few POSTs with a
    // victim's number would lock that number out. The same answer for every phone, sent at once (no floor: it
    // does not depend on the phone).
    if (capToken === null || capToken === "" || !(await deps.capFor(PLAY_CAP_SCOPE).verify(capToken))) {
      deps.log("info", "play.refused", { route, reason: "captcha" });
      return playError("captcha");
    }
    // The per-phone counts over all its codes, written for EVERY phone, known or not: this network's slice first,
    // then the phone's total (a refused slice spends nothing of the total).
    const key = otpPhoneKey(phone.e164);
    const perPhone = await hitRateLimits(deps.valkey, [
      { key: `otp:verify:phone64:${key}:${throttleBucket(clientIp(request.headers))}`, limit: PLAY_LIMITS.verifyPhoneNetworkCap, windowMs: PLAY_LIMITS.verifyPhoneWindowMs },
      { key: `otp:verify:phone:${key}`, limit: PLAY_LIMITS.verifyPhoneCap, windowMs: PLAY_LIMITS.verifyPhoneWindowMs },
    ]);
    if (!perPhone.allowed) {
      deps.log("warn", "play.refused", { route, reason: "rate_limited_phone" });
      return rateLimited(perPhone);
    }
    let login: { readonly token: string | null; readonly authUserId: string | null; readonly setCookies: string[] };
    try {
      const result = await deps.auth.api.verifyPhoneNumber({ body: { phoneNumber: phone.e164, code }, headers: authHeaders(request.headers, false), returnHeaders: true });
      const answer = result.response as { readonly token?: string | null; readonly user?: { readonly id?: string } | null };
      login = { token: answer.token ?? null, authUserId: answer.user?.id ?? null, setCookies: result.headers.getSetCookie() };
    } catch (error) {
      // INVALID_OTP, and R13's FAILED_TO_UPDATE_USER (500) / FAILED_TO_CREATE_SESSION: one generic answer.
      if (!isAPIError(error)) throw error;
      logAuthRefusal(deps.log, route, "invalid_code", error);
      await padTo(started, deps.verifyFloorMs ?? PLAY_LIMITS.verifyFloorMs);
      return playError("invalid_code");
    }
    if (login.token === null || login.authUserId === null) throw new Error("the verify created no session");
    await recordLogin(deps.sql, { token: login.token });
    const label = await loginLabel(deps.sql, login.authUserId);
    await revokeIncoming(deps, request);
    deps.log("info", "play.login", { route, kind: "otp" });
    return playJson(200, { v: 1, ok: true, phone_masked: label }, { setCookies: login.setCookies });
  } catch (error) {
    return failure(deps.log, route, error);
  }
}

// ---------------------------------------------------------------------------------------------
// Magic link (the POST behind the confirm page; the GET page itself changes nothing)

export async function handleMagicLink(deps: PlayDeps, request: Request): Promise<Response> {
  const route = "play.magic_link";
  if (!sameOrigin(deps, request)) return playError("origin");
  try {
    const limited = await attemptLimit(deps, request, "magic");
    if (limited !== null) return limited;
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    const channel = body.ok ? stringField(body.value, "channel", 16) : null;
    const token = body.ok ? stringField(body.value, "token", 64) : null;
    const tokenHash = token === null ? null : hashMagicLinkToken(token);
    if (tokenHash === null || !isMagicLinkChannel(channel)) {
      deps.log("info", "play.refused", { route, reason: "invalid_link" });
      return playError("invalid_link");
    }
    let login: { readonly authUserId: string; readonly setCookies: string[] };
    try {
      const result = await deps.auth.api.playerMagicLinkLogin({ body: { tokenHash: tokenHash.toString("hex"), channel }, headers: authHeaders(request.headers, false), returnHeaders: true });
      login = { authUserId: result.response.authUserId, setCookies: result.headers.getSetCookie() };
    } catch (error) {
      if (!isAPIError(error)) throw error;
      logAuthRefusal(deps.log, route, "invalid_link", error);
      return playError("invalid_link");
    }
    const label = await loginLabel(deps.sql, login.authUserId);
    await revokeIncoming(deps, request);
    deps.log("info", "play.login", { route, kind: channel });
    return playJson(200, { v: 1, ok: true, phone_masked: label }, { setCookies: login.setCookies });
  } catch (error) {
    return failure(deps.log, route, error);
  }
}

/**
 * "Kirim ulang tautan masuk" (US-027, Owner decision; the recovery path for a player whose code checks an attacker
 * used up): POST {phone, cap_token} -> 200 {v:1,status:"sent"} for EVERY well-formed phone, eligible, not eligible
 * or unknown alike, from what the client sent alone (the same rule as the OTP request): the Origin, the per-client
 * limits, the phone's format, the play-scope Cap token, then the per-phone limit counted for every phone. Only after
 * the answer has been sent (`defer`) does enqueue_magic_link_resend look the phone up, and the worker then issues a
 * fresh link per channel (the previous one stops working) and sends it by WhatsApp and e-mail. The outcome is never
 * logged. Valkey or PostgreSQL down before the answer: 503 (fail closed).
 */
export async function handleMagicLinkResend(deps: PlayDeps, request: Request): Promise<Response> {
  const route = "play.magic_link_resend";
  if (!sameOrigin(deps, request)) return playError("origin");
  const requestId = randomUUID();
  try {
    const settings = await loadOtpSettings(deps.sql);
    const ipLimits = clientLimits("ml-resend", request.headers, settings["otp.ip_cap"], settings["otp.ip_window_seconds"] * 1000);
    const perIp = await hitRateLimits(deps.valkey, ipLimits);
    if (!perIp.allowed) {
      deps.log("warn", "play.refused", { requestId, route, reason: limitReason(ipLimits, perIp) });
      return rateLimited(perIp);
    }
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    const rawPhone = body.ok ? stringField(body.value, "phone", MAX_PHONE_INPUT) : null;
    const capToken = body.ok ? stringField(body.value, "cap_token", SDK_LIMITS.capToken) : null;
    const phone = rawPhone === null ? null : normalizeIdMobile(rawPhone);
    if (phone === null || !phone.ok) {
      deps.log("info", "play.refused", { requestId, route, reason: "validation" });
      return playError("validation", { fields: { phone: phone === null ? "invalid" : phone.error } });
    }
    if (capToken === null || capToken === "" || !(await deps.capFor(PLAY_CAP_SCOPE).verify(capToken))) {
      deps.log("info", "play.refused", { requestId, route, reason: "captcha" });
      return playError("captcha");
    }
    const perPhone = await hitRateLimits(deps.valkey, [
      { key: `ml-resend:phone:${otpPhoneKey(phone.e164)}`, limit: PLAY_LIMITS.resendPhoneCap, windowMs: PLAY_LIMITS.resendPhoneWindowMs },
    ]);
    if (!perPhone.allowed) {
      deps.log("info", "play.refused", { requestId, route, reason: "rate_limited_phone" });
      return rateLimited(perPhone);
    }
    deps.defer(async () => {
      try {
        // Whether a job was made (an eligible player) is deliberately neither returned nor logged.
        await deps.sql`SELECT public.enqueue_magic_link_resend(${phone.e164})`;
      } catch (error) {
        deps.log("error", "play.magic_link_resend_failed", { requestId, route, reason: "internal" }, error);
      }
    });
    deps.log("info", "play.magic_link_resend_requested", { requestId, route });
    return playJson(200, { v: 1, status: "sent" });
  } catch (error) {
    return failure(deps.log, route, error);
  }
}

// ---------------------------------------------------------------------------------------------
// Session

export async function handleLogout(deps: PlayDeps, request: Request): Promise<Response> {
  const route = "play.logout";
  if (!sameOrigin(deps, request)) return playError("origin");
  try {
    await revokeIncoming(deps, request);
    return playJson(200, { v: 1, ok: true }, { setCookies: [EXPIRED_SESSION_COOKIE] });
  } catch (error) {
    return failure(deps.log, route, error);
  }
}

/** Ends every session of the request's player (logout everywhere); this browser's cookie expires too. */
export async function handleLogoutAll(deps: PlayDeps, request: Request): Promise<Response> {
  const route = "play.logout_all";
  if (!sameOrigin(deps, request)) return playError("origin");
  try {
    await deps.auth.api.playerRevokeAllSessions({ headers: authHeaders(request.headers, true) });
    deps.log("info", "play.logout_all", { route });
    return playJson(200, { v: 1, ok: true }, { setCookies: [EXPIRED_SESSION_COOKIE] });
  } catch (error) {
    return failure(deps.log, route, error);
  }
}

interface ResolvedPlayer {
  readonly playerId: string | null;
  readonly authUserId: string | null;
  /** Set-Cookie of a rotated (or ended) session: they go on the answer, whatever it is. */
  readonly setCookies: readonly string[];
}

/** Internal: withPlayer is the one way a play route gets the player (it appends these cookies). */
async function resolvePlayer(deps: Pick<PlayDeps, "auth" | "sql">, headers: Headers): Promise<ResolvedPlayer> {
  const result = await deps.auth.api.playerSession({ headers: authHeaders(headers, true), returnHeaders: true });
  const setCookies = result.headers.getSetCookie();
  const { authUserId } = result.response;
  const playerId = authUserId === null ? null : await playerForLogin(deps.sql, authUserId);
  return { playerId, authUserId: playerId === null ? null : authUserId, setCookies };
}

function withCookies(response: Response, cookies: readonly string[]): Response {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Methods that change nothing: the only ones withPlayer lets through without the play Origin. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Runs `handler` for the request's player (US-027's play routes): any other method than GET / HEAD without the
 * exact play Origin is 403 `origin` before the session is read (the session cookie is SameSite=Lax, and
 * order.<DOMAIN> is the same site, so a cookie alone proves no intent), anonymous is 401 `unauthenticated`, a
 * handler that throws is 503 `unavailable`, and the session's rotation cookies are on EVERY answer.
 */
export async function withPlayer(deps: Pick<PlayDeps, "auth" | "sql" | "log" | "playOrigin">, request: Request, handler: (playerId: string) => Promise<Response>): Promise<Response> {
  if (!SAFE_METHODS.has(request.method.toUpperCase()) && !sameOrigin(deps, request)) return playError("origin");
  let player: ResolvedPlayer;
  try {
    player = await resolvePlayer(deps, request.headers);
  } catch (error) {
    return failure(deps.log, "play.session", error);
  }
  let response: Response;
  if (player.playerId === null) {
    response = playError("unauthenticated");
  } else {
    try {
      response = await handler(player.playerId);
    } catch (error) {
      response = failure(deps.log, "play.handler", error);
    }
  }
  return withCookies(response, player.setCookies);
}

/**
 * The player and the session for SERVER COMPONENTS (no cookie can be set there): no rotation, read only, the same rules. The session
 * id is what the profile card's own-contact read is keyed by (player_profile_contact), never the player id.
 */
export async function readPlayerSession(deps: Pick<PlayDeps, "auth" | "sql">, headers: Headers): Promise<{ readonly playerId: string; readonly sessionId: string } | null> {
  const session = await deps.auth.api.getSession({ headers: authHeaders(headers, true), query: { disableRefresh: true, disableCookieCache: true } });
  if (session === null || (await chainStart(deps.sql, session.session.id)) === null) return null;
  const playerId = await playerForLogin(deps.sql, session.user.id);
  return playerId === null ? null : { playerId, sessionId: session.session.id };
}

/** The player for SERVER COMPONENTS (readPlayerSession without the session). */
export async function readPlayer(deps: Pick<PlayDeps, "auth" | "sql">, headers: Headers): Promise<string | null> {
  return (await readPlayerSession(deps, headers))?.playerId ?? null;
}

export async function handleSession(deps: PlayDeps, request: Request): Promise<Response> {
  try {
    const player = await resolvePlayer(deps, request.headers);
    const body = player.authUserId === null ? { v: 1, authenticated: false } : { v: 1, authenticated: true, phone_masked: await loginLabel(deps.sql, player.authUserId) };
    return playJson(200, body, { setCookies: player.setCookies });
  } catch (error) {
    return failure(deps.log, "play.session", error);
  }
}

// ---------------------------------------------------------------------------------------------
// Cap (the widget protocol for the login page)

export async function handlePlayCap(deps: PlayDeps, action: "challenge" | "redeem", request: Request): Promise<Response> {
  const route = `play.cap_${action}`;
  if (!sameOrigin(deps, request)) return playError("origin");
  try {
    const settings = await loadCaptchaSettings(deps.sql);
    const windowMs = settings["captcha.ip_window_seconds"] * 1000;
    const ip = clientIp(request.headers);
    const network = throttleBucket48(ip);
    const limits: RateLimit[] = [
      ...(network === null ? [] : [{ key: `captcha:play:ip48:${network}`, limit: settings["captcha.ip48_cap"], windowMs }]),
      { key: `captcha:play:ip:${throttleBucket(ip)}`, limit: settings["captcha.ip_cap"], windowMs },
    ];
    const decision = await hitRateLimits(deps.valkey, limits);
    if (!decision.allowed) {
      deps.log("warn", "play.refused", { route, reason: limitReason(limits, decision) });
      return rateLimited(decision);
    }
    const cap = deps.capFor(PLAY_CAP_SCOPE);
    if (action === "challenge") return playJson(200, await cap.challenge());
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    return playJson(200, body.ok ? await cap.redeem(body.value) : { success: false });
  } catch (error) {
    return failure(deps.log, route, error);
  }
}
