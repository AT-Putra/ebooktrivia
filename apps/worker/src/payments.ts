// Midtrans payment processing (US-021; plan M6.4; AC-S6, AC-S7, AC-T4, AC-T8; plan §10 items 8 and 17).
//
// Consumer of outbox topic `payment.notification` (one row per inbox row, enqueue_notification):
//   perform   read the inbox row, map it to its attempt by midtrans_order_id (UNIQUE, and bound to
//             {public_id}-{n} of its order by midtrans_attempts_id_guard), RE-QUERY Midtrans
//             (adapters getTransactionStatus, signed answer) outside any transaction. The notification
//             body is never used: status, amount and currency come from the re-query only. The inbox
//             label only asks for a retry: a settlement / capture / refund / chargeback label whose
//             re-query still says pending is Midtrans lagging, so the job retries (it never sets a state).
//             A failed re-query throws, so the outbox backs off (30 s doubling up to 1 h) and retries,
//             for PAYMENT_MAX_ATTEMPTS claims (about 30 h). Once the notification is 24 h old a failure
//             raises a critical alert, one per order (core REQUERY_ALERT_AFTER_MS); a refused key or a bad
//             signature on the re-query alerts at once (configuration).
//   finalize  applyRequery + processed_at, in the outbox finalize transaction.
//
// applyRequery (also used by the nightly reconciliation), in ONE transaction:
//   1. lock the order row (FOR UPDATE): every status change of one order is serialised, so two workers
//      processing two notifications of the order at once apply them one after the other. Lock order:
//      the order, then its attempt (the checkout's Snap bookkeeping takes them in the same order);
//   2. record the attempt's re-queried status, unless a NEWER re-query is already recorded (then this
//      one is stale and changes nothing);
//   3. decide with core decidePayment (confirmSettlement is THE paid predicate: settlement, this
//      attempt, status 200, gross_amount == amount_idr as the signed string, currency IDR; the order
//      machine with the attempt context: latest attempt, the order's OTHER settled attempts);
//   4. apply: a conditional UPDATE of the status (WHERE status = the locked one), then the effects:
//        paid      the buyer's player, player_programs (eligible from an EXISTS over the paid orders,
//                  first_paid_at = the earliest paid_at among the orders STILL paid), deliveries (e-mail
//                  now, WhatsApp after the delay), one MT conversion row per sink (core mtSinks), outbox
//                  `order.paid`; effects this code cancelled on an earlier review come back;
//        refunded / review (Owner decision D5: a paid order in review suspends eligibility until the
//                  Owner decides) eligibility and first_paid_at from the orders still paid; the effects
//                  not sent yet are cancelled (pending deliveries -> cancelled, pending MTs -> failed,
//                  both marked EFFECT_CANCELLED); the player's live winners of the program are flagged on
//                  a chargeback, or when no paid order is left (core winnerFlagReason), which halts
//                  fulfillment (fulfillments_halt_guard); refunded also adds the reversal rows of the
//                  MTs that may have reached their sink (core reversalSinks);
//      plus the payments ledger row, an audit row per status change, the decision's alert and a
//      critical alert for EVERY chargeback (whatever it does to the order).
// Exactly once: every effect is an INSERT ... ON CONFLICT DO NOTHING on a unique key (deliveries
// order+channel, conversion_events order+sink+kind, outbox dedupe_key, player_programs pkey), paid_at is
// stamped once (coalesce; orders_payment_stamps_guard), and deliveries / MT rows exist for paid orders
// only (paid_effects_guard). Replays and races therefore cannot double anything, even past this code.
// FOLLOW-UP US-024 / US-025 (binding): the delivery and conversion consumers check at claim time that
// orders.status = 'paid', so nothing goes out for an order refunded or in review meanwhile.
import { confirmSettlement, getTransactionStatus, type MidtransConfig, MidtransError, type MidtransStatus } from "@ebooktrivia/adapters";
import {
  attemptContext,
  decidePayment,
  deliverySchedule,
  EFFECT_CANCELLED,
  isChargeback,
  isUuid,
  mtSinks,
  NO_MT_TEMPLATE,
  type OrderEvent,
  type OrderStatus,
  type PaymentAlert,
  requeryOverdue,
  reversalSinks,
  type SettlementVerdict,
  winnerFlagReason,
} from "@ebooktrivia/core";
import type postgres from "postgres";
import type { Logger } from "./log.ts";
import type { OutboxConsumer } from "./outbox-consumer.ts";
import { raiseAlert, raiseAlertIn } from "./sweepers.ts";

export { EFFECT_CANCELLED };

export const PAYMENT_TOPIC = "payment.notification";
/** With the outbox backoff (30 s doubling to 1 h) 36 claims span about 30 h, past the 24 h alert. */
export const PAYMENT_MAX_ATTEMPTS = 36;
/** The re-query is one safe-fetch call (5 s timeout); finalize is one short transaction. */
export const PAYMENT_LEASE_MS = 30_000;
/** The outbox topic a PAID order writes (consumed by US-024 / US-025 to queue its deliveries and MTs at once). */
export const ORDER_PAID_TOPIC = "order.paid";
/** Inbox labels that name money moving: a re-query still pending for them is a lag, retried. */
const MONEY_LABELS: readonly string[] = ["settlement", "capture", "refund", "partial_refund", "chargeback", "partial_chargeback"];

/** The deployment's Midtrans access: the server key (opened with the payment private key) and the HTTP port. */
export type MidtransSource = (sql: postgres.Sql) => Promise<MidtransConfig>;

export interface PaymentOptions {
  /** AC-D8: the proactive WhatsApp send waits this long after PAID. */
  readonly waDelayMs: number;
  /** What re-queried the status (audit and alert payloads). */
  readonly source: "notification" | "reconciliation";
}

export interface AttemptRef {
  readonly id: string;
  readonly orderId: string;
  readonly n: number;
  readonly midtransOrderId: string;
}

export type ApplyOutcome =
  /** A newer re-query of this attempt is recorded already: nothing changed. */
  | { readonly kind: "stale" }
  | {
      readonly kind: "applied";
      readonly from: OrderStatus;
      readonly to: OrderStatus;
      readonly event: OrderEvent;
      readonly verdict: SettlementVerdict["kind"];
      readonly alert: PaymentAlert | null;
    };

interface OrderRow {
  id: string;
  status: OrderStatus;
  amount_idr: string;
  snap_attempt_count: number;
  player_id: string | null;
  program_id: string;
  buyer_phone: string;
  buyer_name: string;
  buyer_email: string;
  adnet_id: string | null;
  clickid: string | null;
  event_id: string;
  pixels: unknown;
  /** The order's adnet has an MT postback template (false for an organic order: no S2S row anyway). */
  adnet_has_mt_template: boolean;
  now: Date;
}

const ALERT_MESSAGES: Readonly<Record<PaymentAlert["kind"], string>> = {
  payment_settlement_review: "a Midtrans settlement does not match its order (amount, currency, status code or fraud status): the order is NOT paid; review it",
  payment_double_settlement: "a second Midtrans attempt of a paid order settled: possible double charge, refund one of them",
  payment_review: "a payment moved its order to review (partial refund or chargeback, challenge, or cancel): eligibility is suspended until the Owner decides",
  payment_anomaly: "a re-queried Midtrans status does not fit the order's state; nothing changed",
};

/** An IDR bigint read as text, as a safe integer. */
export function idr(text: string): number {
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n)) throw new RangeError("an IDR amount is not a safe integer");
  return n;
}

async function audit(tx: postgres.TransactionSql, order: OrderRow, to: OrderStatus, event: OrderEvent, attempt: AttemptRef, source: PaymentOptions["source"]): Promise<void> {
  const changes = { status: { before: order.status, after: to }, event, attempt: attempt.n, source };
  await tx`
    INSERT INTO public.audit_log (actor_kind, action, entity_type, entity_id, changes)
    VALUES ('system', 'order.status', 'order', ${order.id}, ${JSON.stringify(changes)}::text::jsonb)`;
}

/**
 * eligible = the player has a PAID order of the program (an EXISTS over orders, no view); first_paid_at
 * = the earliest paid_at among those orders, NULL when none is left (Owner tie-break D4: the earlier
 * payment that still stands wins). The player_programs row is locked first and both are computed in a
 * later statement (READ COMMITTED: a fresh snapshot after the lock), so two orders of one player refunded
 * at once cannot both see the other one still paid.
 */
async function refreshEligibility(tx: postgres.TransactionSql, playerId: string, programId: string, now: Date, create: boolean): Promise<boolean> {
  if (create) await tx`INSERT INTO public.player_programs (player_id, program_id) VALUES (${playerId}, ${programId}) ON CONFLICT (player_id, program_id) DO NOTHING`;
  const locked = await tx`SELECT 1 FROM public.player_programs WHERE player_id = ${playerId} AND program_id = ${programId} FOR UPDATE`;
  if (locked.length === 0) return false;
  const [row] = await tx<{ eligible: boolean }[]>`
    UPDATE public.player_programs pp
       SET eligible = EXISTS (SELECT 1 FROM public.orders o WHERE o.player_id = pp.player_id AND o.program_id = pp.program_id AND o.status = 'paid'),
           first_paid_at = (SELECT min(o.paid_at) FROM public.orders o WHERE o.player_id = pp.player_id AND o.program_id = pp.program_id AND o.status = 'paid'),
           updated_at = ${now}
     WHERE pp.player_id = ${playerId} AND pp.program_id = ${programId}
    RETURNING eligible`;
  return row?.eligible === true;
}

/** The PAID effects (AC-S7, AC-T4, AC-D1): each an INSERT ... ON CONFLICT DO NOTHING on its unique key. */
async function paidEffects(tx: postgres.TransactionSql, order: OrderRow, waDelayMs: number): Promise<void> {
  const { now } = order;
  // One buyer (WhatsApp phone) = one player (spec, AC-Q1); the profile of an existing player is kept.
  await tx`INSERT INTO public.players (phone, name, email) VALUES (${order.buyer_phone}, ${order.buyer_name}, ${order.buyer_email}) ON CONFLICT (phone) DO NOTHING`;
  const [player] = await tx<{ id: string }[]>`SELECT id FROM public.players WHERE phone = ${order.buyer_phone}`;
  if (player === undefined) throw new Error("the buyer's player row is missing");
  const [linked] = await tx<{ player_id: string }[]>`
    UPDATE public.orders SET player_id = coalesce(player_id, ${player.id}) WHERE id = ${order.id} RETURNING player_id`;
  await refreshEligibility(tx, linked?.player_id ?? player.id, order.program_id, now, true);

  const schedule = deliverySchedule(now, waDelayMs);
  await tx`
    INSERT INTO public.deliveries (order_id, channel, not_before)
    VALUES (${order.id}, 'email', ${schedule.email}), (${order.id}, 'whatsapp', ${schedule.whatsapp})
    ON CONFLICT (order_id, channel) DO NOTHING`;
  // Back from review: what this code cancelled goes out again (never a row cancelled for another reason).
  // An MT that had already been attempted is retried too: sinks dedupe by txid / event_id (code review r1).
  await tx`
    UPDATE public.deliveries SET status = 'pending', last_error = NULL, not_before = CASE channel WHEN 'email' THEN ${schedule.email}::timestamptz ELSE ${schedule.whatsapp}::timestamptz END, updated_at = ${now}
     WHERE order_id = ${order.id} AND status = 'cancelled' AND last_error = ${EFFECT_CANCELLED}`;

  // txid = the order id: stable per order (adnets dedupe by it), and no public capability (unlike public_id).
  for (const sink of mtSinks({ adnetId: order.adnet_id, clickid: order.clickid, pixels: order.pixels })) {
    // An attributed order whose adnet has no MT template cannot be reported: its S2S row is created already
    // failed, visibly (AC-T4), instead of being retried for 14 hours; the Owner fixes the adnet and re-fires it.
    const unreportable = sink === "s2s" && !order.adnet_has_mt_template;
    await tx`
      INSERT INTO public.conversion_events (order_id, sink, kind, status, adnet_id, txid, event_id, value_idr, next_attempt_at, failed_at, last_error)
      VALUES (${order.id}, ${sink}, 'mt', ${unreportable ? "failed" : "pending"}, ${sink === "s2s" ? order.adnet_id : null}, ${order.id}, ${order.event_id}, ${order.amount_idr}::bigint, ${now},
              ${unreportable ? now : null}, ${unreportable ? NO_MT_TEMPLATE : null})
      ON CONFLICT (order_id, sink, kind) DO NOTHING`;
  }
  await tx`
    UPDATE public.conversion_events SET status = 'pending', failed_at = NULL, last_error = NULL, next_attempt_at = ${now}, updated_at = ${now}
     WHERE order_id = ${order.id} AND kind = 'mt' AND status = 'failed' AND last_error = ${EFFECT_CANCELLED}`;
  await tx`
    INSERT INTO public.outbox (topic, dedupe_key, payload)
    VALUES (${ORDER_PAID_TOPIC}, ${`${ORDER_PAID_TOPIC}:${order.id}`}, ${JSON.stringify({ order_id: order.id })}::text::jsonb)
    ON CONFLICT (dedupe_key) DO NOTHING`;
}

/** Refund / review effects (security review P2-2, Owner decision D5): see the header. */
async function reversalEffects(tx: postgres.TransactionSql, order: OrderRow, to: OrderStatus, event: OrderEvent, attempt: AttemptRef): Promise<void> {
  const { now } = order;
  // The MTs the sink may have counted (the sticky maybe_counted mark: a 2xx or an uncertain send, never cleared) or
  // that are in flight (sending) need a reversal; one whose every attempt was answered with an error does not.
  const reached = await tx<{ sink: string }[]>`
    SELECT sink FROM public.conversion_events WHERE order_id = ${order.id} AND kind = 'mt' AND (maybe_counted OR status IN ('sending', 'sent'))`;
  await tx`
    UPDATE public.deliveries SET status = 'cancelled', last_error = ${EFFECT_CANCELLED}, updated_at = ${now}
     WHERE order_id = ${order.id} AND status = 'pending'`;
  await tx`
    UPDATE public.conversion_events SET status = 'failed', failed_at = ${now}, last_error = ${EFFECT_CANCELLED}, updated_at = ${now}
     WHERE order_id = ${order.id} AND kind = 'mt' AND status = 'pending'`;

  if (order.player_id !== null) {
    const eligible = await refreshEligibility(tx, order.player_id, order.program_id, now, false);
    const reason = winnerFlagReason(event, eligible);
    if (reason !== null) {
      const flagged = await tx<{ id: string }[]>`
        UPDATE public.winners SET status = 'flagged', flagged_at = ${now}, flag_reason = ${reason}, updated_at = ${now}
         WHERE player_id = ${order.player_id} AND program_id = ${order.program_id} AND status IN ('awaiting_confirmation', 'confirmed')
        RETURNING id`;
      if (flagged.length > 0) {
        await raiseAlertIn(tx, {
          kind: "winner_flagged",
          severity: "critical",
          dedupeKey: `winner_flagged:${order.id}`,
          message: "a winner's payment was charged back or refunded: the winner is flagged and fulfillment is halted; re-award to the next rank",
          payload: { order_id: order.id, attempt: attempt.n, event, reason, winner_ids: flagged.map((w) => w.id) },
        });
      }
    }
  }
  if (to !== "refunded") return;
  const [adnet] =
    order.adnet_id === null ? [] : await tx<{ reversal: boolean }[]>`SELECT reversal_url_template IS NOT NULL AS reversal FROM public.adnets WHERE id = ${order.adnet_id}`;
  for (const sink of reversalSinks(reached.map((r) => r.sink), adnet?.reversal === true)) {
    await tx`
      INSERT INTO public.conversion_events (order_id, sink, kind, adnet_id, txid, event_id, value_idr, next_attempt_at)
      VALUES (${order.id}, ${sink}, 'reversal', ${order.adnet_id}, ${order.id}, ${order.event_id}, ${order.amount_idr}::bigint, ${now})
      ON CONFLICT (order_id, sink, kind) DO NOTHING`;
  }
}

/** The payments ledger (M10 reports): one row per Midtrans transaction, its latest re-queried status. */
async function recordPayment(tx: postgres.TransactionSql, order: OrderRow, attempt: AttemptRef, status: MidtransStatus): Promise<void> {
  const gross = /^(\d{1,15})\.00$/.exec(status.grossAmount)?.[1];
  // A transaction without an id, or of an amount or currency an IDR row cannot hold, is alerted on by
  // the decision (review) and left out of the ledger.
  if (status.transactionId === undefined || gross === undefined || status.currency !== "IDR") return;
  const raw = {
    order_id: status.orderId,
    status_code: status.statusCode,
    gross_amount: status.grossAmount,
    transaction_status: status.transactionStatus,
    fraud_status: status.fraudStatus ?? null,
    payment_type: status.paymentType ?? null,
    transaction_time: status.transactionTime ?? null,
  };
  const settled = status.transactionStatus === "settlement" ? order.now : null;
  await tx`
    INSERT INTO public.payments (order_id, midtrans_attempt_id, gateway_txn_id, payment_type, transaction_status, fraud_status, gross_amount_idr, currency, settled_at, raw, updated_at)
    VALUES (${order.id}, ${attempt.id}, ${status.transactionId.slice(0, 128)}, ${status.paymentType ?? null}, ${status.transactionStatus.slice(0, 64)}, ${status.fraudStatus ?? null},
            ${gross}::bigint, 'IDR', ${settled}, ${JSON.stringify(raw)}::text::jsonb, ${order.now})
    ON CONFLICT (gateway_txn_id) DO UPDATE
       SET transaction_status = EXCLUDED.transaction_status, fraud_status = EXCLUDED.fraud_status,
           payment_type = coalesce(EXCLUDED.payment_type, payments.payment_type), settled_at = coalesce(payments.settled_at, EXCLUDED.settled_at),
           raw = EXCLUDED.raw, updated_at = EXCLUDED.updated_at
     WHERE payments.order_id = EXCLUDED.order_id`;
}

/** Applies one re-queried status of `attempt` to its order, in the caller's transaction. */
export async function applyRequery(tx: postgres.TransactionSql, attempt: AttemptRef, status: MidtransStatus, requeriedAt: Date, options: PaymentOptions): Promise<ApplyOutcome> {
  const [order] = await tx<OrderRow[]>`
    SELECT o.id, o.status::text AS status, o.amount_idr::text AS amount_idr, o.snap_attempt_count, o.player_id, o.program_id,
           o.buyer_phone, o.buyer_name, o.buyer_email, o.adnet_id, o.clickid, o.event_id, lp.pixels,
           coalesce(a.mt_url_template IS NOT NULL, false) AS adnet_has_mt_template, clock_timestamp() AS now
      FROM public.orders o JOIN public.landing_pages lp ON lp.id = o.landing_page_id
      LEFT JOIN public.adnets a ON a.id = o.adnet_id
     WHERE o.id = ${attempt.orderId}
       FOR UPDATE OF o`;
  if (order === undefined) throw new Error("the attempt's order is missing");
  const recorded = await tx`
    UPDATE public.midtrans_attempts
       SET gateway_status = ${status.transactionStatus.slice(0, 64)}, gateway_fraud_status = ${status.fraudStatus?.slice(0, 64) ?? null}, gateway_checked_at = ${requeriedAt}
     WHERE id = ${attempt.id} AND order_id = ${order.id} AND (gateway_checked_at IS NULL OR gateway_checked_at <= ${requeriedAt})`;
  if (recorded.count === 0) return { kind: "stale" };
  const attempts = await tx<{ n: number; gateway_status: string | null; gateway_fraud_status: string | null }[]>`
    SELECT n, gateway_status, gateway_fraud_status FROM public.midtrans_attempts WHERE order_id = ${order.id}`;
  const verdict = confirmSettlement(status, { midtransOrderId: attempt.midtransOrderId, amountIdr: idr(order.amount_idr) });
  const context = attemptContext(
    attempt.n,
    order.snap_attempt_count,
    attempts.map((a) => ({ n: a.n, gatewayStatus: a.gateway_status, gatewayFraudStatus: a.gateway_fraud_status })),
  );
  const decision = decidePayment(order.status, verdict, status.fraudStatus, context);
  await recordPayment(tx, order, attempt, status);

  let to = order.status;
  if (decision.transition.kind === "move") {
    to = decision.transition.to;
    const moved =
      to === "paid"
        ? await tx`UPDATE public.orders SET status = 'paid', paid_at = coalesce(paid_at, ${order.now}), updated_at = ${order.now} WHERE id = ${order.id} AND status = ${order.status}`
        : to === "refunded"
          ? await tx`UPDATE public.orders SET status = 'refunded', refunded_at = coalesce(refunded_at, ${order.now}), updated_at = ${order.now} WHERE id = ${order.id} AND status = ${order.status}`
          : await tx`UPDATE public.orders SET status = ${to}, updated_at = ${order.now} WHERE id = ${order.id} AND status = ${order.status}`;
    if (moved.count !== 1) throw new Error("the order changed under its row lock");
    await audit(tx, order, to, decision.event, attempt, options.source);
    if (to === "paid") await paidEffects(tx, order, options.waDelayMs);
    else if (to === "refunded" || to === "review") await reversalEffects(tx, order, to, decision.event, attempt);
  }
  const payload = {
    order_id: order.id,
    attempt: attempt.n,
    from: order.status,
    to,
    event: decision.event,
    transaction_status: status.transactionStatus.slice(0, 64),
    ...(verdict.kind === "review" ? { reason: verdict.reason } : {}),
    source: options.source,
  };
  if (decision.alert !== null) {
    await raiseAlertIn(tx, {
      kind: decision.alert.kind,
      severity: decision.alert.severity,
      dedupeKey: `${decision.alert.kind}:${order.id}:${String(attempt.n)}`,
      message: ALERT_MESSAGES[decision.alert.kind],
      payload,
    });
  }
  // Security review P2-3: a chargeback is always critical, also on a double payment that keeps the order
  // paid, and before any winner exists (US-028 flags such players on the results page).
  if (isChargeback(decision.event)) {
    await raiseAlertIn(tx, {
      kind: "payment_chargeback",
      severity: "critical",
      dedupeKey: `payment_chargeback:${order.id}:${String(attempt.n)}:${decision.event}`,
      message: "a Midtrans payment was charged back: check the order, the buyer and any prize",
      payload,
    });
  }
  return { kind: "applied", from: order.status, to, event: decision.event, verdict: verdict.kind, alert: decision.alert };
}

// ---------------------------------------------------------------------------------------------
// The notification consumer

export interface PaymentDeps {
  readonly sql: postgres.Sql;
  readonly midtrans: MidtransSource;
  readonly log: Logger;
  readonly waDelayMs: number;
  /** The clock stamped on a re-query (taken BEFORE it is sent); default the system clock. */
  readonly clock?: () => Date;
}

interface InboxRow {
  midtrans_order_id: string;
  transaction_status: string;
  received_at: Date;
  attempt_id: string | null;
  order_id: string | null;
  n: number | null;
}

/** A failure that is not transient: the server key is refused, or the answer's signature is wrong. */
const misconfigured = (error: unknown): boolean => error instanceof MidtransError && (error.code === "unauthorized" || error.code === "bad_signature");

export function createPaymentNotificationConsumer(deps: PaymentDeps): OutboxConsumer {
  const { sql } = deps;
  const clock = deps.clock ?? (() => new Date());
  return {
    topic: PAYMENT_TOPIC,
    leaseMs: PAYMENT_LEASE_MS,
    maxAttempts: PAYMENT_MAX_ATTEMPTS,
    async perform(row) {
      const inboxId = (row.payload as { inbox_id?: unknown } | null)?.inbox_id;
      if (!isUuid(inboxId)) throw new Error("payment.notification payload has no inbox id");
      const [note] = await sql<InboxRow[]>`
        SELECT n.midtrans_order_id, n.transaction_status, n.received_at, a.id AS attempt_id, a.order_id, a.n
          FROM public.payment_notifications n
          LEFT JOIN public.midtrans_attempts a ON a.midtrans_order_id = n.midtrans_order_id
         WHERE n.id = ${inboxId}`;
      if (note === undefined) throw new Error("payment notification row not found");
      const processed = (tx: postgres.TransactionSql) => tx`UPDATE public.payment_notifications SET processed_at = now() WHERE id = ${inboxId} AND processed_at IS NULL`;
      if (note.attempt_id === null || note.order_id === null || note.n === null) {
        // Signed by Midtrans, but for no attempt of ours (no order is ever created without its attempt row).
        deps.log.warn({ inboxId }, "payment notification for an unknown Midtrans order id; dropped");
        return async (tx) => {
          await raiseAlertIn(tx, {
            kind: "payment_unknown_order",
            severity: "warning",
            dedupeKey: "payment_unknown_order",
            message: "a signed Midtrans notification names an order id we never created; nothing was changed",
            payload: { inbox_id: inboxId },
          });
          await processed(tx);
        };
      }
      const attempt: AttemptRef = { id: note.attempt_id, orderId: note.order_id, n: note.n, midtransOrderId: note.midtrans_order_id };
      const failed = (code: string, error: unknown) => requeryFailed(deps, { orderId: attempt.orderId, attempt: attempt.n, receivedAt: note.received_at, now: clock(), code, error });
      const requeriedAt = clock();
      let status: MidtransStatus | undefined;
      try {
        status = await getTransactionStatus(await deps.midtrans(sql), attempt.midtransOrderId);
      } catch (error) {
        const code = error instanceof MidtransError ? error.code : "error";
        await failed(code, error);
        throw new Error(`Midtrans status re-query failed (${code})`, { cause: error });
      }
      if (status === undefined) {
        // A signed notification proves the transaction exists: a 404 is a lag on Midtrans' side. Retry.
        await failed("not_found", undefined);
        throw new Error("Midtrans status re-query found no transaction yet");
      }
      if (status.transactionStatus === "pending" && MONEY_LABELS.includes(note.transaction_status)) {
        // Code review m2: the label names money moving, the status API does not show it yet. Retry.
        await failed("lagging", undefined);
        throw new Error(`Midtrans status re-query still pending for a ${note.transaction_status} notification`);
      }
      const answered = status;
      return async (tx) => {
        const outcome = await applyRequery(tx, attempt, answered, requeriedAt, { waDelayMs: deps.waDelayMs, source: "notification" });
        await processed(tx);
        deps.log.info(
          outcome.kind === "stale" ? { orderId: attempt.orderId, attempt: attempt.n, outcome: "stale" } : { orderId: attempt.orderId, attempt: attempt.n, from: outcome.from, to: outcome.to, event: outcome.event },
          "payment notification applied",
        );
      };
    },
  };
}

async function requeryFailed(
  deps: PaymentDeps,
  failure: { readonly orderId: string; readonly attempt: number; readonly receivedAt: Date; readonly now: Date; readonly code: string; readonly error: unknown },
): Promise<void> {
  const { code } = failure;
  deps.log.warn({ orderId: failure.orderId, attempt: failure.attempt, code, err: failure.error }, "Midtrans status re-query failed; retried with backoff");
  try {
    if (misconfigured(failure.error) || (failure.error !== undefined && !(failure.error instanceof MidtransError))) {
      await raiseAlert(deps.sql, {
        kind: "payment_requery_misconfigured",
        severity: "critical",
        dedupeKey: "payment_requery_misconfigured",
        message: "the worker cannot re-query Midtrans (server key missing or refused, or an answer that does not verify): payments are not confirmed",
        payload: { code },
      });
    }
    if (requeryOverdue(failure.receivedAt, failure.now)) {
      // Security review P2-4: one alert per ORDER, however many of its notifications fail.
      await raiseAlert(deps.sql, {
        kind: "payment_requery_failed",
        severity: "critical",
        dedupeKey: `payment_requery_failed:${failure.orderId}`,
        message: "a Midtrans notification could not be re-queried for 24 hours: its order is not updated; check Midtrans and the reconciliation",
        payload: { order_id: failure.orderId, attempt: failure.attempt, code },
      });
    }
  } catch (alertError) {
    deps.log.error({ orderId: failure.orderId, err: alertError }, "re-query failure alert could not be raised");
  }
}
