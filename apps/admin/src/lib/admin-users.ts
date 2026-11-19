// Admin accounts: created by the Owner (Staff, from the Team page) or by the VM CLI (the first
// Owner), disabled / enabled / reset by the Owner, recovered by the CLI. Each change writes the
// Better Auth rows (admin_auth user + credential account), the admin profile and the audit entry in
// ONE transaction. E-mail and display name are PII: the audit log gets references only.
//
// Temporary passwords (security review US-016 SL3): an account created or reset gets a password
// someone else chose and an enrollment deadline (`enroll_by`, ENROLL_DEADLINE_HOURS). Until TOTP is
// enrolled it may only enroll, and enrollment makes the user choose a new password; after the
// deadline it cannot sign in at all until an Owner resets it (or the CLI recovers it).
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { type FieldKind, type Tx, withAudit } from "./audit.ts";
import { hashSecret } from "./auth/argon2.ts";
import { normalizeEmail, PASSWORD_MAX, PASSWORD_MIN } from "./auth/request.ts";
import { clearThrottle, throttleKey } from "./auth/throttle.ts";
import type { Sql } from "./db.ts";
import type { Role } from "./policy.ts";

export { PASSWORD_MAX, PASSWORD_MIN };
export const ENROLL_DEADLINE_HOURS = 72;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
/** pg_advisory_xact_lock key serializing Owner bootstraps (security review US-016 SL2). */
const BOOTSTRAP_LOCK = 0x6562_7401;

const USER_FIELDS: Readonly<Record<string, FieldKind>> = { email: "pii", display_name: "pii", role: "value", disabled: "value", password: "secret" };

export type AdminUserInput = { readonly email: string; readonly displayName: string; readonly password: string };
export type InputError = "email" | "display_name" | "password";

const validPassword = (password: string): boolean => password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;

export function validateAdminUserInput(input: AdminUserInput): InputError | null {
  const email = normalizeEmail(input.email);
  if (email.length > 254 || !EMAIL.test(email)) return "email";
  const name = input.displayName.trim();
  if (name.length < 1 || name.length > 100 || /\p{Cc}/u.test(name)) return "display_name";
  if (!validPassword(input.password)) return "password";
  return null;
}

export type CreateOutcome = { readonly kind: "created"; readonly userId: string } | { readonly kind: "invalid"; readonly field: InputError } | { readonly kind: "email_taken" };

async function insertAdminUser(tx: Tx, userId: string, input: AdminUserInput, role: Role, passwordHash: string): Promise<void> {
  const email = normalizeEmail(input.email);
  const name = input.displayName.trim();
  await tx`
    INSERT INTO admin_auth."user" (id, name, email, "emailVerified", "twoFactorEnabled")
    VALUES (${userId}, ${name}, ${email}, true, false)`;
  await tx`
    INSERT INTO admin_auth.account (id, "accountId", "providerId", "userId", password, "updatedAt")
    VALUES (${randomBytes(18).toString("base64url")}, ${userId}, 'credential', ${userId}, ${passwordHash}, clock_timestamp())`;
  await tx`
    INSERT INTO public.admin_profiles (auth_user_id, role, display_name, enroll_by)
    VALUES (${userId}, ${role}, ${name}, clock_timestamp() + make_interval(hours => ${ENROLL_DEADLINE_HOURS}))`;
}

const isUniqueViolation = (error: unknown): boolean => error instanceof postgres.PostgresError && error.code === "23505";

class OwnerExists extends Error {}

async function create(sql: Sql, input: AdminUserInput, role: Role, action: string, bootstrap: boolean): Promise<CreateOutcome | { readonly kind: "owner_exists" }> {
  const invalid = validateAdminUserInput(input);
  if (invalid !== null) return { kind: "invalid", field: invalid };
  const passwordHash = await hashSecret(input.password);
  const userId = randomBytes(18).toString("base64url");
  try {
    await withAudit(sql, async (tx, audit) => {
      if (bootstrap) {
        await tx`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`;
        const [owners] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM public.admin_profiles WHERE role = 'owner'`;
        if ((owners?.n ?? 0) > 0) throw new OwnerExists();
      }
      await insertAdminUser(tx, userId, input, role, passwordHash);
      audit({
        action,
        entityType: "admin_user",
        entityId: userId,
        fields: USER_FIELDS,
        after: { email: normalizeEmail(input.email), display_name: input.displayName.trim(), role, disabled: false, password: "set" },
        facts: { enroll_within_hours: ENROLL_DEADLINE_HOURS },
      });
    });
  } catch (error) {
    if (error instanceof OwnerExists) return { kind: "owner_exists" };
    if (isUniqueViolation(error)) return { kind: "email_taken" };
    throw error;
  }
  return { kind: "created", userId };
}

/** A new admin account (no TOTP yet: the first sign-in forces enrollment within 72 h). */
export async function createAdminUser(sql: Sql, input: AdminUserInput, role: Role, action: string): Promise<CreateOutcome> {
  const result = await create(sql, input, role, action, false);
  if (result.kind === "owner_exists") throw new Error("unreachable: not a bootstrap");
  return result;
}

/** The first Owner (VM CLI). Refused once any Owner exists, also under concurrent runs. */
export function bootstrapOwner(sql: Sql, input: AdminUserInput): Promise<CreateOutcome | { readonly kind: "owner_exists" }> {
  return create(sql, input, "owner", "cli.bootstrap_owner", true);
}

export type DisableOutcome = { readonly kind: "updated" } | { readonly kind: "not_found" } | { readonly kind: "self" };

/** Disables (revoking every session) or re-enables an admin. Never the caller's own account. */
export async function setAdminDisabled(sql: Sql, actorUserId: string, targetUserId: string, disabled: boolean): Promise<DisableOutcome> {
  if (actorUserId === targetUserId) return { kind: "self" };
  return withAudit(sql, async (tx, audit) => {
    const [before] = await tx<{ disabled: boolean }[]>`
      SELECT disabled_at IS NOT NULL AS disabled FROM public.admin_profiles WHERE auth_user_id = ${targetUserId} FOR UPDATE`;
    if (before === undefined) {
      audit({ action: "admin_user.disable_refused", entityType: "admin_user", entityId: targetUserId, facts: { reason: "not_found" } });
      return { kind: "not_found" as const };
    }
    await tx`
      UPDATE public.admin_profiles
         SET disabled_at = CASE WHEN ${disabled} THEN coalesce(disabled_at, clock_timestamp()) ELSE NULL END, updated_at = clock_timestamp()
       WHERE auth_user_id = ${targetUserId}`;
    const revoked = disabled ? (await tx`DELETE FROM admin_auth.session WHERE "userId" = ${targetUserId}`).count : 0;
    audit({
      action: disabled ? "admin_user.disable" : "admin_user.enable",
      entityType: "admin_user",
      entityId: targetUserId,
      fields: USER_FIELDS,
      before: { disabled: before.disabled },
      after: { disabled },
      facts: { sessions_revoked: revoked },
    });
    return { kind: "updated" as const };
  });
}

export interface AdminUserRow {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly disabled: boolean;
  readonly twoFactorEnabled: boolean;
  readonly recoveryCodesLeft: number;
  /** Not enrolled and past the enrollment deadline: needs an Owner reset. */
  readonly setupExpired: boolean;
}

export async function listAdminUsers(sql: Sql): Promise<AdminUserRow[]> {
  const rows = await sql<
    { user_id: string; email: string; display_name: string; role: Role; disabled: boolean; two_factor: boolean | null; codes: number; expired: boolean }[]
  >`
    SELECT u.id AS user_id, u.email, p.display_name, p.role, p.disabled_at IS NOT NULL AS disabled,
           u."twoFactorEnabled" AS two_factor,
           (SELECT count(*)::int FROM admin_auth.recovery_code c WHERE c.user_id = u.id AND c.used_at IS NULL) AS codes,
           (u."twoFactorEnabled" IS NOT TRUE AND (p.enroll_by IS NULL OR p.enroll_by <= clock_timestamp())) AS expired
      FROM admin_auth."user" u JOIN public.admin_profiles p ON p.auth_user_id = u.id
     ORDER BY p.role, p.display_name, u.id`;
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    disabled: r.disabled,
    twoFactorEnabled: r.two_factor === true,
    recoveryCodesLeft: r.codes,
    setupExpired: r.expired,
  }));
}

/**
 * Resets an account to "temporary password, enroll within 72 h": TOTP off, the authenticator
 * secret, every recovery code, every session and pending challenge removed, the login throttle of
 * the account (password and second factor, hard lock included) cleared, the new password set.
 */
async function resetAccess(tx: Tx, user: { id: string; email: string }, passwordHash: string): Promise<{ totp: number; codes: number; sessions: number }> {
  await tx`UPDATE admin_auth."user" SET "twoFactorEnabled" = false, "updatedAt" = clock_timestamp() WHERE id = ${user.id}`;
  const totp = await tx`DELETE FROM admin_auth."twoFactor" WHERE "userId" = ${user.id}`;
  const codes = await tx`DELETE FROM admin_auth.recovery_code WHERE user_id = ${user.id}`;
  const sessions = await tx`DELETE FROM admin_auth.session WHERE "userId" = ${user.id}`;
  await tx`DELETE FROM admin_auth.verification WHERE value = ${user.id}`;
  await clearThrottle(tx, [throttleKey("account", user.email), throttleKey("second_factor", user.id)]);
  await tx`UPDATE admin_auth.account SET password = ${passwordHash}, "updatedAt" = clock_timestamp() WHERE "userId" = ${user.id} AND "providerId" = 'credential'`;
  await tx`
    UPDATE public.admin_profiles SET enroll_by = clock_timestamp() + make_interval(hours => ${ENROLL_DEADLINE_HOURS}), updated_at = clock_timestamp()
     WHERE auth_user_id = ${user.id}`;
  return { totp: totp.count, codes: codes.count, sessions: sessions.count };
}

export type RecoverOutcome = { readonly kind: "recovered"; readonly userId: string; readonly sessionsRevoked: number } | { readonly kind: "not_found" } | { readonly kind: "invalid_password" };

/**
 * Owner recovery (VM CLI, audited as actor "cli"). Always sets a new password (security review
 * US-016 SM1: a recovery that kept the old password would let whoever knows it enroll their own
 * authenticator); the next sign-in forces a new TOTP enrollment within 72 h.
 */
export async function recoverAdminUser(sql: Sql, emailInput: string, newPassword: string): Promise<RecoverOutcome> {
  if (!validPassword(newPassword)) return { kind: "invalid_password" };
  const email = normalizeEmail(emailInput);
  const passwordHash = await hashSecret(newPassword);
  return withAudit(sql, async (tx, audit) => {
    const [user] = await tx<{ id: string; two_factor: boolean | null }[]>`
      SELECT id, "twoFactorEnabled" AS two_factor FROM admin_auth."user" WHERE email = ${email} FOR UPDATE`;
    if (user === undefined) {
      audit({ action: "cli.recover_admin_refused", entityType: "admin_user", entityId: null, facts: { reason: "not_found" } });
      return { kind: "not_found" as const };
    }
    const removed = await resetAccess(tx, { id: user.id, email }, passwordHash);
    audit({
      action: "cli.recover_admin",
      entityType: "admin_user",
      entityId: user.id,
      fields: { two_factor_enabled: "value", password: "secret" },
      before: { two_factor_enabled: user.two_factor === true },
      after: { two_factor_enabled: false, password: "set" },
      facts: { authenticators_removed: removed.totp, recovery_codes_removed: removed.codes, sessions_revoked: removed.sessions, enroll_within_hours: ENROLL_DEADLINE_HOURS },
    });
    return { kind: "recovered" as const, userId: user.id, sessionsRevoked: removed.sessions };
  });
}

export type ResetOutcome =
  | { readonly kind: "reset" }
  | { readonly kind: "not_found" }
  | { readonly kind: "self" }
  | { readonly kind: "owner" }
  | { readonly kind: "invalid_password" };

/**
 * The Owner's reset from the Team page: as the CLI recovery, with a temporary password the Owner
 * shares. Staff accounts only (code review US-016 F4): an Owner account is recovered with the VM
 * CLI, so a console session can never take over another Owner. A refused Owner target is audited.
 */
export async function resetAdminUser(sql: Sql, actorUserId: string, targetUserId: string, temporaryPassword: string): Promise<ResetOutcome> {
  if (actorUserId === targetUserId) return { kind: "self" };
  if (!validPassword(temporaryPassword)) return { kind: "invalid_password" };
  const passwordHash = await hashSecret(temporaryPassword);
  return withAudit(sql, async (tx, audit) => {
    const [user] = await tx<{ id: string; email: string; two_factor: boolean | null; role: string }[]>`
      SELECT u.id, u.email, u."twoFactorEnabled" AS two_factor, p.role
        FROM admin_auth."user" u JOIN public.admin_profiles p ON p.auth_user_id = u.id
       WHERE u.id = ${targetUserId} FOR UPDATE OF u, p`;
    if (user === undefined) {
      audit({ action: "admin_user.reset_refused", entityType: "admin_user", entityId: targetUserId, facts: { reason: "not_found" } });
      return { kind: "not_found" as const };
    }
    if (user.role !== "staff") {
      audit({ action: "admin_user.reset_refused", entityType: "admin_user", entityId: targetUserId, facts: { reason: "owner_target" } });
      return { kind: "owner" as const };
    }
    const removed = await resetAccess(tx, user, passwordHash);
    audit({
      action: "admin_user.reset_access",
      entityType: "admin_user",
      entityId: user.id,
      fields: { two_factor_enabled: "value", password: "secret" },
      before: { two_factor_enabled: user.two_factor === true },
      after: { two_factor_enabled: false, password: "set" },
      facts: { authenticators_removed: removed.totp, recovery_codes_removed: removed.codes, sessions_revoked: removed.sessions, enroll_within_hours: ENROLL_DEADLINE_HOURS },
    });
    return { kind: "reset" as const };
  });
}
