// The Owner's review queue on the worker side (US-033, M10c; docs/runbooks/order-review.md):
//   latestOwnerDecision  the order's latest decision (order_owner_decisions, written by the console through
//                        public.order_review_decide), which payments.ts applyRequery and the nightly reconciliation honour
//                        (core decisionCoversRequery / decisionCoversReconciliation). Read under the order's row lock.
//   alertStuckReviews    the minute sweep: one warning alert per order that has been in review for more than 24 hours (core
//                        REVIEW_STUCK_AFTER_MS), ONCE per stay in review (the dedupe key names the order and the instant it
//                        entered review, and no alert is raised while ANY alert with that key exists, resolved or not).
import { type OrderStatus, parseFingerprint, type RecordedDecision, REVIEW_STUCK_AFTER_MS } from "@ebooktrivia/core";
import type postgres from "postgres";

/** The order's latest Owner decision, or null (none, or a fingerprint that is not one: then nothing is honoured). */
export async function latestOwnerDecision(tx: postgres.TransactionSql, orderId: string): Promise<RecordedDecision | null> {
  const [row] = await tx<{ to_status: OrderStatus; attempts: unknown }[]>`
    SELECT to_status::text AS to_status, attempts FROM public.order_owner_decisions
     WHERE order_id = ${orderId} ORDER BY decided_at DESC, id DESC LIMIT 1`;
  if (row === undefined) return null;
  const attempts = parseFingerprint(row.attempts);
  return attempts === null ? null : { toStatus: row.to_status, attempts };
}

/** Raises the stuck-in-review warnings due at `at` (default the database clock; at most 500 per sweep); returns how many. */
export async function alertStuckReviews(sql: postgres.Sql, at?: Date): Promise<number> {
  return sql.begin(async (tx) => {
    // Two worker processes sweeping at once raise each alert once.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('order_review_stuck', 0))`;
    const inserted = await tx`
      WITH stuck AS (
        SELECT o.id, o.review_since, 'order_review_stuck:' || o.id::text || ':' || (extract(epoch FROM o.review_since) * 1000000)::bigint::text AS dedupe_key
          FROM public.orders o
         WHERE o.status = 'review' AND o.review_since < coalesce(${at ?? null}::timestamptz, clock_timestamp()) - ${REVIEW_STUCK_AFTER_MS} * interval '1 millisecond'
      ), due AS (
        SELECT s.* FROM stuck s WHERE NOT EXISTS (SELECT 1 FROM public.alerts a WHERE a.dedupe_key = s.dedupe_key)
         ORDER BY s.review_since
         LIMIT 500
      )
      INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload)
      SELECT 'worker', 'order_review_stuck', 'warning', due.dedupe_key,
             'an order has been in review for more than 24 hours: decide it in the review queue (mark paid or not paid)',
             jsonb_build_object('order_id', due.id, 'review_since', due.review_since)
        FROM due`;
    return inserted.count;
  });
}
