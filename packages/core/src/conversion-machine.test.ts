import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  claimConversion,
  CONVERSION_MAX_ATTEMPTS,
  CONVERSION_STATUSES,
  conversionOutcomeFromHttp,
  expireConversionLease,
  recordConversionOutcome,
  type ConversionDecision,
  type ConversionOutcome,
  type ConversionPatch,
  type ConversionRow,
} from "./conversion-machine.ts";

const T0 = new Date("2027-06-01T03:00:00.000Z");
const LEASE = 30_000;
const MIN = 60_000;
const at = (ms: number): Date => new Date(T0.getTime() + ms);

const row = (over: Partial<ConversionRow> = {}): ConversionRow => ({
  status: "pending",
  attempts: 0,
  leaseUntil: null,
  nextAttemptAt: T0,
  ...over,
});
const sending = (attempts: number): ConversionRow => row({ status: "sending", attempts, leaseUntil: at(LEASE) });

function ok(decision: ConversionDecision): ConversionPatch {
  if (!decision.ok) throw new Error(`expected ok, got ${decision.reason}`);
  return decision.set;
}
const reason = (decision: ConversionDecision): string | undefined => (decision.ok ? undefined : decision.reason);

describe("conversionOutcomeFromHttp (AC-T3: success = 2xx)", () => {
  it.each([200, 201, 204, 299])("%i is sent", (status) => {
    expect(conversionOutcomeFromHttp(status)).toEqual({ kind: "sent", httpStatus: status });
  });
  it.each([100, 199, 300, 302, 404, 429, 500, 503])("%i is a failure", (status) => {
    expect(conversionOutcomeFromHttp(status)).toEqual({ kind: "failed", httpStatus: status, error: `HTTP ${String(status)}` });
  });
  it("rejects a non-integer status", () => {
    expect(() => conversionOutcomeFromHttp(200.5)).toThrow(RangeError);
  });
});

describe("claimConversion", () => {
  it("claims a due pending row with a lease", () => {
    expect(claimConversion(row(), { now: T0, leaseMs: LEASE, requestTimeoutMs: 10_000 })).toEqual({
      ok: true,
      expect: { status: "pending", attempts: 0 },
      set: { status: "sending", attempts: 1, leaseUntil: at(LEASE) },
    });
  });

  it("waits for next_attempt_at", () => {
    expect(reason(claimConversion(row({ nextAttemptAt: at(1) }), { now: T0, leaseMs: LEASE, requestTimeoutMs: 10_000 }))).toBe("not_due");
  });

  it.each(CONVERSION_STATUSES.filter((s) => s !== "pending"))("refuses a %s row", (status) => {
    expect(reason(claimConversion(row({ status }), { now: T0, leaseMs: LEASE, requestTimeoutMs: 10_000 }))).toBe("not_pending");
  });

  it("rejects an invalid lease", () => {
    expect(() => claimConversion(row(), { now: T0, leaseMs: 0, requestTimeoutMs: 10_000 })).toThrow(RangeError);
  });
});

describe("recordConversionOutcome", () => {
  it("2xx -> sent", () => {
    expect(ok(recordConversionOutcome(sending(1), { kind: "sent", httpStatus: 204 }, { now: at(1_000), attempt: 1 }))).toEqual({
      status: "sent",
      leaseUntil: null,
      sentAt: at(1_000),
      lastHttpStatus: 204,
      lastError: null,
    });
  });

  it("retries at 1m / 5m / 30m / 2h / 12h, then fails after the 6th attempt", () => {
    const delays = [MIN, 5 * MIN, 30 * MIN, 120 * MIN, 720 * MIN];
    delays.forEach((delay, i) => {
      const attempt = i + 1;
      expect(
        ok(recordConversionOutcome(sending(attempt), { kind: "failed", httpStatus: 500, error: "HTTP 500" }, { now: T0, attempt })),
      ).toEqual({ status: "pending", leaseUntil: null, nextAttemptAt: at(delay), lastHttpStatus: 500, lastError: "HTTP 500" });
    });
    expect(CONVERSION_MAX_ATTEMPTS).toBe(6);
    expect(
      ok(recordConversionOutcome(sending(6), { kind: "failed", httpStatus: 500, error: "HTTP 500" }, { now: T0, attempt: 6 })),
    ).toEqual({ status: "failed", leaseUntil: null, failedAt: T0, lastHttpStatus: 500, lastError: "HTTP 500" });
    // Defensive: an inconsistent sending row with 0 attempts fails instead of retrying blindly.
    expect(ok(recordConversionOutcome(sending(0), { kind: "failed", httpStatus: null, error: "x" }, { now: T0, attempt: 0 })).status).toBe(
      "failed",
    );
  });

  it("maybe sent (timeout after the request left) is retried with the same txid, like a failure", () => {
    expect(ok(recordConversionOutcome(sending(1), { kind: "maybe_sent", error: "timeout" }, { now: T0, attempt: 1, sinkDedupesByTxid: true }))).toEqual({
      status: "pending",
      leaseUntil: null,
      nextAttemptAt: at(MIN),
      lastHttpStatus: null,
      lastError: "timeout",
    });
  });

  it("rejects stale workers and rows that are not sending", () => {
    expect(reason(recordConversionOutcome(sending(2), { kind: "sent", httpStatus: 200 }, { now: T0, attempt: 1 }))).toBe("stale");
    // Only a late 2xx may land outside `sending` (see H1 below); failures never do.
    expect(reason(recordConversionOutcome(row({ status: "sent", attempts: 1 }), { kind: "sent", httpStatus: 200 }, { now: T0, attempt: 1 }))).toBe(
      "not_sending",
    );
    for (const status of CONVERSION_STATUSES.filter((s) => s !== "sending")) {
      for (const outcome of [
        { kind: "failed", httpStatus: 500, error: "e" },
        { kind: "maybe_sent", error: "t" },
      ] as const) {
        expect(reason(recordConversionOutcome(row({ status, attempts: 1 }), outcome, { now: T0, attempt: 1 }))).toBe("not_sending");
      }
    }
  });
});

describe("expireConversionLease", () => {
  it("retries a crashed sender's row after its lease", () => {
    expect(ok(expireConversionLease(sending(2), at(LEASE), { sinkDedupesByTxid: true }))).toEqual({
      status: "pending",
      leaseUntil: null,
      nextAttemptAt: at(LEASE + 5 * MIN),
      lastHttpStatus: null,
      lastError: "lease expired while sending",
    });
    expect(ok(expireConversionLease(sending(6), at(LEASE), { sinkDedupesByTxid: true })).status).toBe("failed");
    expect(ok(expireConversionLease(row({ status: "sending", attempts: 1, leaseUntil: null }), T0, { sinkDedupesByTxid: true })).status).toBe("pending");
  });

  it("leaves an active lease alone and ignores other states", () => {
    expect(reason(expireConversionLease(sending(1), at(LEASE - 1)))).toBe("lease_active");
    for (const status of CONVERSION_STATUSES.filter((s) => s !== "sending")) {
      expect(reason(expireConversionLease(row({ status }), at(LEASE * 100)))).toBe("not_sending");
    }
  });
});

describe("conversion machine: random operation sequences (AC-T4)", () => {
  type Op =
    | { readonly op: "claim" }
    | { readonly op: "outcome"; readonly outcome: ConversionOutcome; readonly stale: boolean }
    | { readonly op: "expire" }
    | { readonly op: "wait"; readonly ms: number };
  const arbOp: fc.Arbitrary<Op> = fc.oneof(
    fc.constant({ op: "claim" as const }),
    fc.record({
      op: fc.constant("outcome" as const),
      outcome: fc.constantFrom<ConversionOutcome>(
        { kind: "sent", httpStatus: 200 },
        { kind: "failed", httpStatus: 503, error: "HTTP 503" },
        { kind: "maybe_sent", error: "timeout" },
      ),
      stale: fc.boolean(),
    }),
    fc.constant({ op: "expire" as const }),
    fc.record({ op: fc.constant("wait" as const), ms: fc.integer({ min: 0, max: 13 * 60 * MIN }) }),
  );

  it("fires at most 6 times, records sent at most once, never refuses the latest attempt's 2xx", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 60 }), fc.boolean(), (ops, sinkDedupesByTxid) => {
        let state = row();
        let now = T0;
        let fires = 0;
        let sentRecords = 0;
        for (const step of ops) {
          if (step.op === "wait") {
            now = new Date(now.getTime() + step.ms);
            continue;
          }
          const decision =
            step.op === "claim"
              ? claimConversion(state, { now, leaseMs: LEASE, requestTimeoutMs: 10_000 })
              : step.op === "expire"
                ? expireConversionLease(state, now, { sinkDedupesByTxid })
                : recordConversionOutcome(state, step.outcome, {
                    now,
                    attempt: state.attempts + (step.stale ? 1 : 0),
                    sinkDedupesByTxid,
                  });
          if (state.status === "sent") expect(decision.ok).toBe(false);
          // A failed row only ever accepts the late 2xx of its last attempt.
          if (state.status === "failed" && decision.ok) expect(decision.set.status).toBe("sent");
          // H1: the 2xx of the latest fired attempt is always recorded (else it would be fired again).
          if (step.op === "outcome" && step.outcome.kind === "sent" && !step.stale && state.attempts >= 1 && state.status !== "sent") {
            expect(decision.ok).toBe(true);
          }
          // Without txid dedupe an uncertain send is never retried automatically.
          if (!sinkDedupesByTxid && decision.ok && decision.set.status === "pending") {
            expect(step.op === "outcome" && step.outcome.kind === "failed").toBe(true);
          }
          if (!decision.ok) continue;
          expect(decision.expect).toEqual({ status: state.status, attempts: state.attempts });
          if (step.op === "claim") fires++;
          if (decision.set.status === "sent") sentRecords++;
          state = { ...state, ...decision.set };
        }
        expect(fires).toBeLessThanOrEqual(CONVERSION_MAX_ATTEMPTS);
        expect(sentRecords).toBeLessThanOrEqual(1);
        expect(state.attempts).toBe(fires);
      }),
    );
  });
});

describe("review fixes: late 2xx (H1) and txid dedupe (item 1)", () => {
  const apply = (state: ConversionRow, decision: ConversionDecision): ConversionRow => {
    if (!decision.ok) throw new Error(`expected ok, got ${decision.reason}`);
    return { ...state, ...decision.set };
  };
  const claim = (state: ConversionRow, now: Date) =>
    apply(state, claimConversion(state, { now, leaseMs: LEASE, requestTimeoutMs: 10_000 }));

  it("H1: claim, lease expires, late 2xx for that attempt -> sent (no second fire)", () => {
    const claimed = claim(row(), T0);
    const expired = apply(claimed, expireConversionLease(claimed, at(LEASE), { sinkDedupesByTxid: true }));
    expect(expired).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: at(LEASE + MIN) });
    const late = recordConversionOutcome(expired, { kind: "sent", httpStatus: 200 }, { now: at(LEASE + 5_000), attempt: 1 });
    expect(late).toMatchObject({ ok: true, expect: { status: "pending", attempts: 1 }, set: { status: "sent", lastHttpStatus: 200 } });
  });

  it("H1: claim, expire, re-claim, late 2xx for attempt 1 -> stale", () => {
    const claimed = claim(row(), T0);
    const expired = apply(claimed, expireConversionLease(claimed, at(LEASE), { sinkDedupesByTxid: true }));
    const reclaimed = claim(expired, at(LEASE + MIN));
    expect(reclaimed.attempts).toBe(2);
    expect(reason(recordConversionOutcome(reclaimed, { kind: "sent", httpStatus: 200 }, { now: at(LEASE + MIN + 1), attempt: 1 }))).toBe(
      "stale",
    );
  });

  it("H1: at attempt 6 the sweeper fails the row; the late 2xx still records sent", () => {
    const sixth = row({ status: "sending", attempts: 6, leaseUntil: at(LEASE) });
    const failed = apply(sixth, expireConversionLease(sixth, at(LEASE), { sinkDedupesByTxid: true }));
    expect(failed.status).toBe("failed");
    expect(ok(recordConversionOutcome(failed, { kind: "sent", httpStatus: 204 }, { now: at(LEASE + 1), attempt: 6 })).status).toBe("sent");
  });

  it("H1: a never-claimed pending row cannot be marked sent", () => {
    expect(reason(recordConversionOutcome(row(), { kind: "sent", httpStatus: 200 }, { now: T0, attempt: 0 }))).toBe("not_sending");
  });

  it("H1: the request timeout must be shorter than the lease", () => {
    expect(() => claimConversion(row(), { now: T0, leaseMs: LEASE, requestTimeoutMs: LEASE })).toThrow(RangeError);
    expect(() => claimConversion(row(), { now: T0, leaseMs: LEASE, requestTimeoutMs: 0 })).toThrow(RangeError);
  });

  it("item 1: without txid dedupe, maybe sent fails for a manual re-fire instead of retrying", () => {
    for (const ctx of [{ now: T0, attempt: 1 }, { now: T0, attempt: 1, sinkDedupesByTxid: false }]) {
      const set = ok(recordConversionOutcome(sending(1), { kind: "maybe_sent", error: "timeout" }, ctx));
      expect(set).toMatchObject({ status: "failed", failedAt: T0, leaseUntil: null });
      expect(set.lastError).toContain("needs manual re-fire");
    }
    const retried = ok(recordConversionOutcome(sending(1), { kind: "maybe_sent", error: "timeout" }, { now: T0, attempt: 1, sinkDedupesByTxid: true }));
    expect(retried).toMatchObject({ status: "pending", nextAttemptAt: at(MIN) });
  });

  it("item 1: without txid dedupe, an expired lease fails for a manual re-fire", () => {
    const set = ok(expireConversionLease(sending(2), at(LEASE)));
    expect(set).toMatchObject({ status: "failed", failedAt: at(LEASE) });
    expect(set.lastError).toContain("needs manual re-fire");
    expect(ok(expireConversionLease(sending(2), at(LEASE), { sinkDedupesByTxid: true })).status).toBe("pending");
  });

  it("item 1: a definite non-2xx is still retried without txid dedupe", () => {
    expect(ok(recordConversionOutcome(sending(1), { kind: "failed", httpStatus: 503, error: "HTTP 503" }, { now: T0, attempt: 1 })).status).toBe(
      "pending",
    );
  });
});
