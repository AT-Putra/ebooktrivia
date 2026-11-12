// Player magic links (plan M8.4, §10 item 4; spec AC-D2, AC-Q1): one token per delivery channel,
// valid 72 h, single use. The token is 32 bytes (256 bits) from the CSPRNG, base64url without
// padding (43 characters). Only SHA-256(token) is stored (magic_links.token_hash, 32 bytes;
// the plan names no pepper, and a 256-bit random token cannot be brute-forced from its hash).
// Verification compares hashes in constant time and checks consumption and expiry (a stored
// date that is not a valid Date throws a RangeError instead of passing); the caller
// consumes with a conditional `UPDATE ... SET consumed_at = $now WHERE token_hash = $1 AND
// consumed_at IS NULL AND expires_at > $now`, so only one request can win.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const MAGIC_LINK_TTL_MS = 72 * 60 * 60 * 1000;
/** magic_links_channel_check. */
export const MAGIC_LINK_CHANNELS = ["whatsapp", "email"] as const;
export type MagicLinkChannel = (typeof MAGIC_LINK_CHANNELS)[number];

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface IssuedMagicLink {
  /** Goes into the link only; never stored or logged. */
  readonly token: string;
  readonly tokenHash: Buffer;
  readonly channel: MagicLinkChannel;
  readonly expiresAt: Date;
}

export interface MagicLinkRecord {
  readonly tokenHash: Uint8Array;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export type MagicLinkCheck =
  | { readonly ok: true; readonly consumedAt: Date }
  | { readonly ok: false; readonly reason: "malformed" | "mismatch" | "consumed" | "expired" };

/** An invalid Date compares false with everything, so an unchecked expiry would never expire. */
function assertDate(value: unknown, name: string): asserts value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new RangeError(`${name} must be a valid Date`);
}

/** SHA-256 of a well-formed token, or null for anything that is not one. */
export function hashMagicLinkToken(token: string): Buffer | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  return createHash("sha256").update(token, "utf8").digest();
}

export function issueMagicLink(input: { readonly channel: MagicLinkChannel; readonly now: Date }): IssuedMagicLink {
  assertDate(input.now, "now");
  if (!MAGIC_LINK_CHANNELS.includes(input.channel)) throw new RangeError("unknown magic link channel");
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenHash: createHash("sha256").update(token, "utf8").digest(),
    channel: input.channel,
    expiresAt: new Date(input.now.getTime() + MAGIC_LINK_TTL_MS),
  };
}

/** Valid iff the hash matches, the link is unused and now < expires_at. */
export function verifyMagicLink(input: {
  readonly token: string;
  readonly record: MagicLinkRecord;
  readonly now: Date;
}): MagicLinkCheck {
  assertDate(input.now, "now");
  assertDate(input.record.expiresAt, "record.expiresAt");
  if (input.record.consumedAt !== null) assertDate(input.record.consumedAt, "record.consumedAt");
  const hash = hashMagicLinkToken(input.token);
  if (hash === null) return { ok: false, reason: "malformed" };
  const stored = input.record.tokenHash;
  if (stored.length !== hash.length || !timingSafeEqual(hash, stored)) return { ok: false, reason: "mismatch" };
  if (input.record.consumedAt !== null) return { ok: false, reason: "consumed" };
  if (input.now.getTime() >= input.record.expiresAt.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, consumedAt: input.now };
}
