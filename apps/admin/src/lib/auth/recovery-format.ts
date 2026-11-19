// Recovery code format (no I/O). A code is 16 Crockford base32 characters (80 random bits), shown
// as XXXX-XXXX-XXXX-XXXX. The first 4 characters are its selector (stored in clear, unique per
// user) so a check needs one argon2id verification; the hash covers all 16 characters.
import { randomBytes } from "node:crypto";

export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 16;
const NORMALIZED = /^[0-9A-HJKMNP-TV-Z]{16}$/;

function randomCode(): string {
  const bytes = randomBytes((LENGTH * 5) / 8);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >> bits) & 31] ?? "";
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

export const formatRecoveryCode = (normalized: string): string => normalized.replace(/(.{4})(?=.)/g, "$1-");
export const selectorOf = (normalized: string): string => normalized.slice(0, 4);

/** `count` codes (normalized form) with distinct selectors. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Map<string, string>();
  while (codes.size < count) {
    const code = randomCode();
    if (!codes.has(selectorOf(code))) codes.set(selectorOf(code), code);
  }
  return [...codes.values()];
}

/**
 * What the user typed, in normalized form, or null when it cannot be a code. Case, spaces and
 * hyphens are ignored, and Crockford's look-alikes are read as digits (I, L -> 1; O -> 0).
 */
export function normalizeRecoveryCode(input: string): string | null {
  if (input.length > 64) return null;
  const compact = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return NORMALIZED.test(compact) ? compact : null;
}
