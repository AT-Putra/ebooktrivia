// Minute sweepers (plan M3.5). PostgreSQL is canonical, so these make every piece of pending work
// complete even after a crash or the loss of Valkey. Each sweeper is idempotent and safe to run
// concurrently in two worker processes: rows are taken with FOR UPDATE SKIP LOCKED, updates are
// conditional (core decisions carry the expected status + attempts), and job ids are
// deterministic, so a second sweeper only re-adds jobs BullMQ already has.
//
//   lease_expiry   deliveries / conversion_events still `sending` after lease_until: core
//                  expireDeliveryLease (-> unknown: the send may have happened) and
//                  expireConversionLease (-> failed for a manual re-fire, or a retry when the sink
//                  dedupes by txid; never a retry of the MT of an order no longer paid, US-021). Never a
//                  blind resend.
//   outbox         rows relayed more than outboxStaleMs ago and still unprocessed (lost from
//                  Valkey, or a failed / crashed attempt whose lease or backoff passed) are
//                  re-enqueued (job id per outboxJobId: a crashed claim's job may still look active);
//                  rows unrelayed for OUTBOX_UNRELAYED_ALERT_MS (no consumer, or the relay is
//                  stalled) and rows at the attempt cap raise one `alerts` row per topic per hour.
//   conversions    pending events with next_attempt_at <= now -> job `<id>-<attempts>`.
//   deliveries     pending deliveries with not_before <= now -> job `<id>-<attempts>`.
//   snap_create    the checkout's crash window (US-020, core SNAP_URL_STALE_MS): a pending order
//                  whose Snap redirect URL is still missing 60 s after its latest attempt started
//                  (the public app crashed, or lost PostgreSQL, between Snap and storing the URL)
//                  -> snap_create_failed, so the next checkout of that phone + landing page retries
//                  it with attempt n + 1 (the attempt rows stay for reconciliation, US-021). The
//                  checkout treats such an order the same way without waiting for this sweep.
//   order_expiry   orders past expires_at in a state core's order machine moves on `expire`
//                  (pending -> expired; worker_rw passes orders_status_guard).
//   grace_end      published programs at least GRACE_END_SETTLE_MS past their grace end
//                  (sales_end_at + grace_days): one transaction per program calling the SECURITY
//                  DEFINER public.create_leaderboard_snapshot (packages/db sql/contest.sql, US-028),
//                  which closes play, finalizes every open answer as a timeout, writes the stats,
//                  the results snapshot and the winners and moves the program to
//                  awaiting_confirmation, all derived in SQL. It takes the program's exclusive
//                  contest lock and returns an existing snapshot unchanged, so two workers (or a
//                  repeated sweep) never write two. A program whose lock is busy (lock_timeout), or
//                  with a question served before the grace end still running (ET103), is left for
//                  the next sweep; a failing program is logged and alerted, goes to the back of the
//                  next batches, and does not hold back the others.
//   login_throttle admin login-throttle rows whose window and lock are over (US-016), through the
//                  SECURITY DEFINER public.sweep_login_throttle(): worker_rw has no other access
//                  to admin_auth. Consecutive second-factor counts and hard locks are kept.
//   payment_methods the checkout takes no orders while midtrans.enabled_methods is empty (it answers 503): one critical
//                  alert for the Owner while that lasts (Owner D11, US-005).
// conversions and deliveries need a port (the fire port US-024, the delivery consumer US-025):
// runSweeps skips each one until its port is registered, so nothing is moved that the worker
// cannot finish.
import {
  type ConversionStatus,
  EFFECT_CANCELLED,
  type DeliveryPatch,
  type DeliveryRow,
  type DeliveryStatus,
  enabledMidtransMethods,
  expireConversionLease,
  expireDeliveryLease,
  GRACE_END_SETTLE_MS,
  ORDER_STATUSES,
  type OrderStatus,
  SNAP_URL_STALE_MS,
  transitionOrder,
} from "@ebooktrivia/core";
import { LOGIN_THROTTLE_WINDOW_SECONDS } from "@ebooktrivia/db/login-throttle";
import type { Queue } from "bullmq";
import type postgres from "postgres";
import { applyConversionDecision, NO_SINK_DEDUPES, type SinkDedupePolicy } from "./conversion-fire.ts";
import type { Logger } from "./log.ts";
import { OUTBOX_MAX_ATTEMPTS } from "./outbox-consumer.ts";
import { enqueueFresh, outboxJobId, rowJobId } from "./queues.ts";

export const OUTBOX_UNRELAYED_ALERT_MS = 10 * 60_000;
const ALERT_DEDUPE_WINDOW = "1 hour";
const BATCH = 500;

/** Bounds of one grace-end transaction: wait this long for the contest lock, run this long at most. */
export const GRACE_END_LOCK_TIMEOUT = "5s";
export const GRACE_END_STATEMENT_TIMEOUT = "300s";

export interface SweepDeps {
  readonly sql: postgres.Sql;
  readonly log: Logger;
  /** Queue per outbox topic that has a consumer. */
  readonly outboxQueues: ReadonlyMap<string, Queue>;
  /** Topics whose consumer claims more often than OUTBOX_MAX_ATTEMPTS (OutboxConsumer.maxAttempts). */
  readonly outboxMaxAttempts?: ReadonlyMap<string, number>;
  readonly outboxStaleMs: number;
  /** Present only with a fire port (US-024). */
  readonly conversionQueue?: Queue;
  /** Present only with a delivery consumer (US-025). */
  readonly deliveryQueue?: Queue;
  /** Present with the delivery runtime (US-025): the WhatsApp deliveries' own queue. */
  readonly deliveryWaQueue?: Queue;
  /** More minute sweeps of a story's own, by name (US-025: the unknown-send lookup). */
  readonly extraSweeps?: Readonly<Record<string, () => Promise<unknown>>>;
  readonly sinkDedupesByTxid?: SinkDedupePolicy;
}

/** An alerts row of the worker. No PII in the message or the payload. */
export interface Alert {
  readonly kind: string;
  readonly severity: "warning" | "critical";
  readonly dedupeKey: string;
  readonly message: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Inserts an alerts row in `tx` unless an unresolved one with the same dedupe key is under an hour
 * old; the dedupe key's advisory lock is held to the end of `tx`. Used inside the transaction whose
 * change the alert reports (payments.ts), so the alert commits with it or not at all.
 */
export async function raiseAlertIn(tx: postgres.TransactionSql, alert: Alert): Promise<boolean> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${alert.dedupeKey}, 0))`;
  const inserted = await tx`
    INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload)
    SELECT 'worker', ${alert.kind}, ${alert.severity}, ${alert.dedupeKey}, ${alert.message}, ${JSON.stringify(alert.payload)}::text::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM public.alerts a
        WHERE a.dedupe_key = ${alert.dedupeKey} AND a.resolved_at IS NULL
          AND a.created_at > now() - ${ALERT_DEDUPE_WINDOW}::interval)`;
  return inserted.count === 1;
}

/** raiseAlertIn in a transaction of its own. */
export async function raiseAlert(sql: postgres.Sql, alert: Alert): Promise<boolean> {
  return sql.begin((tx) => raiseAlertIn(tx, alert));
}

export async function sweepOutbox(
  deps: Pick<SweepDeps, "sql" | "log" | "outboxQueues" | "outboxStaleMs" | "outboxMaxAttempts">,
): Promise<{ rerelayed: number; alerts: number }> {
  const { sql } = deps;
  const topics = [...deps.outboxQueues.keys()];
  const capOf = (topic: string): number => deps.outboxMaxAttempts?.get(topic) ?? OUTBOX_MAX_ATTEMPTS;
  const rerelayed =
    topics.length === 0
      ? 0
      : await sql.begin(async (tx) => {
          const rows = await tx<{ id: string; topic: string; attempts: number }[]>`
            SELECT o.id, o.topic, o.attempts FROM public.outbox o
              JOIN unnest(${topics}::text[], ${topics.map(capOf)}::int[]) AS t(topic, cap) ON t.topic = o.topic
             WHERE o.processed_at IS NULL AND o.relayed_at < now() - ${deps.outboxStaleMs} * interval '1 millisecond'
               AND o.available_at <= now() AND o.attempts < t.cap + o.deferrals
             ORDER BY o.relayed_at
             LIMIT ${BATCH}
               FOR UPDATE OF o SKIP LOCKED`;
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
  // A topic without a raised cap (or without a consumer in this worker) has the default one.
  const capped = [...(deps.outboxMaxAttempts ?? new Map<string, number>())];
  const stuck = await sql<{ topic: string; count: number; cap: number }[]>`
    SELECT o.topic, count(*)::int AS count, coalesce(t.cap, ${OUTBOX_MAX_ATTEMPTS}) AS cap FROM public.outbox o
      LEFT JOIN unnest(${capped.map(([topic]) => topic)}::text[], ${capped.map(([, cap]) => cap)}::int[]) AS t(topic, cap) ON t.topic = o.topic
     WHERE o.processed_at IS NULL AND o.attempts >= coalesce(t.cap, ${OUTBOX_MAX_ATTEMPTS}) + o.deferrals
     GROUP BY o.topic, t.cap ORDER BY o.topic`;
  for (const { topic, count, cap } of stuck) {
    const raised = await raiseAlert(sql, {
      kind: "outbox_stuck",
      severity: "critical",
      dedupeKey: `outbox_stuck:${topic}`,
      message: `${String(count)} outbox row(s) of ${topic} failed ${String(cap)} times and are no longer retried`,
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

export async function sweepDueDeliveries(deps: Pick<SweepDeps, "sql" | "log" | "deliveryQueue" | "deliveryWaQueue">): Promise<number> {
  if (deps.deliveryQueue === undefined) return 0;
  // A WhatsApp delivery whose opener already went out, is in flight or was given up (US-025, Owner decision D7) waits for the buyer's reply: not a job.
  const rows = await deps.sql<{ id: string; attempts: number; channel: string }[]>`
    SELECT d.id, d.attempts, d.channel FROM public.deliveries d
     WHERE d.status = 'pending' AND d.not_before <= now()
       AND (d.channel <> 'whatsapp' OR NOT EXISTS (SELECT 1 FROM public.delivery_openers o WHERE o.delivery_id = d.id AND (o.status <> 'pending' OR o.next_attempt_at > now())))
     ORDER BY d.not_before LIMIT ${BATCH * 2}`;
  // US-025: WhatsApp deliveries go to their own queue when there is one (their sends wait for a number's slot; e-mail never queues behind them).
  const jobOf = (r: { id: string; attempts: number }) => ({ jobId: rowJobId(r.id, r.attempts), data: { id: r.id } });
  const toWa = deps.deliveryWaQueue === undefined ? [] : rows.filter((r) => r.channel === "whatsapp");
  await enqueueFresh(deps.deliveryQueue, rows.filter((r) => !toWa.includes(r)).map(jobOf));
  if (deps.deliveryWaQueue !== undefined && toWa.length > 0) await enqueueFresh(deps.deliveryWaQueue, toWa.map(jobOf));
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

/** Pending orders still without a Snap URL `staleMs` after their latest attempt -> snap_create_failed; returns how many. */
export async function failStaleSnapCreates(sql: postgres.Sql, staleMs = SNAP_URL_STALE_MS): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      SELECT o.id FROM public.orders o
       WHERE o.status = 'pending' AND o.snap_redirect_url IS NULL
         AND coalesce((SELECT a.created_at FROM public.midtrans_attempts a WHERE a.order_id = o.id AND a.n = o.snap_attempt_count), o.created_at)
             <= clock_timestamp() - ${staleMs} * interval '1 millisecond'
       ORDER BY o.created_at LIMIT ${BATCH}
         FOR UPDATE OF o SKIP LOCKED`;
    if (rows.length === 0) return 0;
    const result = await tx`
      UPDATE public.orders SET status = 'snap_create_failed', updated_at = now()
       WHERE id = ANY(${rows.map((r) => r.id)}::uuid[]) AND status = 'pending' AND snap_redirect_url IS NULL`;
    return result.count;
  });
}

/** Deletes spent admin login-throttle rows (the admin app's own window); returns how many. */
export async function sweepLoginThrottle(sql: postgres.Sql, windowSeconds = LOGIN_THROTTLE_WINDOW_SECONDS): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT public.sweep_login_throttle(${windowSeconds}::integer) AS n`;
  return row?.n ?? 0;
}

/**
 * US-026: dead OTP material leaves the database. Expired player_otps rows (their HMAC) are deleted, and an
 * otp.send job that expired unsent (still queued, or past its attempt cap) loses its sealed code: past its
 * expires_at the code can neither be sent (the consumer drops it) nor used (the verify refuses it). The send
 * ledger (otp_enqueues) is pruned of rows older than 24 hours, which no cap counts any more, and expired player
 * sessions go with their session_state rows.
 */
export async function sweepExpiredOtps(sql: postgres.Sql): Promise<{ readonly deleted: number; readonly wiped: number; readonly pruned: number; readonly sessions: number }> {
  const deleted = await sql`DELETE FROM public.player_otps WHERE expires_at < clock_timestamp()`;
  const wiped = await sql`
    UPDATE public.outbox SET sealed = NULL
     WHERE topic = 'otp.send' AND sealed IS NOT NULL AND processed_at IS NULL
       AND payload->>'expires_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
       AND (payload->>'expires_at')::timestamptz < clock_timestamp()`;
  // The send ledger past every cap's window (24 h), and expired player sessions with their state, through SQL
  // functions: the worker cannot touch a newer ledger row, and has no other access to player_auth.
  const [prune] = await sql<{ ledger: number; sessions: number }[]>`SELECT public.prune_otp_enqueues() AS ledger, public.prune_player_sessions() AS sessions`;
  return { deleted: deleted.count, wiped: wiped.count, pruned: prune?.ledger ?? 0, sessions: prune?.sessions ?? 0 };
}

/**
 * US-030: the retention of strangers' WhatsApp contacts. A wa_contacts row whose phone is no order's buyer phone and no player's
 * phone, unconfirmed for 7 days, is deleted (public.prune_stranger_wa_contacts, at most 500 a call; worker_rw cannot delete
 * wa_contacts itself). A buyer's row lives as long as the buyer's data (the erasure of a deletion request removes it).
 */
export async function pruneStrangerContacts(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT public.prune_stranger_wa_contacts() AS n`;
  return row?.n ?? 0;
}

/** What public.create_leaderboard_snapshot returns (counts only, no player data). */
interface SnapshotSummary {
  readonly created: boolean;
  readonly snapshot_id: string;
  readonly players_ranked?: number;
  readonly winners?: number;
}

/**
 * Not failures, so no alert: the contest lock is busy (55P03: another worker is writing this
 * snapshot, or an Owner action holds the lock), the program is not due yet (ET102 its status
 * changed; ET103 its grace was extended meanwhile, or a question served before the grace end is
 * still running), or the transaction lost a race (40P01 deadlock, 40001). The next sweep looks again.
 */
const GRACE_END_SKIPS: ReadonlySet<string> = new Set(["55P03", "ET102", "ET103", "40P01", "40001"]);

const errorCode = (err: unknown): string | undefined => {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

export async function endGracePeriods(sql: postgres.Sql, log: Logger): Promise<number> {
  // Programs that failed lately go last (oldest failure first), so a failing program cannot starve
  // the others out of the batch (code review MINOR-8).
  const due = await sql<{ id: string }[]>`
    SELECT p.id FROM public.programs p
     WHERE p.status = 'published'
       AND p.sales_end_at + make_interval(days => p.grace_days) + ${GRACE_END_SETTLE_MS} * interval '1 millisecond' <= clock_timestamp()
     ORDER BY (SELECT max(a.created_at) FROM public.alerts a WHERE a.dedupe_key = 'grace_end_failed:' || p.id::text) ASC NULLS FIRST,
              p.sales_end_at
     LIMIT 50`;
  let ended = 0;
  for (const { id } of due) {
    try {
      const summary = await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = '${GRACE_END_LOCK_TIMEOUT}'`);
        await tx.unsafe(`SET LOCAL statement_timeout = '${GRACE_END_STATEMENT_TIMEOUT}'`);
        const [row] = await tx<{ summary: SnapshotSummary }[]>`SELECT public.create_leaderboard_snapshot(${id}::uuid) AS summary`;
        return row?.summary;
      });
      if (summary?.created === true) {
        ended++;
        log.info({ programId: id, snapshotId: summary.snapshot_id, playersRanked: summary.players_ranked, winners: summary.winners }, "grace period ended: results snapshot written");
      }
    } catch (err) {
      const code = errorCode(err);
      if (code !== undefined && GRACE_END_SKIPS.has(code)) {
        log.warn({ programId: id, code }, "grace-end skipped; the next sweep looks again");
        continue;
      }
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
    ...(set.attemptsBase === undefined ? {} : { attempts_base: set.attemptsBase }),
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
      {
        id: string;
        sink: string;
        adnet_id: string | null;
        status: ConversionStatus;
        attempts: number;
        lease_until: Date | null;
        next_attempt_at: Date;
        may_retry: boolean;
        now: Date;
      }[]
    >`
      SELECT c.id, c.sink, c.adnet_id, c.status, c.attempts, c.lease_until, c.next_attempt_at,
             c.kind <> 'mt' OR o.status = 'paid' AS may_retry,
             clock_timestamp() AS now
        FROM public.conversion_events c
        JOIN public.orders o ON o.id = c.order_id
       WHERE c.status = 'sending' AND (c.lease_until IS NULL OR c.lease_until < now())
       ORDER BY c.lease_until NULLS FIRST LIMIT ${BATCH}
         FOR UPDATE OF c SKIP LOCKED
         FOR SHARE OF o SKIP LOCKED`;
    let n = 0;
    for (const row of rows) {
      const decision = expireConversionLease(
        { status: row.status, attempts: row.attempts, leaseUntil: row.lease_until, nextAttemptAt: row.next_attempt_at },
        row.now,
        { sinkDedupesByTxid: sinkDedupesByTxid({ sink: row.sink, adnetId: row.adnet_id }) },
      );
      if (!decision.ok) continue;
      if (decision.set.status === "pending" && !row.may_retry) {
        // The MT of an order no longer paid never goes back to pending (the DB refuses it, ET080,
        // security review US-021 P2-A): it fails, for the Owner, like every uncertain send.
        // US-024 (the race of the US-021 follow-up, closed in two steps). The SELECT above takes the ORDER's share lock
        // (SKIP LOCKED, so it never waits: the sweep after the one that finds it locked simply comes again): the lock
        // order of the claim, and a review -> paid still in flight (it holds the order FOR UPDATE until it commits,
        // its revive of cancelled rows included) is never read half-done. may_retry is what the order's status was
        // under that lock. The UPDATE re-checks it anyway in its own fresh snapshot (defence in depth): it changes
        // nothing when the order is paid, and the row then takes the normal retry path.
        const cancelled = await tx`
          UPDATE public.conversion_events
             SET status = 'failed', failed_at = ${row.now}, lease_until = NULL, last_error = ${EFFECT_CANCELLED}, maybe_counted = true, updated_at = ${row.now}
           WHERE id = ${row.id} AND status = 'sending' AND attempts = ${row.attempts}
             AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = conversion_events.order_id AND o.status = 'paid')`;
        // An expired lease is an uncertain send: the sink may have counted it, for good (maybe_counted).
        if (cancelled.count === 0) await applyConversionDecision(tx, row.id, decision, row.now, true);
      } else await applyConversionDecision(tx, row.id, decision, row.now, true);
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

/**
 * The checkout answers 503 while no payment method is enabled (app_settings midtrans.enabled_methods: the Owner's per-method switch,
 * Owner D11; the console refuses to save none, so this means a setting that was emptied or damaged outside it). The public app cannot
 * write alerts, so the minute sweep does: one critical alert while it lasts (deduped per hour by raiseAlert). Returns whether one was raised.
 */
export async function alertNoPaymentMethods(sql: postgres.Sql): Promise<boolean> {
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM public.app_settings WHERE key = 'midtrans.enabled_methods'`;
  if (enabledMidtransMethods(row?.value).length > 0) return false;
  return raiseAlert(sql, {
    kind: "checkout_no_payment_methods",
    severity: "critical",
    dedupeKey: "checkout_no_payment_methods",
    message: "no payment method is enabled: the checkout answers 503 and takes no orders; enable at least one in Settings, Midtrans",
    payload: {},
  });
}

/** One sweep of everything; a failing sweeper is logged and does not stop the others. */
export async function runSweeps(deps: SweepDeps): Promise<void> {
  const { conversionQueue, deliveryQueue } = deps;
  const sweepers: [string, () => Promise<unknown>][] = [
    ["lease_expiry", () => expireLeases(deps.sql, deps.sinkDedupesByTxid)],
    ["outbox", () => sweepOutbox(deps)],
  ];
  if (conversionQueue !== undefined) sweepers.push(["due_conversions", () => sweepDueConversions({ ...deps, conversionQueue })]);
  if (deliveryQueue !== undefined) sweepers.push(["due_deliveries", () => sweepDueDeliveries({ ...deps, deliveryQueue })]);
  sweepers.push(["snap_create", () => failStaleSnapCreates(deps.sql)]);
  sweepers.push(["order_expiry", () => expireOrders(deps.sql)]);
  sweepers.push(["grace_end", () => endGracePeriods(deps.sql, deps.log)]);
  sweepers.push(["login_throttle", () => sweepLoginThrottle(deps.sql)]);
  sweepers.push(["otp_expiry", () => sweepExpiredOtps(deps.sql)]);
  sweepers.push(["payment_methods", () => alertNoPaymentMethods(deps.sql)]);
  sweepers.push(["wa_contacts_retention", () => pruneStrangerContacts(deps.sql)]);
  for (const [name, run] of Object.entries(deps.extraSweeps ?? {})) sweepers.push([name, run]);
  for (const [sweeper, run] of sweepers) {
    try {
      const result = await run();
      deps.log.debug({ sweeper, result }, "sweep done");
    } catch (err) {
      deps.log.error({ sweeper, err }, "sweeper failed");
    }
  }
}
