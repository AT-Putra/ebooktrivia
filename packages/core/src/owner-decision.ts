// The Owner's decision on an order in review (US-033, M10c; plan M6.4, §10 items 8 and 17; Owner decisions D5 and D9).
//
// The order machine never takes an order out of `review` on its own except by a settlement (paid) or a full refund /
// chargeback (refunded): everything else waits for the Owner (order-machine.ts). The Owner decides in the console
// ("mark paid" or "not paid"), through the database function public.order_review_decide (packages/db sql/order-review.sql),
// which records the decision with the FINGERPRINT of the order's Midtrans state it was taken on: every attempt with its
// last re-queried transaction_status and fraud_status.
//
// Honouring a decision (the payment code, apps/worker payments.ts applyRequery, and the nightly reconciliation): while the
// order is still in the status the decision left it in, a re-query of an attempt that shows the SAME Midtrans state the
// Owner decided on (the attempt's recorded status before this re-query and the re-queried one both equal its fingerprint)
// is no new information: it changes nothing and alerts nothing (a paid -> deny flip the Owner marked paid does not send the
// order back to review, a settlement mismatch the Owner marked not paid does not raise the critical alert again). Any other
// status is a NEW Midtrans event and is processed exactly as without a decision: a refund or a chargeback after "mark paid"
// reverses the order, and a later real settlement after "not paid" makes the order PAID (late settlement, §10 item 8). Once an
// attempt was recorded with another status, the decision no longer covers that attempt, even if Midtrans later returns to the
// decided state (a second flip is a new event). A malformed fingerprint covers nothing (fail closed: processed normally).
import type { OrderStatus } from "./order-machine.ts";

/** Same values as packages/db OWNER_DECISION_KINDS (order_owner_decisions.decision). */
export const OWNER_DECISIONS = ["paid", "not_paid"] as const;
export type OwnerDecision = (typeof OWNER_DECISIONS)[number];

/**
 * The status each decision leaves the order in. "not paid" is gateway_failed: terminal and unpaid (no Snap attempt is ever
 * added to it, the buyer's order page says failed), and the order machine still takes a later confirmed settlement on it to
 * PAID, as for every unpaid order (§10 item 8). No new status is needed for it: the ledger row says it was the Owner.
 */
export const DECISION_STATUS: Readonly<Record<OwnerDecision, OrderStatus>> = { paid: "paid", not_paid: "gateway_failed" };

/** Open alerts of the order that a decision resolves (sql/order-review.sql resolves exactly these kinds). */
export const REVIEW_ALERT_KINDS = [
  "payment_review",
  "payment_paid_reversed",
  "payment_settlement_review",
  "reconciliation_mismatch",
  "order_review_stuck",
  "order_decision_superseded",
  "payment_on_erased_order",
] as const;

/** An order that has been in review this long raises one warning alert (the worker's minute sweep). */
export const REVIEW_STUCK_AFTER_MS = 24 * 3_600_000;

/**
 * The Owner's "re-query Midtrans now" (outbox topic payment.requery) is claimed at most this often (about 15 minutes with the outbox
 * backoff); the console counts a job under it as still running.
 */
export const OWNER_REQUERY_MAX_ATTEMPTS = 5;
/** A re-query of the same order finished less than this long ago makes a new one a no-op (a button pressed twice, a replayed POST). */
export const OWNER_REQUERY_MIN_INTERVAL_MS = 60_000;

/** A Midtrans attempt's recorded (re-queried) state; both NULL before the first re-query. */
export interface GatewayState {
  readonly status: string | null;
  readonly fraud: string | null;
}

/** One attempt of a decision's fingerprint. */
export interface AttemptFingerprint extends GatewayState {
  readonly n: number;
}

/** The latest decision of an order, as the payment code reads it. */
export interface RecordedDecision {
  /** The status the decision left the order in. */
  readonly toStatus: OrderStatus;
  readonly attempts: readonly AttemptFingerprint[];
}

const textOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/** The ledger's `attempts` JSON as a fingerprint, or null when it is not one (then nothing is covered). */
export function parseFingerprint(value: unknown): AttemptFingerprint[] | null {
  if (!Array.isArray(value)) return null;
  const out: AttemptFingerprint[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) return null;
    const { n, status, fraud } = item as Record<string, unknown>;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || !textOrNull(status) || !textOrNull(fraud)) return null;
    if (out.some((a) => a.n === n)) return null;
    out.push({ n, status, fraud });
  }
  return out;
}

const same = (a: GatewayState, b: GatewayState): boolean => a.status === b.status && a.fraud === b.fraud;

/**
 * The decision still covers this re-query of attempt `n`: the order is still in the decision's status, and the attempt's
 * recorded state before the re-query (`prior`) and the re-queried one (`next`) both equal its fingerprint.
 */
export function decisionCoversRequery(decision: RecordedDecision | null, orderStatus: OrderStatus, n: number, prior: GatewayState, next: GatewayState): boolean {
  if (decision === null || decision.toStatus !== orderStatus) return false;
  const decided = decision.attempts.find((a) => a.n === n);
  return decided !== undefined && same(decided, prior) && same(decided, next);
}

/**
 * The attempt was in the decided state before this re-query and is not after it: a new Midtrans event on an order the Owner
 * decided (the Owner is told, even when it changes nothing; security review US-033 M1). Once spent, later re-queries of the
 * attempt are not "leaving" again.
 */
export function decisionLeftByRequery(decision: RecordedDecision | null, orderStatus: OrderStatus, n: number, prior: GatewayState, next: GatewayState): boolean {
  if (decision === null || decision.toStatus !== orderStatus) return false;
  const decided = decision.attempts.find((a) => a.n === n);
  return decided !== undefined && same(decided, prior) && !same(decided, next);
}

/** Statuses with which an attempt shows the buyer's money moving (whatever its fraud status). */
const MONEY_STATUSES: readonly string[] = ["settlement", "capture", "refund", "partial_refund", "chargeback", "partial_chargeback"];

/**
 * The Owner's "mark paid" made this attempt the one holding the money (security review US-033 M1): the order is still PAID by that
 * decision and the attempt showed money when the Owner decided (e.g. a fraud-challenged capture or settlement, which never set
 * payments.settled_at). A later deny / cancel / expire / failure of it then reverses a payment we count, the Owner D9 path (review,
 * links revoked, a critical alert), instead of being ignored as another attempt's noise. An attempt that showed no money at the
 * decision (never re-queried, pending, or already denied or expired) is not made one: its later expiry is not a reversal.
 */
export function decisionHeldMoney(decision: RecordedDecision | null, orderStatus: OrderStatus, n: number): boolean {
  if (decision === null || decision.toStatus !== "paid" || orderStatus !== "paid") return false;
  const decided = decision.attempts.find((a) => a.n === n);
  return decided !== undefined && decided.status !== null && MONEY_STATUSES.includes(decided.status);
}

/** One attempt of a reconciliation: its recorded state and what the re-query said (status NULL for a 404). */
export interface CheckedAttempt {
  readonly n: number;
  readonly prior: GatewayState;
  readonly next: GatewayState;
}

/**
 * The decision covers a whole reconciliation of the order: every attempt of the fingerprint was re-queried, nothing else
 * was, and each one is still in the decided state (decisionCoversRequery). The caller passes only a COMPLETE re-query (no
 * failed or refused attempt); then the reconciliation's findings are what the Owner already decided on.
 */
export function decisionCoversReconciliation(decision: RecordedDecision | null, orderStatus: OrderStatus, checked: readonly CheckedAttempt[]): boolean {
  if (decision === null || checked.length === 0 || checked.length !== decision.attempts.length) return false;
  return checked.every((c) => decisionCoversRequery(decision, orderStatus, c.n, c.prior, c.next));
}
