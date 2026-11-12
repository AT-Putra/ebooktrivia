// Conversion (S2S postback / CAPI) state machine (plan M7.1, M3.5; spec AC-T3, AC-T4):
// claim -> lease -> outcome, retries owned by PostgreSQL via next_attempt_at.
//
//   claim     pending and next_attempt_at <= now -> sending (lease_until, attempts + 1). The
//             HTTP request timeout must be shorter than the lease, so a live worker always
//             reports before the sweeper can expire its lease.
//   outcome   HTTP 2xx -> sent. A late 2xx for the latest claimed attempt is still accepted
//               after the sweeper moved the row to pending or failed: re-firing would pay the
//               CPA twice. A re-claim bumps attempts, so the conditional UPDATE only wins while
//               no newer attempt has been fired.
//             failure (non-2xx, network error before sending) -> pending at now +
//               CONVERSION_RETRY_DELAYS_MS (1m / 5m / 30m / 2h / 12h after attempts 1..5),
//               then failed after attempt 6. Caller contract (M3 HTTP adapter): without a
//               received response, an error is "failed" only when no request bytes left the
//               process (DNS, connect or TLS handshake failure before the request was
//               written); any error after the request was written, including a timeout or a
//               reset while waiting for the response, is maybe_sent.
//             maybe sent (timeout after the request left) and an expired lease: the send may
//               have counted. Only when the sink dedupes by the stable txid (S2S) / event_id
//               (CAPI) is it retried automatically; otherwise (the default) it becomes failed
//               with a "needs manual re-fire" reason, so it is never fired twice blindly.
//               Meta / TikTok CAPI dedupe by event_id and may pass sinkDedupesByTxid: true;
//               for adnets this needs a per-adnet setting (planned adnets.dedupes_by_txid, M7).
// conversion_status has no `unknown` state: an uncertain send is either retried (dedupe) or
// left failed for the Owner's manual re-fire (an Owner transition, M7/M10; not in core yet).
// Each decision carries the expected status + attempts for a conditional UPDATE.

/** Same values and order as the DB enum conversion_status (packages/db/src/schema/tracking.ts). */
export const CONVERSION_STATUSES = ["pending", "sending", "sent", "failed"] as const;
export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];

/** AC-T3 retry schedule; delay i applies after failed attempt i + 1, counted from that failure. */
export const CONVERSION_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
];
/** First attempt + 5 retries. */
export const CONVERSION_MAX_ATTEMPTS = CONVERSION_RETRY_DELAYS_MS.length + 1;
/** Prefix of last_error for an uncertain send that the Owner must re-fire by hand. */
export const NEEDS_MANUAL_REFIRE = "needs manual re-fire";

export interface ConversionRow {
  readonly status: ConversionStatus;
  readonly attempts: number;
  readonly leaseUntil: Date | null;
  readonly nextAttemptAt: Date;
}

export interface ConversionPatch {
  readonly status: ConversionStatus;
  readonly attempts?: number;
  readonly leaseUntil?: Date | null;
  readonly nextAttemptAt?: Date;
  readonly lastHttpStatus?: number | null;
  readonly lastError?: string | null;
  readonly sentAt?: Date;
  readonly failedAt?: Date;
}

export type ConversionRejection = "not_pending" | "not_due" | "not_sending" | "stale" | "lease_active";

export type ConversionDecision =
  | {
      readonly ok: true;
      readonly expect: { readonly status: ConversionStatus; readonly attempts: number };
      readonly set: ConversionPatch;
    }
  | { readonly ok: false; readonly reason: ConversionRejection };

export type ConversionOutcome =
  | { readonly kind: "sent"; readonly httpStatus: number }
  | { readonly kind: "failed"; readonly httpStatus: number | null; readonly error: string }
  | { readonly kind: "maybe_sent"; readonly error: string };

export interface SinkDedupe {
  /** The sink dedupes a repeat of the same txid / event_id. Absent = false (no blind retry). */
  readonly sinkDedupesByTxid?: boolean;
}

const reject = (reason: ConversionRejection): ConversionDecision => ({ ok: false, reason });
const accept = (row: ConversionRow, set: ConversionPatch): ConversionDecision => ({
  ok: true,
  expect: { status: row.status, attempts: row.attempts },
  set,
});

function assertPositiveMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer (ms)`);
}

/** AC-T3: success = HTTP 2xx; anything else is a failure to retry. */
export function conversionOutcomeFromHttp(httpStatus: number, error = `HTTP ${String(httpStatus)}`): ConversionOutcome {
  if (!Number.isInteger(httpStatus)) throw new RangeError("httpStatus must be an integer");
  return httpStatus >= 200 && httpStatus <= 299 ? { kind: "sent", httpStatus } : { kind: "failed", httpStatus, error };
}

export function claimConversion(
  row: ConversionRow,
  ctx: { readonly now: Date; readonly leaseMs: number; readonly requestTimeoutMs: number },
): ConversionDecision {
  assertPositiveMs(ctx.leaseMs, "leaseMs");
  assertPositiveMs(ctx.requestTimeoutMs, "requestTimeoutMs");
  if (ctx.requestTimeoutMs >= ctx.leaseMs) throw new RangeError("requestTimeoutMs must be shorter than leaseMs");
  if (row.status !== "pending") return reject("not_pending");
  if (ctx.now.getTime() < row.nextAttemptAt.getTime()) return reject("not_due");
  return accept(row, {
    status: "sending",
    attempts: row.attempts + 1,
    leaseUntil: new Date(ctx.now.getTime() + ctx.leaseMs),
  });
}

function retryOrFail(row: ConversionRow, now: Date, httpStatus: number | null, error: string): ConversionDecision {
  const delay = CONVERSION_RETRY_DELAYS_MS[row.attempts - 1];
  if (row.attempts >= CONVERSION_MAX_ATTEMPTS || delay === undefined) {
    return accept(row, { status: "failed", leaseUntil: null, failedAt: now, lastHttpStatus: httpStatus, lastError: error });
  }
  return accept(row, {
    status: "pending",
    leaseUntil: null,
    nextAttemptAt: new Date(now.getTime() + delay),
    lastHttpStatus: httpStatus,
    lastError: error,
  });
}

/** The send may have counted: retry only when the sink dedupes, else wait for a manual re-fire. */
function uncertain(row: ConversionRow, now: Date, error: string, opts: SinkDedupe): ConversionDecision {
  if (opts.sinkDedupesByTxid === true) return retryOrFail(row, now, null, error);
  return accept(row, {
    status: "failed",
    leaseUntil: null,
    failedAt: now,
    lastHttpStatus: null,
    lastError: `${NEEDS_MANUAL_REFIRE} (the send may have counted): ${error}`,
  });
}

export function recordConversionOutcome(
  row: ConversionRow,
  outcome: ConversionOutcome,
  ctx: { readonly now: Date; readonly attempt: number } & SinkDedupe,
): ConversionDecision {
  if (row.attempts !== ctx.attempt) return reject("stale");
  if (outcome.kind === "sent" && row.attempts >= 1 && (row.status === "pending" || row.status === "failed")) {
    // Late 2xx after the sweeper expired the lease: the conversion did count.
    return accept(row, { status: "sent", leaseUntil: null, sentAt: ctx.now, lastHttpStatus: outcome.httpStatus, lastError: null });
  }
  if (row.status !== "sending") return reject("not_sending");
  switch (outcome.kind) {
    case "sent":
      return accept(row, {
        status: "sent",
        leaseUntil: null,
        sentAt: ctx.now,
        lastHttpStatus: outcome.httpStatus,
        lastError: null,
      });
    case "failed":
      return retryOrFail(row, ctx.now, outcome.httpStatus, outcome.error);
    case "maybe_sent":
      return uncertain(row, ctx.now, outcome.error, ctx);
  }
}

/** Sweeper: a crashed sender's row (the send may have counted). */
export function expireConversionLease(row: ConversionRow, now: Date, opts: SinkDedupe = {}): ConversionDecision {
  if (row.status !== "sending") return reject("not_sending");
  if (row.leaseUntil !== null && now.getTime() < row.leaseUntil.getTime()) return reject("lease_active");
  return uncertain(row, now, "lease expired while sending", opts);
}
