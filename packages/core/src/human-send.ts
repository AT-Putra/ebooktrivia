// Human-like WhatsApp sending (US-025, Owner requirement; WAHA docs "How to avoid blocking", "Presence", "Chats"). Every WhatsApp message the worker
// sends (the opener, the reply with the ebook, a text reply, the player's OTP) follows one order, and this file holds the part that is pure: HOW LONG
// each pause is. The worker (apps/worker/src/delivery/human.ts) runs the sequence:
//
//   1. seen        the WHOLE chat is marked as read (no message ids), whatever the send: an opener, a reply, a text, an OTP. A chat we write to while older messages
//                  of that person still show unread looks like a bot (Owner rule, 2026-11-24);
//   2. reading     a random pause, as if the message were being read (not for an OTP: it is time-critical);
//   3. typing      the "typing..." presence starts;
//   4. typing wait a random wait scaled to the length of the message;
//   5. paused      the typing presence ends;
//   6. a short random pause;
//   7. send;
//   8. offline     the session goes back to "offline" (WAHA: while a session shows online the phone gets no notifications).
//
// Never fixed timing: every pause is drawn per message, from a random source the caller supplies (the worker's is cryptographic), from a LOG-NORMAL
// distribution (most pauses are short, a few long, like a person's) truncated to its bounds. Values never pile up at a bound either: a drawn value
// outside its range is redrawn, and a typing wait that the message length pushes past its range lands inside it, near the edge, at a random place.
// The bounds below are the Owner's starting values (documented in docs/runbooks/delivery.md); change them here and in the runbook together.
import { jitterMs } from "./delivery-pool.ts";

/** An inclusive range of milliseconds, [min, max]. */
export type MsRange = readonly [number, number];

export const HUMAN_TIMING = {
  /** The pause after the seen mark. */
  reading: [600, 4000],
  /** Typing: a base plus a per-character rate (itself drawn per message), clamped to the typing range. */
  typingBase: [1200, 2500],
  typingPerChar: [35, 75],
  typing: [2000, 14_000],
  /** The short pause between "stopped typing" and the send. */
  paused: [300, 1500],
  /** An OTP is time-critical: its choreography stays under 4 seconds (no reading pause, typing at most 3 s, a pause of at most 0.9 s; the seen mark is one quick best-effort call). */
  otpTypingBase: [800, 1500],
  otpTyping: [1000, 3000],
  otpPaused: [300, 900],
} as const satisfies Record<string, MsRange>;

/** A second message to the same contact waits this long after the previous one (WAHA docs: 30 to 60 s). */
export const CONTACT_GAP_MS: MsRange = [30_000, 60_000];
/** At most this many messages to one contact in an hour (WAHA docs). */
export const CONTACT_MAX_PER_HOUR = 4;
export const CONTACT_WINDOW_MS = 3_600_000;
/** The longest a second message to one contact waits for its gap. */
export const CONTACT_MAX_WAIT_MS = CONTACT_GAP_MS[1];

/** Seen, typing, paused and offline are best effort and quick: each call has this long, then it is given up (never held against the send). */
export const HUMAN_PRESENCE_TIMEOUT_MS = 3000;
/**
 * The longest the choreography can take around the send, calls included: the waits (reading, typing and the pause, at their upper bounds) and the five
 * best-effort calls (seen and the second call of its fallback, typing, paused, and the offline after the send) each running out its timeout. The lease of a
 * claim must cover this, the number's slot, the contact gap and the send itself (apps/worker/src/delivery/config.ts checks it).
 */
export const HUMAN_MAX_MS = HUMAN_TIMING.reading[1] + HUMAN_TIMING.typing[1] + HUMAN_TIMING.paused[1] + 5 * HUMAN_PRESENCE_TIMEOUT_MS;

export type HumanKind = "message" | "otp";

export interface HumanPlan {
  /** 0 for an OTP (time-critical: the chat is marked as read, but there is no reading pause). */
  readonly readingMs: number;
  readonly typingMs: number;
  readonly pausedMs: number;
}

/**
 * One value from a log-normal distribution truncated to [min, max] (whole milliseconds): the median is the geometric mean of the bounds and the bounds
 * sit two standard deviations out. A value outside the range is redrawn (up to 8 times, then uniform inside it), so nothing piles up at a bound.
 */
export function sampleLogNormal(random: () => number, range: MsRange): number {
  const [min, max] = range;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min) throw new RangeError("a range is [min, max] with 1 <= min <= max");
  if (min === max) return min;
  const mu = (Math.log(min) + Math.log(max)) / 2;
  const sigma = (Math.log(max) - Math.log(min)) / 4;
  for (let attempt = 0; attempt < 8; attempt++) {
    const u1 = Math.max(random(), Number.EPSILON);
    const u2 = random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const value = Math.exp(mu + sigma * z);
    if (value >= min && value <= max) return Math.round(value);
  }
  return min + Math.floor(random() * (max - min + 1));
}

/** A value outside [min, max] is put back inside it, near the edge it crossed, at a random place within 15 % of the range (never a pile at the bound). */
function spreadInto(value: number, [min, max]: MsRange, random: () => number): number {
  const edge = Math.floor(random() * (max - min) * 0.15);
  if (value < min) return min + edge;
  if (value > max) return max - edge;
  return value;
}

/** The pauses of one message (see the header). `textLength` is the length of what is typed: the message, or the caption of a file. */
export function humanPlan(input: { readonly kind: HumanKind; readonly textLength: number }, random: () => number): HumanPlan {
  if (!Number.isSafeInteger(input.textLength) || input.textLength < 0) throw new RangeError("textLength must be a non-negative integer");
  const otp = input.kind === "otp";
  const base = sampleLogNormal(random, otp ? HUMAN_TIMING.otpTypingBase : HUMAN_TIMING.typingBase);
  const perChar = sampleLogNormal(random, HUMAN_TIMING.typingPerChar);
  return {
    readingMs: otp ? 0 : sampleLogNormal(random, HUMAN_TIMING.reading),
    typingMs: spreadInto(Math.round(base + perChar * input.textLength), otp ? HUMAN_TIMING.otpTyping : HUMAN_TIMING.typing, random),
    pausedMs: sampleLogNormal(random, otp ? HUMAN_TIMING.otpPaused : HUMAN_TIMING.paused),
  };
}

export type ContactDecision =
  /** The message may go once `notBefore` has come (a random 30 to 60 s after the previous message to this contact, or now). */
  | { readonly ok: true; readonly notBefore: Date }
  /** Four messages in the last hour: nothing more to this contact until `retryAt`. */
  | { readonly ok: false; readonly retryAt: Date };

/** The per-contact rules (see CONTACT_GAP_MS, CONTACT_MAX_PER_HOUR), from the start times of what was already sent to the contact (any number). */
export function contactAllowance(input: { readonly sentAt: readonly Date[]; readonly now: Date; readonly random: () => number }): ContactDecision {
  const since = input.now.getTime() - CONTACT_WINDOW_MS;
  const recent = input.sentAt.map((d) => d.getTime()).filter((t) => t > since).sort((a, b) => a - b);
  const oldestCounted = recent[recent.length - CONTACT_MAX_PER_HOUR];
  if (oldestCounted !== undefined) return { ok: false, retryAt: new Date(oldestCounted + CONTACT_WINDOW_MS) };
  const last = recent.at(-1);
  if (last === undefined) return { ok: true, notBefore: input.now };
  return { ok: true, notBefore: new Date(Math.max(last + jitterMs(CONTACT_GAP_MS, input.random), input.now.getTime())) };
}

/** The buyer's first name for the opener: the first word of the name, without markup characters ("Budi Santoso" -> "Budi"); "" when there is none. */
export function firstName(name: string): string {
  const word = name.trim().split(/\s+/)[0] ?? "";
  return word.replace(/[<>*_~`]/g, "").slice(0, 40);
}
