// Player WhatsApp OTP (spec Security baseline: 6 digits, 5 min expiry, max 5 attempts; plan
// M9.1 "codes are hashed"; docs/spikes/R13.md "OTP storage" and player_otps).
//
//   code     6 digits, uniform: crypto.randomInt(0, 10^6), zero-padded.
//   storage  player_otps.mac = HMAC-SHA256(pepper, `${phone}:${code}`) (the R13 construction);
//            the pepper is an env secret, never in the DB: at least 32 bytes as a Uint8Array
//            (decode the env value with decodeSecretKey; strings are refused).
//   verify   attempts < max, now < expires_at (an expires_at that is not a valid Date throws a
//            RangeError instead of passing), then a constant-time MAC comparison. The caller
//            counts every attempt atomically before comparing (R13: `UPDATE ... SET attempts =
//            attempts + 1 WHERE ... AND attempts < $max RETURNING mac`) and passes the count from
//            before that increment. Single use: delete the row on success.
// TTL and attempt limit default to the spec values; AC-A3 makes them admin settings.

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { assertSecretKey } from "./secret-key.ts";

export const OTP_DIGITS = 6;
export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

const CODE_PATTERN = /^[0-9]{6}$/;
/** Same as packages/db e164Check (player_otps_phone_check). */
const E164 = /^\+[1-9][0-9]{7,14}$/;

export interface IssuedOtp {
  /** Goes to the WA message only (sealed in the outbox); never stored in clear. */
  readonly code: string;
  readonly mac: Buffer;
  readonly expiresAt: Date;
}

export interface OtpRecord {
  readonly mac: Uint8Array;
  readonly expiresAt: Date;
  /** Verification attempts made before this one. */
  readonly attempts: number;
}

export type OtpCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "malformed" | "expired" | "too_many_attempts" | "mismatch" };

function positiveInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

/** An invalid Date compares false with everything, so an unchecked expiry would never expire. */
function assertDate(value: unknown, name: string): asserts value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new RangeError(`${name} must be a valid Date`);
}

export function generateOtpCode(): string {
  return randomInt(0, 10 ** OTP_DIGITS)
    .toString()
    .padStart(OTP_DIGITS, "0");
}

export function otpMac(pepper: Uint8Array, phone: string, code: string): Buffer {
  assertSecretKey(pepper, "OTP pepper");
  if (!E164.test(phone)) throw new RangeError("phone must be E.164");
  if (!CODE_PATTERN.test(code)) throw new RangeError("code must be 6 digits");
  return createHmac("sha256", pepper).update(`${phone}:${code}`, "utf8").digest();
}

export function issueOtp(input: {
  readonly pepper: Uint8Array;
  readonly phone: string;
  readonly now: Date;
  readonly ttlMs?: number;
}): IssuedOtp {
  assertDate(input.now, "now");
  const ttl = positiveInt(input.ttlMs ?? OTP_TTL_MS, "ttlMs");
  const code = generateOtpCode();
  return { code, mac: otpMac(input.pepper, input.phone, code), expiresAt: new Date(input.now.getTime() + ttl) };
}

export function verifyOtp(input: {
  readonly pepper: Uint8Array;
  readonly phone: string;
  readonly code: string;
  readonly record: OtpRecord;
  readonly now: Date;
  readonly maxAttempts?: number;
}): OtpCheck {
  const max = positiveInt(input.maxAttempts ?? OTP_MAX_ATTEMPTS, "maxAttempts");
  assertDate(input.now, "now");
  assertDate(input.record.expiresAt, "record.expiresAt");
  if (!Number.isSafeInteger(input.record.attempts) || input.record.attempts < 0) {
    throw new RangeError("record.attempts must be a non-negative integer");
  }
  if (input.record.attempts >= max) return { ok: false, reason: "too_many_attempts" };
  if (input.now.getTime() >= input.record.expiresAt.getTime()) return { ok: false, reason: "expired" };
  if (!CODE_PATTERN.test(input.code)) return { ok: false, reason: "malformed" };
  const expected = otpMac(input.pepper, input.phone, input.code);
  const stored = input.record.mac;
  if (stored.length !== expected.length || !timingSafeEqual(expected, stored)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}
