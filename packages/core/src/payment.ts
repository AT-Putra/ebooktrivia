// Payment processing rules (plan M6.4 / M6.5; spec AC-S6, AC-S7, AC-T4, AC-T8; plan §10 items 8
// and 17). The worker re-queries Midtrans for every notification, and the nightly reconciliation
// re-queries every attempt of the recently active orders; both decide with these functions and the
// order machine (order-machine.ts). Nothing here trusts a notification body: the verdict comes from
// adapters confirmSettlement on the RE-QUERIED status (SettlementVerdict is its structural copy, core
// has no adapter dependency).

import { classifyMidtransStatus, type OrderEvent, type OrderEventContext, type OrderStatus, type OrderTransition, transitionOrder } from "./order-machine.ts";

/** adapters confirmSettlement's verdict on a re-queried status. */
export type SettlementVerdict =
  | { readonly kind: "paid" }
  /** Money is reported but does not match the order (amount, currency, status code, fraud). */
  | { readonly kind: "review"; readonly reason: string }
  | { readonly kind: "not_settled"; readonly transactionStatus: string };

/**
 * The order-machine event of a re-queried status: a confirmed settlement is `settlement`, a mismatch
 * is `challenge` (Owner review, never paid), anything else is classifyMidtransStatus's event. A
 * not-settled verdict never becomes a settlement, whatever its status says.
 */
export function paymentEvent(verdict: SettlementVerdict, fraudStatus: string | null | undefined): OrderEvent {
  if (verdict.kind === "paid") return "settlement";
  if (verdict.kind === "review") return "challenge";
  const event = classifyMidtransStatus(verdict.transactionStatus, fraudStatus);
  return event === "settlement" ? "challenge" : event;
}

/** A stored, re-queried attempt status that holds the buyer's money (settlement, fraud accept or none). */
export function isSettledStatus(transactionStatus: string | null, fraudStatus: string | null): boolean {
  return transactionStatus !== null && classifyMidtransStatus(transactionStatus, fraudStatus) === "settlement";
}

/** One Midtrans attempt of an order, with its last re-queried status (NULL before the first re-query). */
export interface AttemptState {
  readonly n: number;
  readonly gatewayStatus: string | null;
  readonly gatewayFraudStatus: string | null;
}

/**
 * The order machine's context for an event of attempt `eventN` (order-machine.ts caller contract). `heldMoney` says
 * whether the event's own attempt ever held the buyer's money (Owner D9, eventAttemptHeldMoney): the caller decides it
 * from the attempt's payments.settled_at (set once when a settlement or capture+accept was counted), NOT from its last
 * re-queried status, so an intermediate pending or unknown status cannot hide a later deny, expire, failure or cancel.
 */
export function attemptContext(eventN: number, latestN: number, others: readonly AttemptState[], heldMoney = false): OrderEventContext {
  return {
    eventAttemptIsLatest: eventN >= latestN,
    otherSettledAttempts: others.filter((a) => a.n !== eventN && isSettledStatus(a.gatewayStatus, a.gatewayFraudStatus)).length,
    eventAttemptHeldMoney: heldMoney,
  };
}

export type PaymentAlertKind = "payment_settlement_review" | "payment_double_settlement" | "payment_review" | "payment_anomaly" | "payment_paid_reversed";

const UNPAID: readonly OrderStatus[] = ["pending", "expired", "gateway_failed", "snap_create_failed"];
/** The non-paid final statuses that, from a paid order, mean Midtrans reversed the payment (Owner D9). */
const PAID_REVERSALS: readonly OrderEvent[] = ["deny", "cancel", "expire", "failure"];

export interface PaymentAlert {
  readonly kind: PaymentAlertKind;
  readonly severity: "warning" | "critical";
}

export interface PaymentDecision {
  readonly event: OrderEvent;
  readonly transition: OrderTransition;
  /** What the Owner must be told, if anything. */
  readonly alert: PaymentAlert | null;
}

/**
 * The transition of an order on one re-queried attempt status, and its alert:
 *   - a mismatched settlement (amount, currency, status code, fraud) is critical, whatever happens;
 *   - a second settlement on another attempt of a paid order is a possible double charge (critical);
 *   - a card capture+accept normally IS a settlement (Owner D10) and pays; the `capture` event only exists for the opt-out
 *     (treatCardCaptureAsPaid: false): then, on an unpaid order, it is the normal way to settlement and stays quiet (code
 *     review US-021 m10), and on a paid, reviewed or refunded order it stays an anomaly;
 *   - any other anomaly of the order machine is a warning;
 *   - a move to review asks the Owner to look (warning);
 *   - a PAID order that a deny, cancel, expire or failure of the attempt that held its money moves to review is
 *     critical (Owner D9: the buyer may hold an ebook that Midtrans reversed; nothing sent is reversed for us).
 * Chargebacks get their own critical alert besides (isChargeback).
 */
export function decidePayment(state: OrderStatus, verdict: SettlementVerdict, fraudStatus: string | null | undefined, context: OrderEventContext): PaymentDecision {
  const event = paymentEvent(verdict, fraudStatus);
  const transition = transitionOrder(state, event, context);
  let alert: PaymentAlert | null = null;
  if (verdict.kind === "review") alert = { kind: "payment_settlement_review", severity: "critical" };
  else if (event === "capture" && UNPAID.includes(state)) alert = null;
  else if (transition.kind === "stay" && transition.alert) {
    alert = state === "paid" && event === "settlement" ? { kind: "payment_double_settlement", severity: "critical" } : { kind: "payment_anomaly", severity: "warning" };
  } else if (state === "paid" && transition.kind === "move" && transition.to === "review" && PAID_REVERSALS.includes(event)) {
    alert = { kind: "payment_paid_reversed", severity: "critical" };
  } else if (transition.kind === "move" && transition.to === "review") alert = { kind: "payment_review", severity: "warning" };
  return { event, transition, alert };
}

// ---------------------------------------------------------------------------------------------
// The PAID effects

/** Server-side MT sinks (plan §10 item 2: Google is browser gtag only, so it has no server row). */
export const MT_SINKS = ["s2s", "meta", "tiktok"] as const;
export type MtSink = (typeof MT_SINKS)[number];

export interface MtSource {
  /** orders.adnet_id and orders.clickid: S2S only for an attributed click (AC-T8: organic = pixels / CAPI only). */
  readonly adnetId: string | null;
  readonly clickid: string | null;
  /** landing_pages.pixels, e.g. {"meta": "...", "tiktok": "...", "gtag": "..."}. */
  readonly pixels: unknown;
}

export const hasPixel = (pixels: unknown, key: string): boolean =>
  typeof pixels === "object" && pixels !== null && !Array.isArray(pixels) && typeof (pixels as Record<string, unknown>)[key] === "string" && (pixels as Record<string, string>)[key] !== "";

/** The sinks that get exactly one MT row when the order is PAID (AC-T4). */
export function mtSinks(source: MtSource): MtSink[] {
  const sinks: MtSink[] = [];
  if (source.adnetId !== null && source.clickid !== null && source.clickid !== "") sinks.push("s2s");
  if (hasPixel(source.pixels, "meta")) sinks.push("meta");
  if (hasPixel(source.pixels, "tiktok")) sinks.push("tiktok");
  return sinks;
}

/**
 * Reversal rows of a refunded order (AC-T8): the adnet's optional reversal postback only, for an order
 * that has an S2S MT row and an adnet with a reversal template. Meta and TikTok have no standard refund
 * event (US-012), so they get none.
 */
export function reversalSinks(mtRowSinks: readonly string[], adnetHasReversalTemplate: boolean): "s2s"[] {
  return mtRowSinks.includes("s2s") && adnetHasReversalTemplate ? ["s2s"] : [];
}

/**
 * last_error of a delivery / MT row the payment code took out of the send path because its order left
 * PAID (refund, chargeback, review); only rows with this mark come back when the order is PAID again.
 */
export const EFFECT_CANCELLED = "order_not_paid";

/** AC-D8: the proactive WhatsApp send waits this long by default (the buyer may message first). */
export const WA_PROACTIVE_DELAY_MS = 3 * 60_000;

/** When each delivery of a PAID order may go: e-mail at once, WhatsApp after the delay (AC-D1, AC-D8). */
export function deliverySchedule(paidAt: Date, waDelayMs: number): { readonly email: Date; readonly whatsapp: Date } {
  if (!Number.isSafeInteger(waDelayMs) || waDelayMs < 0) throw new RangeError("waDelayMs must be a non-negative integer");
  return { email: paidAt, whatsapp: new Date(paidAt.getTime() + waDelayMs) };
}

// ---------------------------------------------------------------------------------------------
// Refunds and chargebacks (§10 item 17)

const CHARGEBACKS: readonly OrderEvent[] = ["chargeback", "partial_chargeback"];

/** Every chargeback is a critical alert, whatever it does to the order (security review US-021 P2-3). */
export const isChargeback = (event: OrderEvent): boolean => CHARGEBACKS.includes(event);

/**
 * Why a status change flags the player's live winners of the order's program (awaiting confirmation or
 * confirmed), or null: a chargeback always (the Owner re-awards, §10 item 17), and any change that
 * leaves the player without a paid order for the program (spec: a refund removes prize eligibility).
 */
export function winnerFlagReason(event: OrderEvent, stillEligible: boolean): "chargeback" | "no_paid_order" | null {
  if (isChargeback(event)) return "chargeback";
  return stillEligible ? null : "no_paid_order";
}

// ---------------------------------------------------------------------------------------------
// Re-query and reconciliation

/** A notification whose re-query has failed for this long raises a critical alert (plan M6.4). */
export const REQUERY_ALERT_AFTER_MS = 24 * 3_600_000;

export const requeryOverdue = (receivedAt: Date, now: Date): boolean => now.getTime() - receivedAt.getTime() >= REQUERY_ALERT_AFTER_MS;

/** The nightly reconciliation re-queries every attempt of the orders active in this window (plan M6.5). */
export const RECONCILE_WINDOW_DAYS = 7;
/** It runs once per WIB day, from this WIB hour on. */
export const RECONCILE_HOUR_WIB = 2;
const WIB_OFFSET_MS = 7 * 3_600_000;

/** The WIB calendar day (YYYY-MM-DD) whose reconciliation is due at `now`, or null before its hour. */
export function reconciliationDay(now: Date): string | null {
  const wib = new Date(now.getTime() + WIB_OFFSET_MS);
  if (wib.getUTCHours() < RECONCILE_HOUR_WIB) return null;
  return wib.toISOString().slice(0, 10);
}

/** What Midtrans says about one attempt: confirmSettlement's verdict, or not_found (404). */
export type ReconcileVerdict = SettlementVerdict["kind"] | "not_found";

export const RECONCILE_FINDINGS = ["settled_not_paid", "paid_not_settled", "double_settlement", "settlement_review", "refunded_but_settled", "requery_refused"] as const;
export type ReconcileFinding = (typeof RECONCILE_FINDINGS)[number];

/**
 * Mismatches between our order status (before reconciliation applies anything) and what Midtrans says
 * about EVERY attempt of the order:
 *   settled_not_paid      an attempt is a confirmed settlement but the order is neither paid nor refunded
 *                         (a lost notification: the buyer paid and got nothing);
 *   paid_not_settled      the order is paid but no attempt is a confirmed settlement (money missing);
 *   double_settlement     two or more attempts are confirmed settlements (a possible double charge);
 *   settlement_review     an attempt settled with the wrong amount, currency, status code or fraud status;
 *   refunded_but_settled  the order is refunded but an attempt is still a confirmed settlement.
 * The worker adds requery_refused itself: Midtrans answered an attempt's re-query with something that
 * cannot be trusted or used (a bad signature, a malformed answer, a refusal), a permanent error.
 */
export function reconcileOrder(orderStatus: OrderStatus, verdicts: readonly ReconcileVerdict[]): ReconcileFinding[] {
  const settled = verdicts.filter((v) => v === "paid").length;
  const findings: ReconcileFinding[] = [];
  if (settled > 0 && orderStatus !== "paid" && orderStatus !== "refunded") findings.push("settled_not_paid");
  if (settled === 0 && orderStatus === "paid") findings.push("paid_not_settled");
  if (settled > 1) findings.push("double_settlement");
  if (verdicts.includes("review")) findings.push("settlement_review");
  if (settled > 0 && orderStatus === "refunded") findings.push("refunded_but_settled");
  return findings;
}
