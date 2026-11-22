// The Owner's "re-query Midtrans now" in the review queue (US-033, M10c). The console holds no Midtrans key (admin_rw holds
// no private key), so its button writes one outbox row of topic `payment.requery` (payload {order_id}, dedupe key per click)
// and this consumer runs the NORMAL payment path for it:
//   perform   a no-op (the row is just marked processed) unless the order is still in `review`, or when a re-query of the
//             same order was processed less than core OWNER_REQUERY_MIN_INTERVAL_MS ago (security review L2: the button is
//             no way to make the worker hammer Midtrans). Otherwise it re-queries EVERY Midtrans attempt of the order
//             (adapters getTransactionStatus, signed answer), outside any transaction, each stamped with the instant it was
//             sent (payments.ts requeryInstant: the database clock). A 404 (no transaction yet) leaves that attempt alone;
//             any failure throws, so the outbox backs off and retries (core OWNER_REQUERY_MAX_ATTEMPTS claims; the outbox
//             sweeper alerts past them), and nothing is applied.
//   finalize  payments.ts applyRequery for each answer, in the outbox finalize transaction, exactly as a notification or the
//             reconciliation would (order row lock, stale answers dropped, the Owner's recorded decision honoured).
// The page shows the new statuses on its next load; the Owner may still decide either way afterwards.
import { getTransactionStatus, MidtransError, type MidtransStatus } from "@ebooktrivia/adapters";
import { isUuid, OWNER_REQUERY_MAX_ATTEMPTS, OWNER_REQUERY_MIN_INTERVAL_MS } from "@ebooktrivia/core";
import type { OutboxConsumer } from "./outbox-consumer.ts";
import { applyRequery, type AttemptRef, type PaymentDeps, requeryInstant } from "./payments.ts";

export const OWNER_REQUERY_TOPIC = "payment.requery";
/** An order has at most 5 attempts (core MAX_SNAP_ATTEMPTS) of one 5 s re-query each, plus the finalize. */
export const OWNER_REQUERY_LEASE_MS = 60_000;

export function createOwnerRequeryConsumer(deps: PaymentDeps): OutboxConsumer {
  const { sql } = deps;
  return {
    topic: OWNER_REQUERY_TOPIC,
    leaseMs: OWNER_REQUERY_LEASE_MS,
    maxAttempts: OWNER_REQUERY_MAX_ATTEMPTS,
    async perform(row) {
      const orderId = (row.payload as { order_id?: unknown } | null)?.order_id;
      if (!isUuid(orderId)) throw new Error("payment.requery payload has no order id");
      const [state] = await sql<{ status: string; recent: boolean }[]>`
        SELECT o.status::text AS status,
               EXISTS (SELECT 1 FROM public.outbox x
                        WHERE x.topic = ${OWNER_REQUERY_TOPIC} AND x.id <> ${row.id} AND x.payload ->> 'order_id' = ${orderId}
                          AND x.processed_at > clock_timestamp() - ${OWNER_REQUERY_MIN_INTERVAL_MS} * interval '1 millisecond') AS recent
          FROM public.orders o WHERE o.id = ${orderId}`;
      if (state === undefined || state.status !== "review" || state.recent) {
        deps.log.info({ orderId, status: state?.status ?? null, recent: state?.recent ?? false }, "owner re-query skipped");
        return undefined;
      }
      const attempts = await sql<{ id: string; n: number; midtrans_order_id: string }[]>`
        SELECT id, n, midtrans_order_id FROM public.midtrans_attempts WHERE order_id = ${orderId} ORDER BY n`;
      const midtrans = await deps.midtrans(sql);
      const answers: { attempt: AttemptRef; status: MidtransStatus; requeriedAt: Date }[] = [];
      for (const a of attempts) {
        const requeriedAt = await requeryInstant(sql, deps.clock);
        let status: MidtransStatus | undefined;
        try {
          status = await getTransactionStatus(midtrans, a.midtrans_order_id);
        } catch (error) {
          // The stored error names the code only (no Midtrans id or payload: outbox last_error).
          throw new Error(`Midtrans status re-query failed (${error instanceof MidtransError ? error.code : "error"})`, { cause: error });
        }
        if (status !== undefined) answers.push({ attempt: { id: a.id, orderId, n: a.n, midtransOrderId: a.midtrans_order_id }, status, requeriedAt });
      }
      return async (tx) => {
        for (const { attempt, status, requeriedAt } of answers) {
          await applyRequery(tx, attempt, status, requeriedAt, { waDelayMs: deps.waDelayMs, source: "owner_requery" });
        }
        deps.log.info({ orderId, attempts: attempts.length, answered: answers.length }, "owner re-query applied");
      };
    },
  };
}
