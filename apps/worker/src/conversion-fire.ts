// Conversion-fire consumer (plan M3.5 / M7.1; AC-T3, AC-T4). Queue `conversion.fire`, job data
// { id: conversion_events.id }, job id `<id>-<attempts>` (deterministic per attempt, so the
// conversions sweeper and any retry of the same attempt dedupe to one job). BullMQ attempts: 1;
// PostgreSQL owns retries via next_attempt_at. The rules are core's conversion-machine:
//   1. claim   lock the row, claimConversion(row, now from the DB clock), conditional UPDATE to
//              sending with a lease and attempts + 1. Only one of any number of racing jobs wins.
//   2. fire    the injected FireConversion port, with a timeout shorter than the lease.
//   3. record  lock the row again, log the attempt in conversion_attempts (it happened, whatever
//              the row says now), recordConversionOutcome with this claim's attempt number, and a
//              conditional UPDATE. A stale finisher (lease lost, newer attempt) changes nothing.
// A process that dies between claim and record leaves the row `sending`; the lease sweeper
// (sweepers.ts) applies expireConversionLease, which never re-fires blindly. A process that only
// STALLED after its claim (GC pause, suspended VM) checks before firing that the request can still
// finish inside its lease (claim start + lease - request timeout - 1 s margin, on a monotonic
// clock read before the claim transaction); past that it does not fire and leaves the row
// `sending` for the sweeper (security review US-013 #4).
//
// The fire port: US-024 wires the real requests (adapters buildS2sRequest / buildMetaCapiRequest /
// buildTikTokEventRequest, sent with adapters sendConversion over safe-fetch; S2S secrets need the
// conversions private key). Until then the production worker registers no fire port, and the
// conversions sweeper enqueues nothing (worker.ts).
import {
  claimConversion,
  type ConversionDecision,
  type ConversionOutcome,
  type ConversionPatch,
  type ConversionRow,
  type ConversionStatus,
  recordConversionOutcome,
} from "@ebooktrivia/core";
import { performance } from "node:perf_hooks";
import type postgres from "postgres";
import type { Failpoint } from "./failpoint.ts";
import type { Logger } from "./log.ts";
import { jobRowId } from "./queues.ts";

export const CONVERSION_QUEUE = "conversion.fire";

export interface ConversionToFire {
  readonly id: string;
  readonly orderId: string;
  readonly sink: string;
  readonly kind: string;
  readonly adnetId: string | null;
  readonly txid: string;
  readonly eventId: string;
  readonly valueIdr: number | null;
  /** The attempt number this fire belongs to (conversion_attempts.attempt). */
  readonly attempt: number;
}

/** What one fire reports; adapters sendConversion's ConversionAttemptResult plus the log URL. */
export interface FireResult {
  readonly outcome: ConversionOutcome;
  readonly latencyMs: number;
  readonly responseSnippet: string;
  /** Log form of the request URL (secrets replaced); never the real URL or headers. */
  readonly requestUrlRedacted: string | null;
}

export type FireConversion = (event: ConversionToFire, signal: AbortSignal) => Promise<FireResult>;

/**
 * Whether a sink dedupes a repeat of the same txid / event_id, so an uncertain send may be retried
 * automatically. The default answers false for every sink (an uncertain send waits for the Owner's
 * manual re-fire); US-024 decides per sink / adnet (Meta and TikTok dedupe by event_id).
 */
export type SinkDedupePolicy = (event: { readonly sink: string; readonly adnetId: string | null }) => boolean;
export const NO_SINK_DEDUPES: SinkDedupePolicy = () => false;

export type ConversionResult = ConversionStatus | "skipped" | "stale";

interface EventRow {
  id: string;
  order_id: string;
  sink: string;
  kind: string;
  adnet_id: string | null;
  txid: string;
  event_id: string;
  value_idr: string | null;
  status: ConversionStatus;
  attempts: number;
  lease_until: Date | null;
  next_attempt_at: Date;
  now: Date;
}

const machineRow = (row: EventRow): ConversionRow => ({
  status: row.status,
  attempts: row.attempts,
  leaseUntil: row.lease_until,
  nextAttemptAt: row.next_attempt_at,
});

/** conversion_events columns for a core patch (only the fields the patch sets). */
export function conversionColumns(set: ConversionPatch, now: Date): Record<string, string | number | Date | null> {
  return {
    status: set.status,
    ...(set.attempts === undefined ? {} : { attempts: set.attempts }),
    ...(set.leaseUntil === undefined ? {} : { lease_until: set.leaseUntil }),
    ...(set.nextAttemptAt === undefined ? {} : { next_attempt_at: set.nextAttemptAt }),
    ...(set.lastHttpStatus === undefined ? {} : { last_http_status: set.lastHttpStatus }),
    ...(set.lastError === undefined ? {} : { last_error: set.lastError }),
    ...(set.sentAt === undefined ? {} : { sent_at: set.sentAt }),
    ...(set.failedAt === undefined ? {} : { failed_at: set.failedAt }),
    updated_at: now,
  };
}

/** Applies an accepted decision with `WHERE status = expect.status AND attempts = expect.attempts`. */
export async function applyConversionDecision(tx: postgres.TransactionSql, id: string, decision: ConversionDecision & { ok: true }, now: Date): Promise<void> {
  const result = await tx`
    UPDATE public.conversion_events SET ${tx(conversionColumns(decision.set, now))}
     WHERE id = ${id} AND status = ${decision.expect.status} AND attempts = ${decision.expect.attempts}`;
  if (result.count !== 1) throw new Error("conversion_events row changed under its row lock");
}

const lockEvent = (tx: postgres.TransactionSql, id: string) => tx<EventRow[]>`
  SELECT id, order_id, sink, kind, adnet_id, txid, event_id, value_idr::text AS value_idr, status, attempts, lease_until,
         next_attempt_at, clock_timestamp() AS now
    FROM public.conversion_events WHERE id = ${id} FOR UPDATE`;

/** value_idr as a JS number, or undefined when it cannot be one exactly. */
function valueIdr(row: EventRow): number | null | undefined {
  if (row.value_idr === null) return null;
  const value = Number(row.value_idr);
  return Number.isSafeInteger(value) ? value : undefined;
}

const toFire = (row: EventRow, valueIdr: number | null, attempt: number): ConversionToFire => ({
  id: row.id,
  orderId: row.order_id,
  sink: row.sink,
  kind: row.kind,
  adnetId: row.adnet_id,
  txid: row.txid,
  eventId: row.event_id,
  valueIdr,
  attempt,
});

/** A row that can never be sent: failed (terminal; the Owner may fix it and re-fire), never claimed. */
const UNSENDABLE_VALUE = "value_idr is outside the safe integer range; not sent";

export interface ConversionDeps {
  readonly sql: postgres.Sql;
  readonly fire: FireConversion;
  readonly failpoint: Failpoint;
  readonly log: Logger;
  readonly leaseMs: number;
  readonly requestTimeoutMs: number;
  readonly sinkDedupesByTxid?: SinkDedupePolicy;
  /** Monotonic milliseconds; default performance.now. Injectable for tests. */
  readonly clock?: () => number;
}

/** Safety margin between the latest fire and the end of the lease. */
const FIRE_MARGIN_MS = 1000;

export function createConversionProcessor(deps: ConversionDeps): (data: unknown) => Promise<ConversionResult> {
  const { sql } = deps;
  const dedupes = deps.sinkDedupesByTxid ?? NO_SINK_DEDUPES;
  const clock = deps.clock ?? (() => performance.now());
  return async (data) => {
    // Read before the claim transaction: lease_until is set from the DB clock later than this, so
    // a stall anywhere after (the commit round trip, a delayed continuation) eats into the budget.
    const claimStarted = clock();
    const id = jobRowId(data);
    const event = await sql.begin(async (tx) => {
      const [row] = await lockEvent(tx, id);
      if (row === undefined) return undefined;
      const decision = claimConversion(machineRow(row), { now: row.now, leaseMs: deps.leaseMs, requestTimeoutMs: deps.requestTimeoutMs });
      if (!decision.ok) return undefined;
      const value = valueIdr(row);
      if (value === undefined) {
        // Code review US-013 #10: a claimable row that can never be sent is failed, not retried
        // every sweep forever.
        await tx`
          UPDATE public.conversion_events
             SET status = 'failed', failed_at = ${row.now}, lease_until = NULL, last_error = ${UNSENDABLE_VALUE}, updated_at = ${row.now}
           WHERE id = ${id} AND status = ${row.status} AND attempts = ${row.attempts}`;
        return "unsendable" as const;
      }
      await applyConversionDecision(tx, id, decision, row.now);
      return toFire(row, value, decision.set.attempts ?? row.attempts + 1);
    });
    if (event === undefined) return "skipped";
    if (event === "unsendable") {
      deps.log.error({ conversionEventId: id }, UNSENDABLE_VALUE);
      return "failed";
    }
    const fireBy = claimStarted + deps.leaseMs - deps.requestTimeoutMs - FIRE_MARGIN_MS;
    deps.failpoint("conversion_after_claim");
    if (clock() > fireBy) {
      deps.log.warn({ conversionEventId: id, attempt: event.attempt }, "conversion claim too old to fire inside its lease; left to the lease sweeper");
      return "stale";
    }

    let result: FireResult;
    try {
      result = await deps.fire(event, AbortSignal.timeout(deps.requestTimeoutMs));
    } catch (error) {
      // The port could not say whether the request left: treat it as possibly sent.
      result = { outcome: { kind: "maybe_sent", error: error instanceof Error ? error.message : "fire failed" }, latencyMs: 0, responseSnippet: "", requestUrlRedacted: null };
    }
    deps.failpoint("conversion_after_fire");

    return sql.begin(async (tx) => {
      const [row] = await lockEvent(tx, id);
      if (row === undefined) {
        deps.log.warn({ conversionEventId: id, attempt: event.attempt }, "conversion event deleted while firing; outcome dropped");
        return "stale";
      }
      const { outcome } = result;
      await tx`
        INSERT INTO public.conversion_attempts
               (conversion_event_id, attempt, request_url_redacted, http_status, response_excerpt, latency_ms, error)
        VALUES (${id}, ${event.attempt}, ${result.requestUrlRedacted}, ${outcome.kind === "maybe_sent" ? null : outcome.httpStatus},
                ${result.responseSnippet === "" ? null : result.responseSnippet.slice(0, 2048)}, ${Math.max(0, Math.round(result.latencyMs))},
                ${outcome.kind === "sent" ? null : outcome.error.slice(0, 500)})`;
      const decision = recordConversionOutcome(machineRow(row), outcome, { now: row.now, attempt: event.attempt, sinkDedupesByTxid: dedupes(event) });
      if (!decision.ok) {
        deps.log.warn({ conversionEventId: id, attempt: event.attempt, reason: decision.reason }, "conversion outcome not applied");
        return "stale";
      }
      await applyConversionDecision(tx, id, decision, row.now);
      return decision.set.status;
    });
  };
}
