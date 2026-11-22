// US-031 (ASVS V6.2.12): the console's side of the breached-password check (the worker does the check: the console has no
// egress). Every place a password is set records one check, in the password's own transaction: a new
// admin_profiles.password_check_id, the flag cleared, and an admin.password_hibp_check outbox row whose payload holds the
// ids only and whose `sealed` is the SHA-1 sealed to the messaging key. A flagged admin (the worker's
// flag_breached_admin_password) may only change the password, which clears the flag and signs the other sessions out.
import { createHash } from "node:crypto";
import { createSecretOpener, createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { describe, expect, it } from "vitest";
import { recoverAdminUser, resetAdminUser } from "../src/lib/admin-users.ts";
import { runMutation } from "../src/lib/audit.ts";
import { PASSWORD_CHECK_TOPIC } from "../src/lib/auth/password-check.ts";
import { changeBreachedPassword, signInWithPassword, verifyTotpSignIn } from "../src/lib/auth/service.ts";
import { loadAdminSession } from "../src/lib/auth/session.ts";
import { NO_SETTINGS } from "../src/lib/settings/env.ts";
import { asAdmin, auditRows, codeFor, CookieJar, createTestAdmin, enroll, freshIp, newRuntime, password, passwordStep, root, system, TEST_CONFIG } from "./support.ts";

const keys = generateScopeKeyPair();
const rt = newRuntime(TEST_CONFIG, { ...NO_SETTINGS, sealer: createSecretSealer({ messaging: keys.publicKey }) });
const worker = createSecretOpener({ messaging: keys.privateKey });
const sha1Of = (pw: string): string => createHash("sha1").update(pw, "utf8").digest("hex").toUpperCase();

/** The admin's current check and its outbox job (read as the superuser: admin_rw can never read `sealed` back). */
async function currentCheck(userId: string) {
  const [profile] = await root<{ check_id: string | null; breached: boolean }[]>`
    SELECT password_check_id AS check_id, password_breached_at IS NOT NULL AS breached FROM admin_profiles WHERE auth_user_id = ${userId}`;
  const jobs = await root<{ dedupe_key: string; payload: Record<string, unknown>; sealed: Buffer | null; payload_text: string }[]>`
    SELECT dedupe_key, payload, sealed, payload::text AS payload_text FROM outbox
     WHERE topic = ${PASSWORD_CHECK_TOPIC} AND payload->>'admin_user_id' = ${userId} ORDER BY created_at`;
  return { profile, jobs };
}

/** The job of the admin's current password: ids only in the payload, the SHA-1 of `pw` sealed to the worker. */
async function expectCheckOf(userId: string, pw: string, jobsBefore: number): Promise<void> {
  const { profile, jobs } = await currentCheck(userId);
  expect(jobs).toHaveLength(jobsBefore + 1);
  const job = jobs.at(-1);
  expect(profile?.breached).toBe(false);
  expect(job?.payload).toEqual({ admin_user_id: userId, check_id: profile?.check_id });
  expect(job?.dedupe_key).toBe(`${PASSWORD_CHECK_TOPIC}:${String(profile?.check_id)}`);
  for (const secret of [pw, sha1Of(pw), sha1Of(pw).slice(5), sha1Of(pw).toLowerCase()]) expect(job?.payload_text).not.toContain(secret);
  expect(job?.sealed?.includes(Buffer.from(sha1Of(pw)))).toBe(false);
  expect(worker.openPasswordCheck({ checkId: String(profile?.check_id), adminUserId: userId, sealed: job?.sealed ?? Buffer.alloc(0) })).toBe(sha1Of(pw));
}

describe("the console records a breached-password check wherever a password is set (US-031, ASVS V6.2.12)", () => {
  it("a new account, a staff reset, the CLI's recover and the enrolment each write one job for the password they set", async () => {
    const owner = await enroll(rt, "owner");
    // createTestAdmin + enroll: the account's temporary password, then the enrolment's new one.
    await expectCheckOf(owner.userId, owner.password, 1);

    const staff = await createTestAdmin(rt, "staff");
    await expectCheckOf(staff.userId, staff.password, 0);
    const temporary = password();
    expect(await asAdmin(owner.userId, () => resetAdminUser(rt, owner.userId, staff.userId, temporary))).toEqual({ kind: "reset" });
    await expectCheckOf(staff.userId, temporary, 1);

    const recovered = password();
    expect(await runMutation({ actor: { kind: "cli" }, requestId: "test", ip: null }, () => recoverAdminUser(rt, owner.email, recovered))).toMatchObject({ kind: "recovered" });
    await expectCheckOf(owner.userId, recovered, 2);
  });

  it("writes no job without the messaging public key (fail open, a warning), and the account has no current check", async () => {
    const bare = newRuntime();
    const admin = await createTestAdmin(bare, "staff");
    const { profile, jobs } = await currentCheck(admin.userId);
    expect(jobs).toEqual([]);
    expect(profile).toEqual({ check_id: null, breached: false });
  });
});

describe("a flagged admin must change the password before anything else (Owner and Staff)", () => {
  for (const role of ["owner", "staff"] as const) {
    it(`${role}: the session may only change the password; the change clears the flag, records a new check and signs the other sessions out`, async () => {
      const admin = await enroll(rt, role);
      // A second session of the same account (another browser).
      const ip = freshIp();
      const other = await passwordStep(rt, admin, ip);
      const second = await system(async () => verifyTotpSignIn(rt, { code: await codeFor(admin.userId, admin.secret) }, other.request(ip)), ip);
      expect(second.outcome).toEqual({ kind: "signed_in" });
      other.apply(second.setCookies);
      // The worker found the current password in a breach (sql/functions.sql flag_breached_admin_password).
      const { profile } = await currentCheck(admin.userId);
      expect(await root`SELECT public.flag_breached_admin_password(${admin.userId}, ${String(profile?.check_id)}) AS flagged`).toEqual([{ flagged: true }]);
      const flagged = await loadAdminSession(rt, admin.jar.request(ip).headers);
      expect(flagged.status).toBe("password_change");
      expect((await loadAdminSession(rt, other.request(ip).headers)).status).toBe("password_change");
      if (flagged.status !== "password_change") throw new Error("unreachable");

      const req = admin.jar.request(ip);
      const me = { userId: admin.userId, sessionId: flagged.admin.sessionId };
      expect(await asAdmin(admin.userId, () => changeBreachedPassword(rt, me, { password: "not-the-password-1", newPassword: password() }, req), ip)).toEqual({ kind: "invalid" });
      expect(await asAdmin(admin.userId, () => changeBreachedPassword(rt, me, { password: admin.password, newPassword: "ebooktrivia2026" }, req), ip)).toEqual({ kind: "invalid_new_password" });
      expect(await asAdmin(admin.userId, () => changeBreachedPassword(rt, me, { password: admin.password, newPassword: admin.password }, req), ip)).toEqual({ kind: "invalid_new_password" });
      expect((await loadAdminSession(rt, admin.jar.request(ip).headers)).status).toBe("password_change");

      const fresh = password();
      expect(await asAdmin(admin.userId, () => changeBreachedPassword(rt, me, { password: admin.password, newPassword: fresh }, req), ip)).toEqual({ kind: "changed" });
      expect((await loadAdminSession(rt, admin.jar.request(ip).headers)).status).toBe("active");
      expect((await loadAdminSession(rt, other.request(ip).headers)).status).toBe("anonymous");
      await expectCheckOf(admin.userId, fresh, 2);
      const changed = await auditRows(admin.userId, "admin_auth.breached_password_changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]?.changes).toMatchObject({ password: { set: true } });
      expect(JSON.stringify(changed)).not.toContain(fresh);
      // The old password no longer signs in; the new one does (on to the second factor).
      const jar = new CookieJar();
      const oldIp = freshIp();
      expect((await system(() => signInWithPassword(rt, { email: admin.email, password: admin.password }, jar.request(oldIp)), oldIp)).outcome).toEqual({ kind: "invalid" });
      await passwordStep(rt, { ...admin, password: fresh }, freshIp());
    });
  }
});
