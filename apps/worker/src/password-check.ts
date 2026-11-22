// The admin.password_hibp_check consumer (US-031, ASVS V6.2.12; the Owner's choice: the breached-password check runs in
// the worker, the admin app has no egress). Where an admin password is set, the console writes a new
// admin_profiles.password_check_id and this outbox row: payload { admin_user_id, check_id } and `sealed` = the password's
// SHA-1 sealed to the messaging key, bound to both ids (packages/crypto passwordCheckAad). The password itself never
// leaves the console; the hash never sits in the payload, a log line or an error. Per job:
//   1. the SHA-1 is opened with the messaging private key; a row that does not open is dropped (processed);
//   2. Have I Been Pwned's range API is asked for its first 5 hex characters (k-anonymity, Add-Padding, 3 s timeout,
//      safe-fetch; @ebooktrivia/adapters/pwned-passwords) and the rest is matched here;
//   3. breached: flag_breached_admin_password (sql/functions.sql) sets password_breached_at, only while this check is
//      still the admin's current password's, audits it and raises a warning alert with the admin id only; the admin must
//      change the password at the next sign-in (apps/admin lib/access.ts). Clean: nothing to do;
//   4. unreachable: retried with the outbox backoff (30 s doubling) up to PASSWORD_CHECK_MAX_ATTEMPTS claims, then given
//      up with a warning (fail open: the password stays, as the Owner decided).
// Every end this consumer reaches (clean, flagged, dropped, given up) is a finalize, which marks the row processed and
// wipes `sealed`. The ends it does not reach (the last claim failed after the lookup, e.g. its finalize; or no worker holds
// the messaging key) are the minute sweep's: sweepers.ts sweepExpiredOtps wipes the hash of a job past its attempt cap
// or 24 h old (delta review LOW). The effect is idempotent (the flag is set once per check), so a re-run after a crash
// between the lookup and the finalize changes nothing.
import { createPwnedPasswordsLookup, type PwnedLookup } from "@ebooktrivia/adapters/pwned-passwords";
import { isUuid } from "@ebooktrivia/core";
import { openerFromEnv, type SecretOpener } from "@ebooktrivia/crypto";
import type postgres from "postgres";
import { type Env, optional } from "./env.ts";
import type { Logger } from "./log.ts";
import type { OutboxConsumer } from "./outbox-consumer.ts";

export const PASSWORD_CHECK_TOPIC = "admin.password_hibp_check";
/** 6 claims: the backoff waits 30 s, 1, 2, 4 and 8 min between them (about 15 min of retries), then the check gives up. */
export const PASSWORD_CHECK_MAX_ATTEMPTS = 6;
/** The lookup has a 3 s timeout; the lease leaves room for the claim and the finalize. */
const PASSWORD_CHECK_LEASE_MS = 30_000;
const ADMIN_USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What the consumer needs besides the logger: the messaging private key, and the breach lookup. */
export interface PasswordCheckPort {
  readonly opener: Pick<SecretOpener, "openPasswordCheck">;
  readonly lookup: PwnedLookup;
}

export interface PasswordCheckDeps extends PasswordCheckPort {
  readonly log: Logger;
  readonly leaseMs?: number;
}

/** The port from worker.env (SECRETS_MESSAGING_PRIVATE_KEY), with the real lookup (its own safe-fetch, 3 s); undefined without the key. */
export function passwordCheckFromEnv(env: Env): PasswordCheckPort | undefined {
  if (optional(env, "SECRETS_MESSAGING_PRIVATE_KEY") === undefined) return undefined;
  return { opener: openerFromEnv(env), lookup: createPwnedPasswordsLookup() };
}

function parsePayload(payload: unknown): { readonly adminUserId: string; readonly checkId: string } | null {
  // outbox.payload is always a JSON object (outbox_payload_check); the console writes these two fields.
  const p = payload as Record<string, unknown>;
  const adminUserId = p["admin_user_id"];
  const checkId = p["check_id"];
  if (typeof adminUserId !== "string" || !ADMIN_USER_ID.test(adminUserId) || !isUuid(checkId)) return null;
  return { adminUserId, checkId };
}

export function createPasswordCheckConsumer(deps: PasswordCheckDeps): OutboxConsumer {
  return {
    topic: PASSWORD_CHECK_TOPIC,
    leaseMs: deps.leaseMs ?? PASSWORD_CHECK_LEASE_MS,
    maxAttempts: PASSWORD_CHECK_MAX_ATTEMPTS,
    async perform(row) {
      const job = parsePayload(row.payload);
      if (job === null || row.sealed === null) {
        deps.log.warn({ outboxId: row.id, reason: job === null ? "bad_payload" : "no_sealed_hash" }, "password check dropped");
        return undefined;
      }
      let sha1: string;
      try {
        sha1 = deps.opener.openPasswordCheck({ checkId: job.checkId, adminUserId: job.adminUserId, sealed: row.sealed });
      } catch {
        deps.log.warn({ outboxId: row.id, reason: "unreadable_hash" }, "password check dropped");
        return undefined;
      }
      const result = await deps.lookup(sha1);
      if (result.status === "unavailable") {
        if (row.attempts < PASSWORD_CHECK_MAX_ATTEMPTS) throw new Error(`pwned passwords unavailable: ${result.reason}`);
        // Fail open (the Owner's decision): the password stays; the finalize still wipes the sealed hash.
        deps.log.warn({ outboxId: row.id, adminUserId: job.adminUserId, reason: result.reason, attempts: row.attempts }, "password check given up: the breach database stayed unreachable");
        return undefined;
      }
      if (result.status === "clean") {
        deps.log.info({ outboxId: row.id, adminUserId: job.adminUserId }, "password check: not in a known breach");
        return undefined;
      }
      return async (tx: postgres.TransactionSql) => {
        const [flag] = await tx<{ flagged: boolean }[]>`SELECT public.flag_breached_admin_password(${job.adminUserId}, ${job.checkId}) AS flagged`;
        deps.log.warn(
          { outboxId: row.id, adminUserId: job.adminUserId, flagged: flag?.flagged === true },
          flag?.flagged === true ? "admin password is in a known breach: the admin must change it" : "admin password was in a known breach, but it has been changed since",
        );
      };
    },
  };
}
