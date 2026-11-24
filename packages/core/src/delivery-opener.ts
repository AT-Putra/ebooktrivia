// The opener of a WhatsApp delivery (US-025, Owner decision D7): the state machine of the one short text the proactive WhatsApp send has become.
//
// A buyer who has not written first gets ONE short opener (text only: no PDF, no login link) that asks them to reply. The PDF and the link go out
// when the buyer replies: the buyer-first path claims the SAME deliveries row (delivery-machine claimBuyerFirst), which stays `pending` until then.
// A buyer who never replies gets the PDF by e-mail only: not a failure, no alert. So the opener is a small exactly-once machine of its own, next to
// the delivery's, with the same shape as it (claim -> lease -> outcome) and one rule above all: an opener that went out, or may have, is never sent
// again (the database refuses it too, ET131).
//
//   claim     pending -> sending (lease, attempts + 1, the number into tried_session_ids), once the delivery's not_before and the opener's own
//             next_attempt_at have passed; at most WA_MAX_SESSIONS numbers; an opener older than OPENER_MAX_AGE_MS (counted from not_before) is
//             not sent any more (`expired`: the e-mail has the ebook, and a late "reply to this" would only be odd).
//   outcome   sent              -> sent (awaiting the reply; a late success also settles an `unknown` opener)
//             retryable failure -> pending on another number at once (WAHA refused it, the session is not working), then failed after
//                                  WA_MAX_SESSIONS numbers: quietly, the buyer still has the e-mail and the order page's WhatsApp button
//             permanent failure -> failed
//             maybe sent        -> unknown: never resent (a timeout, a reset, a 5xx: it may be on its way)
//             not attempted     -> pending again after OPENER_RETRY_DELAY_MS, as if the claim never happened (attempt and number given back): a
//                                  fault of ours before anything was sent (a template, the abort, a lease that ended during the waits) and WhatsApp's
//                                  own ban signals (463 / 475: the number is held back, the opener waits for another number)
//   lease     sending with an expired lease -> unknown
//   expire    pending -> expired: the opener is moot (the buyer wrote first and the delivery was claimed by their reply, or it is too old)
// Every decision returns the expected current status and attempt count, for the caller's conditional UPDATE, like the delivery machine's.
import { WA_MAX_SESSIONS } from "./delivery-machine.ts";

/** Same values as delivery_openers_status_check (packages/db/src/schema/delivery.ts). */
export const OPENER_STATUSES = ["pending", "sending", "sent", "unknown", "failed", "expired"] as const;
export type OpenerStatus = (typeof OPENER_STATUSES)[number];

/** An opener is not sent later than this after the delivery's not_before. */
export const OPENER_MAX_AGE_MS = 6 * 3_600_000;
/** A claim that sent nothing is tried again after this (not a number's fault, so no failover). */
export const OPENER_RETRY_DELAY_MS = 30_000;

export interface OpenerRow {
  readonly status: OpenerStatus;
  readonly attempts: number;
  readonly sessionId: string | null;
  readonly triedSessionIds: readonly string[];
  readonly nextAttemptAt: Date | null;
  readonly leaseUntil: Date | null;
}

/** What a new opener row looks like before its first claim: pending, due at the delivery's not_before. */
export const NEW_OPENER: OpenerRow = { status: "pending", attempts: 0, sessionId: null, triedSessionIds: [], nextAttemptAt: null, leaseUntil: null };

export interface OpenerPatch {
  readonly status: OpenerStatus;
  readonly attempts?: number;
  readonly sessionId?: string | null;
  readonly triedSessionIds?: readonly string[];
  readonly nextAttemptAt?: Date | null;
  readonly leaseUntil?: Date | null;
  readonly sentAt?: Date;
  readonly waMessageId?: string;
  readonly lastError?: string | null;
}

export type OpenerRejection =
  | "not_pending"
  | "not_due"
  | "expired"
  | "session_required"
  | "session_already_tried"
  | "attempts_exhausted"
  | "not_sending"
  | "stale"
  | "lease_active";

export type OpenerDecision =
  | { readonly ok: true; readonly expect: { readonly status: OpenerStatus; readonly attempts: number }; readonly set: OpenerPatch }
  | { readonly ok: false; readonly reason: OpenerRejection };

export type OpenerOutcome =
  | { readonly kind: "sent"; readonly waMessageId?: string }
  /** WAHA's check-exists says the phone is not on WhatsApp: final (no failover: no number would change it, no penalty for any number, no alert; the e-mail has the ebook). */
  | { readonly kind: "no_whatsapp" }
  | { readonly kind: "retryable_failure"; readonly error: string }
  | { readonly kind: "permanent_failure"; readonly error: string }
  | { readonly kind: "maybe_sent"; readonly error: string }
  | { readonly kind: "not_attempted"; readonly error: string };

const reject = (reason: OpenerRejection): OpenerDecision => ({ ok: false, reason });
const accept = (row: OpenerRow, set: OpenerPatch): OpenerDecision => ({ ok: true, expect: { status: row.status, attempts: row.attempts }, set });
const later = (at: Date, ms: number): Date => new Date(at.getTime() + ms);

export function claimOpener(
  row: OpenerRow,
  ctx: {
    readonly now: Date;
    /** The delivery's not_before: the opener is due from here, and ages from here. */
    readonly notBefore: Date;
    readonly leaseMs: number;
    readonly sessionId: string;
    /** A pool with one number (or whose other numbers were all tried) may try the same one again, after a backoff, while fewer than WA_MAX_SESSIONS attempts were made. */
    readonly retrySameSession?: boolean;
  },
): OpenerDecision {
  if (!Number.isSafeInteger(ctx.leaseMs) || ctx.leaseMs <= 0) throw new RangeError("leaseMs must be a positive integer (ms)");
  if (row.status !== "pending") return reject("not_pending");
  const dueAt = row.nextAttemptAt !== null && row.nextAttemptAt.getTime() > ctx.notBefore.getTime() ? row.nextAttemptAt : ctx.notBefore;
  if (ctx.now.getTime() < dueAt.getTime()) return reject("not_due");
  if (ctx.now.getTime() - ctx.notBefore.getTime() > OPENER_MAX_AGE_MS) return reject("expired");
  if (ctx.sessionId === "") return reject("session_required");
  if (row.triedSessionIds.includes(ctx.sessionId) && ctx.retrySameSession !== true) return reject("session_already_tried");
  if (row.triedSessionIds.length >= WA_MAX_SESSIONS) return reject("attempts_exhausted");
  return accept(row, {
    status: "sending",
    attempts: row.attempts + 1,
    sessionId: ctx.sessionId,
    triedSessionIds: [...row.triedSessionIds, ctx.sessionId],
    leaseUntil: later(ctx.now, ctx.leaseMs),
    nextAttemptAt: null,
  });
}

export function recordOpenerOutcome(row: OpenerRow, outcome: OpenerOutcome, ctx: { readonly now: Date; readonly attempt: number }): OpenerDecision {
  if (row.attempts !== ctx.attempt) return reject("stale");
  if (outcome.kind === "sent") {
    // A late success also settles an `unknown` opener: the message did go out.
    if (row.status !== "sending" && row.status !== "unknown") return reject("not_sending");
    return accept(row, { status: "sent", sentAt: ctx.now, leaseUntil: null, lastError: null, ...(outcome.waMessageId === undefined ? {} : { waMessageId: outcome.waMessageId }) });
  }
  if (row.status !== "sending") return reject("not_sending");
  switch (outcome.kind) {
    case "no_whatsapp":
      return accept(row, { status: "failed", leaseUntil: null, nextAttemptAt: null, lastError: "no_whatsapp" });
    case "maybe_sent":
      // Keep the lease: the opener is looked at no more, but a late success of the send itself may still settle it.
      return accept(row, { status: "unknown", lastError: outcome.error });
    case "permanent_failure":
      return accept(row, { status: "failed", leaseUntil: null, lastError: outcome.error });
    case "retryable_failure":
      if (row.triedSessionIds.length >= WA_MAX_SESSIONS) return accept(row, { status: "failed", leaseUntil: null, lastError: outcome.error });
      return accept(row, { status: "pending", leaseUntil: null, sessionId: null, nextAttemptAt: ctx.now, lastError: outcome.error });
    case "not_attempted": {
      const tried = [...row.triedSessionIds];
      const at = row.sessionId === null ? -1 : tried.lastIndexOf(row.sessionId);
      if (at >= 0) tried.splice(at, 1);
      return accept(row, {
        status: "pending",
        sessionId: null,
        triedSessionIds: tried,
        leaseUntil: null,
        nextAttemptAt: later(ctx.now, OPENER_RETRY_DELAY_MS),
        lastError: outcome.error,
      });
    }
  }
}

/** Sweeper: a `sending` opener whose lease expired may have been sent, so it becomes `unknown` (and is never sent again). */
export function expireOpenerLease(row: OpenerRow, now: Date): OpenerDecision {
  if (row.status !== "sending") return reject("not_sending");
  if (row.leaseUntil !== null && now.getTime() < row.leaseUntil.getTime()) return reject("lease_active");
  return accept(row, { status: "unknown", lastError: "lease expired while sending" });
}

/** An opener that was never sent and no longer should be (the buyer wrote first; or it is too old): final, quiet. */
export function expireOpener(row: OpenerRow, reason: string): OpenerDecision {
  if (row.status !== "pending") return reject("not_pending");
  return accept(row, { status: "expired", nextAttemptAt: null, lastError: reason });
}

/** An opener that cannot be sent from any number left (every number tried): failed, quietly (the e-mail has the ebook). */
export function failOpener(row: OpenerRow, error: string): OpenerDecision {
  if (row.status !== "pending") return reject("not_pending");
  return accept(row, { status: "failed", nextAttemptAt: null, leaseUntil: null, lastError: error });
}

/** A phone that WhatsApp has is not asked again for this long (WAHA check-exists); one that it has not, for a day (the owner may install it). */
export const CONTACT_CACHE_EXISTS_MS = 30 * 24 * 3_600_000;
export const CONTACT_CACHE_MISSING_MS = 24 * 3_600_000;

/** Is a cached check-exists answer still good? */
export const contactCacheFresh = (entry: { readonly numberExists: boolean; readonly checkedAt: Date }, now: Date): boolean =>
  now.getTime() - entry.checkedAt.getTime() < (entry.numberExists ? CONTACT_CACHE_EXISTS_MS : CONTACT_CACHE_MISSING_MS);

/** Is the opener too old to send (counted from the delivery's not_before)? */
export const openerTooOld = (now: Date, notBefore: Date): boolean => now.getTime() - notBefore.getTime() > OPENER_MAX_AGE_MS;

/** A number does not repeat a wording it used for one of its last this many openers. */
export const OPENER_NO_REPEAT = 3;

/**
 * Which wording (the key of a `delivery_opener_*` template) a number's next opener uses (Owner decision 2026-11-24): uniformly at random among the wordings
 * the number did NOT use for its last OPENER_NO_REPEAT openers. `recentKeys` are the keys of that number's latest openers, newest first (a key whose
 * wording has since been removed still takes its place in the window and excludes nothing). With fewer than OPENER_NO_REPEAT + 1 wordings, as many of the
 * newest ones are excluded as leaves at least one to choose from. Undefined when there is no wording at all. `random` is uniform in [0, 1).
 */
export function pickOpenerWording(keys: readonly string[], recentKeys: readonly string[], random: () => number): string | undefined {
  if (keys.length === 0) return undefined;
  const excluded: string[] = [];
  for (const key of recentKeys.slice(0, OPENER_NO_REPEAT)) {
    if (!keys.includes(key) || excluded.includes(key)) continue;
    // Keep at least one wording to choose from: the oldest of the recent ones are the first to be allowed again.
    if (keys.length - excluded.length > 1) excluded.push(key);
  }
  const allowed = keys.filter((key) => !excluded.includes(key));
  return allowed[Math.min(allowed.length - 1, Math.floor(random() * allowed.length))];
}
