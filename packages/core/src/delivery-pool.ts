// The WhatsApp sender pool (plan M8.1; spec AC-D3, AC-D4, plan §10 item 23 ban mitigation). Which WORKING number
// sends next, and how fast a number may send. Pure: the database supplies each session's counts, the caller the
// random source and the clock.
//
//   eligible    the session is WORKING (its status was polled at most POOL_STATUS_MAX_AGE_MS ago), is not one
//               the delivery already tried, has sent fewer than its daily cap today (deliveries, buyer-first
//               replies and OTPs all count), is not cooling down after repeated failures, and its next free
//               send slot is at most `maxWaitMs` away (a number with a long queue is "busy", never blasted).
//   weighted    round-robin: the eligible session with the lowest (sentToday + 1) / weight goes next, so over a
//               day each number's share follows its weight and equal weights rotate; ties go to the earliest
//               free slot and then to a random one.
//   pacing      every send reserves a slot after the number's previous one, `gap` apart, with a random gap
//               (jitter): a number never sends two messages back to back, whatever the concurrency.
//   health      a number that fails SESSION_FAIL_THRESHOLD sends in a row is put on a cooldown and raises an
//               alert; a send that goes out clears the streak.
//   ban signals WhatsApp's own limits on a number (WAHA: "server returned error 463" reachout timelock, "475" message
//               capping; the session stays WORKING and a restart resets neither): until `reachoutUntil` the number sends
//               no NEW-contact message (an opener, an OTP) but still answers a buyer who wrote first, and its warning
//               level (FIRST_WARNING / SECOND_WARNING) slows its openers down. Not a failure of the number: no streak.
// "No session" is explained (PoolShortage) so the caller can tell a pool that is empty (alert) from one that is
// only busy or capped (wait), and from a delivery that has run out of numbers to fail over to (give up).

export const SESSION_WORKING = "WORKING";
/** A session status older than this is not trusted: the health poll has stopped (or WAHA is unreachable). */
export const POOL_STATUS_MAX_AGE_MS = 3 * 60_000;
/** AC-D4 / the ban mitigation: a number that failed this many sends in a row rests. */
export const SESSION_FAIL_THRESHOLD = 3;
export const SESSION_COOLDOWN_MS = 10 * 60_000;
/** Random gap between two sends of one number: deliveries and replies, and the (urgent, short) OTP. */
export const DELIVERY_GAP_MS: readonly [number, number] = [3000, 9000];
export const OTP_GAP_MS: readonly [number, number] = [500, 2000];
/** The longest a send waits for its slot; a number with a longer queue is skipped. */
export const POOL_MAX_WAIT_MS = 20_000;
/**
 * How long a number is kept from new contacts after WhatsApp refused one (error 463 / 475) when the session's own state (its timelock end, its capping
 * cycle end) is not known: the health poll replaces it with the real end. Restarting or re-pairing the session does not lift either.
 */
export const REACHOUT_COOLDOWN_MS = 60 * 60_000;

/** WAHA's message-capping warnings, in the order they come (CappingStatus FIRST_WARNING / SECOND_WARNING; `none` otherwise). */
export const WARNING_LEVELS = ["none", "first", "second"] as const;
export type WarningLevel = (typeof WARNING_LEVELS)[number];

/** The share of a number's daily budget of NEW contacts that a FIRST_WARNING and a SECOND_WARNING leave it (worker.env WORKER_WA_WARNING_FACTORS overrides). */
export const DEFAULT_WARNING_CAP_FACTORS: readonly [number, number] = [0.5, 0.25];

/**
 * What a warning does to a number's new-contact sends (openers, login codes): a smaller share of its daily new-contact budget and a longer gap between
 * sends. A reply to a buyer who wrote first is never slowed by it.
 */
export function warningSlowdown(level: WarningLevel, capFactors: readonly [number, number] = DEFAULT_WARNING_CAP_FACTORS): { readonly capFactor: number; readonly gapFactor: number } {
  switch (level) {
    case "none":
      return { capFactor: 1, gapFactor: 1 };
    case "first":
      return { capFactor: capFactors[0], gapFactor: 2 };
    case "second":
      return { capFactor: capFactors[1], gapFactor: 4 };
  }
}

/** A number's new-contact budget for today after its warning (whole sends). */
export const effectiveNewContactCap = (session: Pick<PoolSession, "newContactCap" | "warning">, capFactors?: readonly [number, number]): number =>
  Math.floor(session.newContactCap * warningSlowdown(session.warning, capFactors).capFactor);

export interface PoolSession {
  readonly id: string;
  /** > 0. */
  readonly weight: number;
  /** Sends allowed per WIB day; 0 takes the number out of the pool. */
  readonly dailyCap: number;
  /** Sends claimed since WIB midnight, of every kind. */
  readonly sentToday: number;
  readonly status: string | null;
  /** When `status` was polled. */
  readonly statusAt: Date | null;
  /** When the number's last reserved slot ends (the next send may start then). */
  readonly nextSendAt: Date | null;
  readonly cooldownUntil: Date | null;
  /** WhatsApp's ban signal (463 / 475): no new-contact message until here. */
  readonly reachoutUntil: Date | null;
  readonly warning: WarningLevel;
  /** The number's daily budget of NEW contacts (a chat it has no history with), separate from its replies, and what it spent of it today. */
  readonly newContactCap: number;
  readonly newContactsToday: number;
  /** This number already has a chat with the contact being written to (a reply, an earlier message, an inbound message): no new-contact rules for it. */
  readonly knowsContact?: boolean;
}

export type PoolShortage =
  /** Every session of the pool was already tried by this delivery (or the pool holds none): nothing to fail over to, ever. */
  | "no_untried_session"
  /** Sessions remain, none of them WORKING. The pool is empty for now: alert. */
  | "no_working_session"
  | "all_capped"
  | "all_cooling_down"
  /** A NEW-contact message (an opener, an OTP) and every number is held back by WhatsApp (463 / 475): openers stop until one is free again. */
  | "all_reachout_blocked"
  /** A NEW-contact message and every number has spent today's budget of new contacts (replies are not counted against it): openers wait for tomorrow. */
  | "all_new_contact_capped"
  | "all_busy"
  /** The contact already got four messages this hour (core human-send CONTACT_MAX_PER_HOUR); the claim says when to come back. */
  | "contact_capped";

export type PoolPick = { readonly kind: "picked"; readonly session: PoolSession } | { readonly kind: "none"; readonly reason: PoolShortage };

export interface PickContext {
  readonly now: Date;
  /** Sessions this delivery already tried (core WA_MAX_SESSIONS). */
  readonly exclude: readonly string[];
  readonly maxWaitMs: number;
  /** Uniform in [0, 1). */
  readonly random: () => number;
  /**
   * The message goes to a contact who has not written first (an opener, an OTP): on a number that has NO history with the contact (`knowsContact`), a ban
   * signal skips the number and its daily budget of new contacts (after its warning) must have room. A number that already has a chat with the contact
   * answers it whatever its ban state.
   */
  readonly newContact?: boolean;
  /** The share of the new-contact budget each warning leaves (default core DEFAULT_WARNING_CAP_FACTORS). */
  readonly warningCapFactors?: readonly [number, number];
}

const isWorking = (s: PoolSession, now: Date): boolean =>
  s.status === SESSION_WORKING && s.statusAt !== null && now.getTime() - s.statusAt.getTime() <= POOL_STATUS_MAX_AGE_MS;

const waitMs = (s: PoolSession, now: Date): number => (s.nextSendAt === null ? 0 : Math.max(0, s.nextSendAt.getTime() - now.getTime()));

/** Weighted round-robin over the WORKING sessions (see the header). */
export function pickSession(sessions: readonly PoolSession[], ctx: PickContext): PoolPick {
  const untried = sessions.filter((s) => !ctx.exclude.includes(s.id));
  if (untried.length === 0) return { kind: "none", reason: "no_untried_session" };
  const working = untried.filter((s) => isWorking(s, ctx.now));
  if (working.length === 0) return { kind: "none", reason: "no_working_session" };
  const uncapped = working.filter((s) => s.sentToday < s.dailyCap);
  if (uncapped.length === 0) return { kind: "none", reason: "all_capped" };
  const rested = uncapped.filter((s) => s.cooldownUntil === null || s.cooldownUntil.getTime() <= ctx.now.getTime());
  if (rested.length === 0) return { kind: "none", reason: "all_cooling_down" };
  // The new-contact rules apply to a number only for a contact it has no history with: a number WhatsApp holds back from new contacts still answers a chat it has.
  const isNew = (s: PoolSession): boolean => ctx.newContact === true && s.knowsContact !== true;
  const reachable = rested.filter((s) => !isNew(s) || s.reachoutUntil === null || s.reachoutUntil.getTime() <= ctx.now.getTime());
  if (reachable.length === 0) return { kind: "none", reason: "all_reachout_blocked" };
  const budgeted = reachable.filter((s) => !isNew(s) || s.newContactsToday < effectiveNewContactCap(s, ctx.warningCapFactors));
  if (budgeted.length === 0) return { kind: "none", reason: "all_new_contact_capped" };
  const free = budgeted.filter((s) => waitMs(s, ctx.now) <= ctx.maxWaitMs);
  if (free.length === 0) return { kind: "none", reason: "all_busy" };
  const share = (s: PoolSession): number => (s.sentToday + 1) / s.weight;
  const best = Math.min(...free.map(share));
  const level = free.filter((s) => share(s) === best);
  const earliest = Math.min(...level.map((s) => waitMs(s, ctx.now)));
  const tied = level.filter((s) => waitMs(s, ctx.now) === earliest);
  const chosen = tied[Math.floor(ctx.random() * tied.length)] ?? tied[0];
  if (chosen === undefined) throw new Error("unreachable: a non-empty tie has a first element");
  return { kind: "picked", session: chosen };
}

/** A random whole number of milliseconds in [min, max]. */
export function jitterMs(range: readonly [number, number], random: () => number): number {
  const [min, max] = range;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min) throw new RangeError("a jitter range is [min, max] with 0 <= min <= max");
  return min + Math.floor(random() * (max - min + 1));
}

export interface SendSlot {
  /** When the send may start. */
  readonly startAt: Date;
  /** The number's next free slot: the send starts here, then `gapMs` of rest. */
  readonly nextSendAt: Date;
}

/**
 * Reserves the number's next slot: after its previous reservation (or now), and not before `notBefore` (the per-contact gap, core human-send
 * contactAllowance), followed by `gapMs` of rest.
 */
export function reserveSlot(session: Pick<PoolSession, "nextSendAt">, now: Date, gapMs: number, notBefore?: Date): SendSlot {
  if (!Number.isSafeInteger(gapMs) || gapMs < 0) throw new RangeError("gapMs must be a non-negative integer");
  const free = session.nextSendAt !== null && session.nextSendAt.getTime() > now.getTime() ? session.nextSendAt : now;
  const startAt = notBefore !== undefined && notBefore.getTime() > free.getTime() ? notBefore : free;
  return { startAt, nextSendAt: new Date(startAt.getTime() + gapMs) };
}

export interface SessionHealth {
  readonly failStreak: number;
  /** Set when this outcome tripped the breaker. */
  readonly cooldownUntil: Date | null;
  readonly tripped: boolean;
}

/** The streak after one send: a send that went out clears it, a failed (or uncertain) one extends it. */
export function sessionHealthAfter(streak: number, sendWentOut: boolean, now: Date): SessionHealth {
  if (!Number.isSafeInteger(streak) || streak < 0) throw new RangeError("streak must be a non-negative integer");
  if (sendWentOut) return { failStreak: 0, cooldownUntil: null, tripped: false };
  const failStreak = streak + 1;
  const tripped = failStreak >= SESSION_FAIL_THRESHOLD;
  return { failStreak, cooldownUntil: tripped ? new Date(now.getTime() + SESSION_COOLDOWN_MS) : null, tripped };
}
