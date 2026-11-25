// Sign-in, forced TOTP enrollment (with a new password), TOTP and recovery-code sign-in, cookies,
// session rules, enrollment deadline, secret rotation, through the real Better Auth instance on the
// migrated database, connected as the admin_rw login.
import { describe, expect, it } from "vitest";
import { resetAdminUser, setAdminDisabled } from "../src/lib/admin-users.ts";
import { ADMIN_COOKIE_NAMES, SESSION_COOKIE, TWO_FACTOR_COOKIE } from "../src/lib/auth/instance.ts";
import { prepareRecoveryCodes, storeRecoveryCodes } from "../src/lib/auth/recovery-codes.ts";
import {
  completeEnrollment,
  regenerateRecoveryCodes,
  signInWithPassword,
  signOut,
  startEnrollment,
  verifyRecoveryCodeSignIn,
  verifyTotpSignIn,
} from "../src/lib/auth/service.ts";
import { loadAdminSession } from "../src/lib/auth/session.ts";
import { withAudit } from "../src/lib/audit.ts";
import {
  asAdmin,
  auditRows,
  codeFor,
  CookieJar,
  createTestAdmin,
  enroll,
  freshIp,
  newRuntime,
  password,
  passwordStep,
  root,
  SECRET_V1,
  system,
  TEST_CONFIG,
  wrongTotp,
} from "./support.ts";

const rt = newRuntime();

describe("first sign-in of an account without TOTP", () => {
  it("creates a password-only session that may only enroll, with __Host- SameSite=Strict cookies", async () => {
    const admin = await createTestAdmin(rt);
    const jar = new CookieJar();
    const ip = freshIp();
    const res = await system(() => signInWithPassword(rt, { email: admin.email, password: admin.password }, jar.request(ip)), ip);
    expect(res.outcome).toEqual({ kind: "enroll" });
    const cookie = res.setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toBeDefined();
    const attrs = (cookie ?? "").split(";").map((a) => a.trim().toLowerCase());
    expect(attrs).toEqual(expect.arrayContaining(["path=/", "httponly", "secure", "samesite=strict"]));
    expect(attrs.some((a) => a.startsWith("domain="))).toBe(false);
    expect(attrs).toContain(`max-age=${String(12 * 3600)}`);
    jar.apply(res.setCookies);
    const session = await loadAdminSession(rt, jar.request(ip).headers);
    expect(session).toMatchObject({ status: "unenrolled", admin: { userId: admin.userId, role: "staff" } });
  });

  it("enrolls: current + new password, secret + QR + 10 hashed recovery codes, first code; other sessions are revoked", async () => {
    const admin = await createTestAdmin(rt);
    const ip = freshIp();
    const jar = new CookieJar();
    const other = new CookieJar();
    for (const j of [jar, other]) {
      const res = await system(() => signInWithPassword(rt, { email: admin.email, password: admin.password }, j.request(ip)), ip);
      j.apply(res.setCookies);
    }
    const newPassword = password();
    const wrong = await system(() => startEnrollment(rt, { userId: admin.userId }, { password: "not-the-password-1", newPassword }, jar.request(ip)), ip);
    expect(wrong).toEqual({ kind: "invalid" });
    const same = await system(() => startEnrollment(rt, { userId: admin.userId }, { password: admin.password, newPassword: admin.password }, jar.request(ip)), ip);
    expect(same).toEqual({ kind: "invalid_new_password" });
    const short = await system(() => startEnrollment(rt, { userId: admin.userId }, { password: admin.password, newPassword: "short" }, jar.request(ip)), ip);
    expect(short).toEqual({ kind: "invalid_new_password" });
    const started = await system(() => startEnrollment(rt, { userId: admin.userId }, { password: admin.password, newPassword }, jar.request(ip)), ip);
    if (started.kind !== "verify") throw new Error(started.kind);
    expect(started.secret).toMatch(/^[A-Z2-7]+$/);
    expect(started.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(started.qrSvgDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(started.qrSvgDataUrl.split(",")[1] ?? "", "base64").toString()).toMatch(/^<svg [^>]*><rect [^>]*\/><path [^>]*\/><\/svg>$/);
    expect(started.recoveryCodes).toHaveLength(10);
    const stored = await root<{ selector: string; code_hash: string; used_at: Date | null }[]>`
      SELECT selector, code_hash, used_at FROM admin_auth.recovery_code WHERE user_id = ${admin.userId}`;
    expect(stored).toHaveLength(10);
    for (const row of stored) {
      expect(row.code_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(row.used_at).toBeNull();
    }
    const plain = started.recoveryCodes.map((c) => c.replace(/-/g, ""));
    for (const row of stored) for (const code of plain) expect(row.code_hash).not.toContain(code);

    // The temporary password is gone already; the new one works.
    expect((await system(() => signInWithPassword(rt, { email: admin.email, password: admin.password }, new CookieJar().request(freshIp())))).outcome.kind).toBe("invalid");
    // Still not enrolled until the first code: the console stays closed.
    expect((await loadAdminSession(rt, jar.request(ip).headers)).status).toBe("unenrolled");
    const bad = await system(() => completeEnrollment(rt, { userId: admin.userId }, { code: wrongTotp(started.secret) }, jar.request(ip)), ip);
    expect(bad.outcome).toEqual({ kind: "invalid" });
    const done = await system(async () => completeEnrollment(rt, { userId: admin.userId }, { code: await codeFor(admin.userId, started.secret) }, jar.request(ip)), ip);
    expect(done.outcome).toEqual({ kind: "enrolled" });
    const before = jar.cookies.get(SESSION_COOKIE);
    jar.apply(done.setCookies);
    expect(jar.cookies.get(SESSION_COOKIE)).not.toBe(before);

    expect(await loadAdminSession(rt, jar.request(ip).headers)).toMatchObject({ status: "active", admin: { userId: admin.userId } });
    // The other password-only session did not survive enrollment.
    expect(await loadAdminSession(rt, other.request(ip).headers)).toEqual({ status: "anonymous" });
    const actions = (await auditRows(admin.userId)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["admin_auth.totp_secret_requested", "admin_auth.totp_enrollment_started", "admin_auth.totp_enrollment_requested", "admin_auth.totp_enrolled"]));
    expect(actions.indexOf("admin_auth.totp_secret_requested")).toBeLessThan(actions.indexOf("admin_auth.totp_enrollment_started"));
    expect(actions.indexOf("admin_auth.totp_enrollment_requested")).toBeLessThan(actions.indexOf("admin_auth.totp_enrolled"));
    const [enrolled] = await auditRows(admin.userId, "admin_auth.totp_enrolled");
    expect(enrolled).toMatchObject({ actor_kind: "admin", actor_admin_user_id: admin.userId, changes: { two_factor_enabled: { before: false, after: true }, other_sessions_revoked: 1 } });
    const [profile] = await root<{ enroll_by: Date | null }[]>`SELECT enroll_by FROM admin_profiles WHERE auth_user_id = ${admin.userId}`;
    expect(profile?.enroll_by).toBeNull();
  });

  it("stores exactly 10 recovery codes when enrollment starts twice at once", async () => {
    const admin = await createTestAdmin(rt);
    const batches = await Promise.all([prepareRecoveryCodes(), prepareRecoveryCodes(), prepareRecoveryCodes()]);
    await Promise.all(
      batches.map((batch) =>
        system(() =>
          withAudit(rt.sql, async (tx, audit) => {
            await storeRecoveryCodes(tx, admin.userId, batch.rows);
            audit({ action: "test.store_codes", entityType: "admin_user", entityId: admin.userId });
          }),
        ),
      ),
    );
    const [count] = await root<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_auth.recovery_code WHERE user_id = ${admin.userId}`;
    expect(count?.n).toBe(10);
  });
});

describe("enrollment deadline (72 h for a temporary password)", () => {
  it("is set when the account is created; after it the account cannot sign in, and an unfinished session ends", async () => {
    const admin = await createTestAdmin(rt);
    const [profile] = await root<{ hours: number }[]>`SELECT round(extract(epoch FROM enroll_by - now()) / 3600)::int AS hours FROM admin_profiles WHERE auth_user_id = ${admin.userId}`;
    expect(profile?.hours).toBe(72);
    const ip = freshIp();
    const jar = new CookieJar();
    jar.apply((await system(() => signInWithPassword(rt, { email: admin.email, password: admin.password }, jar.request(ip)), ip)).setCookies);
    expect((await loadAdminSession(rt, jar.request(ip).headers)).status).toBe("unenrolled");
    await root`UPDATE admin_profiles SET enroll_by = now() - interval '1 second' WHERE auth_user_id = ${admin.userId}`;
    expect(await loadAdminSession(rt, jar.request(ip).headers)).toEqual({ status: "anonymous" });
    const late = await system(() => signInWithPassword(rt, { email: admin.email, password: admin.password }, new CookieJar().request(freshIp())));
    expect(late.outcome.kind).toBe("invalid");
  });

  it("an Owner reset gives a new temporary password and 72 h again, and turns TOTP off", async () => {
    const owner = await createTestAdmin(rt, "owner");
    const staff = await enroll(rt);
    const temporary = password();
    expect(await asAdmin(owner.userId, () => resetAdminUser(rt, owner.userId, owner.userId, temporary))).toEqual({ kind: "self" });
    expect(await asAdmin(owner.userId, () => resetAdminUser(rt, owner.userId, staff.userId, "short"))).toEqual({ kind: "invalid_password" });
    expect(await asAdmin(owner.userId, () => resetAdminUser(rt, owner.userId, staff.userId, temporary))).toEqual({ kind: "reset" });
    expect(await loadAdminSession(rt, staff.jar.request(freshIp()).headers)).toEqual({ status: "anonymous" });
    expect((await system(() => signInWithPassword(rt, { email: staff.email, password: staff.password }, new CookieJar().request(freshIp())))).outcome.kind).toBe("invalid");
    const again = await enroll(rt, "staff", { ...staff, password: temporary });
    expect(again.secret).not.toBe(staff.secret);
    const [audit] = await auditRows(staff.userId, "admin_user.reset_access");
    expect(audit).toMatchObject({ actor_kind: "admin", actor_admin_user_id: owner.userId, changes: { two_factor_enabled: { before: true, after: false }, password: { set: true }, sessions_revoked: 1 } });
  });
});

describe("Owner reset from the console (code review US-016 F4)", () => {
  it("refuses another Owner (Owner recovery is CLI-only), audited, and changes nothing", async () => {
    const owner = await createTestAdmin(rt, "owner");
    const other = await enroll(rt, "owner");
    const result = await asAdmin(owner.userId, () => resetAdminUser(rt, owner.userId, other.userId, password()));
    expect(result).toEqual({ kind: "owner" });
    expect(await loadAdminSession(rt, other.jar.request(freshIp()).headers)).toMatchObject({ status: "active" });
    const [totp] = await root<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_auth."twoFactor" WHERE "userId" = ${other.userId}`;
    expect(totp?.n).toBe(1);
    const [refusal] = await auditRows(other.userId, "admin_user.reset_refused");
    expect(refusal).toMatchObject({ actor_kind: "admin", actor_admin_user_id: owner.userId, changes: { reason: "owner_target" } });
    expect(await auditRows(other.userId, "admin_user.reset_access")).toHaveLength(0);
  });
});

describe("sign-in of an enrolled account", () => {
  it("asks for the second factor: no session cookie, only the __Host-admin_2fa challenge; the password step is audited", async () => {
    const admin = await enroll(rt);
    const ip = freshIp();
    const jar = new CookieJar();
    const res = await system(() => signInWithPassword(rt, { email: admin.email, password: admin.password }, jar.request(ip)), ip);
    expect(res.outcome).toEqual({ kind: "second_factor" });
    jar.apply(res.setCookies);
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    expect(jar.has(TWO_FACTOR_COOKIE)).toBe(true);
    const challenge = res.setCookies.find((c) => c.startsWith(`${TWO_FACTOR_COOKIE}=`)) ?? "";
    expect(challenge.toLowerCase()).toContain("samesite=strict");
    expect(challenge.toLowerCase()).toContain("secure");
    expect(await loadAdminSession(rt, jar.request(ip).headers)).toEqual({ status: "anonymous" });
    const [verified] = await auditRows(admin.userId, "admin_auth.password_verified");
    expect(verified).toMatchObject({ actor_kind: "system", changes: { next: "second_factor" }, ip });
  });

  it("signs in with the authenticator code and never sets a trusted-device cookie", async () => {
    const admin = await enroll(rt);
    const ip = freshIp();
    const jar = await passwordStep(rt, admin, ip);
    const res = await system(async () => verifyTotpSignIn(rt, { code: await codeFor(admin.userId, admin.secret) }, jar.request(ip)), ip);
    expect(res.outcome).toEqual({ kind: "signed_in" });
    jar.apply(res.setCookies);
    expect(jar.has(TWO_FACTOR_COOKIE)).toBe(false);
    expect(await loadAdminSession(rt, jar.request(ip).headers)).toMatchObject({ status: "active", admin: { userId: admin.userId } });
    const allCookies = [...jar.seen, ...admin.jar.seen].join("\n");
    expect(allCookies).not.toContain(ADMIN_COOKIE_NAMES.trust_device);
    const [state] = await root<{ mfa_method: string }[]>`
      SELECT st.mfa_method FROM admin_auth.session_state st JOIN admin_auth.session s ON s.id = st.session_id
       WHERE s."userId" = ${admin.userId} ORDER BY st.mfa_verified_at DESC LIMIT 1`;
    expect(state?.mfa_method).toBe("totp");
  });

  it("refuses a TOTP code that was already used (replay), even on a new challenge", async () => {
    const admin = await enroll(rt);
    const ip = freshIp();
    const code = await codeFor(admin.userId, admin.secret);
    const first = await passwordStep(rt, admin, ip);
    expect((await system(() => verifyTotpSignIn(rt, { code }, first.request(ip)), ip)).outcome).toEqual({ kind: "signed_in" });
    const second = await passwordStep(rt, admin, ip);
    expect((await system(() => verifyTotpSignIn(rt, { code }, second.request(ip)), ip)).outcome).toEqual({ kind: "invalid" });
    const [failed] = await auditRows(admin.userId, "admin_auth.sign_in_failed");
    expect(failed?.changes).toMatchObject({ step: "totp", reason: "replayed" });
  });

  it("refuses a wrong code and a challenge cookie that is missing", async () => {
    const admin = await enroll(rt);
    const ip = freshIp();
    const jar = await passwordStep(rt, admin, ip);
    expect((await system(() => verifyTotpSignIn(rt, { code: wrongTotp(admin.secret) }, jar.request(ip)), ip)).outcome).toEqual({ kind: "invalid" });
    expect((await system(() => verifyTotpSignIn(rt, { code: "12a456" }, jar.request(ip)), ip)).outcome).toEqual({ kind: "invalid" });
    const nobody = new CookieJar();
    expect((await system(async () => verifyTotpSignIn(rt, { code: await codeFor(admin.userId, admin.secret) }, nobody.request(ip)), ip)).outcome).toEqual({ kind: "expired" });
  });
});

describe("secret rotation (versioned ADMIN_AUTH_SECRETS)", () => {
  it("a TOTP secret enrolled under v1 still verifies after v2 is added in front; dropping v1 breaks it", async () => {
    const admin = await enroll(rt);
    const v2 = { version: 2, value: `${"r".repeat(16)}${SECRET_V1.value.slice(16)}` };
    const rotated = newRuntime({ ...TEST_CONFIG, authSecrets: [v2, SECRET_V1] });
    // The old session cookie was signed with v1: rotation signs everyone out.
    expect(await loadAdminSession(rotated, admin.jar.request(freshIp()).headers)).toEqual({ status: "anonymous" });
    const ip = freshIp();
    const jar = await passwordStep(rotated, admin, ip);
    const res = await system(async () => verifyTotpSignIn(rotated, { code: await codeFor(admin.userId, admin.secret) }, jar.request(ip)), ip);
    expect(res.outcome).toEqual({ kind: "signed_in" });

    const v2Only = newRuntime({ ...TEST_CONFIG, authSecrets: [v2] });
    const lost = await passwordStep(v2Only, admin, ip);
    // Without v1 the stored TOTP secret cannot be decrypted: the request fails (500 via the action wrapper).
    await expect(system(async () => verifyTotpSignIn(v2Only, { code: await codeFor(admin.userId, admin.secret) }, lost.request(ip)), ip)).rejects.toThrow(/Secret version 1 not found/);
  });
});

describe("recovery codes", () => {
  it("sign in once per code; a used code is refused; every use is audited", async () => {
    const admin = await enroll(rt);
    const ip = freshIp();
    const [code, other] = admin.recoveryCodes;
    if (code === undefined || other === undefined) throw new Error("codes");
    const jar = await passwordStep(rt, admin, ip);
    const res = await system(() => verifyRecoveryCodeSignIn(rt, { code: code.toLowerCase() }, jar.request(ip)), ip);
    expect(res.outcome).toEqual({ kind: "signed_in" });
    jar.apply(res.setCookies);
    expect(await loadAdminSession(rt, jar.request(ip).headers)).toMatchObject({ status: "active" });

    const again = await passwordStep(rt, admin, ip);
    expect((await system(() => verifyRecoveryCodeSignIn(rt, { code }, again.request(ip)), ip)).outcome).toEqual({ kind: "invalid" });
    expect((await system(() => verifyRecoveryCodeSignIn(rt, { code: "ABCD-EFGH-JKMN-PQRS" }, again.request(ip)), ip)).outcome).toEqual({ kind: "invalid" });
    expect((await system(() => verifyRecoveryCodeSignIn(rt, { code: other }, again.request(ip)), ip)).outcome).toEqual({ kind: "signed_in" });

    const used = await root<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_auth.recovery_code WHERE user_id = ${admin.userId} AND used_at IS NOT NULL`;
    expect(used[0]?.n).toBe(2);
    const audits = await auditRows(admin.userId, "admin_auth.recovery_code_used");
    expect(audits.map((a) => a.changes)).toEqual([{ remaining: 9 }, { remaining: 8 }]);
    expect(audits.every((a) => a.actor_kind === "admin" && a.actor_admin_user_id === admin.userId && a.ip === ip)).toBe(true);
    const [state] = await root<{ mfa_method: string }[]>`
      SELECT st.mfa_method FROM admin_auth.session_state st JOIN admin_auth.session s ON s.id = st.session_id
       WHERE s."userId" = ${admin.userId} ORDER BY st.mfa_verified_at DESC LIMIT 1`;
    expect(state?.mfa_method).toBe("recovery_code");
  });

  it("marks the code used and writes its audit row in the same transaction", async () => {
    const admin = await enroll(rt);
    const ip = freshIp();
    const jar = await passwordStep(rt, admin, ip);
    const code = admin.recoveryCodes[3] ?? "";
    expect((await system(() => verifyRecoveryCodeSignIn(rt, { code }, jar.request(ip)), ip)).outcome).toEqual({ kind: "signed_in" });
    const [codeTx] = await root<{ xmin: string }[]>`SELECT xmin::text FROM admin_auth.recovery_code WHERE user_id = ${admin.userId} AND used_at IS NOT NULL`;
    const [auditTx] = await root<{ xmin: string }[]>`SELECT xmin::text FROM audit_log WHERE entity_id = ${admin.userId} AND action = 'admin_auth.recovery_code_used'`;
    expect(codeTx?.xmin).toBeDefined();
    expect(codeTx?.xmin).toBe(auditTx?.xmin);
  });

  it("keeps the code when the account may not sign in (disabled between the steps)", async () => {
    const owner = await createTestAdmin(rt, "owner");
    const admin = await enroll(rt);
    const ip = freshIp();
    const jar = await passwordStep(rt, admin, ip);
    await asAdmin(owner.userId, () => setAdminDisabled(rt.sql, owner.userId, admin.userId, true));
    const res = await system(() => verifyRecoveryCodeSignIn(rt, { code: admin.recoveryCodes[2] ?? "" }, jar.request(ip)), ip);
    expect(res.outcome.kind).not.toBe("signed_in");
    const [used] = await root<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_auth.recovery_code WHERE user_id = ${admin.userId} AND used_at IS NOT NULL`;
    expect(used?.n).toBe(0);
    expect(await root`SELECT 1 FROM admin_auth.session WHERE "userId" = ${admin.userId}`).toHaveLength(0);
  });

  it("allows one sign-in when the same code is submitted concurrently", async () => {
    const admin = await enroll(rt);
    const ip = freshIp();
    const code = admin.recoveryCodes[5] ?? "";
    const jars = await Promise.all([passwordStep(rt, admin, freshIp()), passwordStep(rt, admin, freshIp()), passwordStep(rt, admin, freshIp())]);
    const results = await Promise.all(jars.map((j) => system(() => verifyRecoveryCodeSignIn(rt, { code }, j.request(ip)), ip)));
    expect(results.filter((r) => r.outcome.kind === "signed_in")).toHaveLength(1);
  });

  it("can be regenerated with a current authenticator code; the old ones stop working", async () => {
    const admin = await enroll(rt);
    const ip = freshIp();
    const res = await system(async () => regenerateRecoveryCodes(rt, { userId: admin.userId }, { code: await codeFor(admin.userId, admin.secret) }, admin.jar.request(ip)), ip);
    if (res.kind !== "codes") throw new Error(res.kind);
    expect(res.recoveryCodes).toHaveLength(10);
    expect(res.recoveryCodes).not.toContain(admin.recoveryCodes[0]);
    const jar = await passwordStep(rt, admin, ip);
    expect((await system(() => verifyRecoveryCodeSignIn(rt, { code: admin.recoveryCodes[0] ?? "" }, jar.request(ip)), ip)).outcome).toEqual({ kind: "invalid" });
    expect((await system(() => verifyRecoveryCodeSignIn(rt, { code: res.recoveryCodes[0] ?? "" }, jar.request(ip)), ip)).outcome).toEqual({ kind: "signed_in" });
    const refused = await system(() => regenerateRecoveryCodes(rt, { userId: admin.userId }, { code: wrongTotp(admin.secret) }, admin.jar.request(ip)), ip);
    expect(refused).toEqual({ kind: "invalid" });
  });
});

describe("sessions", () => {
  it("has no idle limit: a session left unused for hours stays signed in, and its last use is recorded", async () => {
    const admin = await enroll(rt);
    const ip = freshIp();
    // Owner decision 2026-11-25: no idle limit; only the 12 h limit below ends a session.
    await root`UPDATE admin_auth.session_state SET last_seen_at = clock_timestamp() - interval '11 hours 59 minutes'
                WHERE session_id IN (SELECT id FROM admin_auth.session WHERE "userId" = ${admin.userId})`;
    expect((await loadAdminSession(rt, admin.jar.request(ip).headers)).status).toBe("active");
    const [state] = await root<{ idle_seconds: number }[]>`
      SELECT extract(epoch FROM clock_timestamp() - last_seen_at)::int AS idle_seconds FROM admin_auth.session_state
       WHERE session_id IN (SELECT id FROM admin_auth.session WHERE "userId" = ${admin.userId})`;
    expect(state?.idle_seconds).toBeLessThan(60);
  });

  it("expires 12 hours after sign-in, however active", async () => {
    const admin = await enroll(rt);
    const ip = freshIp();
    const [session] = await root<{ expires_in: number }[]>`
      SELECT extract(epoch FROM "expiresAt" - "createdAt")::int AS expires_in FROM admin_auth.session WHERE "userId" = ${admin.userId}`;
    expect(session?.expires_in).toBe(12 * 3600);
    await root`UPDATE admin_auth.session SET "createdAt" = clock_timestamp() - interval '12 hours 1 second' WHERE "userId" = ${admin.userId}`;
    expect(await loadAdminSession(rt, admin.jar.request(ip).headers)).toEqual({ status: "anonymous" });
  });

  it("is never refreshed by Better Auth (the 12 h limit is absolute)", async () => {
    const admin = await enroll(rt);
    const [before] = await root<{ expires_at: Date }[]>`SELECT "expiresAt" AS expires_at FROM admin_auth.session WHERE "userId" = ${admin.userId}`;
    for (let i = 0; i < 3; i++) await loadAdminSession(rt, admin.jar.request(freshIp()).headers);
    const [after] = await root<{ expires_at: Date }[]>`SELECT "expiresAt" AS expires_at FROM admin_auth.session WHERE "userId" = ${admin.userId}`;
    expect(after?.expires_at.getTime()).toBe(before?.expires_at.getTime());
  });

  it("refuses a session without session_state (not created by the console's sign-in flows)", async () => {
    const admin = await enroll(rt);
    await root`DELETE FROM admin_auth.session_state WHERE session_id IN (SELECT id FROM admin_auth.session WHERE "userId" = ${admin.userId})`;
    expect(await loadAdminSession(rt, admin.jar.request(freshIp()).headers)).toEqual({ status: "anonymous" });
  });

  it("refuses an enrolled user's session that did not pass the second factor", async () => {
    const admin = await enroll(rt);
    await root`UPDATE admin_auth.session_state SET mfa_method = NULL, mfa_verified_at = NULL
                WHERE session_id IN (SELECT id FROM admin_auth.session WHERE "userId" = ${admin.userId})`;
    expect(await loadAdminSession(rt, admin.jar.request(freshIp()).headers)).toEqual({ status: "anonymous" });
  });

  it("refuses a disabled admin: sessions are revoked and no new one is created", async () => {
    const owner = await enroll(rt, "owner");
    const staff = await enroll(rt);
    const ip = freshIp();
    const res = await asAdmin(owner.userId, () => setAdminDisabled(rt.sql, owner.userId, staff.userId, true), ip);
    expect(res).toEqual({ kind: "updated" });
    expect(await loadAdminSession(rt, staff.jar.request(ip).headers)).toEqual({ status: "anonymous" });
    const again = await system(() => signInWithPassword(rt, { email: staff.email, password: staff.password }, new CookieJar().request(freshIp())), ip);
    expect(again.outcome).toEqual({ kind: "invalid" });
    const sessions = await root`SELECT 1 FROM admin_auth.session WHERE "userId" = ${staff.userId}`;
    expect(sessions).toHaveLength(0);
  });

  it("refuses an auth user without an admin profile", async () => {
    const admin = await createTestAdmin(rt);
    await root`DELETE FROM admin_profiles WHERE auth_user_id = ${admin.userId}`;
    const ip = freshIp();
    const res = await system(() => signInWithPassword(rt, { email: admin.email, password: admin.password }, new CookieJar().request(ip)), ip);
    expect(res.outcome).toEqual({ kind: "invalid" });
  });

  it("signs out: audited before and after, the session row is gone and the cookie is cleared", async () => {
    const admin = await enroll(rt);
    const ip = freshIp();
    const cleared = await asAdmin(admin.userId, () => signOut(rt, { userId: admin.userId }, admin.jar.request(ip)), ip);
    const before = admin.jar.request(ip).headers;
    admin.jar.apply(cleared);
    expect(admin.jar.has(SESSION_COOKIE)).toBe(false);
    expect(await loadAdminSession(rt, before)).toEqual({ status: "anonymous" });
    const actions = (await auditRows(admin.userId)).map((r) => r.action).filter((a) => a.startsWith("admin_auth.sign_out"));
    expect(actions).toEqual(["admin_auth.sign_out_requested", "admin_auth.sign_out"]);
  });
});
