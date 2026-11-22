// Every sign-in and second-factor flow of the console (the only callers of `auth.api.*` besides the
// session check). Each one:
//   - passes Better Auth only the cookie the step needs (the password step none, the second factor
//     only the __Host-admin_2fa challenge, enrollment only the session), so a step never takes
//     another path inside Better Auth (e.g. a session-bound TOTP check without its lockout);
//   - is throttled per account and per client address (lib/auth/throttle.ts) before any check; the
//     per-user second-factor key also counts consecutive failures (hard lock at 20);
//   - records an audit entry for every outcome (failures as actor "system", successes as the admin);
//   - returns the Set-Cookie headers for the caller to apply (lib/next/request.ts), so it runs
//     unchanged outside Next.js (tests, CLI).
// A session becomes usable only through admin_auth.session_state, written here: with mfa NULL for
// the password-only session of a user who has not enrolled TOTP yet (it may only enroll), with
// mfa = totp / recovery_code after the second factor.
// Where Better Auth commits on its own connection before our audit transaction (enrolling the TOTP
// secret, verifying the first code, sign-out), a `*_requested` audit row is written BEFORE the call,
// so a failure in between still leaves a trace (lib/audit.ts, "accepted deviations").
// Must run inside a mutation scope (lib/audit.ts runMutation): the server action wrappers do that.
import { createHash } from "node:crypto";
import { isAPIError } from "better-auth/api";
import { renderSVG } from "uqr";
import { type AuditChange, currentMutationScope, insertAudit, NoMutationScopeError, withAudit } from "../audit.ts";
import { throttleBucket } from "@ebooktrivia/edge";
import type { Sql } from "../db.ts";
import { logEvent } from "../log.ts";
import { hashSecret, verifySecret } from "./argon2.ts";
import { SESSION_COOKIE, TOTP_ISSUER, TWO_FACTOR_COOKIE } from "./instance.ts";
import { enqueuePasswordCheck } from "./password-check.ts";
import { configuredOrigin, passwordProblem } from "./password-policy.ts";
import { prepareRecoveryCodes, storeRecoveryCodes } from "./recovery-codes.ts";
import { authHeaders, normalizeEmail, PASSWORD_MAX, PASSWORD_MIN } from "./request.ts";
import type { AuthRuntime } from "./runtime.ts";
import { beginAttempt, clearThrottle, type FailureResult, type Gate, LOCK_SECONDS, notePendingSignIn, refund, takePendingSignIn, throttleKey } from "./throttle.ts";

export interface RequestInfo {
  readonly headers: Headers;
  readonly ip: string | null;
}

export interface WithCookies<T> {
  readonly outcome: T;
  readonly setCookies: readonly string[];
}

/** `permanent`: hard-locked after too many consecutive second-factor failures (recovery CLI only). */
export type Locked = { readonly kind: "locked"; readonly retryAfterSeconds: number; readonly permanent: boolean };
export type SignInOutcome = { readonly kind: "second_factor" } | { readonly kind: "enroll" } | { readonly kind: "invalid" } | Locked;
export type SecondFactorOutcome = { readonly kind: "signed_in" } | { readonly kind: "invalid" } | { readonly kind: "expired" } | Locked;
export type EnrollStartOutcome =
  | { readonly kind: "verify"; readonly secret: string; readonly uri: string; readonly qrSvgDataUrl: string; readonly recoveryCodes: readonly string[] }
  | { readonly kind: "invalid" }
  | { readonly kind: "invalid_new_password" }
  | Locked;
export type CodeOutcome<T> = T | { readonly kind: "invalid" } | Locked;

/** How long a used TOTP code is remembered: longer than its validity (its step +- one, 90 s). */
export const TOTP_REPLAY_SECONDS = 120;
const TOTP_CODE = /^\d{6}$/;

/** The session token a Set-Cookie list hands the browser (the signed value is `token.signature`). */
export function sessionTokenFromSetCookie(setCookies: readonly string[]): string | null {
  for (const header of setCookies) {
    const [pair = ""] = header.split(";");
    const eq = pair.indexOf("=");
    if (pair.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = decodeURIComponent(pair.slice(eq + 1).trim());
    const token = value.split(".")[0] ?? "";
    if (token !== "") return token;
  }
  return null;
}

/** The authenticator setup URI as a QR code (SVG, rendered here on the server) in a data: URL. */
export function totpQrDataUrl(uri: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(renderSVG(uri, { ecc: "M", border: 2, pixelSize: 6 })).toString("base64")}`;
}

const locked = (retryAfterSeconds: number, permanent = false): Locked => ({ kind: "locked", retryAfterSeconds, permanent });
const refused = (gate: Extract<Gate, { allowed: false }>): Locked => locked(gate.retryAfterSeconds, gate.hardLocked);
const ipKey = (req: RequestInfo): string => throttleKey("ip", throttleBucket(req.ip));
const userIdOf = (value: unknown): string | null =>
  typeof value === "object" && value !== null && "userId" in value && typeof value.userId === "string" ? value.userId : null;

function scope() {
  const current = currentMutationScope();
  if (current === undefined) throw new NoMutationScopeError();
  return current;
}

/** An audit entry in its own transaction (auth events; settings changes use withAudit). */
async function recordEvent(sql: Sql, change: AuditChange): Promise<void> {
  await insertAudit(sql, scope(), change);
}

function apiErrorCode(error: unknown): { status: number; code: string } {
  if (!isAPIError(error)) return { status: 0, code: "" };
  const body: unknown = error.body;
  const code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "";
  return { status: error.statusCode, code };
}

async function userIdByEmail(sql: Sql, email: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM admin_auth."user" WHERE email = ${email}`;
  return row?.id ?? null;
}

/**
 * A sign-in is complete (second factor passed, or TOTP enrolled): the account key its password step
 * kept counted is cleared (security review US-016 F1). The address count of that password step is
 * refunded only when this request comes from the same address and a password step from it is still
 * pending (G2): completing from another address refunds nothing, so nobody can steer refunds to an
 * address of their choice.
 */
async function signInCompleted(sql: Sql, userId: string, req: RequestInfo): Promise<void> {
  const [user] = await sql<{ email: string }[]>`SELECT email FROM admin_auth."user" WHERE id = ${userId}`;
  if (user !== undefined) await clearThrottle(sql, [throttleKey("account", user.email)]);
  if (await takePendingSignIn(sql, userId, throttleBucket(req.ip))) await refund(sql, [ipKey(req)]);
}

/** Logs and audits a second-factor hard lock (security review US-016 SM2). */
async function reportHardLock(sql: Sql, userId: string, result: FailureResult, step: string): Promise<boolean> {
  if (result.hardLocked.length === 0) return false;
  logEvent("warn", "admin.second_factor_locked", { userId });
  await recordEvent(sql, { action: "admin_auth.second_factor_hard_locked", entityType: "admin_user", entityId: userId, facts: { step } });
  return true;
}

/** Marks the session behind `token` usable (admin_auth.session_state) and audits the sign-in. */
async function startSession(sql: Sql, token: string, mfa: "totp" | "recovery_code" | null, facts: Record<string, string>): Promise<string> {
  return withAudit(sql, async (tx, audit) => {
    const [session] = await tx<{ id: string; userId: string }[]>`SELECT id, "userId" FROM admin_auth.session WHERE token = ${token}`;
    if (session === undefined) throw new Error("the new session was not found");
    await tx`
      INSERT INTO admin_auth.session_state (session_id, last_seen_at, mfa_method, mfa_verified_at)
      VALUES (${session.id}, clock_timestamp(), ${mfa}, CASE WHEN ${mfa}::text IS NULL THEN NULL ELSE clock_timestamp() END)`;
    audit({
      action: "admin_auth.sign_in",
      entityType: "admin_user",
      entityId: session.userId,
      facts: { ...facts, mfa: mfa ?? "enrollment_pending" },
      actor: { kind: "admin", userId: session.userId },
    });
    return session.id;
  });
}

/** Remembers a TOTP code of `userId`; false when it was already used within TOTP_REPLAY_SECONDS. */
export async function claimTotpCode(sql: Sql, userId: string, code: string): Promise<boolean> {
  const hash = createHash("sha256").update(`${userId}:${code}`).digest("hex");
  await sql`DELETE FROM admin_auth.totp_used WHERE user_id = ${userId} AND used_at < clock_timestamp() - make_interval(secs => ${TOTP_REPLAY_SECONDS})`;
  const claimed = await sql`
    INSERT INTO admin_auth.totp_used (user_id, code_hash, used_at) VALUES (${userId}, ${hash}, clock_timestamp())
    ON CONFLICT (user_id, code_hash) DO NOTHING RETURNING 1`;
  return claimed.length === 1;
}

/**
 * Step 1: e-mail + password. Every outcome is audited (security review US-016 SM1). A correct
 * password stays counted on the account and address keys until the sign-in completes
 * (signInCompleted), so unfinished sign-ins, and the audit rows they write, are capped at 5 per
 * 15 minutes per account and per address (F1). There is no hard lock on this step: knowing an
 * e-mail address must never be enough to lock an account for good.
 */
export async function signInWithPassword(rt: AuthRuntime, input: { email: string; password: string }, req: RequestInfo): Promise<WithCookies<SignInOutcome>> {
  const email = normalizeEmail(input.email);
  const accountKey = throttleKey("account", email);
  const gate = await beginAttempt(rt.sql, [accountKey, ipKey(req)]);
  if (!gate.allowed) return { outcome: refused(gate), setCookies: [] };
  let result;
  try {
    result = await rt.auth.api.signInEmail({
      body: { email, password: input.password, rememberMe: true },
      headers: authHeaders(req.headers, []),
      returnHeaders: true,
    });
  } catch (error) {
    if (!isAPIError(error)) {
      await gate.attempt.abandoned();
      throw error;
    }
    const { locked: lockedKeys } = await gate.attempt.failed();
    const userId = await userIdByEmail(rt.sql, email);
    await recordEvent(rt.sql, { action: "admin_auth.sign_in_failed", entityType: "admin_user", entityId: userId, facts: { step: "password" } });
    if (lockedKeys.length > 0) {
      await recordEvent(rt.sql, {
        action: "admin_auth.locked_out",
        entityType: "admin_user",
        entityId: userId,
        facts: { step: "password", account: lockedKeys.includes(accountKey), address: lockedKeys.includes(ipKey(req)) },
      });
      return { outcome: locked(LOCK_SECONDS), setCookies: [] };
    }
    return { outcome: { kind: "invalid" }, setCookies: [] };
  }
  // Deliberately neither `succeeded` nor `failed`: the attempt stays counted until signInCompleted,
  // which refunds the address only if the completion comes from this same address (G2).
  const setCookies = result.headers.getSetCookie();
  const body: unknown = result.response;
  const signedInUserId = await userIdByEmail(rt.sql, email);
  if (signedInUserId !== null) await notePendingSignIn(rt.sql, signedInUserId, throttleBucket(req.ip));
  if (typeof body === "object" && body !== null && "twoFactorRedirect" in body && body.twoFactorRedirect === true) {
    const userId = signedInUserId;
    await recordEvent(rt.sql, { action: "admin_auth.password_verified", entityType: "admin_user", entityId: userId, facts: { next: "second_factor" } });
    return { outcome: { kind: "second_factor" }, setCookies };
  }
  // No TOTP enrolled yet: Better Auth created a password-only session, which may only enroll.
  const token = sessionTokenFromSetCookie(setCookies);
  if (token === null) throw new Error("sign-in returned no session cookie");
  await startSession(rt.sql, token, null, { step: "password" });
  return { outcome: { kind: "enroll" }, setCookies };
}

type SecondFactorStep = "totp" | "recovery_code";

async function secondFactor(
  rt: AuthRuntime,
  step: SecondFactorStep,
  code: string,
  req: RequestInfo,
): Promise<WithCookies<SecondFactorOutcome>> {
  const headers = authHeaders(req.headers, [TWO_FACTOR_COOKIE]);
  const userId = userIdOf(await rt.auth.api.adminPendingSecondFactor({ headers }));
  if (userId === null) return { outcome: { kind: "expired" }, setCookies: [] };
  const userKey = throttleKey("second_factor", userId);
  const gate = await beginAttempt(rt.sql, [userKey, ipKey(req)], [userKey]);
  if (!gate.allowed) return { outcome: refused(gate), setCookies: [] };
  const fail = async (reason: string, expired = false): Promise<WithCookies<SecondFactorOutcome>> => {
    const result = await gate.attempt.failed();
    await recordEvent(rt.sql, { action: "admin_auth.sign_in_failed", entityType: "admin_user", entityId: userId, facts: { step, reason } });
    if (await reportHardLock(rt.sql, userId, result, step)) return { outcome: locked(LOCK_SECONDS, true), setCookies: [] };
    if (result.locked.length > 0) {
      await recordEvent(rt.sql, { action: "admin_auth.locked_out", entityType: "admin_user", entityId: userId, facts: { step } });
      return { outcome: locked(LOCK_SECONDS), setCookies: [] };
    }
    return { outcome: expired ? { kind: "expired" } : { kind: "invalid" }, setCookies: [] };
  };
  if (step === "totp") {
    if (!TOTP_CODE.test(code)) return fail("malformed");
    if (!(await claimTotpCode(rt.sql, userId, code))) return fail("replayed");
  }
  let result;
  try {
    result =
      step === "totp"
        ? await rt.auth.api.verifyTOTP({ body: { code, trustDevice: false }, headers, returnHeaders: true })
        : await rt.auth.api.adminVerifyRecoveryCode({ body: { code }, headers, returnHeaders: true });
  } catch (error) {
    if (!isAPIError(error)) {
      await gate.attempt.abandoned();
      throw error;
    }
    const { status, code: errorCode } = apiErrorCode(error);
    if (status === 429) {
      const outcome = await fail("account_locked");
      return outcome.outcome.kind === "locked" ? outcome : { outcome: locked(LOCK_SECONDS), setCookies: [] };
    }
    const expired = errorCode === "INVALID_TWO_FACTOR_COOKIE" || errorCode === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE";
    return fail(expired ? "challenge_expired" : "invalid_code", expired);
  }
  await gate.attempt.succeeded([userKey]);
  const setCookies = result.headers.getSetCookie();
  const token = sessionTokenFromSetCookie(setCookies);
  if (token === null) throw new Error("second factor returned no session cookie");
  await startSession(rt.sql, token, step, { step });
  await signInCompleted(rt.sql, userId, req);
  return { outcome: { kind: "signed_in" }, setCookies };
}

/** Step 2 at sign-in: the authenticator code. */
export function verifyTotpSignIn(rt: AuthRuntime, input: { code: string }, req: RequestInfo): Promise<WithCookies<SecondFactorOutcome>> {
  return secondFactor(rt, "totp", input.code.trim(), req);
}

/** Step 2 at sign-in, instead of the authenticator: a recovery code (single use). */
export function verifyRecoveryCodeSignIn(rt: AuthRuntime, input: { code: string }, req: RequestInfo): Promise<WithCookies<SecondFactorOutcome>> {
  return secondFactor(rt, "recovery_code", input.code, req);
}

export interface SignedInAdmin {
  readonly userId: string;
}

/**
 * A check of the signed-in user's own TOTP code (enrollment, re-generating codes), throttled per
 * user with the consecutive count. `before` runs once the gate is open, before Better Auth is
 * called (the `*_requested` audit row).
 */
async function checkOwnTotp(
  rt: AuthRuntime,
  admin: SignedInAdmin,
  code: string,
  req: RequestInfo,
  action: string,
  before: () => Promise<void> = () => Promise.resolve(),
): Promise<{ ok: true; setCookies: readonly string[]; finish: () => Promise<void> } | { ok: false; outcome: { kind: "invalid" } | Locked }> {
  const userKey = throttleKey("second_factor", admin.userId);
  const gate = await beginAttempt(rt.sql, [userKey, ipKey(req)], [userKey]);
  if (!gate.allowed) return { ok: false, outcome: refused(gate) };
  const fail = async (reason: string) => {
    const result = await gate.attempt.failed();
    await recordEvent(rt.sql, { action: `${action}_failed`, entityType: "admin_user", entityId: admin.userId, facts: { reason }, actor: { kind: "admin", userId: admin.userId } });
    if (await reportHardLock(rt.sql, admin.userId, result, action)) return { ok: false as const, outcome: locked(LOCK_SECONDS, true) };
    return { ok: false as const, outcome: result.locked.length > 0 ? locked(LOCK_SECONDS) : { kind: "invalid" as const } };
  };
  if (!TOTP_CODE.test(code)) return fail("malformed");
  if (!(await claimTotpCode(rt.sql, admin.userId, code))) return fail("replayed");
  await before();
  try {
    const result = await rt.auth.api.verifyTOTP({
      body: { code, trustDevice: false },
      headers: authHeaders(req.headers, [SESSION_COOKIE]),
      returnHeaders: true,
    });
    return { ok: true, setCookies: result.headers.getSetCookie(), finish: () => gate.attempt.succeeded([userKey]) };
  } catch (error) {
    if (!isAPIError(error)) {
      await gate.attempt.abandoned();
      throw error;
    }
    return fail("invalid_code");
  }
}

/**
 * Enrollment step 1 (a signed-in user without TOTP): the current (temporary) password and a new
 * one (security review US-016 SL3: a temporary password set by the Owner or the CLI never stays in
 * use). Creates the TOTP secret, sets the new password and 10 fresh recovery codes. The codes only
 * work once TOTP is verified (step 2): before that the user is never asked for a second factor.
 */
export async function startEnrollment(
  rt: AuthRuntime,
  admin: SignedInAdmin,
  input: { password: string; newPassword: string },
  req: RequestInfo,
): Promise<EnrollStartOutcome> {
  if (input.newPassword.length < PASSWORD_MIN || input.newPassword.length > PASSWORD_MAX || input.newPassword === input.password) {
    return { kind: "invalid_new_password" };
  }
  // US-031: not a common password, no context word (the product's, the domain's, this account's e-mail); the breach
  // check runs in the worker once the password is set (password-check.ts).
  const [me] = await rt.sql<{ email: string }[]>`SELECT email FROM admin_auth."user" WHERE id = ${admin.userId}`;
  if (passwordProblem(input.newPassword, { email: me?.email, origin: configuredOrigin() }) !== null) return { kind: "invalid_new_password" };
  const userKey = throttleKey("second_factor", admin.userId);
  const gate = await beginAttempt(rt.sql, [userKey, ipKey(req)], [userKey]);
  if (!gate.allowed) return refused(gate);
  const actor = { kind: "admin", userId: admin.userId } as const;
  await recordEvent(rt.sql, { action: "admin_auth.totp_secret_requested", entityType: "admin_user", entityId: admin.userId, actor });
  let totpURI: string;
  try {
    const result: unknown = await rt.auth.api.enableTwoFactor({
      body: { password: input.password, issuer: TOTP_ISSUER },
      headers: authHeaders(req.headers, [SESSION_COOKIE]),
    });
    if (typeof result !== "object" || result === null || !("totpURI" in result) || typeof result.totpURI !== "string") {
      throw new Error("enableTwoFactor returned no TOTP URI");
    }
    totpURI = result.totpURI;
  } catch (error) {
    if (!isAPIError(error)) {
      await gate.attempt.abandoned();
      throw error;
    }
    const failure = await gate.attempt.failed();
    await recordEvent(rt.sql, {
      action: "admin_auth.totp_enrollment_failed",
      entityType: "admin_user",
      entityId: admin.userId,
      facts: { reason: apiErrorCode(error).code.toLowerCase() || "rejected" },
      actor,
    });
    if (await reportHardLock(rt.sql, admin.userId, failure, "enrollment")) return locked(LOCK_SECONDS, true);
    return failure.locked.length > 0 ? locked(LOCK_SECONDS) : { kind: "invalid" };
  }
  const secret = new URL(totpURI).searchParams.get("secret");
  if (secret === null) throw new Error("TOTP URI without a secret");
  const [codes, passwordHash] = await Promise.all([prepareRecoveryCodes(), hashSecret(input.newPassword)]);
  await withAudit(rt.sql, async (tx, audit) => {
    await storeRecoveryCodes(tx, admin.userId, codes.rows);
    await tx`
      UPDATE admin_auth.account SET password = ${passwordHash}, "updatedAt" = clock_timestamp()
       WHERE "userId" = ${admin.userId} AND "providerId" = 'credential'`;
    await enqueuePasswordCheck(tx, rt.settings.sealer, admin.userId, input.newPassword);
    audit({
      action: "admin_auth.totp_enrollment_started",
      entityType: "admin_user",
      entityId: admin.userId,
      fields: { password: "secret" },
      after: { password: "set" },
      facts: { recovery_codes: codes.rows.length },
      actor,
    });
  });
  // Kept counted on the user's key (security review US-016 G1): step 1 repeated without finishing
  // enrollment is capped at 5 per 15 minutes; completeEnrollment's successful TOTP check clears it.
  // The address count is refunded: the cap is per user, and a successful step must not use up the
  // address budget that real failures need (one office, several admins enrolling).
  await refund(rt.sql, [ipKey(req)]);
  return { kind: "verify", secret, uri: totpURI, qrSvgDataUrl: totpQrDataUrl(totpURI), recoveryCodes: codes.shown };
}

/**
 * Enrollment step 2: the first authenticator code. Better Auth turns TOTP on and replaces the
 * session; the new one is marked as second-factor verified, the enrollment deadline is cleared and
 * every OTHER session of the user is revoked (a password-only session elsewhere must not outlive
 * enrollment).
 */
export async function completeEnrollment(rt: AuthRuntime, admin: SignedInAdmin, input: { code: string }, req: RequestInfo): Promise<WithCookies<CodeOutcome<{ readonly kind: "enrolled" }>>> {
  const actor = { kind: "admin", userId: admin.userId } as const;
  const check = await checkOwnTotp(rt, admin, input.code.trim(), req, "admin_auth.totp_enrollment", () =>
    recordEvent(rt.sql, { action: "admin_auth.totp_enrollment_requested", entityType: "admin_user", entityId: admin.userId, actor }),
  );
  if (!check.ok) return { outcome: check.outcome, setCookies: [] };
  const token = sessionTokenFromSetCookie(check.setCookies);
  if (token === null) throw new Error("enrollment returned no new session");
  await withAudit(rt.sql, async (tx, audit) => {
    const [session] = await tx<{ id: string }[]>`SELECT id FROM admin_auth.session WHERE token = ${token} AND "userId" = ${admin.userId}`;
    if (session === undefined) throw new Error("the enrolled session was not found");
    await tx`
      INSERT INTO admin_auth.session_state (session_id, last_seen_at, mfa_method, mfa_verified_at)
      VALUES (${session.id}, clock_timestamp(), 'totp', clock_timestamp())`;
    await tx`UPDATE public.admin_profiles SET enroll_by = NULL, updated_at = clock_timestamp() WHERE auth_user_id = ${admin.userId}`;
    const revoked = await tx`DELETE FROM admin_auth.session WHERE "userId" = ${admin.userId} AND id <> ${session.id}`;
    audit({
      action: "admin_auth.totp_enrolled",
      entityType: "admin_user",
      entityId: admin.userId,
      fields: { two_factor_enabled: "value" },
      before: { two_factor_enabled: false },
      after: { two_factor_enabled: true },
      facts: { other_sessions_revoked: revoked.count },
      actor,
    });
  });
  await check.finish();
  await signInCompleted(rt.sql, admin.userId, req);
  return { outcome: { kind: "enrolled" }, setCookies: check.setCookies };
}

/** New recovery codes (the old ones stop working), after the user's current authenticator code. */
export async function regenerateRecoveryCodes(rt: AuthRuntime, admin: SignedInAdmin, input: { code: string }, req: RequestInfo): Promise<CodeOutcome<{ readonly kind: "codes"; readonly recoveryCodes: readonly string[] }>> {
  const check = await checkOwnTotp(rt, admin, input.code.trim(), req, "admin_auth.recovery_codes_regenerate");
  if (!check.ok) return check.outcome;
  const codes = await prepareRecoveryCodes();
  await withAudit(rt.sql, async (tx, audit) => {
    const replaced = await storeRecoveryCodes(tx, admin.userId, codes.rows);
    audit({
      action: "admin_auth.recovery_codes_regenerated",
      entityType: "admin_user",
      entityId: admin.userId,
      facts: { recovery_codes: codes.rows.length, replaced },
      actor: { kind: "admin", userId: admin.userId },
    });
  });
  await check.finish();
  return { kind: "codes", recoveryCodes: codes.shown };
}

export type PasswordChangeOutcome = { readonly kind: "changed" } | { readonly kind: "invalid" } | { readonly kind: "invalid_new_password" } | Locked;

/**
 * US-031 (ASVS V6.2.12): the forced change of a password the worker found in a known breach (session status
 * "password_change", lib/access.ts). The current password and a new one: the new one passes the same rules as everywhere
 * (and is checked against breaches in its turn), every OTHER session of the account is signed out, and the flag is
 * cleared with the new check (password-check.ts). Wrong current passwords count on the account's second-factor key, like
 * enrolment, so this page is no password oracle.
 */
export async function changeBreachedPassword(
  rt: AuthRuntime,
  admin: SignedInAdmin & { readonly sessionId: string },
  input: { password: string; newPassword: string },
  req: RequestInfo,
): Promise<PasswordChangeOutcome> {
  if (input.newPassword.length < PASSWORD_MIN || input.newPassword.length > PASSWORD_MAX || input.newPassword === input.password) {
    return { kind: "invalid_new_password" };
  }
  const [me] = await rt.sql<{ email: string; hash: string | null }[]>`
    SELECT u.email, a.password AS hash
      FROM admin_auth."user" u
      LEFT JOIN admin_auth.account a ON a."userId" = u.id AND a."providerId" = 'credential'
     WHERE u.id = ${admin.userId}`;
  if (passwordProblem(input.newPassword, { email: me?.email, origin: configuredOrigin() }) !== null) return { kind: "invalid_new_password" };
  const userKey = throttleKey("second_factor", admin.userId);
  const gate = await beginAttempt(rt.sql, [userKey, ipKey(req)], [userKey]);
  if (!gate.allowed) return refused(gate);
  const actor = { kind: "admin", userId: admin.userId } as const;
  if (typeof me?.hash !== "string" || !(await verifySecret(me.hash, input.password))) {
    const failure = await gate.attempt.failed();
    await recordEvent(rt.sql, { action: "admin_auth.password_change_failed", entityType: "admin_user", entityId: admin.userId, facts: { reason: "wrong_password" }, actor });
    if (await reportHardLock(rt.sql, admin.userId, failure, "password_change")) return locked(LOCK_SECONDS, true);
    return failure.locked.length > 0 ? locked(LOCK_SECONDS) : { kind: "invalid" };
  }
  const passwordHash = await hashSecret(input.newPassword);
  await withAudit(rt.sql, async (tx, audit) => {
    await tx`
      UPDATE admin_auth.account SET password = ${passwordHash}, "updatedAt" = clock_timestamp()
       WHERE "userId" = ${admin.userId} AND "providerId" = 'credential'`;
    const others = await tx`DELETE FROM admin_auth.session WHERE "userId" = ${admin.userId} AND id <> ${admin.sessionId}`;
    await enqueuePasswordCheck(tx, rt.settings.sealer, admin.userId, input.newPassword);
    audit({
      action: "admin_auth.breached_password_changed",
      entityType: "admin_user",
      entityId: admin.userId,
      fields: { password: "secret" },
      after: { password: "set" },
      facts: { other_sessions_revoked: others.count },
      actor,
    });
  });
  await gate.attempt.succeeded([userKey]);
  return { kind: "changed" };
}

/** Ends the current session (audited before Better Auth deletes it, and after). */
export async function signOut(rt: AuthRuntime, admin: SignedInAdmin, req: RequestInfo): Promise<readonly string[]> {
  const actor = { kind: "admin", userId: admin.userId } as const;
  await recordEvent(rt.sql, { action: "admin_auth.sign_out_requested", entityType: "admin_user", entityId: admin.userId, actor });
  const result = await rt.auth.api.signOut({ headers: authHeaders(req.headers, [SESSION_COOKIE]), returnHeaders: true });
  await recordEvent(rt.sql, { action: "admin_auth.sign_out", entityType: "admin_user", entityId: admin.userId, actor });
  return result.headers.getSetCookie();
}
