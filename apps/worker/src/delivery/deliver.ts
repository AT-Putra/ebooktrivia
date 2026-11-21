// The delivery consumer (US-025; plan M8.2; AC-D1, AC-D4, AC-D8). Queue `delivery.send`, job data { id: deliveries.id }, job id
// `<id>-<attempts>` (deterministic per attempt, so the sweeper, the order.paid nudge and a failover dedupe to one job). BullMQ
// attempts: 1; PostgreSQL owns retries (not_before, tried_session_ids). The rules are core's delivery-machine, the way
// conversion-fire.ts uses conversion-machine:
//
//   1. claim    one short transaction: the order FOR SHARE, then the delivery row FOR UPDATE (payments' lock order). A row that is
//               not `pending` and due is skipped; an order that is not `paid` is never claimed (the row is taken out of the send
//               path with payments' own mark, order_not_paid, which only payments revives and only when the order is paid
//               again). E-mail: claimDelivery. WhatsApp: the pool picks a number (core pickSession: WORKING, not tried, under its
//               daily cap, rested, a free slot), reserves its slot and ledger row, and claimDelivery records the session in
//               tried_session_ids. `sending` with a lease and attempts + 1: only one of any number of racing jobs wins, in the
//               database. No lock is held after this transaction.
//   2. send     outside any transaction: render the template, issue the login link, mint the signed URL, wait for the number's
//               slot (jitter), then one WAHA sendFile or one SMTP message.
//   3. record   lock the row again and apply core recordDeliveryOutcome for THIS claim's attempt number, with a conditional UPDATE.
//               sent -> `sent`. A definite failure -> back to `pending` on another number (WhatsApp, up to 3 numbers) or after
//               the e-mail retry delay (up to 4 attempts), then `failed`. A send that MAY have gone out (a timeout, a reset, a
//               5xx) -> `unknown`: never resent automatically (the lease sweeper and resolve-unknown.ts only ever settle it as
//               `sent`, or leave it to the Owner). A stale finisher (lease lost, a newer attempt) changes nothing.
// A process that dies between claim and record leaves the row `sending`; the lease sweeper moves it to `unknown`. The database
// backs this up: the unique key (order, channel), the conditional claim, ET080 (nothing of an unpaid order) and ET130 (a delivery
// that went out, or may have, never goes back on the send path).
//
// WhatsApp (Owner decision D7): the proactive job of a WhatsApp delivery sends ONE short OPENER (text only: no PDF, no link, one of the Owner's
// variants with the buyer's first name, asking to reply), never the ebook. The opener is exactly-once on its own (delivery_openers, core delivery-opener,
// ET131) and the delivery row stays `pending`. The PDF and the login link go out when the buyer REPLIES: the buyer-first path (inbound.ts) claims the
// SAME deliveries row (core claimBuyerFirst) and sends them through `perform`. A buyer who never replies gets the ebook by e-mail only: not a failure, no
// alert. Every WhatsApp send (opener, reply, OTP) follows the human-like sequence of human.ts, and WhatsApp's own refusals of a new contact (WAHA "server
// returned error 463" reachout timelock, "475" message capping) hold the number back from new contacts (a cooldown and a persisted alert) without
// counting against its health: the opener goes back to pending for another number.
//
// Nothing here logs or stores a phone, an e-mail address, a message, a login link or a signed URL: errors are codes
// (deliveries.last_error), logs and alerts carry ids and codes only.
import { SmtpError, WahaError } from "@ebooktrivia/adapters";
import {
  type BuyerFirstReply,
  claimDelivery,
  claimOpener,
  DELIVERY_GAP_MS,
  type DeliveryDecision,
  type DeliveryOutcome,
  type DeliveryRow,
  type DeliveryStatus,
  deliveryFilename,
  EFFECT_CANCELLED,
  expireOpener,
  failOpener,
  firstName,
  HUMAN_MAX_MS,
  HUMAN_PRESENCE_TIMEOUT_MS,
  isIdMobileE164,
  type OpenerDecision,
  type OpenerOutcome,
  type OpenerPatch,
  openerTooOld,
  type OpenerRow,
  type OpenerStatus,
  recordDeliveryOutcome,
  recordOpenerOutcome,
  TemplateError,
  toWaChatId,
  WA_MAX_SESSIONS,
} from "@ebooktrivia/core";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type postgres from "postgres";
import type { Logger } from "../log.ts";
import { type JobSpec, jobRowId, rowJobId } from "../queues.ts";
import { deliveryColumns, raiseAlert, raiseAlertIn } from "../sweepers.ts";
import type { DeliveryConfig } from "./config.ts";
import { ContactCacheError, type ContactResolution, knownChatsOf, resolveContact } from "./contacts.ts";
import { refreshSessionLimits } from "./health.ts";
import { cryptoRandom, sendLikeAHuman } from "./human.ts";
import { emailMessage, loadOpenerTemplates, loadTemplate, openerMessage, TemplateMissing, whatsappCaption } from "./messages.ts";
import { claimSession, closeSend, markReachoutBlocked, recordSessionOutcome } from "./pool.ts";
import { type EbookFiles, MagicLinkUnavailable, type MagicLinks, MailAccessError, type MailSender, type WahaAccess, WahaAccessError } from "./ports.ts";

export const DELIVERY_QUEUE = "delivery.send";
/**
 * WhatsApp deliveries have their own queue (same processor): a send waits for its number's slot (jitter, up to POOL_MAX_WAIT_MS) and a WAHA request
 * takes seconds, so a backlog of them must never hold the concurrency slots of the e-mail deliveries (AC-D1: e-mail within 10 s of PAID).
 */
export const DELIVERY_WA_QUEUE = "delivery.send.wa";

/** A delivery job and the channel (queue) it belongs on. */
export interface DeliveryJob extends JobSpec {
  readonly channel: "email" | "whatsapp";
}

/** A one-number pool retries the same number only this long after its last failure (the number may be restarting). */
export const SAME_NUMBER_BACKOFF_MS = 60_000;

/** `opened`: the WhatsApp opener went out (the delivery itself stays pending until the buyer replies). `no_whatsapp`: the phone is not on WhatsApp (final, quiet). */
export type DeliveryResult = DeliveryStatus | "opened" | "no_whatsapp" | "skipped" | "deferred" | "stale";

export interface DeliveryDeps {
  readonly sql: postgres.Sql;
  readonly log: Logger;
  readonly config: Pick<DeliveryConfig, "leaseMs" | "wahaTimeoutMs" | "playOrigin" | "emailAttachMaxBytes" | "emailLinkTtlSeconds" | "unknownSkewMs"> & { readonly warningCapFactors?: readonly [number, number] };
  readonly waha: WahaAccess;
  readonly mail: MailSender;
  readonly files: EbookFiles;
  readonly magicLinks: MagicLinks;
  /** Puts jobs on delivery.send (a failover goes at once instead of waiting for the next sweep). */
  readonly enqueue: (jobs: readonly DeliveryJob[]) => Promise<void>;
  readonly random?: () => number;
  /** The human-like pauses' random source (default: the operating system's CSPRNG, human.ts). A test passes its own. */
  readonly humanRandom?: () => number;
  /** Waits `ms` (aborted by `signal`). Injectable for tests. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Monotonic milliseconds; default performance.now. Injectable for tests. */
  readonly clock?: () => number;
}

export interface ClaimRow {
  id: string;
  order_id: string;
  channel: DeliveryRow["channel"];
  status: DeliveryStatus;
  not_before: Date;
  lease_until: Date | null;
  attempts: number;
  attempts_base: number;
  session_id: string | null;
  tried_session_ids: string[];
  wa_chat_id: string | null;
  filename: string | null;
  /** When the row last changed (for a failure, the time of that failure). */
  updated_at: Date;
  now: Date;
  order_status: string;
  order_code: string;
  buyer_name: string;
  buyer_phone: string;
  buyer_email: string;
  player_id: string | null;
  product_title: string;
  storage_path: string | null;
}

/** The order, the player and the file a claimed delivery sends. Held in memory only. */
export interface SendContext {
  readonly deliveryId: string;
  readonly orderId: string;
  readonly channel: "whatsapp" | "email";
  /** The attempt number of THIS claim (deliveries.attempts after the claim). */
  readonly attempt: number;
  readonly buyer: { readonly name: string; readonly phone: string; readonly email: string; readonly playerId: string | null };
  readonly product: { readonly title: string; readonly storagePath: string };
  readonly code: string;
  /** WhatsApp: where and with which number; startAt is the number's reserved send slot. */
  readonly whatsapp?: { readonly sessionId: string; readonly chatId: string; readonly filename: string; readonly startAt: Date };
  /** A buyer-first reply: send to this chat, with or without the login link. */
  readonly reply?: BuyerFirstReply;
  /** The buyer's inbound message this reply answers: marked as seen first (human.ts). */
  readonly seenMessageId?: string;
  /** The pool's ledger row of this claim (pool.ts closeSend: its end state, or taken back when nothing went out). */
  readonly sendId?: string;
  /** Monotonic time the claim was taken (for the lease margin). */
  readonly claimedAt: number;
}

/** The claim of a WhatsApp opener (Owner decision D7): who to write to, from which number, when its slot starts. Held in memory only. */
export interface OpenerContext {
  readonly deliveryId: string;
  /** The opener's attempt number (delivery_openers.attempts after the claim). */
  readonly attempt: number;
  readonly buyer: { readonly name: string; readonly phone: string };
  readonly product: { readonly title: string };
  readonly code: string;
  /** The chat id is NOT here: a first contact is sent to the chat id WAHA's check-exists returns (contacts.ts), never to one we build from the phone. */
  readonly whatsapp: { readonly sessionId: string; readonly startAt: Date };
  /** The pool's ledger row of this claim (pool.ts closeSend: its end state, or taken back when nothing went out). */
  readonly sendId: string;
  readonly claimedAt: number;
}

export type Claim =
  | { readonly kind: "claimed"; readonly context: SendContext }
  | { readonly kind: "opener"; readonly context: OpenerContext }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "deferred"; readonly reason: string };

/** WhatsApp's refusals of a new contact (WAHA error text 463 / 475, classified by the adapter). */
type BanCode = "reachout_timelock" | "message_capping";
const isBan = (code: string): code is BanCode => code === "reachout_timelock" || code === "message_capping";

interface OpenerDbRow {
  status: OpenerStatus;
  attempts: number;
  session_id: string | null;
  tried_session_ids: string[];
  next_attempt_at: Date | null;
  lease_until: Date | null;
  updated_at: Date;
  now: Date;
}

const openerRow = (r: OpenerDbRow): OpenerRow => ({ status: r.status, attempts: r.attempts, sessionId: r.session_id, triedSessionIds: r.tried_session_ids, nextAttemptAt: r.next_attempt_at, leaseUntil: r.lease_until });

/** delivery_openers columns for a core patch (only the fields the patch sets). */
export function openerColumns(set: OpenerPatch, now: Date): Record<string, string | number | Date | readonly string[] | null> {
  return {
    status: set.status,
    ...(set.attempts === undefined ? {} : { attempts: set.attempts }),
    ...(set.sessionId === undefined ? {} : { session_id: set.sessionId }),
    ...(set.triedSessionIds === undefined ? {} : { tried_session_ids: set.triedSessionIds }),
    ...(set.nextAttemptAt === undefined ? {} : { next_attempt_at: set.nextAttemptAt }),
    ...(set.leaseUntil === undefined ? {} : { lease_until: set.leaseUntil }),
    ...(set.sentAt === undefined ? {} : { sent_at: set.sentAt }),
    ...(set.waMessageId === undefined ? {} : { wa_message_id: set.waMessageId }),
    ...(set.lastError === undefined ? {} : { last_error: set.lastError }),
    updated_at: now,
  };
}

/** The expected state of an opener decision, as the WHERE of its UPDATE. */
async function applyOpenerDecision(tx: postgres.TransactionSql, deliveryId: string, decision: OpenerDecision & { ok: true }, now: Date): Promise<void> {
  const result = await tx`
    UPDATE public.delivery_openers SET ${tx(openerColumns(decision.set, now))}
     WHERE delivery_id = ${deliveryId} AND status = ${decision.expect.status} AND attempts = ${decision.expect.attempts}`;
  if (result.count !== 1) throw new Error("delivery_openers row changed under its row lock");
}

/** Rolls the claim transaction back (a decision that turned out not to be one). */
class Abandon extends Error {
  readonly outcome: Claim;
  constructor(outcome: Claim) {
    super("claim abandoned");
    this.outcome = outcome;
  }
}

export const machineRow = (row: ClaimRow, waChatId: string | null, filename: string | null): DeliveryRow => ({
  channel: row.channel,
  status: row.status,
  notBefore: row.not_before,
  leaseUntil: row.lease_until,
  attempts: row.attempts,
  attemptsBase: row.attempts_base,
  sessionId: row.session_id,
  triedSessionIds: row.tried_session_ids,
  waChatId,
  filename,
});

/** Locks the order (shared) and then the delivery row, the lock order of payments, and reads what the send needs. */
export async function lockDelivery(tx: postgres.TransactionSql, id: string): Promise<ClaimRow | undefined> {
  const [ref] = await tx<{ order_id: string }[]>`SELECT order_id FROM public.deliveries WHERE id = ${id}`;
  if (ref === undefined) return undefined;
  await tx`SELECT 1 FROM public.orders WHERE id = ${ref.order_id} FOR SHARE`;
  const [row] = await tx<ClaimRow[]>`
    SELECT d.id, d.order_id, d.channel, d.status, d.not_before, d.lease_until, d.attempts, d.attempts_base, d.session_id, d.tried_session_ids, d.wa_chat_id, d.filename, d.updated_at,
           clock_timestamp() AS now,
           o.status::text AS order_status, o.order_code, o.buyer_name, o.buyer_phone, o.buyer_email, o.player_id,
           p.title AS product_title, u.storage_path
      FROM public.deliveries d
      JOIN public.orders o ON o.id = d.order_id
      JOIN public.products p ON p.id = o.product_id
      LEFT JOIN public.uploads u ON u.id = p.pdf_upload_id
     WHERE d.id = ${id}
       FOR UPDATE OF d`;
  return row;
}

/** The expected state of a decision, as the WHERE of its UPDATE. */
export async function applyDecision(tx: postgres.TransactionSql, id: string, decision: DeliveryDecision & { ok: true }, now: Date, extra: Record<string, string | null> = {}): Promise<void> {
  const result = await tx`
    UPDATE public.deliveries SET ${tx({ ...deliveryColumns(decision.set, now), ...extra })}
     WHERE id = ${id} AND status = ${decision.expect.status} AND attempts = ${decision.expect.attempts}`;
  if (result.count !== 1) throw new Error("deliveries row changed under its row lock");
}

/** Takes the row out of the send path for good (a failed delivery: nothing can be sent; the Owner looks at it). */
async function failUnsendable(tx: postgres.TransactionSql, row: ClaimRow, reason: string): Promise<void> {
  await tx`
    UPDATE public.deliveries SET status = 'failed', last_error = ${reason}, lease_until = NULL, updated_at = ${row.now}
     WHERE id = ${row.id} AND status = 'pending' AND attempts = ${row.attempts}`;
  await raiseAlertIn(tx, {
    kind: "delivery_failed",
    severity: "critical",
    dedupeKey: `delivery_failed:${row.id}`,
    message: "a delivery could not be sent and needs the Owner (see the failed deliveries)",
    payload: { delivery_id: row.id, order_id: row.order_id, channel: row.channel, error: reason },
  });
}

export interface Delivery {
  /** Sends a claimed delivery and records the outcome. */
  perform(context: SendContext): Promise<DeliveryResult>;
  /** The delivery.send job. */
  process(data: unknown): Promise<DeliveryResult>;
}

export function createDelivery(deps: DeliveryDeps): Delivery {
  const { sql, log, config } = deps;
  // The slot and contact gaps are drawn from the operating system's random source too (not Math.random): the pacing is part of what makes the sends look human.
  const random = deps.random ?? cryptoRandom;
  const clock = deps.clock ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));

  // --- 1. claim ------------------------------------------------------------------------------------------------------

  async function claim(id: string): Promise<Claim> {
    const claimedAt = clock();
    try {
      return await sql.begin(async (tx): Promise<Claim> => {
        const row = await lockDelivery(tx, id);
        if (row === undefined) return { kind: "skipped", reason: "missing" };
        if (row.status !== "pending") return { kind: "skipped", reason: "not_pending" };
        if (row.not_before.getTime() > row.now.getTime()) return { kind: "skipped", reason: "not_due" };
        if (row.order_status !== "paid") {
          // Payments' own mark: only payments brings it back, and only when the order is paid again. Never resurrected here.
          await tx`
            UPDATE public.deliveries SET status = 'cancelled', last_error = ${EFFECT_CANCELLED}, lease_until = NULL, updated_at = ${row.now}
             WHERE id = ${id} AND status = 'pending' AND attempts = ${row.attempts}`;
          return { kind: "skipped", reason: "order_not_paid" };
        }
        if (row.storage_path === null) {
          await failUnsendable(tx, row, "no_ebook_file");
          return { kind: "skipped", reason: "no_ebook_file" };
        }
        const base = {
          deliveryId: row.id,
          orderId: row.order_id,
          channel: row.channel,
          buyer: { name: row.buyer_name, phone: row.buyer_phone, email: row.buyer_email, playerId: row.player_id },
          product: { title: row.product_title, storagePath: row.storage_path },
          code: row.order_code,
          claimedAt,
        } as const;

        if (row.channel === "email") {
          const decision = claimDelivery(machineRow(row, null, null), { now: row.now, leaseMs: config.leaseMs });
          if (!decision.ok) return { kind: "skipped", reason: decision.reason };
          await applyDecision(tx, id, decision, row.now);
          return { kind: "claimed", context: { ...base, channel: "email", attempt: decision.set.attempts ?? row.attempts + 1 } };
        }

        // WhatsApp (Owner decision D7): the proactive job sends the OPENER, never the ebook. The delivery row is not touched: it stays `pending`
        // until the buyer replies and the buyer-first path claims it. The opener has its own row, claimed here with the same exactly-once rules.
        const chatId = row.wa_chat_id ?? (isIdMobileE164(row.buyer_phone) ? toWaChatId(row.buyer_phone) : null);
        if (chatId === null) {
          await failUnsendable(tx, row, "invalid_whatsapp_number");
          return { kind: "skipped", reason: "invalid_whatsapp_number" };
        }
        await tx`INSERT INTO public.delivery_openers (delivery_id) VALUES (${id}) ON CONFLICT (delivery_id) DO NOTHING`;
        const [raw] = await tx<OpenerDbRow[]>`
          SELECT status, attempts, session_id, tried_session_ids, next_attempt_at, lease_until, updated_at, clock_timestamp() AS now
            FROM public.delivery_openers WHERE delivery_id = ${id} FOR UPDATE`;
        if (raw === undefined) throw new Error("the opener row is missing under its lock");
        const opener = openerRow(raw);
        // Awaiting the reply (sent), in flight, may have gone out (unknown), failed or moot (expired): never sent a second time.
        if (opener.status !== "pending") return { kind: "skipped", reason: `opener_${opener.status}` };
        if (opener.nextAttemptAt !== null && opener.nextAttemptAt.getTime() > raw.now.getTime()) return { kind: "skipped", reason: "not_due" };
        if (openerTooOld(raw.now, row.not_before)) {
          // Too late for an opener (the e-mail has the ebook): final and quiet. Decided before the pool is asked, so nothing is reserved.
          const moot = expireOpener(opener, "too_old");
          if (moot.ok) await applyOpenerDecision(tx, id, moot, raw.now);
          return { kind: "skipped", reason: "opener_expired" };
        }
        // A new contact (the buyer has not written first): a buyer is identified by the PHONE, so the opener, the reply to it and a login code all count as one
        // contact; the chat ids it is known by tell the pool which numbers already have a chat with it.
        const claimInput = { kind: "opener", deliveryId: id, gap: DELIVERY_GAP_MS, random, newContact: true, contact: row.buyer_phone, contactChats: await knownChatsOf(tx, row.buyer_phone, chatId), ...(config.warningCapFactors === undefined ? {} : { warningCapFactors: config.warningCapFactors }) } as const;
        let picked = await claimSession(tx, { exclude: opener.triedSessionIds, ...claimInput });
        let retrySame = false;
        const tried = opener.triedSessionIds.length;
        if (picked.kind === "none" && picked.reason === "no_untried_session" && picked.known > 0 && tried > 0 && tried < WA_MAX_SESSIONS) {
          // A pool with one number (or whose other numbers were all tried): the same number again, after a backoff, while fewer than 3
          // attempts were made. Right after the failure it waits (the next sweep or job comes back for it).
          if (raw.now.getTime() - raw.updated_at.getTime() < SAME_NUMBER_BACKOFF_MS) return { kind: "deferred", reason: "same_number_backoff" };
          picked = await claimSession(tx, { exclude: [], ...claimInput });
          retrySame = true;
        }
        if (picked.kind === "none") {
          if (picked.reason === "no_untried_session" && tried > 0) {
            // Every attempt there is was made: the opener is given up quietly (the buyer has the e-mail, and the order page's WhatsApp button).
            const gaveUp = failOpener(opener, "no_untried_number");
            if (gaveUp.ok) await applyOpenerDecision(tx, id, gaveUp, raw.now);
            return { kind: "skipped", reason: "no_untried_number" };
          }
          return { kind: "deferred", reason: picked.known === 0 ? "no_session_configured" : picked.reason };
        }
        const decision = claimOpener(opener, { now: raw.now, notBefore: row.not_before, leaseMs: config.leaseMs, sessionId: picked.sessionId, retrySameSession: retrySame });
        if (!decision.ok) throw new Abandon({ kind: "skipped", reason: decision.reason });
        await applyOpenerDecision(tx, id, decision, raw.now);
        return {
          kind: "opener",
          context: {
            deliveryId: id,
            attempt: decision.set.attempts ?? opener.attempts + 1,
            buyer: { name: row.buyer_name, phone: row.buyer_phone },
            product: { title: row.product_title },
            code: row.order_code,
            whatsapp: { sessionId: picked.sessionId, startAt: picked.slot.startAt },
            sendId: picked.sendId,
            claimedAt,
          },
        };
      });
    } catch (error) {
      if (error instanceof Abandon) return error.outcome;
      throw error;
    }
  }

  // --- 2. send -------------------------------------------------------------------------------------------------------

  /** A short code for last_error: never a message, an address or a value from a provider. */
  const code = (prefix: string, detail: string): string => `${prefix}_${detail}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 64);

  const buyerValues = (context: SendContext, link: string | undefined) => ({
    nama: context.buyer.name,
    judul_ebook: context.product.title,
    order_id: context.code,
    ...(link === undefined ? {} : { link_trivia: link }),
  });

  /**
   * What went wrong BEFORE anything was sent. Nobody's fault but ours: the row goes back to pending after a backoff with its attempt
   * and its number given back (core `not_attempted`), and nothing is counted against the number. A missing PDF is the one permanent case.
   */
  function preparationFailure(error: unknown): DeliveryOutcome {
    if (error instanceof TemplateMissing || error instanceof TemplateError) return { kind: "not_attempted", error: "template_invalid" };
    if (error instanceof MagicLinkUnavailable) return { kind: "not_attempted", error: "magic_link_unavailable" };
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return { kind: "permanent_failure", error: "ebook_file_missing" };
    return { kind: "not_attempted", error: "preparation_failed" };
  }

  /** An outcome and whether it says something about the NUMBER: only what WAHA answered (WahaError, WahaAccessError) does. */
  interface Sent {
    readonly outcome: DeliveryOutcome;
    readonly counts: boolean;
    /** WhatsApp refused a new contact (463 / 475): the number is held back from new contacts, and this says nothing of its health. */
    readonly ban?: BanCode;
  }

  /** The opener's outcomes are the delivery's plus `no_whatsapp` (the phone is not on WhatsApp). */
  type OpenerSent = Omit<Sent, "outcome"> & { readonly outcome: OpenerOutcome };

  /** What the lease can still cover: after the claim's waits, the human-like sequence and the send itself must fit in it. */
  const leaseLeft = (context: { readonly claimedAt: number }, reserveMs: number): boolean => clock() <= context.claimedAt + config.leaseMs - config.wahaTimeoutMs - reserveMs - 1000;
  const humanDeps = { log, random: deps.humanRandom, sleep };
  const notAttempted = (error: string): Sent => ({ outcome: { kind: "not_attempted", error }, counts: false });

  /** The PDF with the login link, as a REPLY to a buyer who wrote first (the buyer-first claim of inbound.ts): the human-like sequence, then one sendFile. */
  async function sendWhatsApp(context: SendContext, signal: AbortSignal): Promise<Sent> {
    const target = context.whatsapp;
    if (target === undefined) throw new Error("a WhatsApp delivery has a session");
    const chatId = context.reply?.chatId ?? target.chatId;
    let caption: string;
    let url: string;
    try {
      const template = await loadTemplate(sql, "delivery", "whatsapp");
      const link = context.buyer.playerId === null ? undefined : await deps.magicLinks.issue({ playerId: context.buyer.playerId, channel: "whatsapp" });
      if (link === undefined) throw new MagicLinkUnavailable();
      caption = whatsappCaption(template, buyerValues(context, link), config.playOrigin);
      url = deps.files.signedUrl(context.product.storagePath, new Date());
    } catch (error) {
      return { outcome: preparationFailure(error), counts: false };
    }
    // The number's slot (jitter, and the contact gap): it never sends two messages back to back.
    try {
      await sleep(Math.max(0, target.startAt.getTime() - Date.now()), signal);
    } catch {
      return notAttempted("aborted_before_send");
    }
    // A claim that stalled past what the lease can still cover (the human-like pauses and the send) is not sent: nothing went out, so it is as if it
    // had not been made.
    if (!leaseLeft(context, HUMAN_MAX_MS)) return notAttempted("claim_too_old");
    try {
      const result = await deps.waha.withSession(target.sessionId, ({ sessionName, client }) =>
        sendLikeAHuman(humanDeps, {
          client,
          sessionName,
          chatId,
          textLength: caption.length,
          kind: "message",
          withSeen: true,
          seenMessageId: context.seenMessageId,
          signal,
          beforeSend: () => leaseLeft(context, HUMAN_PRESENCE_TIMEOUT_MS),
          send: () => client.sendFile(sessionName, chatId, { url, filename: target.filename, mimetype: "application/pdf" }, caption),
        }),
      );
      if (result.kind === "not_sent") return notAttempted(result.reason === "aborted" ? "aborted_before_send" : "claim_too_old");
      return { outcome: { kind: "sent", waMessageId: result.value.id }, counts: true };
    } catch (error) {
      return whatsappFailure(error);
    }
  }

  /** The short opener (Owner decision D7): one of the Owner's variants with the buyer's first name, text only; the human-like sequence without a seen mark. */
  async function sendOpener(context: OpenerContext, signal: AbortSignal): Promise<OpenerSent> {
    const target = context.whatsapp;
    let text: string;
    try {
      const variants = await loadOpenerTemplates(sql);
      text = openerMessage(variants, { firstName: firstName(context.buyer.name), title: context.product.title, code: context.code }, deps.humanRandom ?? cryptoRandom);
    } catch (error) {
      return { outcome: preparationFailure(error), counts: false };
    }
    try {
      await sleep(Math.max(0, target.startAt.getTime() - Date.now()), signal);
    } catch {
      return notAttempted("aborted_before_send");
    }
    if (!leaseLeft(context, HUMAN_MAX_MS)) return notAttempted("claim_too_old");
    try {
      const result = await deps.waha.withSession(target.sessionId, async ({ sessionName, client }) => {
        // First contact: ask WAHA where this phone lives (cached per phone) and send THERE, never to a chat id we build.
        let contact: ContactResolution;
        try {
          contact = await resolveContact(sql, client, sessionName, context.buyer.phone);
        } catch (error) {
          if (error instanceof WahaError) return { kind: "lookup_failed", code: error.code } as const;
          // Our own database failed (the contact cache): nothing was sent, so this is NOT an uncertain send.
          if (error instanceof ContactCacheError) return { kind: "cache_failed", code: error.code } as const;
          throw error;
        }
        if (contact.kind === "no_whatsapp") return { kind: "no_whatsapp" } as const;
        return sendLikeAHuman(humanDeps, {
          client,
          sessionName,
          chatId: contact.chatId,
          textLength: text.length,
          kind: "message",
          withSeen: false,
          signal,
          beforeSend: () => leaseLeft(context, HUMAN_PRESENCE_TIMEOUT_MS),
          send: () => client.sendText(sessionName, contact.chatId, text),
        });
      });
      // The phone is not on WhatsApp: final and quiet (no failover, no penalty for any number, no alert). The e-mail has the ebook.
      if (result.kind === "no_whatsapp") return { outcome: { kind: "no_whatsapp" }, counts: false };
      // The lookup failed (5xx, timeout): nothing was sent, so it is NOT an uncertain send; it waits for its backoff and asks again.
      if (result.kind === "lookup_failed") return notAttempted(code("check_exists", result.code));
      if (result.kind === "cache_failed") {
        log.warn({ deliveryId: context.deliveryId, code: result.code }, "the contact cache could not be read or written; the opener is tried again");
        return notAttempted("contact_cache_failed");
      }
      if (result.kind === "not_sent") return notAttempted(result.reason === "aborted" ? "aborted_before_send" : "claim_too_old");
      return { outcome: { kind: "sent", waMessageId: result.value.id }, counts: true };
    } catch (error) {
      return whatsappFailure(error);
    }
  }

  function whatsappFailure(error: unknown): Sent {
    if (error instanceof WahaAccessError) return { outcome: { kind: "retryable_failure", error: code("waha", error.code) }, counts: true };
    if (error instanceof WahaError && isBan(error.code)) {
      // WhatsApp's own refusal of a new contact: nothing was sent, the session stays WORKING, a restart resets nothing. Not a failure of the number: it is held
      // back from new contacts (record), and the send goes back for another number.
      return { outcome: { kind: "not_attempted", error: error.code }, counts: false, ban: error.code };
    }
    if (error instanceof WahaError) {
      // maybe_sent: the request may have reached WhatsApp (a timeout, a reset, a 5xx, an answer we could not read). Never resent.
      return { outcome: error.code === "maybe_sent" ? { kind: "maybe_sent", error: "waha_maybe_sent" } : { kind: "retryable_failure", error: code("waha", error.code) }, counts: true };
    }
    // An unexpected error somewhere after the request may have left: treat it as possibly sent (never a blind resend). It is not
    // WAHA's answer, so it says nothing about the number.
    return { outcome: { kind: "maybe_sent", error: "waha_send_failed" }, counts: false };
  }

  async function sendEmail(context: SendContext): Promise<DeliveryOutcome> {
    let attach: boolean;
    let bytes: Uint8Array | undefined;
    let base: ReturnType<typeof emailMessage>;
    let linkUrl: string;
    let withDownloadLink: () => ReturnType<typeof emailMessage>;
    try {
      const template = await loadTemplate(sql, "delivery", "email");
      const link = context.buyer.playerId === null ? undefined : await deps.magicLinks.issue({ playerId: context.buyer.playerId, channel: "email" });
      if (link === undefined) throw new MagicLinkUnavailable();
      const values = buyerValues(context, link);
      attach = (await deps.files.size(context.product.storagePath)) <= config.emailAttachMaxBytes;
      if (attach) bytes = await deps.files.read(context.product.storagePath);
      linkUrl = deps.files.signedUrl(context.product.storagePath, new Date(), config.emailLinkTtlSeconds);
      base = emailMessage(template, values, config.playOrigin, attach ? undefined : linkUrl);
      withDownloadLink = () => emailMessage(template, values, config.playOrigin, linkUrl);
    } catch (error) {
      return preparationFailure(error);
    }
    const filename = deliveryFilename(context.product.title);
    try {
      await deps.mail.send({ to: context.buyer.email, ...base, ...(attach && bytes !== undefined ? { attachments: [{ filename, content: bytes, contentType: "application/pdf" }] } : {}) });
      return { kind: "sent" };
    } catch (error) {
      // The server refused the attachment for its size (a definite 5xx: the message was not taken): the same e-mail with a download link
      // instead. Not a second copy: the first was refused.
      if (attach && error instanceof SmtpError && error.code === "rejected" && isSizeRejection(error)) {
        try {
          await deps.mail.send({ to: context.buyer.email, ...withDownloadLink() });
          return { kind: "sent" };
        } catch (fallbackError) {
          return emailFailure(fallbackError);
        }
      }
      return emailFailure(error);
    }
  }

  function emailFailure(error: unknown): DeliveryOutcome {
    if (error instanceof SmtpError) {
      if (error.code === "maybe_sent") return { kind: "maybe_sent", error: "smtp_maybe_sent" };
      return error.code === "rejected" ? { kind: "permanent_failure", error: "smtp_rejected" } : { kind: "retryable_failure", error: code("smtp", error.code) };
    }
    if (error instanceof MailAccessError) return { kind: "retryable_failure", error: code("mail", error.code) };
    if (error instanceof RangeError) return { kind: "permanent_failure", error: "invalid_recipient" };
    return { kind: "maybe_sent", error: "smtp_send_failed" };
  }

  // --- 3. record -----------------------------------------------------------------------------------------------------

  async function record(context: SendContext, sent: Sent): Promise<DeliveryResult> {
    const { outcome } = sent;
    const result = await sql.begin(async (tx): Promise<{ status: DeliveryResult }> => {
      // The ledger row of this claim says how the send ended whatever becomes of the delivery row (taken over, deleted, cancelled by a refund): it must never stay
      // `reserved`, which counts against the number's day for ever.
      await closeSend(tx, context.sendId, outcome.kind);
      const row = await lockDelivery(tx, context.deliveryId);
      if (row === undefined) return { status: "stale" };
      const decision = recordDeliveryOutcome(machineRow(row, row.wa_chat_id, row.filename), outcome, { now: row.now, attempt: context.attempt });
      if (!decision.ok) {
        log.warn({ deliveryId: context.deliveryId, attempt: context.attempt, reason: decision.reason }, "delivery outcome not applied");
        return { status: "stale" };
      }
      if (decision.set.status === "pending" && row.order_status !== "paid") {
        // Refunded (or in review) while the send was out and the outcome says "retry": the row never goes back to pending
        // (ET080). Out of the send path with payments' mark, like the sweeper does.
        await tx`
          UPDATE public.deliveries SET status = 'cancelled', last_error = ${EFFECT_CANCELLED}, lease_until = NULL, updated_at = ${row.now}
           WHERE id = ${row.id} AND status = ${decision.expect.status} AND attempts = ${decision.expect.attempts}`;
        return { status: "cancelled" };
      }
      await applyDecision(tx, row.id, decision, row.now);
      // The number: a send that went out clears its failure streak, a failed or uncertain one extends it (the breaker rests it). Only what
      // WAHA answered counts; a failure of ours before the send (a login link, a template) says nothing about the number.
      if (context.whatsapp !== undefined && sent.counts) {
        const health = await recordSessionOutcome(tx, context.whatsapp.sessionId, outcome.kind === "sent", row.now);
        if (health?.tripped === true) {
          await raiseAlertIn(tx, {
            kind: "waha_session_failing",
            severity: "critical",
            dedupeKey: `waha_session_failing:${context.whatsapp.sessionId}`,
            message: "a WhatsApp number failed several sends in a row and is resting; check its session in WAHA",
            payload: { session_id: context.whatsapp.sessionId, fail_streak: health.failStreak },
          });
        }
      }
      const status = decision.set.status;
      if (sent.ban !== undefined && context.whatsapp !== undefined) await holdBack(tx, context.whatsapp.sessionId, sent.ban, row.now);
      else if (outcome.kind === "not_attempted") {
        // Deliveries wait on something of ours (the login link, a template, the PDF): one persisted alert per cause an hour, no personal data.
        await raiseAlertIn(tx, {
          kind: "delivery_not_attempted",
          severity: "critical",
          dedupeKey: `delivery_not_attempted:${outcome.error}`,
          message: "deliveries are held back by a fault on our side (the login link, a message template or the ebook file): nothing is sent until it is fixed",
          payload: { cause: outcome.error },
        });
      }
      // An unknown row raises its alert only if the lookup of resolve-unknown.ts could not settle it (most are: WAHA answered late).
      if (status === "failed") {
        await raiseAlertIn(tx, {
          kind: "delivery_failed",
          severity: "critical",
          dedupeKey: `delivery_failed:${row.id}`,
          message: "a delivery failed on every attempt and needs the Owner (see the failed deliveries)",
          payload: { delivery_id: row.id, order_id: row.order_id, channel: row.channel, error: outcome.kind === "sent" ? null : outcome.error },
        });
      }
      return { status };
    });
    if (sent.ban !== undefined && context.whatsapp !== undefined) await refreshSessionLimits({ sql, log, waha: deps.waha }, context.whatsapp.sessionId, { keepHold: true }).catch(() => undefined);
    return result.status;
  }


  /** The opener's outcome, under its own row lock (core recordOpenerOutcome, a conditional UPDATE for THIS claim's attempt). */
  async function recordOpener(context: OpenerContext, sent: OpenerSent): Promise<DeliveryResult> {
    const { outcome } = sent;
    const result = await sql.begin(async (tx): Promise<{ status: DeliveryResult; requeue: boolean; ban: boolean }> => {
      // The ledger row of this claim says how the send ended whatever becomes of the opener row (taken over, deleted): never left `reserved`.
      await closeSend(tx, context.sendId, outcome.kind);
      const [raw] = await tx<OpenerDbRow[]>`
        SELECT status, attempts, session_id, tried_session_ids, next_attempt_at, lease_until, updated_at, clock_timestamp() AS now
          FROM public.delivery_openers WHERE delivery_id = ${context.deliveryId} FOR UPDATE`;
      if (raw === undefined) return { status: "stale", requeue: false, ban: false };
      const decision = recordOpenerOutcome(openerRow(raw), outcome, { now: raw.now, attempt: context.attempt });
      if (!decision.ok) {
        log.warn({ deliveryId: context.deliveryId, attempt: context.attempt, reason: decision.reason }, "opener outcome not applied");
        return { status: "stale", requeue: false, ban: false };
      }
      await applyOpenerDecision(tx, context.deliveryId, decision, raw.now);
      // The number's health, as for every send: only what WAHA answered counts.
      if (sent.counts) {
        const health = await recordSessionOutcome(tx, context.whatsapp.sessionId, outcome.kind === "sent", raw.now);
        if (health?.tripped === true) {
          await raiseAlertIn(tx, {
            kind: "waha_session_failing",
            severity: "critical",
            dedupeKey: `waha_session_failing:${context.whatsapp.sessionId}`,
            message: "a WhatsApp number failed several sends in a row and is resting; check its session in WAHA",
            payload: { session_id: context.whatsapp.sessionId, fail_streak: health.failStreak },
          });
        }
      }
      if (sent.ban !== undefined) await holdBack(tx, context.whatsapp.sessionId, sent.ban, raw.now);
      else if (outcome.kind === "not_attempted" && outcome.error.startsWith("check_exists_")) {
        // WAHA's lookup of a phone failing (a 5xx, a timeout) is a problem of that NUMBER or of the instance, not a fault of ours: a warning, once an hour per number,
        // instead of a critical alert per cause.
        await raiseAlertIn(tx, {
          kind: "waha_lookup_failing",
          severity: "warning",
          dedupeKey: `waha_lookup_failing:${context.whatsapp.sessionId}`,
          message: "a WhatsApp number could not look up whether a phone is on WhatsApp (WAHA failed): its openers wait and are tried again; check the session in WAHA",
          payload: { session_id: context.whatsapp.sessionId, cause: outcome.error },
        });
      } else if (outcome.kind === "not_attempted") {
        await raiseAlertIn(tx, {
          kind: "delivery_not_attempted",
          severity: "critical",
          dedupeKey: `delivery_not_attempted:${outcome.error}`,
          message: "deliveries are held back by a fault on our side (the login link, a message template or the ebook file): nothing is sent until it is fixed",
          payload: { cause: outcome.error },
        });
      }
      // A failed or unknown opener raises NO alert: the buyer has the ebook by e-mail (and the WhatsApp button of the order page), and a buyer who never
      // replies is not a failure. The pool's own alerts (no number, held back, failing) say what is wrong with the numbers.
      const status = decision.set.status;
      const shown: DeliveryResult = outcome.kind === "no_whatsapp" ? "no_whatsapp" : status === "sent" ? "opened" : status === "failed" || status === "unknown" || status === "pending" ? status : "stale";
      return { status: shown, requeue: status === "pending" && outcome.kind === "retryable_failure", ban: sent.ban !== undefined };
    });
    // After a 463 / 475 the session's own state is read at once (the timelock's end, the capping cycle), not at the next poll.
    if (result.ban) await refreshSessionLimits({ sql, log, waha: deps.waha }, context.whatsapp.sessionId, { keepHold: true }).catch(() => undefined);
    if (result.requeue) {
      // A definite failure goes on to another number at once. (A distinct job id per opener attempt: the delivery's own ids are `<id>-<attempts>`.)
      await deps.enqueue([{ channel: "whatsapp", jobId: rowJobId(context.deliveryId, 1000 + context.attempt), data: { id: context.deliveryId } }]).catch((error: unknown) => {
        log.warn({ deliveryId: context.deliveryId, err: error }, "failover job could not be enqueued; the sweeper will");
      });
    }
    return result.status;
  }

  // --- the job -------------------------------------------------------------------------------------------------------

  /** Sends what a claim reserved and records how it ended (the e-mail job, and the buyer-first reply of inbound.ts). */
  async function perform(context: SendContext): Promise<DeliveryResult> {
    const abort = AbortSignal.timeout(Math.max(1, config.leaseMs - 1000));
    const sent: Sent = context.channel === "email" ? { outcome: await sendEmail(context), counts: false } : await sendWhatsApp(context, abort);
    return record(context, sent);
  }

  async function performOpener(context: OpenerContext): Promise<DeliveryResult> {
    const abort = AbortSignal.timeout(Math.max(1, config.leaseMs - 1000));
    return recordOpener(context, await sendOpener(context, abort));
  }

  return {
    perform,
    /** The delivery.send job: claim, send, record (the WhatsApp job sends the opener, Owner decision D7). */
    async process(data: unknown): Promise<DeliveryResult> {
      const id = jobRowId(data);
      const claimed = await claim(id);
      if (claimed.kind === "skipped") return "skipped";
      if (claimed.kind === "deferred") {
        await raisePoolAlert(sql, claimed.reason, log);
        return "deferred";
      }
      return claimed.kind === "opener" ? performOpener(claimed.context) : perform(claimed.context);
    },
  };
}

/**
 * WhatsApp refused a message to a new contact (463 reachout timelock, 475 message capping). The number is held back from NEW contacts (an opener, an OTP;
 * it still answers a buyer who wrote first) for the session's own end or an hour, and a critical alert is persisted, once an hour per number. The
 * session is NOT restarted or re-paired (WAHA: neither lifts the restriction), and its health is not touched: it is not failing, WhatsApp is limiting it.
 */
export async function holdBack(tx: postgres.TransactionSql, sessionId: string, ban: BanCode, now: Date): Promise<void> {
  const until = await markReachoutBlocked(tx, sessionId, now);
  // How many times WhatsApp has refused this number (463 reachout timelock, 475 message capping), for the alert.
  const [counts] = await tx<{ ban_463_count: number; ban_475_count: number }[]>`
    UPDATE public.waha_sessions
       SET ban_463_count = ban_463_count + ${ban === "reachout_timelock" ? 1 : 0}, ban_475_count = ban_475_count + ${ban === "message_capping" ? 1 : 0}
     WHERE id = ${sessionId} RETURNING ban_463_count, ban_475_count`;
  await raiseAlertIn(tx, {
    kind: "waha_reachout_blocked",
    severity: "critical",
    dedupeKey: `waha_reachout_blocked:${sessionId}`,
    message: "WhatsApp refused a message to a new contact from this number (reachout timelock or message capping): it sends no new-contact message until it is lifted; do not restart or re-pair it",
    payload: { session_id: sessionId, signal: ban, until: until.toISOString(), refused_463: counts?.ban_463_count ?? 0, refused_475: counts?.ban_475_count ?? 0 },
  });
}

/**
 * The pool alerts of a WhatsApp delivery that found no number to send from (persisted, one per kind per hour): the pool is empty
 * (no number WORKING, or none configured) or every number is at its daily cap or resting. A pool that is only busy is the normal
 * flow control of a burst (the delivery waits for the next sweep) and raises nothing.
 */
export async function raisePoolAlert(sql: postgres.Sql, reason: string, log: Logger): Promise<void> {
  // A contact that is not written to yet (the gap, the hour's four) is no pool problem either.
  if (reason === "all_busy" || reason === "same_number_backoff" || reason === "contact_capped" || reason === "contact_wait") return;
  const empty = reason === "no_session_configured" || reason === "no_working_session";
  try {
    if (reason === "all_new_contact_capped") {
      // Every number has spent today's budget of NEW contacts (replies are not counted against it): openers wait for the budget to come back, pending with
      // their backoff, and the e-mail covers the buyers meanwhile.
      await raiseAlert(sql, {
        kind: "wa_new_contact_budget_spent",
        severity: "warning",
        dedupeKey: "wa_new_contact_budget_spent",
        message: "every WhatsApp number has spent today's budget of new contacts: WhatsApp openers wait until tomorrow (or until the budget is raised); e-mail is unaffected",
        payload: { reason },
      });
      return;
    }
    if (reason === "all_reachout_blocked") {
      // Every number is held back from new contacts by WhatsApp (463 / 475): no opener and no login code goes out until one is free again. Not restarted,
      // not re-paired. The per-number alerts (waha_reachout_blocked) say which numbers and until when.
      await raiseAlert(sql, {
        kind: "wa_reachout_blocked",
        severity: "critical",
        dedupeKey: "wa_reachout_blocked",
        message: "every WhatsApp number is held back from new contacts by WhatsApp (reachout timelock or message capping): no opener or login code is sent until one is free again; e-mail is unaffected",
        payload: { reason },
      });
      return;
    }
    await raiseAlert(sql, {
      kind: empty ? "wa_pool_empty" : "wa_pool_exhausted",
      severity: empty ? "critical" : "warning",
      dedupeKey: empty ? "wa_pool_empty" : `wa_pool_exhausted:${reason}`,
      message: empty
        ? "no WhatsApp number is WORKING (or none is configured): WhatsApp deliveries wait, e-mail is unaffected"
        : "every WhatsApp number is at its daily cap, resting or busy: WhatsApp deliveries wait for the next free slot",
      payload: { reason },
    });
  } catch (error) {
    log.error({ err: error }, "the WhatsApp pool alert could not be raised");
  }
}

/** The server refused the message for its size (552 / 5.3.4 and the like). */
export function isSizeRejection(error: SmtpError): boolean {
  const cause = error.cause as { responseCode?: unknown; response?: unknown; message?: unknown } | undefined;
  if (cause?.responseCode === 552) return true;
  const text = [cause?.response, cause?.message].filter((v): v is string => typeof v === "string").join(" ");
  return /\b5\.3\.4\b|message size|too large|exceeds? (?:the )?(?:fixed |maximum )?(?:message )?size|size limit/i.test(text);
}

