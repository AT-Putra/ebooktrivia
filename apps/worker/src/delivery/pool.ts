// The WhatsApp sender pool in PostgreSQL (US-025; plan M8.1). core delivery-pool.ts decides (weighted round-robin, caps,
// pacing, health, ban signals) and core human-send.ts the per-contact rules; this file supplies the numbers they decide on and writes the
// decision down:
//   - every claimed send is a waha_sends row (kind opener, reply, text or otp), which the per-number daily cap (since WIB
//     midnight) and the round-robin count, and which carries a digest of the recipient (contact_key) and the moment the send starts: a second
//     message to one contact waits a random 30 to 60 s after the previous one (whichever number sent it) and at most 4 go in an hour;
//   - a number's next free send slot is waha_sessions.next_send_at: reserving a slot moves it by a random gap (jitter), so a
//     number never sends two messages back to back whatever the concurrency, and a send waits for its slot;
//   - the streak of failed sends and the cooldown of a number the breaker rested (core sessionHealthAfter);
//   - WhatsApp's own limits on a number (reachout_until: errors 463 / 475, or WAHA's timelock / capping state; warning_level: the capping
//     warnings): a number under one sends no NEW-contact message (an opener, an OTP), and a warning shrinks its share of the cap and
//     stretches its gap;
//   - the warm-up of a new number (waha_sessions.warmup_started_at, core WARMUP_SCHEDULE): its budget of NEW contacts grows with the WIB days
//     since it started; replies and contacts the number already knows are never held down by it.
// Every reservation runs in the caller's transaction under ONE advisory lock (POOL_LOCK), so two claims never both pass
// a cap check or take the same slot. The lock is held only for those few statements, never across a WAHA call, and is taken
// after the order and delivery locks (the lock order of every delivery path), so it cannot deadlock with them.
import {
  contactAllowance,
  jitterMs,
  type PoolShortage,
  type PoolSession,
  pickSession,
  POOL_MAX_WAIT_MS,
  REACHOUT_COOLDOWN_MS,
  reserveSlot,
  type SendSlot,
  type SessionHealth,
  sessionHealthAfter,
  type WarningLevel,
  warningSlowdown,
} from "@ebooktrivia/core";
import { createHash } from "node:crypto";
import type postgres from "postgres";

type Db = postgres.Sql | postgres.TransactionSql;

export type SendKind = "opener" | "reply" | "text" | "otp";

const POOL_LOCK = "waha_pool";
/** A number "has a chat" with a contact for this long after the last message either way (the ledger keeps this much history). */
export const KNOWN_CONTACT_MS = 30 * 24 * 3_600_000;

/** The digest of a recipient's chat id that the per-contact rules count: never the chat id itself. */
export const contactKey = (chatId: string): string => createHash("sha256").update(`ebooktrivia/contact/v1|${chatId}`).digest("hex");

interface SessionDbRow {
  id: string;
  weight: number;
  daily_cap: number;
  status: string | null;
  status_at: Date | null;
  next_send_at: Date | null;
  cooldown_until: Date | null;
  reachout_until: Date | null;
  warning_level: WarningLevel;
  new_contact_cap: number;
  warmup_started_at: Date | null;
  sent_today: number;
  new_contacts_today: number;
  now: Date;
}

/** The pool: every active session of an active server, with what it sent since WIB midnight. */
export async function listPoolSessions(db: Db, only?: string): Promise<{ readonly sessions: PoolSession[]; readonly now: Date }> {
  const rows = await db<SessionDbRow[]>`
    SELECT s.id, s.weight, s.daily_cap, s.status, s.status_at, s.next_send_at, s.cooldown_until, s.reachout_until, s.warning_level, s.new_contact_cap, s.warmup_started_at,
           (SELECT count(*)::int FROM public.waha_sends x
             WHERE x.session_id = s.id AND x.outcome <> 'failed'
               AND x.created_at >= date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta') AS sent_today,
           (SELECT count(*)::int FROM public.waha_sends x
             WHERE x.session_id = s.id AND x.new_contact AND x.outcome <> 'failed'
               AND x.created_at >= date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta') AS new_contacts_today,
           clock_timestamp() AS now
      FROM public.waha_sessions s JOIN public.waha_servers w ON w.id = s.server_id
     WHERE s.active AND w.active AND (${only ?? null}::uuid IS NULL OR s.id = ${only ?? null}::uuid)
     ORDER BY s.id`;
  return {
    now: rows[0]?.now ?? new Date(),
    sessions: rows.map((r) => ({
      id: r.id,
      weight: r.weight,
      dailyCap: r.daily_cap,
      sentToday: r.sent_today,
      status: r.status,
      statusAt: r.status_at,
      nextSendAt: r.next_send_at,
      cooldownUntil: r.cooldown_until,
      reachoutUntil: r.reachout_until,
      warning: r.warning_level,
      newContactCap: r.new_contact_cap,
      warmupStartedAt: r.warmup_started_at,
      newContactsToday: r.new_contacts_today,
    })),
  };
}

export interface ClaimInput {
  /** Sessions this delivery already tried. */
  readonly exclude: readonly string[];
  /** Only this session may send (a buyer-first reply goes out of the number the buyer wrote to). */
  readonly only?: string;
  readonly kind: SendKind;
  readonly deliveryId: string | null;
  /** The random gap after this send (core DELIVERY_GAP_MS / OTP_GAP_MS). */
  readonly gap: readonly [number, number];
  readonly random: () => number;
  readonly maxWaitMs?: number;
  /**
   * The extra sends (replies to inbound messages) may only use this share of a number's daily cap (0..1), so they can never starve the
   * proactive deliveries of the rest of it.
   */
  readonly capShare?: number;
  /** The message goes to a contact who has not written first (an opener, an OTP): numbers under a ban signal are skipped, warnings slow the number. */
  readonly newContact?: boolean;
  /**
   * The recipient: the per-contact rules (a 30 to 60 s gap after the previous message, at most 4 an hour) apply, and a new-contact send is judged per number
   * by the history with this contact. A buyer is identified by the phone (an opener, a reply to the order's buyer, a login code), a stranger by the chat id.
   */
  readonly contact?: string;
  /** The chat ids this contact is known by (its @c.us, its @lid): the inbound messages from them count as a chat the number has with the contact. */
  readonly contactChats?: readonly string[];
  /** The share of the new-contact budget each warning leaves (default core DEFAULT_WARNING_CAP_FACTORS). */
  readonly warningCapFactors?: readonly [number, number];
  /** The longest the send may be held back by the contact gap; a send that would wait longer is `contact_wait` (an OTP's lease is short). Default: the whole gap. */
  readonly maxContactWaitMs?: number;
}

export type SessionClaim =
  | { readonly kind: "claimed"; readonly sessionId: string; readonly slot: SendSlot; readonly now: Date; /** The ledger row of this claim: discardSend when nothing went out. */ readonly sendId: string }
  /** `known`: how many sessions the pool holds (0 = none configured). `retryAt`: for a contact that cannot be written to yet. */
  | { readonly kind: "none"; readonly reason: PoolShortage | "contact_wait"; readonly known: number; readonly retryAt?: Date };

/** The sessions that already have a chat with the contact (the digest `key`, or one of `chats`): a send from them in the last 30 days, or a message from it to them. */
async function sessionsKnowing(tx: postgres.TransactionSql, key: string, chats: readonly string[], now: Date): Promise<Set<string>> {
  const since = new Date(now.getTime() - KNOWN_CONTACT_MS);
  const rows = await tx<{ session_id: string }[]>`
    SELECT session_id FROM public.waha_sends WHERE contact_key = ${key} AND outcome <> 'failed' AND created_at > ${since}
    UNION
    SELECT session_id FROM public.waha_inbound WHERE session_id IS NOT NULL AND received_at > ${since} AND from_jid = ANY(${[...chats]}::text[])`;
  return new Set(rows.map((r) => r.session_id));
}

/** Picks a session and reserves its slot and its ledger row, in the caller's transaction. */
export async function claimSession(tx: postgres.TransactionSql, input: ClaimInput): Promise<SessionClaim> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${POOL_LOCK}, 0))`;
  const listed = await listPoolSessions(tx, input.only);
  const { now } = listed;
  const share = input.capShare;
  // The extra sends (replies) may only use a share of a number's daily cap; the warnings never touch that cap, only the budget of NEW contacts.
  const capped = share === undefined ? listed.sessions : listed.sessions.map((s) => ({ ...s, dailyCap: Math.floor(s.dailyCap * share) }));
  // The contact's rules come first: a contact that already got four messages this hour is not written to, whichever number would send.
  let notBefore: Date | undefined;
  let key: string | null = null;
  let sessions = capped;
  if (input.contact !== undefined) {
    key = contactKey(input.contact);
    const previous = await tx<{ send_at: Date }[]>`SELECT send_at FROM public.waha_sends WHERE contact_key = ${key} AND outcome <> 'failed' AND send_at > ${new Date(now.getTime() - 3_600_000)}`;
    const allowance = contactAllowance({ sentAt: previous.map((r) => r.send_at), now, random: input.random });
    if (!allowance.ok) return { kind: "none", reason: "contact_capped", known: capped.length, retryAt: allowance.retryAt };
    if (input.maxContactWaitMs !== undefined && allowance.notBefore.getTime() - now.getTime() > input.maxContactWaitMs) {
      return { kind: "none", reason: "contact_wait", known: capped.length, retryAt: allowance.notBefore };
    }
    notBefore = allowance.notBefore;
    // "New contact" is per number: a number that has a chat with this contact (it sent to it, or the contact wrote to it, in the last 30 days) is not held
    // to the new-contact rules for it, whatever WhatsApp thinks of its other new contacts.
    if (input.newContact === true) {
      const known = await sessionsKnowing(tx, key, input.contactChats ?? [], now);
      sessions = capped.map((s) => ({ ...s, knowsContact: known.has(s.id) }));
    }
  }
  const pick = pickSession(sessions, { now, exclude: input.exclude, maxWaitMs: input.maxWaitMs ?? POOL_MAX_WAIT_MS, random: input.random, ...(input.newContact === true ? { newContact: true } : {}), ...(input.warningCapFactors === undefined ? {} : { warningCapFactors: input.warningCapFactors }) });
  if (pick.kind === "none") return { kind: "none", reason: pick.reason, known: sessions.length };
  const spendsBudget = input.newContact === true && pick.session.knowsContact !== true;
  const gapFactor = spendsBudget ? warningSlowdown(pick.session.warning, input.warningCapFactors).gapFactor : 1;
  const slot = reserveSlot(pick.session, now, jitterMs(input.gap, input.random) * gapFactor, notBefore);
  await tx`UPDATE public.waha_sessions SET next_send_at = ${slot.nextSendAt} WHERE id = ${pick.session.id}`;
  const [ledger] = await tx<{ id: string }[]>`
    INSERT INTO public.waha_sends (session_id, delivery_id, kind, contact_key, send_at, new_contact)
    VALUES (${pick.session.id}, ${input.deliveryId}, ${input.kind}, ${key}, ${slot.startAt}, ${spendsBudget})
    RETURNING id`;
  if (ledger === undefined) throw new Error("the send ledger row was not written");
  return { kind: "claimed", sessionId: pick.session.id, slot, now, sendId: ledger.id };
}

/**
 * Takes a claim's ledger row back: nothing went out for a reason that is not the number's (a fault of ours before the send, a phone that is not on WhatsApp,
 * WhatsApp's own refusal of a new contact, an abort), so it is not a message to the contact (the per-contact gap and the hour's four, the number's budget of new
 * contacts), not a send of the number (its daily cap) and not a failure of it (the delivery report).
 */
export async function discardSend(db: Db, sendId: string | undefined): Promise<void> {
  if (sendId !== undefined) await db`DELETE FROM public.waha_sends WHERE id = ${sendId}`;
}

/** The ledger row's end state (the delivery report counts it per number): a send that went out, one that MAY have, or one WAHA refused for sure. */
export type SendEnd = "sent" | "unknown" | "failed";

/**
 * Records how a claim's send ended. `failed` (WAHA refused it for sure: the number's own failure) stays in the ledger for the report but is no message to
 * the contact and no send of the number's day: the caps and the per-contact rules skip it. A send that went out keeps its row as `sent`, one that MAY have as
 * `unknown`.
 */
export async function settleSend(db: Db, sendId: string | undefined, end: SendEnd): Promise<void> {
  if (sendId !== undefined) await db`UPDATE public.waha_sends SET outcome = ${end} WHERE id = ${sendId}`;
}

/** What a delivery or a pool send's outcome means for its ledger row: its end state, or null when the row is taken back (nothing went out, not the number's doing). */
export function sendEndOf(outcomeKind: string): SendEnd | null {
  if (outcomeKind === "sent") return "sent";
  if (outcomeKind === "maybe_sent") return "unknown";
  if (outcomeKind === "retryable_failure") return "failed";
  return null;
}

/** Settles or discards the ledger row of a claim by the outcome of its send. */
export async function closeSend(db: Db, sendId: string | undefined, outcomeKind: string): Promise<void> {
  const end = sendEndOf(outcomeKind);
  if (end === null) await discardSend(db, sendId);
  else await settleSend(db, sendId, end);
}

/**
 * Records how a send ended on the number: a send that went out clears the failure streak, a failed or uncertain one extends
 * it, and the one that reaches the threshold rests the number (cooldown_until). Returns the new health (tripped: raise an alert).
 */
export async function recordSessionOutcome(tx: postgres.TransactionSql, sessionId: string, wentOut: boolean, now: Date): Promise<SessionHealth | undefined> {
  const [row] = await tx<{ fail_streak: number }[]>`SELECT fail_streak FROM public.waha_sessions WHERE id = ${sessionId} FOR UPDATE`;
  if (row === undefined) return undefined;
  const health = sessionHealthAfter(row.fail_streak, wentOut, now);
  await tx`UPDATE public.waha_sessions SET fail_streak = ${health.failStreak}, cooldown_until = ${health.cooldownUntil ?? null} WHERE id = ${sessionId}`;
  return health;
}

/**
 * WhatsApp refused a message to a NEW contact (error 463 reachout timelock, 475 message capping): the number sends no new-contact message until
 * `until` (the session's own end when WAHA says it, else REACHOUT_COOLDOWN_MS from now). The session stays WORKING and a restart resets neither,
 * so the number is neither restarted nor counted as failing: no streak, no breaker. Never moves an existing end earlier.
 */
export async function markReachoutBlocked(db: Db, sessionId: string, now: Date, until?: Date | null): Promise<Date> {
  const end = until ?? new Date(now.getTime() + REACHOUT_COOLDOWN_MS);
  const [row] = await db<{ reachout_until: Date }[]>`
    UPDATE public.waha_sessions SET reachout_until = GREATEST(coalesce(reachout_until, ${end}), ${end}) WHERE id = ${sessionId} RETURNING reachout_until`;
  return row?.reachout_until ?? end;
}

/** The ledger keeps a month (the history a number has with a contact, KNOWN_CONTACT_MS, and the reports of the last days); older rows go. */
export async function pruneSends(sql: postgres.Sql, days = 31): Promise<number> {
  const result = await sql`DELETE FROM public.waha_sends WHERE created_at < clock_timestamp() - ${days} * interval '1 day'`;
  return result.count;
}
