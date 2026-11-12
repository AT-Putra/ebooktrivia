import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertIdr, assertNonNegativeIdr, gatewayFeeIdr, netProfitIdr, sumIdr } from "./money.ts";

const MAX = Number.MAX_SAFE_INTEGER;

describe("IDR amount guards", () => {
  it("accepts whole rupiah and rejects fractions, NaN, Infinity and unsafe integers", () => {
    expect(() => {
      assertIdr(0);
      assertIdr(-49_000);
      assertIdr(MAX);
      assertNonNegativeIdr(49_000);
    }).not.toThrow();
    for (const bad of [0.5, 49_000.01, Number.NaN, Number.POSITIVE_INFINITY, MAX + 1, -(MAX + 1)]) {
      expect(() => {
        assertIdr(bad);
      }).toThrow(RangeError);
    }
    expect(() => {
      assertNonNegativeIdr(-1, "price");
    }).toThrow(/price must not be negative/);
  });

  it("sums with overflow detection", () => {
    expect(sumIdr([])).toBe(0);
    expect(sumIdr([49_000, 51_000, -10_000])).toBe(90_000);
    expect(sumIdr([MAX, -MAX])).toBe(0);
    expect(() => sumIdr([MAX, 1])).toThrow(/overflows/);
    expect(() => sumIdr([1, 0.1])).toThrow(/values\[1\]/);
  });
});

describe("gatewayFeeIdr: flat + ceil(gross * bps / 10000)", () => {
  it("computes flat-only, percent-only and combined fees", () => {
    expect(gatewayFeeIdr(49_000, { flatIdr: 4_000, percentBps: 0 })).toBe(4_000); // VA flat
    expect(gatewayFeeIdr(49_000, { flatIdr: 0, percentBps: 70 })).toBe(343); // QRIS 0.7 % = 343 exactly
    expect(gatewayFeeIdr(49_000, { flatIdr: 0, percentBps: 200 })).toBe(980); // GoPay 2 %
    expect(gatewayFeeIdr(49_000, { flatIdr: 2_000, percentBps: 290 })).toBe(3_421); // 2000 + 1421
  });

  it("rounds the percentage part up to the next rupiah", () => {
    expect(gatewayFeeIdr(49_999, { flatIdr: 0, percentBps: 70 })).toBe(350); // 349.993 -> 350
    expect(gatewayFeeIdr(1, { flatIdr: 0, percentBps: 1 })).toBe(1); // 0.0001 -> 1
    expect(gatewayFeeIdr(0, { flatIdr: 0, percentBps: 70 })).toBe(0);
    expect(gatewayFeeIdr(10_000, { flatIdr: 0, percentBps: 10_000 })).toBe(10_000);
  });

  it("uses exact integer arithmetic for amounts where floats lose precision", () => {
    // MAX * 1 bp = 900719925474.0991 -> ceil 900719925475 (a float product would round first).
    expect(gatewayFeeIdr(MAX, { flatIdr: 0, percentBps: 1 })).toBe(900_719_925_475);
    expect(() => gatewayFeeIdr(MAX, { flatIdr: 1, percentBps: 10_000 })).toThrow(/overflows/);
  });

  it("rejects invalid inputs", () => {
    expect(() => gatewayFeeIdr(-1, { flatIdr: 0, percentBps: 0 })).toThrow(RangeError);
    expect(() => gatewayFeeIdr(1.5, { flatIdr: 0, percentBps: 0 })).toThrow(RangeError);
    expect(() => gatewayFeeIdr(1, { flatIdr: -1, percentBps: 0 })).toThrow(RangeError);
    expect(() => gatewayFeeIdr(1, { flatIdr: 0, percentBps: 10_001 })).toThrow(RangeError);
    expect(() => gatewayFeeIdr(1, { flatIdr: 0, percentBps: -1 })).toThrow(RangeError);
    expect(() => gatewayFeeIdr(1, { flatIdr: 0, percentBps: 0.5 })).toThrow(RangeError);
  });

  it("property: integer, >= flat, within 1 rupiah above the exact fee", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (gross, flatIdr, percentBps) => {
          const fee = gatewayFeeIdr(gross, { flatIdr, percentBps });
          expect(Number.isSafeInteger(fee)).toBe(true);
          const exactTimes10k = BigInt(gross) * BigInt(percentBps); // exact percent part * 10000
          const pct = BigInt(fee - flatIdr) * 10_000n;
          expect(pct >= exactTimes10k).toBe(true);
          expect(pct - exactTimes10k < 10_000n).toBe(true);
        },
      ),
    );
  });
});

describe("netProfitIdr: revenue - payout - gateway fee - ad spend", () => {
  it("computes net profit and losses", () => {
    expect(netProfitIdr({ revenueIdr: 4_900_000, payoutIdr: 1_500_000, gatewayFeeIdr: 34_300, adSpendIdr: 2_000_000 })).toBe(
      1_365_700,
    );
    expect(netProfitIdr({ revenueIdr: 0, payoutIdr: 0, gatewayFeeIdr: 0, adSpendIdr: 750_000 })).toBe(-750_000);
  });

  it("rejects negative or fractional components and overflow", () => {
    const ok = { revenueIdr: 1, payoutIdr: 0, gatewayFeeIdr: 0, adSpendIdr: 0 };
    expect(() => netProfitIdr({ ...ok, payoutIdr: -1 })).toThrow(RangeError);
    expect(() => netProfitIdr({ ...ok, adSpendIdr: 0.5 })).toThrow(RangeError);
    expect(() => netProfitIdr({ ...ok, revenueIdr: -1 })).toThrow(RangeError);
    expect(() => netProfitIdr({ ...ok, gatewayFeeIdr: Number.NaN })).toThrow(RangeError);
    expect(() => netProfitIdr({ revenueIdr: 0, payoutIdr: MAX, gatewayFeeIdr: MAX, adSpendIdr: 0 })).toThrow(/overflows/);
  });
});
