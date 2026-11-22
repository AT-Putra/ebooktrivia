// The breached-password check of an admin password (US-031, ASVS V6.2.12). The Owner's choice: the WORKER checks it
// (Have I Been Pwned's range API, k-anonymity, apps/worker/src/password-check.ts); this console has no egress and never
// calls the API. Wherever a password is set (a new account, a staff reset, the CLI's recover, enrolment, the forced
// change), in the same transaction as the new password:
//   - admin_profiles.password_check_id gets a new id and password_breached_at is cleared (a new password starts clean);
//   - an outbox job admin.password_hibp_check is written: payload { admin_user_id, check_id } only, and `sealed` = the
//     password's SHA-1 sealed to the messaging public key, bound to both ids (packages/crypto sealPasswordCheck).
// Why that payload: the range API needs the hash's first 5 hex characters and the match needs the other 35, so the full
// SHA-1 is the least the worker can work with. Anything shorter that keeps false matches negligible still lets an
// attacker test candidate passwords offline, so the protection is where it lives, not how long it is: never in the
// payload, a log line or an error; sealed to a key only the worker holds, so the database, its WAL and its backups hold
// ciphertext only; and wiped from the row when the job ends (processed or given up), or by the worker's minute sweep
// once it is past its attempt cap or 24 h old.
// Without the messaging public key (admin.env SECRETS_MESSAGING_PUBLIC_KEY) no job is written: a warning is logged and the
// password is accepted on the local checks (fail open, the Owner's decision).
import { randomUUID } from "node:crypto";
import type { SecretSealer } from "@ebooktrivia/crypto/sealer";
import type { Tx } from "../audit.ts";
import { logEvent } from "../log.ts";

export const PASSWORD_CHECK_TOPIC = "admin.password_hibp_check";

/** What setting a password needs to enqueue its check: the public-key-only sealer of admin.env (or none). */
export type PasswordCheckSealer = Pick<SecretSealer, "scopes" | "sealPasswordCheck"> | null;

/** Records a new password's breached-password check (call it in the transaction that sets the password). */
export async function enqueuePasswordCheck(tx: Tx, sealer: PasswordCheckSealer, adminUserId: string, password: string): Promise<void> {
  if (sealer === null || !sealer.scopes.includes("messaging")) {
    await tx`UPDATE public.admin_profiles SET password_check_id = NULL, password_breached_at = NULL WHERE auth_user_id = ${adminUserId}`;
    logEvent("warn", "admin.password_check_skipped", { reason: "no_messaging_key" });
    return;
  }
  const checkId = randomUUID();
  const sealed = sealer.sealPasswordCheck({ checkId, adminUserId, password });
  await tx`UPDATE public.admin_profiles SET password_check_id = ${checkId}, password_breached_at = NULL WHERE auth_user_id = ${adminUserId}`;
  await tx`
    INSERT INTO public.outbox (id, topic, dedupe_key, payload, sealed)
    VALUES (${randomUUID()}, ${PASSWORD_CHECK_TOPIC}, ${`${PASSWORD_CHECK_TOPIC}:${checkId}`}, ${tx.json({ admin_user_id: adminUserId, check_id: checkId })}, ${sealed})`;
}
