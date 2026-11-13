// Minute sweepers (plan M3.5). PostgreSQL is canonical, so these make every piece of pending work
// complete even after a crash or the loss of Valkey. Each sweeper is idempotent and safe to run
// concurrently in two worker processes: rows are taken with FOR UPDATE SKIP LOCKED, updates are
// conditional (core decisions carry the expected status + attempts), and job ids are
// deterministic, so a second sweeper only re-adds jobs BullMQ already has.
//
//   lease_expiry   deliveries / conversion_events still `sending` after lease_until: core
//                  expireDeliveryLease (-> unknown: the send may have happened) and
//                  expireConversionLease (-> failed for a manual re-fire, or a retry when the sink
//                  dedupes by txid). Never a blind resend.
//   outbox         rows relayed more than outboxStaleMs ago and still unprocessed (lost from
//                  Valkey, or a failed / crashed attempt whose lease or backoff passed) are
//                  re-enqueued (job id per outboxJobId: a crashed claim's job may still look active);
//                  rows unrelayed for OUTBOX_UNRELAYED_ALERT_MS (no consumer, or the relay is
//                  stalled) and rows at the attempt cap raise one `alerts` row per topic per hour.
//   conversions    pending events with next_attempt_at <= now -> job `<id>-<attempts>`.
//   deliveries     pending deliveries with not_before <= now -> job `<id>-<attempts>`.
//   order_expiry   orders past expires_at in a state core's order machine moves on `expire`
//                  (pending -> expired; worker_rw passes orders_status_guard).
//   grace_end      published programs past sales_end_at + grace_days -> awaiting_confirmation
//                  (the only change programs_status_guard allows the worker), in one transaction
//                  per program after the GraceEndHook: US-028 plugs the finalize / snapshot /
//                  winners work in there, so the status only moves once that work committed with
//                  it. A failing program is logged and alerted and does not hold back the others.
// conversions, deliveries and grace_end need a port (the fire port US-024, the delivery consumer
// US-025, the grace-end hook US-028): runSweeps skips each one until its port is registered, so
// nothing is moved that the worker cannot finish (the worker cannot move a program back).
import {
  type ConversionStatus,
  type DeliveryPatch,
  type DeliveryRow,
  type DeliveryStatus,
  expireConversionLease,
  expireDeliveryLease,
  ORDER_STATUSES,
  type OrderStatus,
  transitionOrder,
} from "@ebooktrivia/core";
import type { Queue } from "bullmq";
import type postgres from "postgres";
import { applyConversionDecision, NO_SINK_DEDUPES, type SinkDedupePolicy } from "./conversion-fire.ts";
import type { Logger } from "./log.ts";
import { OUTBOX_MAX_ATTEMPTS } from "./outbox-consumer.ts";
import { enqueueFresh, outboxJobId, rowJobId } from "./queues.ts";

export const OUTBOX_UNRELAYED_ALERT_MS = 10 * 60_000;
const ALERT_DEDUPE_WINDOW = "1 hour";
const BATCH = 500;

/** US-028: finalize play, write the snapshot and winners, in the transaction that ends the grace period. */
export type GraceEndHook = (tx: postgres.TransactionSql, program: { readonly programId: string; readonly graceEndedAt: Date }) => Promise<void>;

export interface SweepDeps {
  readonly sql: postgres.Sql;
  readonly log: Logger;
  /** Queue per outbox topic that has a consumer. */
  readonly outboxQueues: ReadonlyMap<string, Queue>;
  readonly outboxStaleMs: number;
  /** Present only with a fire port (US-024). */
  readonly conversionQueue?: Queue;
  /** Present only with a delivery consumer (US-025). */
  readonly deliveryQueue?: Queue;
  /** US-028; without it no grace period is ended. */
  readonly graceEnd?: GraceEndHook;
  readonly sinkDedupesByTxid?: SinkDedupePolicy;
}

interface Alert {
  readonly kind: string;
  readonly severity: "warning" | "critical";
  readonly dedupeKey: string;
  readonly message: string;
  readonly payload: Record<string, unknown>;
}

/** Inserts an alerts row unless an unresolved one with the same dedupe key is under an hour old. */
async function raiseAlert(sql: postgres.Sql, alert: Alert): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${alert.dedupeKey}, 0))`;
    const inserted = await tx`
      INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload)
      SELECT 'worker', ${alert.kind}, ${alert.severity}, ${alert.dedupeKey}, ${alert.message}, ${JSON.stringify(alert.payload)}::text::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM public.alerts a
          WHERE a.dedupe_key = ${alert.dedupeKey} AND a.resolved_at IS NULL
            AND a.created_at > now() - ${ALERT_DEDUPE_WINDOW}::interval)`;
    return inserted.count === 1;
  });
}

export async function sweepOutbox(deps: Pick<SweepDeps, "sql" | "log" | "outboxQueues" | "outboxStaleMs">): Promise<{ rerelayed: number; alerts: number }> {
  const { sql } = deps;
  const topics = [...deps.outboxQueues.keys()];
  const rerelayed =
    topics.length === 0
      ? 0
      : await sql.begin(async (tx) => {
          const rows = await tx<{ id: string; topic: string; attempts: number }[]>`
            SELECT id, topic, attempts FROM public.outbox
             WHERE processed_at IS NULL AND relayed_at < now() - ${deps.outboxStaleMs} * interval '1 millisecond'
               AND available_at <= now() AND attempts < ${OUTBOX_MAX_ATTEMPTS} AND topic = ANY(${topics}::text[])
             ORDER BY relayed_at
             LIMIT ${BATCH}
               FOR UPDATE SKIP LOCKED`;
          for (const [topic, queue] of deps.outboxQueues) {
            const jobs = rows.filter((r) => r.topic === topic).map((r) => ({ jobId: outboxJobId(r.id, r.attempts), data: { id: r.id } }));
            if (jobs.length > 0) await enqueueFresh(queue, jobs);
          }
          if (rows.length > 0) await tx`UPDATE public.outbox SET relayed_at = now() WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`;
          return rows.length;
        });

  let alerts = 0;
  const unrelayed = await sql<{ topic: string; count: number }[]>`
    SELECT topic, count(*)::int AS count FROM public.outbox
     WHERE relayed_at IS NULL AND processed_at IS NULL
       AND available_at < now() - ${OUTBOX_UNRELAYED_ALERT_MS} * interval '1 millisecond'
     GROUP BY topic ORDER BY topic`;
  for (const { topic, count } of unrelayed) {
    const consumed = topics.includes(topic);
    const raised = await raiseAlert(sql, {
      kind: "outbox_unrelayed",
      severity: "warning",
      dedupeKey: `outbox_unrelayed:${topic}`,
      message: consumed
        ? `${String(count)} outbox row(s) of ${topic} unrelayed for over 10 minutes (relay stalled?)`
        : `${String(count)} outbox row(s) of ${topic} have no consumer in this worker`,
      payload: { topic, count },
    });
    if (raised) alerts++;
  }
  const stuck = await sql<{ topic: string; count: number }[]>`
    SELECT topic, count(*)::int AS count FROM public.outbox
     WHERE processed_at IS NULL AND attempts >= ${OUTBOX_MAX_ATTEMPTS}
     GROUP BY topic ORDER BY topic`;
  for (const { topic, count } of stuck) {
    const raised = await raiseAlert(sql, {
      kind: "outbox_stuck",
      severity: "critical",
      dedupeKey: `outbox_stuck:${topic}`,
      message: `${String(count)} outbox row(s) of ${topic} failed ${String(OUTBOX_MAX_ATTEMPTS)} times and are no longer retried`,
      payload: { topic, count },
    });
    if (raised) alerts++;
  }
  if (rerelayed > 0) deps.log.warn({ rerelayed }, "re-enqueued stale outbox rows");
  return { rerelayed, alerts };
}

export async function sweepDueConversions(deps: Pick<SweepDeps, "sql" | "log" | "conversionQueue">): Promise<number> {
  if (deps.conversionQueue === undefined) return 0;
  const rows = await deps.sql<{ id: string; attempts: number }[]>`
    SELECT id, attempts FROM public.conversion_events
     WHERE status = 'pending' AND next_attempt_at <= now()
     ORDER BY next_attempt_at LIMIT ${BATCH * 2}`;
  await enqueueFresh(deps.conversionQueue, rows.map((r) => ({ jobId: rowJobId(r.id, r.attempts), data: { id: r.id } })));
  return rows.length;
}

export async function sweepDueDeliveries(deps: Pick<SweepDeps, "sql" | "log" | "deliveryQueue">): Promise<number> {
  if (deps.deliveryQueue === undefined) return 0;
  const rows = await deps.sql<{ id: string; attempts: number }[]>`
    SELECT id, attempts FROM public.deliveries
     WHERE status = 'pending' AND not_before <= now()
     ORDER BY not_before LIMIT ${BATCH * 2}`;
  await enqueueFresh(deps.deliveryQueue, rows.map((r) => ({ jobId: rowJobId(r.id, r.attempts), data: { id: r.id } })));
  return rows.length;
}

/** Where core's order machine moves each state on `expire` (today only pending -> expired). */
export const ORDER_EXPIRY: ReadonlyMap<OrderStatus, OrderStatus> = new Map(
  ORDER_STATUSES.flatMap((state): [OrderStatus, OrderStatus][] => {
    const transition = transitionOrder(state, "expire");
    return transition.kind === "move" ? [[state, transition.to]] : [];
  }),
);

export async function expireOrders(sql: postgres.Sql): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; status: OrderStatus }[]>`
      SELECT id, status FROM public.orders
       WHERE status::text = ANY(${[...ORDER_EXPIRY.keys()]}::text[]) AND expires_at <= now()
       ORDER BY expires_at LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`;
    let expired = 0;
    for (const [from, to] of ORDER_EXPIRY) {
      const ids = rows.filter((r) => r.status === from).map((r) => r.id);
      if (ids.length === 0) continue;
      const result = await tx`
        UPDATE public.orders SET status = ${to}, updated_at = now() WHERE id = ANY(${ids}::uuid[]) AND status = ${from}`;
      expired += result.count;
    }
    return expired;
  });
}

export async function endGracePeriods(sql: postgres.Sql, hook: GraceEndHook, log: Logger): Promise<number> {
  const due = await sql<{ id: string }[]>`
    SELECT id FROM public.programs
     WHERE status = 'published' AND sales_end_at + make_interval(days => grace_days) <= now()
     ORDER BY sales_end_at LIMIT 50`;
  let ended = 0;
  for (const { id } of due) {
    try {
      const moved = await sql.begin(async (tx) => {
        const [program] = await tx<{ id: string; grace_ended_at: Date }[]>`
          SELECT id, sales_end_at + make_interval(days => grace_days) AS grace_ended_at FROM public.programs
           WHERE id = ${id} AND status = 'published' AND sales_end_at + make_interval(days => grace_days) <= now()
             FOR UPDATE SKIP LOCKED`;
        if (program === undefined) return false;
        await hook(tx, { programId: program.id, graceEndedAt: program.grace_ended_at });
        await tx`UPDATE public.programs SET status = 'awaiting_confirmation', updated_at = now() WHERE id = ${id} AND status = 'published'`;
        return true;
      });
      if (moved) ended++;
    } catch (err) {
      // The program stays published (its transaction rolled back) and is retried next sweep.
      log.error({ programId: id, err }, "grace-end work failed; program stays published");
      await raiseAlert(sql, {
        kind: "grace_end_failed",
        severity: "critical",
        dedupeKey: `grace_end_failed:${id}`,
        message: "the grace-end work of a program failed; it stays published and is retried every sweep",
        payload: { programId: id },
      }).catch((alertError: unknown) => {
        log.error({ programId: id, err: alertError }, "grace-end alert could not be raised");
      });
    }
  }
  return ended;
}

interface DeliveryDbRow {
  id: string;
  channel: DeliveryRow["channel"];
  status: DeliveryStatus;
  not_before: Date;
  lease_until: Date | null;
  attempts: number;
  session_id: string | null;
  tried_session_ids: string[];
  wa_chat_id: string | null;
  filename: string | null;
  now: Date;
}

/** deliveries columns for a core patch (only the fields the patch sets). */
export function deliveryColumns(set: DeliveryPatch, now: Date): Record<string, string | number | Date | readonly string[] | null> {
  return {
    status: set.status,
    ...(set.notBefore === undefined ? {} : { not_before: set.notBefore }),
    ...(set.leaseUntil === undefined ? {} : { lease_until: set.leaseUntil }),
    ...(set.attempts === undefined ? {} : { attempts: set.attempts }),
    ...(set.sessionId === undefined ? {} : { session_id: set.sessionId }),
    ...(set.triedSessionIds === undefined ? {} : { tried_session_ids: set.triedSessionIds }),
    ...(set.sentAt === undefined ? {} : { sent_at: set.sentAt }),
    ...(set.waMessageId === undefined ? {} : { wa_message_id: set.waMessageId }),
    ...(set.lastError === undefined ? {} : { last_error: set.lastError }),
    updated_at: now,
  };
}

export async function expireLeases(sql: postgres.Sql, sinkDedupesByTxid: SinkDedupePolicy = NO_SINK_DEDUPES): Promise<{ conversions: number; deliveries: number }> {
  const conversions = await sql.begin(async (tx) => {
    const rows = await tx<
      { id: string; sink: string; adnet_id: string | null; status: ConversionStatus; attempts: number; lease_until: Date | null; next_attempt_at: Date; now: Date }[]
    >`
      SELECT id, sink, adnet_id, status, attempts, lease_until, next_attempt_at, clock_timestamp() AS now
        FROM public.conversion_events
       WHERE status = 'sending' AND (lease_until IS NULL OR lease_until < now())
       ORDER BY lease_until NULLS FIRST LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`;
    let n = 0;
    for (const row of rows) {
      const decision = expireConversionLease(
        { status: row.status, attempts: row.attempts, leaseUntil: row.lease_until, nextAttemptAt: row.next_attempt_at },
        row.now,
        { sinkDedupesByTxid: sinkDedupesByTxid({ sink: row.sink, adnetId: row.adnet_id }) },
      );
      if (!decision.ok) continue;
      await applyConversionDecision(tx, row.id, decision, row.now);
      n++;
    }
    return n;
  });
  const deliveries = await sql.begin(async (tx) => {
    const rows = await tx<DeliveryDbRow[]>`
      SELECT id, channel, status, not_before, lease_until, attempts, session_id, tried_session_ids, wa_chat_id, filename,
             clock_timestamp() AS now
        FROM public.deliveries
       WHERE status = 'sending' AND (lease_until IS NULL OR lease_until < now())
       ORDER BY lease_until NULLS FIRST LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`;
    let n = 0;
    for (const row of rows) {
      const decision = expireDeliveryLease(
        {
          channel: row.channel,
          status: row.status,
          notBefore: row.not_before,
          leaseUntil: row.lease_until,
          attempts: row.attempts,
          sessionId: row.session_id,
          triedSessionIds: row.tried_session_ids,
          waChatId: row.wa_chat_id,
          filename: row.filename,
        },
        row.now,
      );
      if (!decision.ok) continue;
      const result = await tx`
        UPDATE public.deliveries SET ${tx(deliveryColumns(decision.set, row.now))}
         WHERE id = ${row.id} AND status = ${decision.expect.status} AND attempts = ${decision.expect.attempts}`;
      n += result.count;
    }
    return n;
  });
  return { conversions, deliveries };
}

/** One sweep of everything; a failing sweeper is logged and does not stop the others. */
export async function runSweeps(deps: SweepDeps): Promise<void> {
  const { conversionQueue, deliveryQueue, graceEnd } = deps;
  const sweepers: [string, () => Promise<unknown>][] = [
    ["lease_expiry", () => expireLeases(deps.sql, deps.sinkDedupesByTxid)],
    ["outbox", () => sweepOutbox(deps)],
  ];
  if (conversionQueue !== undefined) sweepers.push(["due_conversions", () => sweepDueConversions({ ...deps, conversionQueue })]);
  if (deliveryQueue !== undefined) sweepers.push(["due_deliveries", () => sweepDueDeliveries({ ...deps, deliveryQueue })]);
  sweepers.push(["order_expiry", () => expireOrders(deps.sql)]);
  if (graceEnd !== undefined) sweepers.push(["grace_end", () => endGracePeriods(deps.sql, graceEnd, deps.log)]);
  for (const [sweeper, run] of sweepers) {
    try {
      const result = await run();
      deps.log.debug({ sweeper, result }, "sweep done");
    } catch (err) {
      deps.log.error({ sweeper, err }, "sweeper failed");
    }
  }
}
