// Our OTP store (spike R13: the stock phone plugin would keep the code in plaintext). A code is 6 digits
// from the CSPRNG (packages/core otp.ts); the database holds only HMAC-SHA256(PLAYER_OTP_PEPPER, phone:code)
// and, until the worker has sent it, the code sealed to the messaging public key (only the worker can open
// it; enqueue_otp copies it into the outbox and the worker wipes it after the send).
//
//   issue   runs AFTER the uniform answer was sent (lib/play/handlers.ts), so nothing here can change what
//           or when the client is answered. In one READ COMMITTED transaction: prepare_player_login (NULL
//           for an unknown or non-eligible phone: then nothing is stored, sent or logged), the player_auth
//           user created first (R13 finding 7), the phone's older codes deleted (one live code per phone),
//           the new row, enqueue_otp (eligibility again, the per-phone cap and the global breaker, in SQL;
//           it moves the sealed code into the outbox). A refused enqueue rolls everything back, the older
//           code included; a tripped breaker commits its alert and keeps no code.
//   verify  ONE attempt counted atomically before any comparison (`attempts + 1 ... WHERE attempts < max`,
//           so concurrent guesses cannot exceed the limit), then a constant-time MAC comparison (core
//           verifyOtp, at the database's clock), and on success the row is deleted: single use, and the
//           request that deletes it is the only one that wins. Every failure is the same `false` (no code,
//           expired, too many attempts, wrong code): Better Auth answers INVALID_OTP for all of them.
import { randomUUID } from "node:crypto";
import { isIdMobileE164, issueOtp, verifyOtp } from "@ebooktrivia/core";
import type { SecretSealer } from "@ebooktrivia/crypto";
import { sqlState } from "@ebooktrivia/db/sql-state";
import type { Sql } from "../db.ts";

const CODE = /^[0-9]{6}$/;

/** SQLSTATEs of enqueue_otp that are an expected refusal, never reported: not eligible, per-phone cap. */
const EXPECTED_REFUSALS = new Set(["ET001", "ET002"]);

export type IssueOutcome = "issued" | "not_eligible" | "refused";

export async function issuePlayerOtp(deps: { readonly sql: Sql; readonly sealer: Pick<SecretSealer, "sealOtp">; readonly pepper: Uint8Array; readonly ttlSeconds: number }, phone: string): Promise<IssueOutcome> {
  if (!isIdMobileE164(phone)) return "not_eligible";
  try {
    return await deps.sql.begin("isolation level read committed", async (tx) => {
      const [prepared] = await tx<{ user_id: string | null }[]>`SELECT public.prepare_player_login(${phone}) AS user_id`;
      if (prepared === undefined || prepared.user_id === null) return "not_eligible" as const;
      const otpId = randomUUID();
      const issued = issueOtp({ pepper: deps.pepper, phone, now: new Date(), ttlMs: deps.ttlSeconds * 1000 });
      const sealed = deps.sealer.sealOtp({ otpId, phone, code: issued.code });
      await tx`DELETE FROM public.player_otps WHERE phone = ${phone}`;
      await tx`
        INSERT INTO public.player_otps (id, phone, mac, sealed_code, expires_at)
        VALUES (${otpId}, ${phone}, ${issued.mac}, ${sealed}, ${issued.expiresAt})`;
      const [enqueued] = await tx<{ outbox_id: string | null }[]>`SELECT public.enqueue_otp(${otpId}) AS outbox_id`;
      if (enqueued === undefined || enqueued.outbox_id === null) {
        // The global send breaker tripped (enqueue_otp wrote its alert, which commits with this
        // transaction): no live code is kept.
        await tx`DELETE FROM public.player_otps WHERE id = ${otpId}`;
        return "refused" as const;
      }
      return "issued" as const;
    });
  } catch (error) {
    if (EXPECTED_REFUSALS.has(sqlState(error) ?? "")) return "refused";
    throw error;
  }
}

export async function verifyStoredOtp(deps: { readonly sql: Sql; readonly pepper: Uint8Array; readonly maxAttempts: number }, phone: string, code: string): Promise<boolean> {
  if (!isIdMobileE164(phone) || !CODE.test(code)) return false;
  // Its own transaction, which does not wait for the WAL flush at commit (security review M1): an attempt on a
  // phone that has a code writes a row, one on a phone without one writes nothing, and a synchronous commit
  // made that difference measurable. The attempt still counts atomically; a crash may lose an increment.
  const [row] = await deps.sql.begin(async (tx) => {
    await tx`SET LOCAL synchronous_commit = off`;
    return tx<{ id: string; mac: Buffer; expires_at: Date; attempts: number; now: Date }[]>`
      UPDATE public.player_otps SET attempts = attempts + 1
       WHERE id = (SELECT o.id FROM public.player_otps o WHERE o.phone = ${phone} ORDER BY o.created_at DESC LIMIT 1)
         AND attempts < ${deps.maxAttempts} AND expires_at > clock_timestamp()
      RETURNING id, mac, expires_at, attempts, clock_timestamp() AS now`;
  });
  if (row === undefined) return false;
  const check = verifyOtp({
    pepper: deps.pepper,
    phone,
    code,
    record: { mac: row.mac, expiresAt: row.expires_at, attempts: row.attempts - 1 },
    now: row.now,
    maxAttempts: deps.maxAttempts,
  });
  if (!check.ok) return false;
  const deleted = await deps.sql`DELETE FROM public.player_otps WHERE id = ${row.id} RETURNING id`;
  return deleted.length === 1;
}
