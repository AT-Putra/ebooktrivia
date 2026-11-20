// Outbox consumer framework (plan M3.5). A job carries only the outbox id. Per job:
//   1. claim   UPDATE outbox SET attempts = attempts + 1, available_at = now() + lease
//              WHERE id AND topic AND processed_at IS NULL AND available_at <= now() AND attempts < cap.
//              available_at doubles as the lease (no relay or claim takes the row before it passes);
//              the new attempts value is the claim's fencing token. No row = processed, leased by
//              another worker, backing off or capped: the job is a no-op.
//   2. perform the consumer's effect, outside any transaction, with an AbortSignal that fires
//              before the lease ends.
//   3. finalize one transaction: re-lock the row WHERE attempts = token AND processed_at IS NULL,
//              apply the consumer's DB writes, set processed_at and wipe `sealed`. A finisher whose
//              lease was lost (someone re-claimed: attempts moved on) commits nothing.
//   On an error the row is released with backoff (available_at) and last_error, conditioned on
//   the claim, and the job fails; the outbox sweeper re-relays it once available again.
// Exactly-once holds for what finalize commits. An effect OUTSIDE the database may run again if
// the process dies between perform and finalize (the lease expires, the row is re-claimed), so
// a consumer with an external side effect must route it through an effect row with its own
// claim/lease state machine (deliveries, conversion_events; see conversion-fire.ts) instead of
// performing it here.
//
// Error messages a consumer throws are stored in outbox.last_error and logged: they must not
// contain payload values or PII. As a backstop, emails and phone-like numbers are masked before
// last_error is written.
import type postgres from "postgres";
import type { Failpoint } from "./failpoint.ts";
import type { Logger } from "./log.ts";
import { maskPii } from "./pii.ts";
import { jobRowId } from "./queues.ts";

/** Claims stop after this many attempts; the outbox sweeper alerts on such rows. */
export const OUTBOX_MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;

export interface ClaimedOutboxRow {
  readonly id: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly sealed: Uint8Array | null;
  /** This claim's fencing token. */
  readonly attempts: number;
}

/** DB writes committed atomically with processed_at, only while the claim is current. */
export type FinalizeWrites = (tx: postgres.TransactionSql) => Promise<void>;

export interface OutboxConsumer {
  readonly topic: string;
  readonly leaseMs: number;
  /**
   * Claims stop after this many attempts (default OUTBOX_MAX_ATTEMPTS); the outbox sweeper then alerts.
   * With the backoff (30 s doubling up to 1 h) 10 attempts span about 4.4 h; a consumer that must keep
   * trying for longer (the Midtrans re-query: 24 h, US-021) raises it.
   */
  readonly maxAttempts?: number;
  /** Errors thrown here must carry no payload values or PII: they reach last_error and the logs. */
  perform(row: ClaimedOutboxRow, signal: AbortSignal): Promise<FinalizeWrites | undefined>;
}

export type OutboxResult = "processed" | "skipped" | "lease_lost";

class LeaseLost extends Error {}

const backoffMs = (attempts: number): number => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_MAX_MS);

export function createOutboxProcessor(
  consumer: OutboxConsumer,
  deps: { readonly sql: postgres.Sql; readonly failpoint: Failpoint; readonly log: Logger },
): (data: unknown) => Promise<OutboxResult> {
  const { sql } = deps;
  return async (data) => {
    const id = jobRowId(data);
    const [row] = await sql<{ id: string; topic: string; payload: unknown; sealed: Uint8Array | null; attempts: number }[]>`
      UPDATE public.outbox
         SET attempts = attempts + 1, available_at = now() + ${consumer.leaseMs} * interval '1 millisecond'
       WHERE id = ${id} AND topic = ${consumer.topic} AND processed_at IS NULL AND available_at <= now()
         AND attempts < ${consumer.maxAttempts ?? OUTBOX_MAX_ATTEMPTS}
      RETURNING id, topic, payload, sealed, attempts`;
    if (row === undefined) return "skipped";
    deps.failpoint("after_claim_before_effect");
    try {
      const writes = await consumer.perform(row, AbortSignal.timeout(Math.max(Math.floor(consumer.leaseMs * 0.9), 1)));
      await sql.begin(async (tx) => {
        const current = await tx`
          SELECT 1 FROM public.outbox WHERE id = ${id} AND attempts = ${row.attempts} AND processed_at IS NULL FOR UPDATE`;
        if (current.length === 0) throw new LeaseLost();
        if (writes !== undefined) await writes(tx);
        await tx`UPDATE public.outbox SET processed_at = now(), sealed = NULL, last_error = NULL WHERE id = ${id}`;
      });
      return "processed";
    } catch (error) {
      if (error instanceof LeaseLost) {
        deps.log.warn({ outboxId: id, topic: consumer.topic, attempts: row.attempts }, "outbox claim lost before finalize; nothing committed");
        return "lease_lost";
      }
      const message = maskPii(error instanceof Error ? error.message : "consumer failed").slice(0, 500);
      try {
        await sql`
          UPDATE public.outbox
             SET available_at = now() + ${backoffMs(row.attempts)} * interval '1 millisecond', last_error = ${message}
           WHERE id = ${id} AND attempts = ${row.attempts} AND processed_at IS NULL`;
      } catch (backoffError) {
        // The lease still expires on its own; the consumer's error is the one that matters.
        deps.log.error({ outboxId: id, topic: consumer.topic, err: backoffError, cause: message }, "outbox backoff could not be recorded");
      }
      throw error;
    }
  };
}
