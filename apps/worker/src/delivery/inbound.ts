// Buyer-first inbound WhatsApp (US-025; plan M8.3; spec AC-D8; plan §10 item 23; Owner decision D6). Consumer of outbox topic `waha.inbound` (one
// row per stored webhook message, enqueue_waha_inbound). The webhook route is untrusted input: it verified an HMAC and stored a hint, and this
// consumer decides nothing from it:
//
//   1. re-fetch   the message is read again from WAHA by its id, on the session (and server) it arrived on (adapters getMessage).
//                 A message WAHA does not know is a forged or stale row: nothing is sent. The sender, the chat and the text below are
//                 the re-fetched ones, never the webhook's.
//      read     a confirmed personal message (not ours, a phone or @lid chat: never a group, a status, a channel or anything else) is marked as read: the WHOLE chat,
//                 on the number it arrived on, after a random reading pause, BEFORE the decision below and whatever it is (a stranger, no code, a rate-limited
//                 sender, a buyer): WhatsApp finds a number that answers some chats and leaves the others unread suspicious (Owner rule, 2026-11-24; WAHA "How to
//                 avoid blocking": send seen before processing the message). Best effort: a failed mark is only logged as a code and never fails or retries the job.
//                 A reply's own send marks the chat again (human.ts): one extra, cheap call, accepted rather than a flag that skips it.
//   2. match      the order code (>= 40 bits) is found in the text (core extractOrderCodes) and looked up. No code, or a code of no order:
//                 nothing is sent (a stranger gets no oracle and no chatter).
//   3. who        the sender decides, never the code alone (core senderVerdict): a phone chat must be the order's phone; an @lid chat is
//                 resolved to a phone (resolveLid), and compared, or, with no number behind it, is `unresolved`. The order of the @lid resolution:
//                   a. a link of this lid in wa_contacts confirmed within a day (no WAHA call);
//                   b. WAHA's lid -> phone on the receiving session;
//                   c. from the PHONE side: the lid of our own buyers' phones (the orders whose codes the message carries, the phone of a stale link, the openers
//                      this number sent that still await the reply), asked of WhatsApp with check-exists on the receiving session; the phone whose lid equals
//                      the sender's is the sender (phoneSideMatch). At most 5 phones per message and one such round per sender lid per hour.
//                 Measured on the Owner's WAHA (2026.10.1, WEBJS, 2026-11-24): WAHA's LID store (lids/{lid}, lids/pn/{phone}) is LOCAL to a session and knows only
//                 what that session looked up, so b. often has no number; check-exists is a WhatsApp SERVER query that answers for any phone, so c. is reliable.
//                 A code-less reply of a buyer who writes from a @lid is then found by openerReplyOrder through the phone c. matched.
//        verified    (the order's phone) claim THE SAME WhatsApp delivery row (core claimBuyerFirst: pending -> sending, ignoring
//                 not_before), under the same locks and the same pool ledger and pacing as the proactive send, and reply from the number
//                 the buyer wrote to, in that chat: the PDF and the login link. The proactive send then finds the row claimed and does
//                 nothing, so the buyer gets exactly one WhatsApp delivery. A row that is not pending, or an order that is not paid: a
//                 text that says where things stand (and only to a verified sender), the row untouched.
//        unresolved  (an @lid WAHA cannot put a number to; Owner decision D6) cannot be told from a stranger, so it NEVER claims the row and
//                 never gets a login link or a name: the PDF goes as an EXTRA reply (no name, no order, no link) and the buyer's own
//                 proactive send still goes out on schedule. An order that is not paid gets one neutral text.
//        mismatch    another phone: one neutral text, and the proactive send is NOT cancelled.
//   4. replies    the extra sends (a text, the PDF for an unresolved sender) are limited: one reply per sender per hour (waha_inbound.replied_at,
//                 claimed in the database under an advisory lock on the sender before the send, so two messages at once cannot both pass and a
//                 crash can lose a reply but never double it), and only while the number is under 80 % of its daily cap, so they can never
//                 starve the proactive deliveries.
// The sender's own number and the message text are never logged; the outcome is a code on the waha_inbound row.
import { NotSentError, type WahaClient, WahaError } from "@ebooktrivia/adapters";
import {
  claimBuyerFirst,
  DELIVERY_GAP_MS,
  deliveryFilename,
  extractOrderCodes,
  HUMAN_PRESENCE_TIMEOUT_MS,
  HUMAN_TIMING,
  type InboundSender,
  isIdMobileE164,
  isUuid,
  sampleLogNormal,
  senderVerdict,
  toWaChatId,
} from "@ebooktrivia/core";
import type { Redis } from "ioredis";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type postgres from "postgres";
import type { Logger } from "../log.ts";
import type { FinalizeWrites, OutboxConsumer } from "../outbox-consumer.ts";
import type { DeliveryConfig } from "./config.ts";
import { askContact, freshLidOf, knownLid, LID_LINK_FRESH_MS, rememberLid } from "./contacts.ts";
import { raiseAlert } from "../sweepers.ts";
import { applyDecision, type Delivery, lockDelivery, machineRow, type SendContext } from "./deliver.ts";
import { deliveredSize, FILE_UNAVAILABLE, wrongFile } from "./file-check.ts";
import { cryptoRandom, sendLikeAHuman } from "./human.ts";
import { pdfOnlyCaption, type ReplyKind, replyText } from "./messages.ts";
import { claimSession, discardSend, recordSessionOutcome, settleSend } from "./pool.ts";
import { type EbookFiles, type FilePreflight, type WahaAccess, WahaAccessError } from "./ports.ts";

export const INBOUND_TOPIC = "waha.inbound";
/** A WAHA lookup (the message, an @lid) is a quick read; a text reply is one small send; the PDF for an unresolved sender is a file send. */
const LOOKUP_TIMEOUT_MS = 10_000;
const TEXT_TIMEOUT_MS = 30_000;
/** The longest the read mark of a message takes before the decision: the reading pause at its top, and the mark's two calls (sendSeen and its fallback) running out their timeouts. */
const READ_MARK_MAX_MS = HUMAN_TIMING.reading[1] + 2 * HUMAN_PRESENCE_TIMEOUT_MS;
/** The extra replies (texts, the PDF for an unresolved sender) stop at this share of a number's daily cap. */
export const REPLY_CAP_SHARE = 0.8;
/** The phone-side match of an @lid sender asks WhatsApp about at most this many phones per message. */
export const LID_CHECK_MAX = 5;
/** ... and a sender lid gets one such round per this many seconds. */
export const LID_ROUND_TTL_SECONDS = 3600;

/** Spends the ONE phone-side round a sender lid gets per hour; false when it is already spent. The same holder (the inbound row) may take it again: a retried job. */
export type LidRound = (lid: string, holder: string) => Promise<boolean>;

/**
 * The per-lid round budget in Valkey: `SET key holder NX EX 3600`. The key holds a hash of the lid, never the lid itself (a sender's identifier has no business in a key
 * space anyone with Valkey access can list). Without it (no Valkey wired) the consumer does no phone-side match at all.
 */
export function lidRoundFromValkey(valkey: Pick<Redis, "get" | "set">, prefix: string): LidRound {
  return async (lid, holder) => {
    const key = `${prefix}:lid-round:${createHash("sha256").update(lid).digest("hex")}`;
    return (await valkey.set(key, holder, "EX", LID_ROUND_TTL_SECONDS, "NX")) === "OK" || (await valkey.get(key)) === holder;
  };
}

export interface InboundDeps {
  readonly sql: postgres.Sql;
  readonly log: Logger;
  readonly config: Pick<DeliveryConfig, "leaseMs" | "wahaTimeoutMs">;
  readonly waha: WahaAccess;
  readonly delivery: Delivery;
  readonly files: EbookFiles;
  readonly random?: () => number;
  /** The human-like pauses' random source (default: the operating system's CSPRNG). A test passes its own. */
  readonly humanRandom?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Monotonic milliseconds; default performance.now. Injectable for tests, and the SAME clock the delivery uses. */
  readonly clock?: () => number;
  /** The per-lid budget of the phone-side match of an @lid sender (lidRoundFromValkey). Absent: no phone-side match (an unresolved @lid stays unresolved). */
  readonly lidRound?: LidRound;
}

interface InboundRow {
  id: string;
  message_id: string;
  session_name: string;
  from_jid: string;
  processed_at: Date | null;
}

interface Fetched {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly messageId: string;
  readonly fromMe: boolean;
  readonly body: string;
  readonly chat: { readonly kind: "phone"; readonly chatId: string; readonly phone: string } | { readonly kind: "lid"; readonly chatId: string; readonly lid: string } | { readonly kind: "other"; readonly chatId: string };
}

/** Rolls a transaction back and carries the answer out (the right to reply is only spent when the reply can go out). */
class Abandon<T> extends Error {
  readonly value: T;
  constructor(value: T) {
    super("abandoned");
    this.value = value;
  }
}

const POOL_ERRORS: ReadonlySet<string> = new Set(["no_untried_session", "no_working_session", "all_capped", "all_cooling_down"]);
const NOT_PAID_YET: ReadonlySet<string> = new Set(["pending", "expired", "gateway_failed", "snap_create_failed"]);

type ReplyClaim = { readonly slotStart: Date; readonly sessionId: string; readonly sendId: string } | { readonly outcome: string };

/** A buyer-first claim that did not happen: the outcome code, and the row's status when it was not pending. */
type Refused = { readonly outcome: string; readonly status?: string | undefined };

export function createInboundConsumer(deps: InboundDeps): OutboxConsumer {
  const { sql, log } = deps;
  const random = deps.random ?? cryptoRandom;
  const sleep = deps.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const clock = deps.clock ?? (() => performance.now());
  const humanDeps = { log, random: deps.humanRandom, sleep };

  /**
   * What a failed send tells the ledger row of its claim: WAHA refused it for sure (`failed`: not a message to the contact, not a send of the number's day), or it
   * may have gone out (`unknown`).
   */
  async function settleFailedSend(sendId: string, error: unknown): Promise<void> {
    // An argument the adapter refused BEFORE it made any request (an empty text, a malformed chat id: exactly NotSentError): nothing was sent, so the claim is given back, never
    // `unknown`. Any other error, a plain RangeError included, may have been raised after the request left: it is an unknown send below.
    if (error instanceof NotSentError) {
      await discardSend(sql, sendId).catch(() => undefined);
      return;
    }
    // Anything else (a fault of ours after the request may have left) is an unknown send too: a row is never left `reserved`.
    const end = error instanceof WahaAccessError || (error instanceof WahaError && error.code !== "maybe_sent") ? "failed" : "unknown";
    await settleSend(sql, sendId, end).catch(() => undefined);
  }

  /** Re-reads the message from WAHA on the session it arrived on (a name may exist on two servers: the one that knows the id wins). */
  async function refetch(inbound: InboundRow): Promise<Fetched | "unverified"> {
    const candidates = await sql<{ id: string }[]>`
      SELECT s.id FROM public.waha_sessions s JOIN public.waha_servers w ON w.id = s.server_id
       WHERE s.session_name = ${inbound.session_name} AND s.active AND w.active ORDER BY s.id`;
    let failed = false;
    for (const { id } of candidates) {
      try {
        const found = await deps.waha.withSession(id, async ({ sessionName, client }) => ({ sessionName, message: await client.getMessage(sessionName, inbound.message_id) }), { timeoutMs: LOOKUP_TIMEOUT_MS });
        if (found.message === null) continue;
        const { message } = found;
        return { sessionId: id, sessionName: found.sessionName, messageId: message.messageId, fromMe: message.fromMe, body: message.body, chat: message.chat };
      } catch (error) {
        // A message id that is not even shaped like WAHA's is a forgery, not an outage.
        if (error instanceof RangeError) return "unverified";
        if (error instanceof WahaError || error instanceof WahaAccessError) {
          failed = true;
          continue;
        }
        throw error;
      }
    }
    // WAHA could not be asked (or not on every candidate): try again later instead of calling the message forged.
    if (failed) throw new Error("WAHA could not be asked about an inbound message");
    return "unverified";
  }

  /**
   * The phone behind an @lid sender, or null (unresolved). In this order, the first answer wins:
   *   1. the link check-exists and earlier lookups taught us, while it is fresh (a day): no WAHA call. A @lid can be reassigned, so an older link is never trusted on its
   *      own, least of all before a login link is issued to the sender it leads to;
   *   2. WAHA's lid -> phone on the receiving session. That store is LOCAL to the session (a lid never looked up there has no number), so a null is common;
   *   3. the PHONE side (phoneSideMatch): the lid of our own buyers' phones, asked of WhatsApp itself.
   * Nothing is stored for the sender here: only a message that matched an order or an opener remembers its lid (handle).
   */
  async function resolveLid(inbound: InboundRow, fetched: Fetched, lid: string, orderPhones: readonly string[]): Promise<string | null> {
    const known = await knownLid(sql, lid);
    if (known !== null && Date.now() - known.checkedAt.getTime() < LID_LINK_FRESH_MS) return known.phone;
    try {
      const phone = await deps.waha.withSession(fetched.sessionId, ({ sessionName, client }) => client.resolveLid(sessionName, lid), { timeoutMs: LOOKUP_TIMEOUT_MS });
      if (phone !== null) return phone;
    } catch (error) {
      // An @lid WAHA has no number for (it may answer 404): no answer from this step, which only costs the link. Anything else is an outage: retry.
      if (!(error instanceof WahaError && error.code === "rejected")) throw error;
    }
    return phoneSideMatch(inbound, fetched, lid, orderPhones, known?.phone ?? null);
  }

  /**
   * The buyer's phone whose WhatsApp account IS this @lid sender, found from the phone side: a few candidate phones, each asked of WhatsApp (check-exists on the receiving
   * session, never the session-local lids/pn), and the one whose lid equals the sender's is the sender. Candidates are OUR buyers' phones only, in this order: the orders
   * whose codes the message carries; the phone of a stale link for this lid; the phones of openers this number sent (within a week) whose delivery still awaits the reply,
   * newest first. At most LID_CHECK_MAX of them, so at most that many WhatsApp calls per message, and a candidate whose lid was confirmed within a day costs none. A sender
   * lid gets ONE such round an hour (lidRound: a spammer cannot make us query WhatsApp in a loop); a spent budget, or no Valkey wired, is the same as no match.
   * Nothing is sent, and a stranger's phone is never stored: only candidates' answers are cached (askContact). A candidate WhatsApp refuses does not match; any other
   * failure throws (the job is retried, and the same message may take the round again).
   */
  async function phoneSideMatch(inbound: InboundRow, fetched: Fetched, lid: string, orderPhones: readonly string[], stalePhone: string | null): Promise<string | null> {
    if (deps.lidRound === undefined) return null;
    const awaiting = await sql<{ buyer_phone: string }[]>`
      SELECT o.buyer_phone
        FROM public.delivery_openers p
        JOIN public.deliveries d ON d.id = p.delivery_id AND d.channel = 'whatsapp' AND d.status = 'pending'
        JOIN public.orders o ON o.id = d.order_id
       WHERE p.status IN ('sent', 'unknown') AND p.session_id = ${fetched.sessionId} AND p.sent_at > now() - interval '7 days'
       GROUP BY o.buyer_phone ORDER BY max(p.sent_at) DESC LIMIT ${LID_CHECK_MAX}`;
    const candidates = [...new Set([...orderPhones, ...(stalePhone === null ? [] : [stalePhone]), ...awaiting.map((r) => r.buyer_phone)])].filter((p) => isIdMobileE164(p)).slice(0, LID_CHECK_MAX);
    if (candidates.length === 0 || !(await deps.lidRound(lid, inbound.id))) return null;
    return deps.waha.withSession(
      fetched.sessionId,
      async ({ sessionName, client }) => {
        for (const phone of candidates) if ((await lidOfPhone(sessionName, client, phone)) === lid) return phone;
        return null;
      },
      { timeoutMs: LOOKUP_TIMEOUT_MS },
    );
  }

  /** The lid WhatsApp knows `phone` by: the cached one while that link is fresh, else asked (and cached) with check-exists; null when it has none or WhatsApp refuses the question. */
  async function lidOfPhone(sessionName: string, client: WahaClient, phone: string): Promise<string | null> {
    const cached = await freshLidOf(sql, phone);
    if (cached !== null) return cached;
    try {
      const contact = await askContact(sql, client, sessionName, phone);
      return contact.kind === "ok" ? contact.lid : null;
    } catch (error) {
      if (error instanceof WahaError && error.code === "rejected") return null;
      throw error;
    }
  }

  /**
   * The right to send ONE extra reply to this sender, and the number's slot for it, in one transaction: an advisory lock on the sender
   * (two messages at once cannot both pass), the reply claimed (at most one an hour per sender), and the pool's reservation under the reply
   * share of the daily cap. When no number can send, the whole claim rolls back and the right is not spent.
   */
  async function claimReply(inbound: InboundRow, fetched: Fetched, kind: "text" | "reply", prefix: string): Promise<ReplyClaim> {
    try {
      return await sql.begin(async (tx): Promise<ReplyClaim> => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`waha_reply:${inbound.from_jid}`}, 0))`;
        const claimed = await tx`
          UPDATE public.waha_inbound i SET replied_at = clock_timestamp()
           WHERE i.id = ${inbound.id} AND i.replied_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM public.waha_inbound x
                WHERE x.from_jid = i.from_jid AND x.id <> i.id AND x.replied_at > clock_timestamp() - interval '1 hour')`;
        if (claimed.count !== 1) throw new Abandon<ReplyClaim>({ outcome: `${prefix}_skipped` });
        // A reply answers a buyer who wrote first: not a new contact (the ban signals do not apply), but the per-contact rules do (a gap after the
        // previous message to this chat, four an hour).
        const picked = await claimSession(tx, { exclude: [], only: fetched.sessionId, kind, deliveryId: null, gap: DELIVERY_GAP_MS, random, capShare: REPLY_CAP_SHARE, contact: fetched.chat.chatId });
        if (picked.kind === "none") throw new Abandon<ReplyClaim>({ outcome: picked.reason === "contact_capped" ? `${prefix}_contact_capped` : POOL_ERRORS.has(picked.reason) ? `${prefix}_no_number` : `${prefix}_busy` });
        return { slotStart: picked.slot.startAt, sessionId: picked.sessionId, sendId: picked.sendId };
      });
    } catch (error) {
      if (error instanceof Abandon) return error.value as ReplyClaim;
      throw error;
    }
  }

  /** The one text reply (at most one per sender per hour, from a number under its reply share of the cap). */
  async function textReply(inbound: InboundRow, fetched: Fetched, kind: ReplyKind, signal: AbortSignal): Promise<string> {
    const claim = await claimReply(inbound, fetched, "text", "text");
    if ("outcome" in claim) return claim.outcome;
    try {
      await sleep(Math.max(0, claim.slotStart.getTime() - Date.now()), signal);
      const text = replyText(kind);
      const result = await deps.waha.withSession(
        fetched.sessionId,
        ({ sessionName, client }) =>
          sendLikeAHuman(humanDeps, {
            client,
            sessionName,
            chatId: fetched.chat.chatId,
            textLength: text.length,
            kind: "message",
            signal,
            send: () => client.sendText(sessionName, fetched.chat.chatId, text),
          }),
        { timeoutMs: TEXT_TIMEOUT_MS },
      );
      // An abort during a wait: nothing was sent (the right to reply is spent; the sender asks again after the hour).
      if (result.kind !== "sent") await discardSend(sql, claim.sendId);
      else await settleSend(sql, claim.sendId, "sent");
      return result.kind === "sent" ? `text_${kind}` : "text_failed";
    } catch (error) {
      // An informational reply: never retried, never alarming. The code says why. What WAHA refused for sure was not sent (its ledger row says failed); one that may
      // have gone out says unknown.
      log.warn({ inboundId: inbound.id, code: error instanceof WahaError || error instanceof WahaAccessError ? error.code : "failed" }, "the text reply was not sent");
      await settleFailedSend(claim.sendId, error);
      return "text_failed";
    }
  }

  /**
   * Owner decision D6: the PDF for an @lid sender we could not confirm, as an EXTRA send: no name, no order, no login link, and the delivery row
   * is neither read nor claimed, so the buyer's own proactive send is untouched. The same reply limits as a text.
   */
  async function pdfOnlyReply(inbound: InboundRow, fetched: Fetched, order: { id: string }, signal: AbortSignal): Promise<string> {
    const [file] = await sql<{ title: string; storage_path: string | null }[]>`
      SELECT p.title, u.storage_path FROM public.orders o JOIN public.products p ON p.id = o.product_id LEFT JOIN public.uploads u ON u.id = p.pdf_upload_id WHERE o.id = ${order.id}`;
    if (file?.storage_path === undefined || file.storage_path === null) return "not_sendable";
    const claim = await claimReply(inbound, fetched, "reply", "pdf");
    if ("outcome" in claim) return claim.outcome;
    const { sessionId } = claim;
    try {
      await sleep(Math.max(0, claim.slotStart.getTime() - Date.now()), signal);
      // The pre-flight (US-005 R11): WAHA delivers whatever the URL answers, even a 404 page. Nothing is sent unless the URL answers the stored PDF; the claim is given back.
      let url: string;
      let preflight: FilePreflight;
      try {
        url = deps.files.signedUrl(file.storage_path, new Date());
        preflight = await deps.files.preflight(file.storage_path, new Date());
      } catch {
        // The stored PDF is not on disk (or its path is not a deliverable one): nothing could be sent, so this is NOT an uncertain send: the claim is given back, never
        // ledgered `unknown`.
        log.warn({ inboundId: inbound.id }, "the stored ebook file cannot be read; the PDF reply is not sent");
        await discardSend(sql, claim.sendId);
        return "not_sendable";
      }
      const caption = pdfOnlyCaption();
      if (!preflight.ok) {
        log.warn({ inboundId: inbound.id, reason: preflight.reason }, "the signed ebook URL does not answer the stored file; the PDF reply is not sent");
        await discardSend(sql, claim.sendId);
        await raiseAlert(sql, {
          kind: "delivery_not_attempted",
          severity: "critical",
          dedupeKey: `delivery_not_attempted:${FILE_UNAVAILABLE}`,
          message: "deliveries are held back by a fault on our side (the login link, a message template or the ebook file): nothing is sent until it is fixed",
          payload: { cause: FILE_UNAVAILABLE },
        }).catch(() => undefined);
        return "pdf_only_failed";
      }
      const { sent: result, delivered } = await deps.waha.withSession(
        sessionId,
        async ({ sessionName, client }) => {
          const sentResult = await sendLikeAHuman(humanDeps, {
            client,
            sessionName,
            chatId: fetched.chat.chatId,
            textLength: caption.length,
            kind: "message",
            signal,
            send: () => client.sendFile(sessionName, fetched.chat.chatId, { url, filename: deliveryFilename(file.title), mimetype: "application/pdf" }, caption),
          });
          // The read-back: the size WAHA delivered against the stored file's (best effort; an unknown size is not an error).
          return { sent: sentResult, delivered: sentResult.kind === "sent" ? await deliveredSize(client, sessionName, sentResult.value.id, log) : undefined };
        },
        { timeoutMs: deps.config.wahaTimeoutMs },
      );
      if (result.kind !== "sent") {
        await discardSend(sql, claim.sendId);
        return "pdf_only_failed";
      }
      const wrong = wrongFile(preflight.size, delivered);
      if (wrong !== undefined) {
        // It went out, and is never resent by itself: the Owner is told (this extra send has no delivery row to mark).
        log.warn({ inboundId: inbound.id, expected: wrong.expected, delivered: wrong.delivered }, "the PDF reply was delivered with another size than the stored file");
        await raiseAlert(sql, {
          kind: "delivery_wrong_file",
          severity: "critical",
          dedupeKey: `delivery_wrong_file:inbound:${inbound.id}`,
          message: "a WhatsApp ebook went out but WAHA delivered a file of another size than the PDF (a page instead of the ebook?): check the order and resend it; it is not resent by itself",
          payload: { inbound_id: inbound.id, order_id: order.id, expected_bytes: wrong.expected, delivered_bytes: wrong.delivered },
        }).catch(() => undefined);
      }
      await settleSend(sql, claim.sendId, "sent");
      await sql.begin((tx) => recordSessionOutcome(tx, sessionId, true, new Date()));
      return "pdf_only_sent";
    } catch (error) {
      // Not retried (the right to reply is spent): the sender asks again after the hour. Only WAHA's own answers say anything about the number.
      const code = error instanceof WahaError || error instanceof WahaAccessError ? error.code : undefined;
      log.warn({ inboundId: inbound.id, code: code ?? "failed" }, "the PDF reply was not sent");
      if (code !== undefined) await sql.begin((tx) => recordSessionOutcome(tx, sessionId, false, new Date())).catch(() => undefined);
      await settleFailedSend(claim.sendId, error);
      return "pdf_only_failed";
    }
  }

  /** The verified buyer's claim of the same row, and the reply; returns the outcome code. */
  async function buyerFirst(inbound: InboundRow, fetched: Fetched, order: { id: string; status: string }, signal: AbortSignal): Promise<string> {
    if (order.status !== "paid") return textReply(inbound, fetched, NOT_PAID_YET.has(order.status) ? "not_paid" : "not_available", signal);
    const claim = await sql
      .begin(async (tx): Promise<{ context: SendContext } | Refused> => {
        const [ref] = await tx<{ id: string }[]>`SELECT id FROM public.deliveries WHERE order_id = ${order.id} AND channel = 'whatsapp'`;
        if (ref === undefined) return { outcome: "no_delivery" };
        const row = await lockDelivery(tx, ref.id);
        if (row === undefined) return { outcome: "no_delivery" };
        if (row.order_status !== "paid" || row.storage_path === null) return { outcome: "not_sendable" };
        if (row.status !== "pending") return { outcome: "not_pending", status: row.status };
        const chatId = row.wa_chat_id ?? (isIdMobileE164(row.buyer_phone) ? toWaChatId(row.buyer_phone) : null);
        if (chatId === null) return { outcome: "not_sendable" };
        const filename = row.filename ?? deliveryFilename(row.product_title);
        // The same ledger, pacing and daily cap as the opener, on the number the buyer wrote to; not a new contact (the buyer wrote first), but the
        // per-contact rules apply (the opener went to this chat a moment ago: the reply waits out the gap).
        const picked = await claimSession(tx, { exclude: [], only: fetched.sessionId, kind: "reply", deliveryId: row.id, gap: DELIVERY_GAP_MS, random, contact: row.buyer_phone });
        if (picked.kind === "none") throw new Abandon<Refused>({ outcome: picked.reason === "contact_capped" ? "contact_capped" : POOL_ERRORS.has(picked.reason) ? "pool_unavailable" : "pool_busy" });
        const decision = claimBuyerFirst(machineRow(row, chatId, filename), { now: row.now, leaseMs: deps.config.leaseMs, sessionId: fetched.sessionId, chatId: fetched.chat.chatId, sender: "verified" });
        if (!decision.ok) throw new Abandon<Refused>({ outcome: decision.reason === "not_pending" ? "not_pending" : "not_sendable" });
        await applyDecision(tx, row.id, decision, row.now, { wa_chat_id: chatId, filename, reply_chat_id: fetched.chat.chatId });
        // The buyer wrote first (Owner decision D7: the reply claims the row): an opener that has not gone out is moot (final, quiet, never sent). One that is
        // in flight or already out is left as it is (exactly-once: the guard trigger refuses any way back).
        await tx`UPDATE public.delivery_openers SET status = 'expired', next_attempt_at = NULL, last_error = 'buyer_wrote', updated_at = ${row.now} WHERE delivery_id = ${row.id} AND status = 'pending'`;
        const reply = decision.reply;
        if (reply === undefined) throw new Error("a buyer-first claim carries its reply");
        return {
          context: {
            deliveryId: row.id,
            orderId: row.order_id,
            channel: "whatsapp",
            attempt: decision.set.attempts ?? row.attempts + 1,
            buyer: { name: row.buyer_name, phone: row.buyer_phone, email: row.buyer_email, playerId: row.player_id },
            product: { title: row.product_title, storagePath: row.storage_path },
            code: row.order_code,
            whatsapp: { sessionId: fetched.sessionId, chatId, filename, startAt: picked.slot.startAt },
            reply,
            sendId: picked.sendId,
            claimedAt: clock(),
          },
        };
      })
      .catch((error: unknown) => {
        if (error instanceof Abandon) return error.value as Refused;
        throw error;
      });
    if ("outcome" in claim) {
      if (claim.outcome === "pool_busy") throw new Error("the number's queue is full; the reply is retried");
      if (claim.outcome !== "not_pending") return claim.outcome;
      // A row that is not pending: text only, and the proactive send is not cancelled. What the text says follows the row: on its way (in
      // flight, sent, unknown), failed (the Owner is told), or withdrawn (cancelled).
      return textReply(inbound, fetched, claim.status === "failed" ? "needs_help" : claim.status === "cancelled" ? "not_available" : "already_sent", signal);
    }
    const result = await deps.delivery.perform(claim.context);
    return result === "sent" ? "delivered" : `delivery_${result}`;
  }

  /** The order whose WhatsApp opener went out from `sessionId` to `phone` and whose delivery still awaits its reply (the newest one), or undefined. */
  async function openerReplyOrder(phone: string | null, sessionId: string): Promise<{ id: string; status: string; buyer_phone: string; order_code: string } | undefined> {
    if (phone === null) return undefined;
    const [found] = await sql<{ id: string; status: string; buyer_phone: string; order_code: string }[]>`
      SELECT o.id, o.status::text AS status, o.buyer_phone, o.order_code
        FROM public.delivery_openers p
        JOIN public.deliveries d ON d.id = p.delivery_id AND d.channel = 'whatsapp' AND d.status = 'pending'
        JOIN public.orders o ON o.id = d.order_id
       WHERE p.status IN ('sent', 'unknown') AND p.session_id = ${sessionId} AND o.buyer_phone = ${phone}
       ORDER BY p.sent_at DESC LIMIT 1`;
    return found;
  }

  /**
   * Marks the sender's whole chat as read on the number it wrote to (sendSeen without message ids), after a random reading pause (log-normal, from the human-like random
   * source). The pause ends early with the job's signal, and that abort is NOT swallowed: the job ends before anything is decided. The mark itself is best effort: whatever
   * goes wrong (the session cannot be opened, WAHA refuses or times out) is logged as a code and the message is handled as if it had worked.
   */
  async function markRead(inbound: InboundRow, fetched: Fetched, signal: AbortSignal): Promise<void> {
    await sleep(sampleLogNormal(humanDeps.random ?? cryptoRandom, HUMAN_TIMING.reading), signal);
    try {
      await deps.waha.withSession(fetched.sessionId, ({ sessionName, client }) => client.sendSeen(sessionName, fetched.chat.chatId), { timeoutMs: HUMAN_PRESENCE_TIMEOUT_MS });
    } catch (error) {
      log.debug({ inboundId: inbound.id, step: "seen", code: error instanceof WahaError || error instanceof WahaAccessError ? error.code : "failed" }, "the inbound message could not be marked as read; it is handled anyway");
    }
  }

  async function handle(inbound: InboundRow, signal: AbortSignal): Promise<string> {
    const fetched = await refetch(inbound);
    if (fetched === "unverified") return "unverified";
    if (fetched.fromMe || fetched.chat.kind === "other") return "ignored";
    await markRead(inbound, fetched, signal);
    const codes = extractOrderCodes(fetched.body);
    const sender: InboundSender = fetched.chat.kind === "phone" ? { kind: "phone", phone: fetched.chat.phone } : { kind: "lid" };
    const orders =
      codes.length === 0
        ? []
        : await sql<{ id: string; status: string; buyer_phone: string; order_code: string }[]>`
            SELECT id, status::text AS status, buyer_phone, order_code FROM public.orders WHERE order_code = ANY(${codes}::text[])`;
    // The orders come first: their phones are the first candidates of the phone-side match of an @lid sender (resolveLid).
    const resolvedPhone = fetched.chat.kind === "lid" ? await resolveLid(inbound, fetched, fetched.chat.lid, orders.map((o) => o.buyer_phone)) : null;
    let order = codes.map((c) => orders.find((o) => o.order_code === c)).find((o) => o !== undefined);
    // A reply to our opener needs no code (Owner decision D7: "reply to this message"): the number that wrote IS the buyer's, and it wrote to the very
    // number that sent the opener. Nothing about the order is learnt from a message that carries no code: this only finds the order we wrote to.
    if (order === undefined) order = await openerReplyOrder(fetched.chat.kind === "phone" ? fetched.chat.phone : resolvedPhone, fetched.sessionId);
    if (order === undefined) return codes.length === 0 ? "no_code" : "unknown_code";
    const verdict = senderVerdict({ orderPhone: order.buyer_phone, sender, resolvedPhone });
    // The lid is worth remembering only once this message matched an order or an opener (the sender IS the buyer): never a stranger's phone.
    if (verdict === "verified" && fetched.chat.kind === "lid" && resolvedPhone !== null) await rememberLid(sql, resolvedPhone, fetched.chat.lid);
    // A stranger who knows an order code gets a neutral text and nothing else: no PDF, no login link, and the buyer's delivery is untouched.
    if (verdict === "mismatch" || verdict === "ignore") return verdict === "ignore" ? "ignored" : textReply(inbound, fetched, "mismatch", signal);
    if (verdict === "unresolved") return order.status === "paid" ? pdfOnlyReply(inbound, fetched, order, signal) : textReply(inbound, fetched, "generic", signal);
    return buyerFirst(inbound, fetched, order, signal);
  }

  return {
    topic: INBOUND_TOPIC,
    // The claim, the number's slot, the WAHA request and the record all happen inside one job.
    leaseMs: deps.config.leaseMs + 30_000 + READ_MARK_MAX_MS,
    async perform(row, signal): Promise<FinalizeWrites | undefined> {
      const payload = row.payload as { inbound_id?: unknown; message_id?: unknown };
      if (!isUuid(payload.inbound_id)) throw new Error("waha.inbound payload has no valid inbound_id");
      const [inbound] = await sql<InboundRow[]>`SELECT id, message_id, session_name, from_jid, processed_at FROM public.waha_inbound WHERE id = ${payload.inbound_id}`;
      // The row is gone (deleted for compliance) or already handled: nothing to do.
      if (inbound === undefined || inbound.processed_at !== null) return undefined;
      const outcome = inbound.message_id === payload.message_id ? await handle(inbound, signal) : "inconsistent";
      return async (tx) => {
        await tx`UPDATE public.waha_inbound SET processed_at = clock_timestamp(), outcome = ${outcome} WHERE id = ${inbound.id} AND processed_at IS NULL`;
      };
    },
  };
}
