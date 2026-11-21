// Delivery state machine (plan M8.2, spec AC-D4/AC-D8): claim -> lease -> outcome.
//
//   claim     pending -> sending (lease_until = now + lease, attempts + 1, WA session recorded in
//             tried_session_ids). Only when now >= not_before. No lock is held across the send.
//   buyer-first claim (AC-D8, plan M8.3): the buyer messaged a pool number first, so the same
//             pending WA row is claimed at once (not_before ignored) to reply from that session
//             and chat; the tried-session check does not apply. The reply chat is NOT written to
//             wa_chat_id: it may be an unresolved @lid sender (plan §10 item 23: PDF without the
//             magic link). The claim returns it as `reply` for the worker to use for this one send;
//             any later retry or proactive send still goes to the order's own chat. An unknown
//             buyer-first send is looked up in the order chat, so it normally ends in Owner review.
//             A sender that resolves to another phone than the order's is rejected, row untouched.
//             reply.withoutLink: the worker must render a link-free WhatsApp template
//             (renderMessage throws missing_value when {link_trivia} has no value).
//             Owner decision D6 (US-025 review): the worker no longer claims the row for an `unresolved` @lid sender (it cannot be
//             told from a stranger). It sends the PDF as an EXTRA reply with no name and no link, and the row stays pending for the
//             proactive send. The `unresolved` branch of this machine stays, tested, for a caller that does want to claim.
//   outcome   sent              -> sent
//             retryable failure -> WA: back to pending at once on another number, up to
//                                  WA_MAX_SESSIONS numbers (AC-D4), then failed. "At once"
//                                  never moves not_before earlier: a failed buyer-first reply
//                                  keeps the proactive delay.
//                                  Email: pending again after EMAIL_RETRY_DELAYS_MS, up to
//                                  EMAIL_MAX_ATTEMPTS attempts (first try + 3 retries), then failed.
//             permanent failure -> failed (the message definitely did not go out; no retry helps)
//             maybe sent        -> unknown (e.g. a timeout after the request left)
//             not attempted     -> pending after NOT_ATTEMPTED_DELAY_MS, as if the claim never happened: the RETRY BUDGET is given back
//                                  (attempts_base grows) and the number leaves tried_session_ids. The attempt NUMBER is never reused:
//                                  `attempts` only ever increases (a claim, a resend, a retry), so a stale finisher of an old claim can never
//                                  record its outcome onto a newer one. For a failure BEFORE anything was sent that is nobody's fault but ours
//                                  (the login link could not be issued, the template did not render, the PDF could not be read): it must
//                                  neither burn a failover slot nor count against the number's health.
//   lease     sending with an expired lease -> unknown (the worker may have sent before dying)
//   unknown   never resent automatically. After the lease has expired, a WA row is resolved by
//             the session's recent outgoing messages to the chat: a message with the same
//             filename inside the lease window -> sent; otherwise (and always for email) the
//             row waits for Owner review. The window is derived from lease_until - leaseMs; a
//             deliveries.claimed_at column (M8) would make it exact if lease lengths change.
// The retry budget of an e-mail is `attempts - attempts_base` (a resend, public.resend_delivery, moves attempts_base up to attempts: a fresh budget, and `attempts`
// keeps increasing). Marking an unknown row as sent after review is an admin action and not part of this machine yet.
// Every decision returns the expected current status and attempt count; the caller applies the
// update with `UPDATE ... WHERE id = $1 AND status = $expect.status AND attempts = $expect.attempts`
// so a stale worker or a concurrent sweeper cannot overwrite a newer state.

/** Same values and order as the DB enum delivery_status (packages/db/src/schema/delivery.ts). */
export const DELIVERY_STATUSES = ["pending", "sending", "sent", "failed", "unknown", "cancelled"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** deliveries_channel_check. */
export const DELIVERY_CHANNELS = ["whatsapp", "email"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

/** AC-D4: up to 3 numbers tried. */
export const WA_MAX_SESSIONS = 3;
/** AC-D4 "Email retries 3x" / plan M8.2 "3 retries": first attempt + 3 retries. */
export const EMAIL_MAX_ATTEMPTS = 4;
/** Spec silent on email spacing: the first three steps of the AC-T3 postback schedule. */
export const EMAIL_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000];

export interface DeliveryRow {
  readonly channel: DeliveryChannel;
  readonly status: DeliveryStatus;
  readonly notBefore: Date;
  readonly leaseUntil: Date | null;
  readonly attempts: number;
  /** The attempts that no longer count against the retry budget (given back by a not-attempted claim, or by a resend). Default 0. */
  readonly attemptsBase?: number;
  readonly sessionId: string | null;
  readonly triedSessionIds: readonly string[];
  readonly waChatId: string | null;
  readonly filename: string | null;
}

export interface DeliveryPatch {
  readonly status: DeliveryStatus;
  readonly notBefore?: Date;
  readonly leaseUntil?: Date | null;
  readonly attempts?: number;
  readonly attemptsBase?: number;
  readonly sessionId?: string | null;
  readonly triedSessionIds?: readonly string[];
  readonly sentAt?: Date;
  readonly waMessageId?: string;
  readonly lastError?: string | null;
}

export type DeliveryRejection =
  | "not_pending"
  | "not_due"
  | "not_sending"
  | "not_unknown"
  | "stale"
  | "lease_active"
  | "session_required"
  | "session_not_allowed"
  | "session_already_tried"
  | "attempts_exhausted"
  | "missing_target"
  | "needs_review"
  | "wrong_channel"
  | "sender_mismatch";

/**
 * Who wrote first, as the worker resolved the sender against the order phone:
 *   verified    the sender is the order phone: full reply, with the magic link;
 *   unresolved  an @lid sender that cannot be resolved: the PDF without the link (plan §10.23);
 *   mismatch    the sender is another phone: rejected, the row is not consumed or changed.
 */
export type BuyerFirstSender = "verified" | "unresolved" | "mismatch";

/**
 * Where a buyer-first claim sends its one reply; withoutLink = send the PDF without the login
 * link, which needs a link-free WhatsApp template ({link_trivia} without a value is missing_value).
 */
export interface BuyerFirstReply {
  readonly chatId: string;
  readonly withoutLink: boolean;
}

export type DeliveryDecision =
  | {
      readonly ok: true;
      readonly expect: { readonly status: DeliveryStatus; readonly attempts: number };
      readonly set: DeliveryPatch;
      /** Only on a buyer-first claim. */
      readonly reply?: BuyerFirstReply;
    }
  | { readonly ok: false; readonly reason: DeliveryRejection };

/** A claim that failed before it sent anything is tried again after this (not a number's fault, so no failover). */
export const NOT_ATTEMPTED_DELAY_MS = 60_000;

export type DeliveryOutcome =
  | { readonly kind: "sent"; readonly waMessageId?: string }
  | { readonly kind: "retryable_failure"; readonly error: string }
  | { readonly kind: "permanent_failure"; readonly error: string }
  | { readonly kind: "maybe_sent"; readonly error: string }
  | { readonly kind: "not_attempted"; readonly error: string };

/** One message from the WAHA "recent outgoing messages to this chat" lookup. */
export interface OutgoingMessage {
  readonly id: string;
  readonly chatId: string;
  readonly fromMe: boolean;
  readonly filename: string | null;
  readonly timestamp: Date;
}

const reject = (reason: DeliveryRejection): DeliveryDecision => ({ ok: false, reason });
const accept = (row: DeliveryRow, set: DeliveryPatch): DeliveryDecision => ({
  ok: true,
  expect: { status: row.status, attempts: row.attempts },
  set,
});

function assertPositiveMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer (ms)`);
}

const later = (at: Date, ms: number): Date => new Date(at.getTime() + ms);

/** The attempts that count against the retry budget. */
const spent = (row: DeliveryRow): number => row.attempts - (row.attemptsBase ?? 0);

export function claimDelivery(
  row: DeliveryRow,
  ctx: {
    readonly now: Date;
    readonly leaseMs: number;
    readonly sessionId?: string;
    /**
     * A pool with no number left that this delivery has not tried may try the same one again (the worker lets it, after a backoff, while
     * fewer than WA_MAX_SESSIONS attempts were made): the number goes into tried_session_ids once more, so the budget of 3 stays 3.
     */
    readonly retrySameSession?: boolean;
  },
): DeliveryDecision {
  assertPositiveMs(ctx.leaseMs, "leaseMs");
  if (row.status !== "pending") return reject("not_pending");
  if (ctx.now.getTime() < row.notBefore.getTime()) return reject("not_due");
  const lease = { status: "sending", leaseUntil: later(ctx.now, ctx.leaseMs), attempts: row.attempts + 1 } as const;
  if (row.channel === "email") {
    if (ctx.sessionId !== undefined) return reject("session_not_allowed");
    if (spent(row) >= EMAIL_MAX_ATTEMPTS) return reject("attempts_exhausted");
    return accept(row, lease);
  }
  if (ctx.sessionId === undefined || ctx.sessionId === "") return reject("session_required");
  if (row.triedSessionIds.includes(ctx.sessionId) && ctx.retrySameSession !== true) return reject("session_already_tried");
  if (row.triedSessionIds.length >= WA_MAX_SESSIONS) return reject("attempts_exhausted");
  if (row.waChatId === null || row.filename === null) return reject("missing_target");
  return accept(row, { ...lease, sessionId: ctx.sessionId, triedSessionIds: [...row.triedSessionIds, ctx.sessionId] });
}

/**
 * Buyer-first reply (AC-D8): claims the same pending WA row for the session the buyer wrote to,
 * ignoring not_before and tried_session_ids. Still requires `pending`, so the reply and the
 * proactive send can never both claim the row, and still counts an attempt. The buyer's chat
 * goes back as `reply`; wa_chat_id keeps the order's chat (never written here). `sender`: see
 * BuyerFirstSender; anything but "verified" gets reply.withoutLink.
 */
export function claimBuyerFirst(
  row: DeliveryRow,
  ctx: {
    readonly now: Date;
    readonly leaseMs: number;
    readonly sessionId: string;
    readonly chatId: string;
    readonly sender: BuyerFirstSender;
  },
): DeliveryDecision {
  assertPositiveMs(ctx.leaseMs, "leaseMs");
  if (ctx.sender === "mismatch") return reject("sender_mismatch");
  if (row.status !== "pending") return reject("not_pending");
  if (row.channel !== "whatsapp") return reject("wrong_channel");
  if (ctx.sessionId === "") return reject("session_required");
  if (ctx.chatId === "" || row.filename === null) return reject("missing_target");
  return {
    ok: true,
    expect: { status: row.status, attempts: row.attempts },
    set: {
      status: "sending",
      leaseUntil: later(ctx.now, ctx.leaseMs),
      attempts: row.attempts + 1,
      sessionId: ctx.sessionId,
      triedSessionIds: row.triedSessionIds.includes(ctx.sessionId)
        ? row.triedSessionIds
        : [...row.triedSessionIds, ctx.sessionId],
    },
    reply: { chatId: ctx.chatId, withoutLink: ctx.sender !== "verified" },
  };
}

export function recordDeliveryOutcome(
  row: DeliveryRow,
  outcome: DeliveryOutcome,
  ctx: { readonly now: Date; readonly attempt: number },
): DeliveryDecision {
  if (row.attempts !== ctx.attempt) return reject("stale");
  if (outcome.kind === "sent") {
    // A late success also settles an `unknown` row: the message did go out.
    if (row.status !== "sending" && row.status !== "unknown") return reject("not_sending");
    return accept(row, {
      status: "sent",
      sentAt: ctx.now,
      leaseUntil: null,
      lastError: null,
      ...(outcome.waMessageId === undefined ? {} : { waMessageId: outcome.waMessageId }),
    });
  }
  if (row.status !== "sending") return reject("not_sending");
  switch (outcome.kind) {
    case "maybe_sent":
      // Keep the lease: resolution starts only after it has expired.
      return accept(row, { status: "unknown", lastError: outcome.error });
    case "permanent_failure":
      return accept(row, { status: "failed", leaseUntil: null, lastError: outcome.error });
    case "retryable_failure":
      return retryOrFail(row, ctx.now, outcome.error);
    case "not_attempted": {
      // As if the claim had not happened, but not at once: the same fault would just repeat.
      const retryAt = later(ctx.now, NOT_ATTEMPTED_DELAY_MS);
      const tried = [...row.triedSessionIds];
      const at = row.sessionId === null ? -1 : tried.lastIndexOf(row.sessionId);
      if (at >= 0) tried.splice(at, 1);
      return accept(row, {
        status: "pending",
        notBefore: retryAt.getTime() > row.notBefore.getTime() ? retryAt : row.notBefore,
        leaseUntil: null,
        attemptsBase: (row.attemptsBase ?? 0) + 1,
        sessionId: null,
        triedSessionIds: tried,
        lastError: outcome.error,
      });
    }
  }
}

function retryOrFail(row: DeliveryRow, now: Date, error: string): DeliveryDecision {
  if (row.channel === "whatsapp") {
    if (row.triedSessionIds.length >= WA_MAX_SESSIONS) {
      return accept(row, { status: "failed", leaseUntil: null, lastError: error });
    }
    // Fail over now, but not before the proactive delay (a failed buyer-first reply claimed the
    // row early); the pool picks a session not in tried_session_ids.
    const notBefore = now.getTime() < row.notBefore.getTime() ? row.notBefore : now;
    return accept(row, { status: "pending", notBefore, leaseUntil: null, sessionId: null, lastError: error });
  }
  const delay = EMAIL_RETRY_DELAYS_MS[spent(row) - 1];
  if (spent(row) >= EMAIL_MAX_ATTEMPTS || delay === undefined) {
    return accept(row, { status: "failed", leaseUntil: null, lastError: error });
  }
  return accept(row, { status: "pending", notBefore: later(now, delay), leaseUntil: null, lastError: error });
}

/** Sweeper: a `sending` row whose lease expired may have been sent, so it becomes `unknown`. */
export function expireDeliveryLease(row: DeliveryRow, now: Date): DeliveryDecision {
  if (row.status !== "sending") return reject("not_sending");
  if (row.leaseUntil !== null && now.getTime() < row.leaseUntil.getTime()) return reject("lease_active");
  return accept(row, { status: "unknown", lastError: "lease expired while sending" });
}

/**
 * Resolves an `unknown` WA row from the session's recent outgoing messages. The window is the
 * lease, [lease_until - leaseMs - skewMs, lease_until + skewMs].
 */
export function resolveUnknownDelivery(
  row: DeliveryRow,
  ctx: {
    readonly now: Date;
    readonly leaseMs: number;
    readonly skewMs: number;
    readonly outgoing: readonly OutgoingMessage[];
  },
): DeliveryDecision {
  assertPositiveMs(ctx.leaseMs, "leaseMs");
  if (!Number.isSafeInteger(ctx.skewMs) || ctx.skewMs < 0) throw new RangeError("skewMs must be a non-negative integer");
  if (row.status !== "unknown") return reject("not_unknown");
  if (row.leaseUntil !== null && ctx.now.getTime() < row.leaseUntil.getTime()) return reject("lease_active");
  if (row.channel !== "whatsapp" || row.leaseUntil === null || row.waChatId === null || row.filename === null) {
    return reject("needs_review");
  }
  const from = row.leaseUntil.getTime() - ctx.leaseMs - ctx.skewMs;
  const to = row.leaseUntil.getTime() + ctx.skewMs;
  const match = ctx.outgoing.find(
    (m) =>
      m.fromMe &&
      m.chatId === row.waChatId &&
      m.filename === row.filename &&
      m.timestamp.getTime() >= from &&
      m.timestamp.getTime() <= to,
  );
  if (match === undefined) return reject("needs_review");
  return accept(row, { status: "sent", sentAt: match.timestamp, leaseUntil: null, waMessageId: match.id, lastError: null });
}

/** A pending delivery that has not gone out can be cancelled. */
export function cancelDelivery(row: DeliveryRow): DeliveryDecision {
  if (row.status !== "pending") return reject("not_pending");
  return accept(row, { status: "cancelled", leaseUntil: null });
}
