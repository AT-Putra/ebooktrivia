// The Owner's review queue for orders (US-033, M10c; docs/runbooks/order-review.md). Owner only: every page, action and route
// that reaches this asks policy.ts `order.review.resolve`, which Staff never have (they get 403 before anything here runs).
//
//   loadReviewQueue   every order in `review`, oldest stay first: why it is there (the payment code's status change that put it
//                     there, its open alerts, the reconciliation's findings), its Midtrans attempts with their latest re-queried
//                     status and the payments ledger, its status history and the decisions taken on it, the amount, the buyer
//                     MASKED (core maskName / maskPhone; the raw values never leave this server module), the player's eligibility;
//   revealBuyer       the unmasked buyer of one order in review, one click away for the Owner, and AUDITED (order.buyer.view);
//   requestRequery    "re-query Midtrans now": one outbox row of topic payment.requery (the worker holds the Midtrans key and
//                     runs the normal applyRequery path for it); audited; refused while one is still running;
//   decideReview      "mark paid" / "not paid" through public.order_review_decide (packages/db sql/order-review.sql, owned by the
//                     NOLOGIN role order_review), which does everything in one transaction under the order lock and writes its
//                     own audit row; the console only validates the form and maps the database's refusals to messages. A replay
//                     of the same request key (a double click, a re-posted form) answers the same result and changes nothing.
import { maskName, maskPhone, OWNER_DECISIONS, OWNER_REQUERY_MAX_ATTEMPTS, type OwnerDecision } from "@ebooktrivia/core";
import { currentMutationScope, insertAudit, NoMutationScopeError, withAudit } from "../audit.ts";
import type { Sql } from "../db.ts";
import { InvalidInput, multiLine, singleLine, sqlState, uuid } from "../settings/fields.ts";
import { parseReason } from "../settings/rescore.ts";

export const REVIEW_PATH = "/orders/review";
export const REQUERY_TOPIC = "payment.requery";
/** The queue shows this many orders, oldest stay first (the count above it is the full number). */
export const QUEUE_LIMIT = 100;

export interface ReviewPayment {
  readonly n: number | null;
  readonly transactionStatus: string;
  readonly fraudStatus: string | null;
  readonly paymentType: string | null;
  readonly grossIdr: number;
  readonly settledAt: Date | null;
  readonly updatedAt: Date;
}

export interface ReviewAttempt {
  readonly n: number;
  readonly midtransOrderId: string;
  /** Our Snap bookkeeping: requested / created / failed. */
  readonly snapStatus: string;
  readonly gatewayStatus: string | null;
  readonly gatewayFraudStatus: string | null;
  readonly gatewayCheckedAt: Date | null;
}

export interface ReviewHistoryEntry {
  readonly at: Date;
  /** order.status (the payment code), order.review.decide (an Owner decision), order.review.requery (an Owner re-query). */
  readonly action: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly event: string | null;
  readonly attempt: number | null;
  readonly source: string | null;
}

export interface ReviewOrder {
  readonly id: string;
  readonly publicId: string;
  readonly amountIdr: number;
  readonly createdAt: Date;
  readonly reviewSince: Date;
  readonly program: string;
  readonly product: string;
  readonly buyer: { readonly name: string; readonly phone: string; readonly email: string };
  /** US-030: the buyer was erased (UU PDP): no contact to show, and "mark paid" keeps the money without fulfilment. */
  readonly erased: boolean;
  /** no_player: never paid (no player yet); suspended: in review, no other paid order (D5); eligible: another paid order stands. */
  readonly eligibility: { readonly state: "no_player" | "eligible" | "suspended"; readonly firstPaidAt: Date | null };
  /** The payment code's status change that put the order in review (the latest), when the audit log has it. */
  readonly reason: { readonly label: string; readonly event: string; readonly from: string; readonly attempt: number | null; readonly source: string | null } | null;
  readonly alerts: readonly { readonly kind: string; readonly label: string; readonly severity: string; readonly createdAt: Date }[];
  readonly findings: readonly { readonly kind: string; readonly runDate: string }[];
  readonly attempts: readonly ReviewAttempt[];
  readonly payments: readonly ReviewPayment[];
  readonly history: readonly ReviewHistoryEntry[];
  /** An Owner re-query that has not been applied yet, and when the last one was asked for. */
  readonly requery: { readonly pending: boolean; readonly requestedAt: Date } | null;
}

const ALERT_LABELS: Readonly<Record<string, string>> = {
  payment_paid_reversed: "Midtrans reversed a payment we counted (D9)",
  payment_review: "A payment moved the order to review",
  payment_settlement_review: "A settlement that does not match the order",
  payment_chargeback: "Chargeback",
  payment_anomaly: "A Midtrans status that does not fit the order",
  payment_double_settlement: "Possible double charge",
  reconciliation_mismatch: "Nightly reconciliation mismatch",
  order_review_stuck: "In review for more than 24 hours",
  order_decision_superseded: "A new Midtrans event after your decision",
  winner_flagged: "A winner of this buyer is flagged",
};

/** A readable reason for the status change that put the order in review (event of the order machine, the status it left). */
export function reasonLabel(event: string, from: string): string {
  if (from === "paid" && ["deny", "cancel", "expire", "failure"].includes(event)) return `Midtrans reversed a payment we counted (D9: ${event})`;
  switch (event) {
    case "partial_refund":
      return "Partial refund (D5)";
    case "partial_chargeback":
      return "Partial chargeback (D5)";
    case "challenge":
      return "Fraud challenge, or a settlement that does not match the order (amount, currency, status code)";
    case "refund":
    case "chargeback":
      return `Full ${event} of an order that was never confirmed paid`;
    default:
      return `Midtrans status ${event}`;
  }
}

/** b***@g*** : the first character of the local part and of the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const local = Array.from(at < 0 ? email : email.slice(0, at))[0] ?? "";
  const domain = at < 0 ? "" : (Array.from(email.slice(at + 1))[0] ?? "");
  return `${local}***@${domain}***`;
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

/** How many orders are in review now (the dashboard and the navigation badge). */
export async function reviewCount(sql: Sql): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM public.orders WHERE review_since IS NOT NULL`;
  return row?.n ?? 0;
}

export async function loadReviewQueue(sql: Sql): Promise<{ readonly total: number; readonly orders: readonly ReviewOrder[] }> {
  const rows = await sql<
    {
      id: string;
      public_id: string;
      amount_idr: string;
      created_at: Date;
      review_since: Date;
      buyer_name: string;
      buyer_phone: string | null;
      buyer_email: string;
      erased: boolean;
      player_id: string | null;
      program: string;
      product: string;
      eligible: boolean | null;
      first_paid_at: Date | null;
    }[]
  >`
    SELECT o.id, o.public_id, o.amount_idr::text AS amount_idr, o.created_at, o.review_since, o.buyer_name, o.buyer_phone, o.buyer_email,
           o.anonymized_at IS NOT NULL AS erased, o.player_id,
           pr.name AS program, pd.title AS product, pp.eligible, pp.first_paid_at
      FROM public.orders o
      JOIN public.programs pr ON pr.id = o.program_id
      JOIN public.products pd ON pd.id = o.product_id
      LEFT JOIN public.player_programs pp ON pp.player_id = o.player_id AND pp.program_id = o.program_id
     WHERE o.status = 'review'
     ORDER BY o.review_since, o.id
     LIMIT ${QUEUE_LIMIT}`;
  const total = await reviewCount(sql);
  if (rows.length === 0) return { total, orders: [] };
  const ids = rows.map((r) => r.id);
  const [attempts, payments, audits, alerts, findings, requeries] = await Promise.all([
    sql<{ order_id: string; n: number; midtrans_order_id: string; status: string; gateway_status: string | null; gateway_fraud_status: string | null; gateway_checked_at: Date | null }[]>`
      SELECT order_id, n, midtrans_order_id, status, gateway_status, gateway_fraud_status, gateway_checked_at
        FROM public.midtrans_attempts WHERE order_id = ANY(${ids}::uuid[]) ORDER BY order_id, n`,
    sql<{ order_id: string; n: number | null; transaction_status: string; fraud_status: string | null; payment_type: string | null; gross: string; settled_at: Date | null; updated_at: Date }[]>`
      SELECT p.order_id, a.n, p.transaction_status, p.fraud_status, p.payment_type, p.gross_amount_idr::text AS gross, p.settled_at, p.updated_at
        FROM public.payments p LEFT JOIN public.midtrans_attempts a ON a.id = p.midtrans_attempt_id
       WHERE p.order_id = ANY(${ids}::uuid[]) ORDER BY p.order_id, p.created_at`,
    sql<{ order_id: string; occurred_at: Date; action: string; changes: Record<string, unknown> }[]>`
      SELECT entity_id AS order_id, occurred_at, action, changes
        FROM public.audit_log
       WHERE entity_type = 'order' AND entity_id = ANY(${ids}::text[]) AND action IN ('order.status', 'order.review.decide', 'order.review.requery')
       ORDER BY occurred_at, id`,
    sql<{ order_id: string; kind: string; severity: string; created_at: Date }[]>`
      SELECT payload ->> 'order_id' AS order_id, kind, severity, created_at
        FROM public.alerts WHERE resolved_at IS NULL AND payload ->> 'order_id' = ANY(${ids}::text[]) ORDER BY created_at`,
    sql<{ order_id: string; kind: string; run_date: string }[]>`
      SELECT f.order_id, f.kind, r.run_date::text AS run_date
        FROM public.payment_reconciliation_findings f JOIN public.payment_reconciliation_runs r ON r.id = f.run_id
       WHERE f.order_id = ANY(${ids}::uuid[]) ORDER BY r.run_date DESC, f.kind LIMIT 1000`,
    sql<{ order_id: string; pending: boolean; requested_at: Date }[]>`
      SELECT payload ->> 'order_id' AS order_id, bool_or(processed_at IS NULL AND attempts < ${OWNER_REQUERY_MAX_ATTEMPTS}) AS pending, max(created_at) AS requested_at
        FROM public.outbox WHERE topic = ${REQUERY_TOPIC} AND payload ->> 'order_id' = ANY(${ids}::text[]) GROUP BY 1`,
  ]);
  const orders = rows.map((r): ReviewOrder => {
    const history = audits
      .filter((a) => a.order_id === r.id)
      .map((a): ReviewHistoryEntry => {
        const status = a.changes["status"] as { before?: unknown; after?: unknown } | undefined;
        return {
          at: a.occurred_at,
          action: a.action,
          from: text(status?.before),
          to: text(status?.after),
          event: text(a.changes["event"]) ?? text(a.changes["decision"]),
          attempt: num(a.changes["attempt"]),
          source: text(a.changes["source"]),
        };
      });
    const entered = history.filter((h) => h.action === "order.status" && h.to === "review").at(-1);
    const requery = requeries.find((q) => q.order_id === r.id);
    return {
      id: r.id,
      publicId: r.public_id,
      amountIdr: Number(r.amount_idr),
      createdAt: r.created_at,
      reviewSince: r.review_since,
      program: r.program,
      product: r.product,
      buyer: { name: maskName(r.buyer_name), phone: maskPhone(r.buyer_phone) ?? "", email: maskEmail(r.buyer_email) },
      erased: r.erased,
      eligibility: { state: r.player_id === null || r.eligible === null ? "no_player" : r.eligible ? "eligible" : "suspended", firstPaidAt: r.first_paid_at },
      reason:
        entered === undefined || entered.event === null || entered.from === null
          ? null
          : { label: reasonLabel(entered.event, entered.from), event: entered.event, from: entered.from, attempt: entered.attempt, source: entered.source },
      alerts: alerts.filter((a) => a.order_id === r.id).map((a) => ({ kind: a.kind, label: ALERT_LABELS[a.kind] ?? a.kind, severity: a.severity, createdAt: a.created_at })),
      findings: findings.filter((f) => f.order_id === r.id).map((f) => ({ kind: f.kind, runDate: f.run_date })),
      attempts: attempts
        .filter((a) => a.order_id === r.id)
        .map((a) => ({
          n: a.n,
          midtransOrderId: a.midtrans_order_id,
          snapStatus: a.status,
          gatewayStatus: a.gateway_status,
          gatewayFraudStatus: a.gateway_fraud_status,
          gatewayCheckedAt: a.gateway_checked_at,
        })),
      payments: payments
        .filter((p) => p.order_id === r.id)
        .map((p) => ({
          n: p.n,
          transactionStatus: p.transaction_status,
          fraudStatus: p.fraud_status,
          paymentType: p.payment_type,
          grossIdr: Number(p.gross),
          settledAt: p.settled_at,
          updatedAt: p.updated_at,
        })),
      history,
      requery: requery === undefined ? null : { pending: requery.pending, requestedAt: requery.requested_at },
    };
  });
  return { total, orders };
}

const NOT_IN_REVIEW = "This order is no longer in review: it was decided, or a Midtrans event moved it. Reload the page.";

/** The unmasked buyer of an order in review, for the Owner; every view is audited (no value in the log, only that it was shown). */
export async function revealBuyer(sql: Sql, orderId: string): Promise<{ readonly name: string; readonly phone: string; readonly email: string }> {
  return withAudit(sql, async (tx, audit) => {
    const [row] = await tx<{ status: string; erased: boolean; buyer_name: string; buyer_phone: string | null; buyer_email: string }[]>`
      SELECT status::text AS status, anonymized_at IS NOT NULL AS erased, buyer_name, buyer_phone, buyer_email FROM public.orders WHERE id = ${orderId}`;
    if (row === undefined) throw new InvalidInput("This order no longer exists.");
    if (row.status !== "review") throw new InvalidInput(NOT_IN_REVIEW);
    if (row.erased || row.buyer_phone === null) throw new InvalidInput("The buyer of this order was erased (UU PDP): there is nothing to show.");
    audit({ action: "order.buyer.view", entityType: "order", entityId: orderId, facts: { fields: "buyer_name,buyer_phone,buyer_email", purpose: "review_queue" } });
    return { name: row.buyer_name, phone: row.buyer_phone, email: row.buyer_email };
  });
}

/**
 * Asks the worker to re-query every Midtrans attempt of an order in review now (outbox topic payment.requery; the worker applies the
 * answers through the normal payment path). Audited. `requestKey` (one per rendered form) makes a double click one request.
 * Returns false when nothing was queued: the same request again, or a re-query of the order still running.
 */
export async function requestRequery(sql: Sql, orderId: string, requestKey: string): Promise<boolean> {
  const scope = currentMutationScope();
  if (scope === undefined) throw new NoMutationScopeError();
  return sql.begin(async (tx) => {
    // No row lock (admin_rw holds no UPDATE on orders): a decision that lands just after this only makes the re-query redundant
    // (the worker's applyRequery honours it).
    const [order] = await tx<{ status: string }[]>`SELECT status::text AS status FROM public.orders WHERE id = ${orderId}`;
    if (order === undefined) throw new InvalidInput("This order no longer exists.");
    if (order.status !== "review") throw new InvalidInput(NOT_IN_REVIEW);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`payment.requery:${orderId}`}, 0))`;
    const [running] = await tx`
      SELECT 1 FROM public.outbox WHERE topic = ${REQUERY_TOPIC} AND payload ->> 'order_id' = ${orderId} AND processed_at IS NULL AND attempts < ${OWNER_REQUERY_MAX_ATTEMPTS} LIMIT 1`;
    if (running !== undefined) return false;
    const queued = await tx`
      INSERT INTO public.outbox (topic, dedupe_key, payload)
      VALUES (${REQUERY_TOPIC}, ${`${REQUERY_TOPIC}:${orderId}:${requestKey}`}, ${tx.json({ order_id: orderId })})
      ON CONFLICT (dedupe_key) DO NOTHING`;
    if (queued.count === 0) return false;
    await insertAudit(tx, scope, { action: "order.review.requery", entityType: "order", entityId: orderId, facts: { request_key: requestKey } });
    return true;
  });
}

export interface DecisionInput {
  readonly orderId: string;
  readonly decision: OwnerDecision;
  /** The order's public id, typed by the Owner. */
  readonly confirm: string;
  readonly reason: string;
  /** One per rendered form: a replay of it answers the same result. */
  readonly requestKey: string;
}

export interface DecisionResult {
  readonly decision: OwnerDecision;
  readonly replayed: boolean;
  readonly eligible: boolean;
  readonly deliveriesCreated: number;
  readonly deliveriesRevived: number;
  readonly mtCreated: number;
  readonly mtRevived: number;
  readonly reversalsCreated: number;
  readonly magicLinksRevoked: number;
  readonly winnersFlagged: number;
  readonly alertsResolved: number;
  /** US-030 / US-033: the buyer was erased, so mark paid kept the money and fulfilled nothing. */
  readonly fulfilmentSkipped: boolean;
}

/** The form's fields, validated (fixed messages; the database checks all of it again). */
export function parseDecision(fields: { readonly id: string; readonly decision: string; readonly confirm: string; readonly reason: string; readonly key: string }): DecisionInput {
  const decision = OWNER_DECISIONS.find((d) => d === fields.decision);
  if (decision === undefined) throw new InvalidInput("Choose mark paid or not paid.");
  return {
    orderId: uuid(fields.id),
    decision,
    confirm: singleLine(fields.confirm, "Type the order's id to confirm.", { max: 64 }),
    reason: parseReason(multiLine(fields.reason.trim(), "Give the reason for the decision (10 to 500 characters).", { min: 10, max: 500 })),
    requestKey: uuid(fields.key, "The form is out of date. Reload the page and try again."),
  };
}

export const DECISION_MESSAGES: Readonly<Record<string, string>> = {
  ET181: "Give the reason for the decision (10 to 500 characters), without e-mail addresses or phone numbers.",
  ET182: "Only an active Owner can decide an order in review.",
  ET183: "This order no longer exists.",
  ET184: "This form was already used for another decision. Reload the page.",
  ET185: "The confirmation does not match: type the order's id exactly as shown.",
  ET186: NOT_IN_REVIEW,
  // lock_not_available: a payment of this order is being applied right now.
  "55P03": "The order is busy (a payment is being applied). Try again in a moment.",
  // query_canceled: the decision ran into its 15 s statement timeout; nothing was written (one transaction).
  "57014": "The decision took too long and was not made. Try again.",
};

const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) ? v : 0);

/** A decision's result as order_review_decide returns it (and keeps it in the ledger's `effects`). */
function toResult(decision: OwnerDecision, r: Readonly<Record<string, unknown>>): DecisionResult {
  return {
    decision,
    replayed: r["replayed"] === true,
    eligible: r["eligible"] === true,
    deliveriesCreated: count(r["deliveries_created"]),
    deliveriesRevived: count(r["deliveries_revived"]),
    mtCreated: count(r["mt_created"]),
    mtRevived: count(r["mt_revived"]),
    reversalsCreated: count(r["reversals_created"]),
    magicLinksRevoked: count(r["magic_links_revoked"]),
    winnersFlagged: count(r["winners_flagged"]),
    alertsResolved: count(r["alerts_resolved"]),
    fulfilmentSkipped: r["fulfilment"] === "skipped",
  };
}

export interface RecentDecision {
  readonly orderId: string;
  readonly publicId: string;
  readonly decidedAt: Date;
  /** The order's status now (a later Midtrans event may have moved it again). */
  readonly status: string;
  readonly result: DecisionResult;
}

/** The decisions of the last 24 hours, newest first: the page's confirmation once a decided order has left the queue. */
export async function loadRecentDecisions(sql: Sql): Promise<readonly RecentDecision[]> {
  const rows = await sql<{ order_id: string; public_id: string; decided_at: Date; decision: string; effects: Record<string, unknown>; status: string }[]>`
    SELECT d.order_id, o.public_id, d.decided_at, d.decision, d.effects, o.status::text AS status
      FROM public.order_owner_decisions d JOIN public.orders o ON o.id = d.order_id
     WHERE d.decided_at > clock_timestamp() - interval '24 hours'
     ORDER BY d.decided_at DESC, d.id
     LIMIT 50`;
  return rows.flatMap((r) => {
    const decision = OWNER_DECISIONS.find((d) => d === r.decision);
    return decision === undefined ? [] : [{ orderId: r.order_id, publicId: r.public_id, decidedAt: r.decided_at, status: r.status, result: toResult(decision, r.effects) }];
  });
}

export async function decideReview(sql: Sql, input: DecisionInput): Promise<DecisionResult> {
  const scope = currentMutationScope();
  if (scope === undefined) throw new NoMutationScopeError();
  if (scope.actor.kind !== "admin") throw new Error("a review decision is an admin action");
  const actorId = scope.actor.userId;
  try {
    const r = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '5s'");
      await tx.unsafe("SET LOCAL statement_timeout = '15s'");
      const [row] = await tx<{ r: Record<string, unknown> }[]>`
        SELECT public.order_review_decide(${input.orderId}, ${input.decision}, ${input.confirm}, ${input.reason}, ${input.requestKey},
                                          ${actorId}, ${scope.requestId}, ${scope.ip}::inet) AS r`;
      if (row === undefined) throw new Error("order_review_decide returned nothing");
      return row.r;
    });
    return toResult(input.decision, r);
  } catch (error) {
    const message = DECISION_MESSAGES[sqlState(error) ?? ""];
    if (message !== undefined) throw new InvalidInput(message);
    throw error;
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;

/** What the form says after a decision (the same text for a replay: the same answer). */
export function decisionMessage(r: DecisionResult): string {
  if (r.decision === "paid" && r.fulfilmentSkipped) {
    return "Marked paid without fulfilment: the buyer was erased (UU PDP), so nothing is delivered, no conversion is reported and nobody becomes eligible.";
  }
  if (r.decision === "paid") {
    const back = r.deliveriesRevived + r.mtRevived;
    const created = r.deliveriesCreated + r.mtCreated;
    const parts = [
      "Marked paid.",
      back > 0 ? `${plural(r.deliveriesRevived, "delivery", "deliveries")} and ${plural(r.mtRevived, "conversion")} back on the send path.` : null,
      created > 0 ? `${plural(r.deliveriesCreated, "delivery", "deliveries")} and ${plural(r.mtCreated, "conversion")} created.` : null,
      r.eligible ? "The buyer can play and log in again (WhatsApp code or the login page's resend)." : null,
      r.winnersFlagged > 0 ? `${plural(r.winnersFlagged, "flagged winner")} of this buyer ${r.winnersFlagged === 1 ? "stays" : "stay"} flagged: reinstate on the contest results page.` : null,
    ];
    return parts.filter((p) => p !== null).join(" ");
  }
  const parts = [
    "Marked not paid: the order is closed as failed.",
    r.reversalsCreated > 0 ? `${plural(r.reversalsCreated, "reversal postback")} queued.` : null,
    r.eligible ? "The buyer stays eligible through another paid order." : "The buyer is not eligible.",
    r.magicLinksRevoked > 0 ? `${plural(r.magicLinksRevoked, "login link")} revoked.` : null,
  ];
  return parts.filter((p) => p !== null).join(" ");
}
