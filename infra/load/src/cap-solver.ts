// The client side of the Cap proof of work, as the widget runs it (@cap.js/widget 0.1.62 against
// @cap.js/server 4.0.5, behind packages/adapters captcha.ts): a challenge token and {c, s, d}; for each
// sub-challenge i (1-based) the salt is prng(token + i, s) and the target prng(token + i + "d", d), and its
// solution is the smallest nonce n for which sha256(salt + n) starts with the target (hex).
//
// The prng is copied from the server (it is not exported); solver.test.ts proves the copy by redeeming
// real challenges of the real provider, so a drift on a Cap upgrade fails there.
import { createHash } from "node:crypto";

/** @cap.js/server 4.0.5's deterministic generator of salts and targets (hex string of `length` characters). */
export function prng(seed: string, length: number): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  let state = hash >>> 0;
  let result = "";
  while (result.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result += (state >>> 0).toString(16).padStart(8, "0");
  }
  return result.substring(0, length);
}

export interface CapParams {
  readonly c: number;
  readonly s: number;
  readonly d: number;
}

/** The nonce of one sub-challenge. */
export function solveOne(token: string, index: number, params: CapParams): number {
  const salt = prng(`${token}${String(index)}`, params.s);
  const target = prng(`${token}${String(index)}d`, params.d);
  const whole = Buffer.from(target.slice(0, target.length - (target.length % 2)), "hex");
  const nibble = target.length % 2 === 1 ? Number.parseInt(target.slice(-1), 16) : -1;
  for (let nonce = 0; ; nonce++) {
    const digest = createHash("sha256").update(`${salt}${String(nonce)}`).digest();
    if (digest.subarray(0, whole.length).equals(whole) && (nibble < 0 || (digest[whole.length] ?? 0) >> 4 === nibble)) return nonce;
  }
}

/** All `c` solutions of a challenge, in order. CPU bound: the difficulty is d hex digits, 16^d hashes per sub-challenge on average. */
export function solveChallenge(token: string, params: CapParams): number[] {
  return Array.from({ length: params.c }, (_, index) => solveOne(token, index + 1, params));
}
