// IDR money (plan M2.1: amounts are whole rupiah in bigint columns, `*_idr`). Values are JS
// safe integers; anything else (fractions, NaN, Infinity, |x| > 2^53 - 1) is rejected, and
// every intermediate product is computed in BigInt, so no float ever reaches a result.
//
// Gateway fees (AC-S10, plan M10 ROI): per payment method, flat IDR plus a percentage in basis
// points (1 bp = 0.01 %, 70 bp = 0.7 %). Rounding rule: the percentage part is rounded UP to
// the next whole rupiah (ceil), so a fee is never understated and the ROI report never
// overstates profit.
//
// ROI (AC-A8, plan M10): net = revenue - adnet payout (CPA) - gateway fee - ad spend. Net may
// be negative.

export const BPS_PER_UNIT = 10_000;

export interface GatewayFee {
  readonly flatIdr: number;
  /** 0..10000 (0 % .. 100 %). */
  readonly percentBps: number;
}

export interface ProfitInput {
  readonly revenueIdr: number;
  readonly payoutIdr: number;
  readonly gatewayFeeIdr: number;
  readonly adSpendIdr: number;
}

/** Asserts a whole-rupiah amount (may be negative, e.g. a net loss). */
export function assertIdr(value: number, name = "amount"): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer IDR amount`);
}

/** Asserts a whole-rupiah amount >= 0 (prices, fees, payouts, ad spend). */
export function assertNonNegativeIdr(value: number, name = "amount"): void {
  assertIdr(value, name);
  if (value < 0) throw new RangeError(`${name} must not be negative`);
}

function toSafe(value: bigint, name: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${name} overflows the safe integer range`);
  }
  return Number(value);
}

/** Checked sum of IDR amounts. */
export function sumIdr(values: readonly number[]): number {
  let total = 0n;
  values.forEach((v, i) => {
    assertIdr(v, `values[${String(i)}]`);
    total += BigInt(v);
  });
  return toSafe(total, "sum");
}

/** flat + ceil(gross * bps / 10000), in whole rupiah. */
export function gatewayFeeIdr(grossIdr: number, fee: GatewayFee): number {
  assertNonNegativeIdr(grossIdr, "grossIdr");
  assertNonNegativeIdr(fee.flatIdr, "flatIdr");
  if (!Number.isSafeInteger(fee.percentBps) || fee.percentBps < 0 || fee.percentBps > BPS_PER_UNIT) {
    throw new RangeError("percentBps must be an integer from 0 to 10000");
  }
  const scaled = BigInt(grossIdr) * BigInt(fee.percentBps);
  const unit = BigInt(BPS_PER_UNIT);
  const percentPart = (scaled + unit - 1n) / unit; // ceil for non-negative operands
  return toSafe(BigInt(fee.flatIdr) + percentPart, "fee");
}

/** revenue - payout - gateway fee - ad spend. */
export function netProfitIdr(input: ProfitInput): number {
  assertNonNegativeIdr(input.revenueIdr, "revenueIdr");
  assertNonNegativeIdr(input.payoutIdr, "payoutIdr");
  assertNonNegativeIdr(input.gatewayFeeIdr, "gatewayFeeIdr");
  assertNonNegativeIdr(input.adSpendIdr, "adSpendIdr");
  const net =
    BigInt(input.revenueIdr) - BigInt(input.payoutIdr) - BigInt(input.gatewayFeeIdr) - BigInt(input.adSpendIdr);
  return toSafe(net, "net");
}
