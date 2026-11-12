import { createHmac } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyPermutation,
  invertPermutation,
  shuffledIndices,
  shuffleSeed,
  uniformBelow,
  wordStream,
} from "./shuffle.ts";

const KEY = Buffer.alloc(32, 0x5a);
const OTHER_KEY = Buffer.alloc(32, 0xa5);

const isPermutation = (p: readonly number[], n: number): boolean =>
  p.length === n && [...p].sort((a, b) => a - b).every((v, i) => v === i);

describe("shuffleSeed / wordStream", () => {
  it("is HMAC-SHA256(key, domain + length-prefixed parts)", () => {
    const expected = createHmac("sha256", KEY)
      .update(
        Buffer.concat([
          Buffer.from("ebooktrivia/shuffle/v1"),
          Buffer.from([0, 0, 0, 3]),
          Buffer.from("att"),
          Buffer.from([0, 0, 0, 2]),
          Buffer.from("q1"),
        ]),
      )
      .digest();
    expect(shuffleSeed(KEY, ["att", "q1"]).equals(expected)).toBe(true);
  });

  it("separates context parts unambiguously", () => {
    expect(shuffleSeed(KEY, ["ab", "c"]).equals(shuffleSeed(KEY, ["a", "bc"]))).toBe(false);
  });

  it("streams HMAC(seed, counter) blocks as uint32 words across block boundaries", () => {
    const seed = shuffleSeed(KEY, ["x"]);
    const next = wordStream(seed);
    const words = Array.from({ length: 9 }, next);
    const block0 = createHmac("sha256", seed).update(Buffer.from([0, 0, 0, 0])).digest();
    const block1 = createHmac("sha256", seed).update(Buffer.from([0, 0, 0, 1])).digest();
    expect(words.slice(0, 8)).toEqual(Array.from({ length: 8 }, (_, i) => block0.readUInt32BE(i * 4)));
    expect(words[8]).toBe(block1.readUInt32BE(0));
  });

  it("rejects short keys and empty contexts", () => {
    expect(() => shuffleSeed(Buffer.alloc(31), ["x"])).toThrow(RangeError);
    expect(() => shuffleSeed(KEY, [])).toThrow(RangeError);
  });
});

describe("uniformBelow", () => {
  it("redraws words in the incomplete top bucket (no modulo bias)", () => {
    // 2^32 mod 3 = 1, so 0xFFFFFFFF is the one rejected word for bound 3.
    const words = [0xffff_ffff, 0xffff_fffe, 5];
    let calls = 0;
    const next = () => words[calls++] ?? 0;
    expect(uniformBelow(next, 3)).toBe(0xffff_fffe % 3);
    expect(calls).toBe(2);
    const words7 = [0xffff_fffc, 0xffff_fffb]; // 2^32 mod 7 = 4: 0xFFFFFFFC..0xFFFFFFFF rejected
    let calls7 = 0;
    expect(uniformBelow(() => words7[calls7++] ?? 0, 7)).toBe(0xffff_fffb % 7);
    expect(calls7).toBe(2);
  });

  it("accepts every word for powers of two up to 2^32", () => {
    expect(uniformBelow(() => 0xffff_ffff, 2 ** 32)).toBe(0xffff_ffff);
    expect(uniformBelow(() => 0xffff_ffff, 4)).toBe(3);
    expect(uniformBelow(() => 12345, 1)).toBe(0);
  });

  it("rejects invalid bounds", () => {
    for (const bound of [0, -1, 1.5, 2 ** 32 + 1, Number.NaN]) {
      expect(() => uniformBelow(() => 0, bound)).toThrow(RangeError);
    }
  });
});

describe("shuffledIndices", () => {
  it("is deterministic for the same key and context", () => {
    const a = shuffledIndices(20, KEY, ["attempt-1", "question-7"]);
    expect(shuffledIndices(20, KEY, ["attempt-1", "question-7"])).toEqual(a);
    expect(isPermutation(a, 20)).toBe(true);
  });

  it("matches golden vectors from an independent implementation (review round 3, L5)", () => {
    // Derived by a standalone script written from this module's header alone (it imports nothing
    // from the package, only node:crypto): seed = HMAC-SHA256(key, "ebooktrivia/shuffle/v1" +
    // u32be(UTF-8 byte length) + UTF-8 bytes per part), words = u32be from HMAC-SHA256(seed,
    // u32be(counter)) blocks, Fisher-Yates from the end with rejection sampling. Key = bytes
    // 0x00..0x1f. Stored attempt_questions.permutation values depend on these exact outputs:
    // any change to the construction must be a new domain version, not an edit.
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    expect(shuffleSeed(key, ["attempt-1", "question-7"]).toString("hex")).toBe(
      "67caaddd54ae5a1c260815f5f8139245c4129d842af5fad5f436bfe6e302c0db",
    );
    expect(shuffledIndices(20, key, ["attempt-1", "question-7"])).toEqual([
      2, 16, 12, 3, 17, 11, 18, 15, 0, 8, 5, 13, 9, 14, 10, 4, 6, 7, 1, 19,
    ]);
    // Multi-byte parts: the length prefix counts UTF-8 bytes, not UTF-16 code units.
    expect(shuffledIndices(8, key, ["percobaan-\u{00FC}", "soal-\u{1F600}"])).toEqual([0, 4, 6, 7, 2, 1, 3, 5]);
  });

  it("differs for a different key or context", () => {
    const a = shuffledIndices(20, KEY, ["attempt-1", "question-7"]);
    expect(shuffledIndices(20, OTHER_KEY, ["attempt-1", "question-7"])).not.toEqual(a);
    expect(shuffledIndices(20, KEY, ["attempt-2", "question-7"])).not.toEqual(a);
    expect(shuffledIndices(20, KEY, ["attempt-1", "question-8"])).not.toEqual(a);
  });

  it("handles 0 and 1 items and rejects invalid sizes", () => {
    expect(shuffledIndices(0, KEY, ["a"])).toEqual([]);
    expect(shuffledIndices(1, KEY, ["a"])).toEqual([0]);
    for (const n of [-1, 1.5, 1_000_001]) expect(() => shuffledIndices(n, KEY, ["a"])).toThrow(RangeError);
  });

  it("property: always a permutation of 0..n-1", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), fc.array(fc.string(), { minLength: 1, maxLength: 3 }), (n, ctx) => {
        expect(isPermutation(shuffledIndices(n, KEY, ctx), n)).toBe(true);
      }),
    );
  });

  it("is uniform over the 6 orders of 3 options (chi-square, fixed contexts)", () => {
    const counts = new Map<string, number>();
    const samples = 12_000;
    for (let i = 0; i < samples; i++) {
      const key = shuffledIndices(3, KEY, ["attempt", String(i)]).join("");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    const expected = samples / 6;
    const chi2 = [...counts.values()].reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(20.52); // p = 0.001, 5 degrees of freedom
  });

  it("puts every item in every position equally often (10 items)", () => {
    const n = 10;
    const samples = 10_000;
    const grid = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < samples; i++) {
      shuffledIndices(n, KEY, ["pos", String(i)]).forEach((original, position) => {
        const row = grid[position] as number[];
        row[original] = (row[original] ?? 0) + 1;
      });
    }
    const expected = samples / n;
    const chi2 = grid.flat().reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(126.1); // p = 0.001, (10 - 1)^2 = 81 degrees of freedom
  });
});

describe("applyPermutation / invertPermutation", () => {
  it("applies a permutation and inverts it", () => {
    const options = ["A", "B", "C", "D"];
    const p = shuffledIndices(4, KEY, ["attempt-1", "q"]);
    const shown = applyPermutation(options, p);
    const inverse = invertPermutation(p);
    options.forEach((option, original) => {
      expect(shown[inverse[original] as number]).toBe(option);
    });
    expect(invertPermutation(inverse)).toEqual(p);
    expect(applyPermutation(["x", "y", "z"], [2, 0, 1])).toEqual(["z", "x", "y"]);
    expect(invertPermutation([2, 0, 1])).toEqual([1, 2, 0]);
  });

  it("property: inverse composes to the identity", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), fc.string(), (n, ctx) => {
        const p = shuffledIndices(n, KEY, [ctx]);
        const inv = invertPermutation(p);
        p.forEach((original, position) => {
          expect(inv[original]).toBe(position);
        });
      }),
    );
  });

  it("rejects non-permutations", () => {
    expect(() => applyPermutation(["a", "b"], [0])).toThrow(RangeError);
    expect(() => applyPermutation(["a", "b"], [0, 0])).toThrow(RangeError);
    expect(() => invertPermutation([0, 2])).toThrow(RangeError);
    expect(() => invertPermutation([0, -1])).toThrow(RangeError);
    expect(() => invertPermutation([0.5, 1])).toThrow(RangeError);
  });
});

describe("review item 12: the shuffle key must be bytes", () => {
  it("refuses a string key, even a long one", () => {
    const text = "a-shuffle-key-string-that-is-longer-than-32-chars";
    expect(() => shuffleSeed(text as unknown as Uint8Array, ["x"])).toThrow(RangeError);
    expect(() => shuffledIndices(4, text as unknown as Uint8Array, ["x"])).toThrow(RangeError);
  });
});
