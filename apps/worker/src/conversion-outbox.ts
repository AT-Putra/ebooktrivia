// The outbox consumers of the conversions (US-024; plan M7, M6.2-M6.4):
//
//   conversion.mo  (enqueue_mo, written by the checkout once Snap succeeded, at most once per order, so a deduped
//                  order never fires a second MO). The consumer writes the MO rows of the order, one per sink
//                  (core moSinks), `INSERT ... ON CONFLICT DO NOTHING` on conversion_events_order_id_sink_kind_key,
//                  with the order's event_id (the browser pixel's id, for Meta / TikTok dedupe) and orders.id as
//                  the stable txid. The conversions sweeper then picks them up. It runs in the finalize
//                  transaction, so the rows and processed_at commit together or not at all.
//   order.paid     (written by payments in the PAID transaction, together with the order's MT rows). Those rows
//                  are due at once, so the consumer only hurries them: it puts the order's due conversions on the
//                  conversion queue instead of waiting for the next minute sweep. Job ids are deterministic
//                  (rowJobId), so a repeat is a no-op, and the claim is in PostgreSQL, so even a lost job loses
//                  nothing. US-025 adds the delivery nudge to the same consumer (OrderPaidNudge list): one outbox
//                  row has one processed_at, so a second consumer of this topic is refused (worker.ts).
import { isUuid, moSinks } from "@ebooktrivia/core";
import type { Queue } from "bullmq";
import type postgres from "postgres";
import type { OutboxConsumer } from "./outbox-consumer.ts";
import { ORDER_PAID_TOPIC } from "./payments.ts";
import { enqueueFresh, rowJobId } from "./queues.ts";

export const MO_TOPIC = "conversion.mo";

const orderIdOf = (topic: string, payload: unknown): string => {
  const id = typeof payload === "object" && payload !== null ? (payload as { order_id?: unknown }).order_id : undefined;
  if (!isUuid(id)) throw new Error(`${topic} payload has no order id`);
  return id;
};

interface MoOrder {
  id: string;
  adnet_id: string | null;
  clickid: string | null;
  event_id: string;
  amount_idr: string;
  has_mo_template: boolean;
  pixels: unknown;
  now: Date;
}

export function createMoConsumer(): OutboxConsumer {
  return {
    topic: MO_TOPIC,
    leaseMs: 30_000,
    perform(row) {
      const orderId = orderIdOf(MO_TOPIC, row.payload);
      return Promise.resolve(async (tx) => {
        const [order] = await tx<MoOrder[]>`
          SELECT o.id, o.adnet_id, o.clickid, o.event_id, o.amount_idr::text AS amount_idr, a.mo_url_template IS NOT NULL AS has_mo_template,
                 lp.pixels, clock_timestamp() AS now
            FROM public.orders o
            JOIN public.landing_pages lp ON lp.id = o.landing_page_id
            LEFT JOIN public.adnets a ON a.id = o.adnet_id
           WHERE o.id = ${orderId}`;
        if (order === undefined) throw new Error("the order of this MO no longer exists");
        for (const sink of moSinks({ adnetId: order.adnet_id, clickid: order.clickid, adnetHasMoTemplate: order.has_mo_template, pixels: order.pixels })) {
          await tx`
            INSERT INTO public.conversion_events (order_id, sink, kind, adnet_id, txid, event_id, value_idr, next_attempt_at)
            VALUES (${order.id}, ${sink}, 'mo', ${sink === "s2s" ? order.adnet_id : null}, ${order.id}, ${order.event_id}, ${order.amount_idr}::bigint, ${order.now})
            ON CONFLICT (order_id, sink, kind) DO NOTHING`;
        }
      });
    },
  };
}

/** Hurries the effects of a paid order along (a job per due row; never the work itself). */
export type OrderPaidNudge = (orderId: string) => Promise<void>;

/** Puts the order's due conversions on the conversion queue now (instead of at the next sweep). */
export function nudgeConversions(sql: postgres.Sql, queue: Queue): OrderPaidNudge {
  return async (orderId) => {
    const rows = await sql<{ id: string; attempts: number }[]>`
      SELECT id, attempts FROM public.conversion_events WHERE order_id = ${orderId} AND status = 'pending' AND next_attempt_at <= now()`;
    await enqueueFresh(queue, rows.map((r) => ({ jobId: rowJobId(r.id, r.attempts), data: { id: r.id } })));
  };
}

export function createOrderPaidConsumer(nudges: readonly OrderPaidNudge[]): OutboxConsumer {
  return {
    topic: ORDER_PAID_TOPIC,
    leaseMs: 30_000,
    async perform(row) {
      const orderId = orderIdOf(ORDER_PAID_TOPIC, row.payload);
      // Every nudge runs (a conversion nudge failing must not hold back the delivery's, or the other way round); a failure of any of them
      // still fails the row, which the outbox retries (each nudge is idempotent: enqueueFresh).
      const settled = await Promise.allSettled(nudges.map((nudge) => nudge(orderId)));
      const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed !== undefined) throw failed.reason;
      return undefined;
    },
  };
}
