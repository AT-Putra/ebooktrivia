// Deterministic per-player shuffles (spec AC-Q6: same questions for everyone, question order
// and option order shuffled per player; plan M2.4 / attempt_questions.permutation).
//
// seed  = HMAC-SHA256(key, "ebooktrivia/shuffle/v1" + length-prefixed context parts)
// block = HMAC-SHA256(seed, uint32be(counter)), counter = 0, 1, 2, ...; read as uint32be words
// Fisher-Yates from the end; each index j in [0, i] is drawn by rejection sampling (a word is
// redrawn when it falls in the incomplete top bucket), so there is no modulo bias.
// The key is a server secret of at least 32 bytes (a Uint8Array; decode config values with
// decodeSecretKey), so players cannot predict another attempt's order. Same key +
// context => same permutation; a different key or context => an independent one.

import { createHmac } from "node:crypto";
import { assertSecretKey } from "./secret-key.ts";

const DOMAIN = "ebooktrivia/shuffle/v1";
const MAX_ITEMS = 1_000_000;
const TWO_32 = 0x1_0000_0000;

/** Length-prefixed, so ["ab", "c"] and ["a", "bc"] give different seeds. */
function encodeContext(context: readonly string[]): Buffer {
  const parts = context.map((part) => {
    const bytes = Buffer.from(part, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    return Buffer.concat([len, bytes]);
  });
  return Buffer.concat([Buffer.from(DOMAIN, "utf8"), ...parts]);
}

export function shuffleSeed(key: Uint8Array, context: readonly string[]): Buffer {
  assertSecretKey(key, "shuffle key");
  if (context.length === 0) throw new RangeError("context must not be empty");
  return createHmac("sha256", key).update(encodeContext(context)).digest();
}

/** Endless deterministic uint32 stream from a seed. */
export function wordStream(seed: Uint8Array): () => number {
  let counter = 0;
  let block = Buffer.alloc(0);
  let offset = 0;
  return () => {
    if (offset >= block.length) {
      const ctr = Buffer.alloc(4);
      ctr.writeUInt32BE(counter++);
      block = createHmac("sha256", seed).update(ctr).digest();
      offset = 0;
    }
    const word = block.readUInt32BE(offset);
    offset += 4;
    return word;
  };
}

/** Uniform integer in [0, bound) by rejection sampling over uint32 words. */
export function uniformBelow(next: () => number, bound: number): number {
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > TWO_32) throw new RangeError("bound must be in 1..2^32");
  const limit = TWO_32 - (TWO_32 % bound); // largest multiple of bound <= 2^32
  for (;;) {
    const word = next();
    if (word < limit) return word % bound;
  }
}

/**
 * Permutation of 0..n-1: entry k is the original index shown at position k (store it as
 * attempt_questions.position order / permutation).
 */
export function shuffledIndices(n: number, key: Uint8Array, context: readonly string[]): number[] {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_ITEMS) throw new RangeError(`n must be an integer in 0..${MAX_ITEMS}`);
  const next = wordStream(shuffleSeed(key, context));
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = uniformBelow(next, i + 1);
    const tmp = out[i] as number;
    out[i] = out[j] as number;
    out[j] = tmp;
  }
  return out;
}

/** Items in shuffled order: result[k] = items[permutation[k]]. */
export function applyPermutation<T>(items: readonly T[], permutation: readonly number[]): T[] {
  assertPermutation(permutation, items.length);
  return permutation.map((i) => items[i] as T);
}

/** inverse[original index] = shown position. */
export function invertPermutation(permutation: readonly number[]): number[] {
  assertPermutation(permutation, permutation.length);
  const inverse = new Array<number>(permutation.length);
  permutation.forEach((original, position) => {
    inverse[original] = position;
  });
  return inverse;
}

function assertPermutation(permutation: readonly number[], n: number): void {
  if (permutation.length !== n) throw new RangeError("permutation length does not match");
  const seen = new Uint8Array(n);
  for (const i of permutation) {
    if (!Number.isInteger(i) || i < 0 || i >= n || seen[i] === 1) throw new RangeError("not a permutation");
    seen[i] = 1;
  }
}
