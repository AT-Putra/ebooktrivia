// Order state machine (plan M2.4 table, M6.4; spec AC-S6..S8, AC-T8; plan §10 items 8 and 17).
// Events come from the server-side Midtrans status re-query, never from the raw notification.
//
// Plan rules:
//   any non-paid, non-refunded state + confirmed settlement -> paid   (late settlement, §10.8)
//   pending + deny -> stays pending (Snap allows a retry with another method; logged)
//   paid + refund / chargeback -> refunded
//   any state + partial_refund / partial_chargeback / capture+challenge -> review (§10.17)
// Where the plan is silent, the safest choice (documented per cell in TRANSITIONS):
//   - nothing but a settlement ever leads to paid. Card capture+accept is NOT a settlement
//     (spec AC-S6: paid only on confirmed settlement): it is the `capture` event, which never
//     changes state and alerts. classifyMidtransStatus's `treatCardCaptureAsPaid` (default false)
//     lets the Owner decide later to count capture+accept as a settlement;
//   - refunded is terminal; money events on it are logged, a settlement on it is an anomaly;
//   - a full refund / chargeback of an order we never confirmed paid goes to review (Owner);
//   - paid + cancel -> review is an addition beyond the plan table, kept as a safety net: a
//     captured card can be cancelled before settlement, so the money may never arrive (relevant
//     when treatCardCaptureAsPaid is on); paid + pending / deny / expire / failure are ignored,
//     because with several Snap attempts per order they normally belong to another attempt;
//   - pending + cancel / failure -> gateway_failed, pending + expire -> expired; the same events on
//     the other unpaid states change nothing (the order's own expiry sweeper owns those);
//   - review only leaves via settlement (paid) or a full refund / chargeback (refunded);
//     everything else waits for the Owner. Owner transitions (exit from review, re-award) are
//     admin actions (M10), not events of this machine.
//
// Caller contract (multiple Midtrans attempts per order, midtrans_order_id = {publicId}-{n}):
// pass OrderEventContext so the machine can tell attempts apart.
//   - eventAttemptIsLatest: false -> deny / cancel / expire / failure are ignored (they belong to
//     an older attempt), except paid + cancel, which may be the attempt that paid;
//   - otherSettledAttempts = number of the order's OTHER attempts whose latest re-queried status is
//     settled (settlement, or capture+accept when treatCardCaptureAsPaid is on). Double payment
//     policy: the kept attempt's money still stands, so every reversal or doubt event (refund,
//     partial_refund, chargeback, partial_chargeback, challenge, cancel) leaves a paid (or
//     review) order unchanged and alerts the Owner; a second settlement on a paid order alerts.
//     The buyer stays eligible (eligibility = a paid order).
//   - concurrency: lock the order row (SELECT ... FOR UPDATE) and recompute otherSettledAttempts
//     from the attempts' stored statuses inside the same transaction that applies the
//     transition. Otherwise two parallel reversals on a double payment (refunds of both
//     attempts) could each see the other attempt as still settled, both return a stay, and the
//     order stays paid with no money behind it.
// Without a context the machine assumes the event's attempt is the latest and no other attempt
// is settled.

/** Same values and order as the DB enum order_status (packages/db/src/schema/funnel.ts). */
export const ORDER_STATUSES = [
  "pending",
  "paid",
  "review",
  "expired",
  "gateway_failed",
  "snap_create_failed",
  "refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_EVENTS = [
  "settlement",
  "challenge",
  "capture",
  "pending",
  "deny",
  "cancel",
  "expire",
  "failure",
  "refund",
  "partial_refund",
  "chargeback",
  "partial_chargeback",
  "unknown",
] as const;
export type OrderEvent = (typeof ORDER_EVENTS)[number];

export type OrderTransition =
  | { readonly kind: "move"; readonly to: OrderStatus }
  /** No state change. `alert` = log and alert the Owner (anomaly), not just log. */
  | { readonly kind: "stay"; readonly alert: boolean };

export interface OrderEventContext {
  /** The event's Midtrans attempt is the order's latest attempt. Default true. */
  readonly eventAttemptIsLatest?: boolean;
  /** The order's other attempts whose re-queried status is settled. Default 0. */
  readonly otherSettledAttempts?: number;
}

const move = (to: OrderStatus): OrderTransition => ({ kind: "move", to });
const stay: OrderTransition = { kind: "stay", alert: false };
const anomaly: OrderTransition = { kind: "stay", alert: true };

/** Unpaid states other than pending: expired, gateway_failed, snap_create_failed. */
const unpaidClosed: Readonly<Record<OrderEvent, OrderTransition>> = {
  settlement: move("paid"),
  challenge: move("review"),
  capture: anomaly,
  pending: stay,
  deny: stay,
  cancel: stay,
  expire: stay,
  failure: stay,
  refund: move("review"),
  partial_refund: move("review"),
  chargeback: move("review"),
  partial_chargeback: move("review"),
  unknown: anomaly,
};

const TRANSITIONS: Readonly<Record<OrderStatus, Readonly<Record<OrderEvent, OrderTransition>>>> = {
  pending: {
    settlement: move("paid"),
    challenge: move("review"),
    capture: anomaly,
    pending: stay,
    deny: stay,
    cancel: move("gateway_failed"),
    expire: move("expired"),
    failure: move("gateway_failed"),
    refund: move("review"),
    partial_refund: move("review"),
    chargeback: move("review"),
    partial_chargeback: move("review"),
    unknown: anomaly,
  },
  paid: {
    settlement: stay,
    challenge: move("review"),
    capture: anomaly,
    pending: stay,
    deny: stay,
    cancel: move("review"),
    expire: stay,
    failure: stay,
    refund: move("refunded"),
    partial_refund: move("review"),
    chargeback: move("refunded"),
    partial_chargeback: move("review"),
    unknown: anomaly,
  },
  review: {
    settlement: move("paid"),
    challenge: stay,
    capture: anomaly,
    pending: stay,
    deny: stay,
    cancel: stay,
    expire: stay,
    failure: stay,
    refund: move("refunded"),
    partial_refund: stay,
    chargeback: move("refunded"),
    partial_chargeback: stay,
    unknown: anomaly,
  },
  expired: unpaidClosed,
  gateway_failed: unpaidClosed,
  snap_create_failed: unpaidClosed,
  refunded: {
    settlement: anomaly,
    challenge: anomaly,
    capture: anomaly,
    pending: stay,
    deny: stay,
    cancel: stay,
    expire: stay,
    failure: stay,
    refund: stay,
    partial_refund: stay,
    chargeback: stay,
    partial_chargeback: stay,
    unknown: anomaly,
  },
};

const NEGATIVE_EVENTS: readonly OrderEvent[] = ["deny", "cancel", "expire", "failure"];
const REVERSAL_OR_DOUBT_EVENTS: readonly OrderEvent[] = [
  "refund",
  "partial_refund",
  "chargeback",
  "partial_chargeback",
  "challenge",
  "cancel",
];

export function transitionOrder(state: OrderStatus, event: OrderEvent, context: OrderEventContext = {}): OrderTransition {
  const latest = context.eventAttemptIsLatest ?? true;
  const others = context.otherSettledAttempts ?? 0;
  if (!Number.isSafeInteger(others) || others < 0) {
    throw new RangeError("otherSettledAttempts must be a non-negative integer");
  }
  if (others > 0 && (state === "paid" || state === "review")) {
    // Double payment: another attempt still holds the buyer's money, so nothing is revoked.
    if (REVERSAL_OR_DOUBT_EVENTS.includes(event)) return anomaly;
    if (state === "paid" && event === "settlement") return anomaly;
  }
  if (!latest && NEGATIVE_EVENTS.includes(event) && !(state === "paid" && event === "cancel")) return stay;
  return TRANSITIONS[state][event];
}

export interface MidtransClassifyOptions {
  /** Count card capture+accept as a settlement (paid). Default false: wait for settlement. */
  readonly treatCardCaptureAsPaid?: boolean;
}

/**
 * Maps a re-queried Midtrans transaction_status / fraud_status to an event.
 *   settlement (fraud accept or absent) -> settlement; with any other fraud status -> challenge
 *   capture + accept -> capture (settlement only with treatCardCaptureAsPaid); capture + deny ->
 *   deny; capture + challenge / missing / anything else -> challenge (review, fail-safe)
 *   pending, deny, cancel, expire, failure, refund, partial_refund, chargeback,
 *   partial_chargeback -> the same event; anything else (e.g. authorize) -> unknown
 */
export function classifyMidtransStatus(
  transactionStatus: string,
  fraudStatus?: string | null,
  options: MidtransClassifyOptions = {},
): OrderEvent {
  const fraud = fraudStatus ?? "";
  switch (transactionStatus) {
    case "settlement":
      return fraud === "" || fraud === "accept" ? "settlement" : "challenge";
    case "capture":
      if (fraud === "accept") return options.treatCardCaptureAsPaid === true ? "settlement" : "capture";
      return fraud === "deny" ? "deny" : "challenge";
    case "pending":
    case "deny":
    case "cancel":
    case "expire":
    case "failure":
    case "refund":
    case "partial_refund":
    case "chargeback":
    case "partial_chargeback":
      return transactionStatus;
    default:
      return "unknown";
  }
}
