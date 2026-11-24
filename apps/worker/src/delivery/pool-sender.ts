// One text message out of the WhatsApp pool (US-025; plan M9.1 "OTP via the WAHA pool"; the OTP sender of US-026 plugs in here). The same
// rules as every other WhatsApp send of the worker, for a message that has no delivery row:
//   - the number comes from the pool (weighted round-robin over the WORKING numbers, under their daily caps, resting numbers skipped) and the
//     send is recorded in the ledger (kind `otp`), so a player's OTP counts against a number's cap and its pacing like every other send;
//   - the number paces itself, with the SHORT gap (core OTP_GAP_MS: a player is waiting for a code);
//   - the sequence is the human-like one (human.ts): the chat marked as read (one quick best-effort call), typing, a short wait, paused, send, offline; an OTP has no reading pause and its
//     whole choreography stays short (core HUMAN_TIMING.otp*: under 4 s);
//   - a player who asked for a code on the web has not written to us on WhatsApp, so an OTP is a message to a NEW contact: a number that WhatsApp holds
//     back from new contacts (error 463 / 475) is skipped, and one that refuses with those errors is held back and the next number tried (not counted
//     against its health);
//   - before the FIRST message to a phone WAHA is asked where it lives (check-exists, cached per phone, contacts.ts) and the code is sent to the chat id it
//     returns (a @lid, perhaps), never to one built from the phone; a phone that is not on WhatsApp ends in `no_whatsapp` (nothing is sent, no number is
//     penalised); a lookup that fails sends nothing and the next number is tried;
//   - the per-contact rules apply: at most 4 messages an hour to one contact, and a second one waits its 30 to 60 s gap, but never longer than the
//     consumer's lease allows (OTP_CONTACT_WAIT_MS): beyond it the code is retried later by the outbox, never sent late and never held;
//   - a definite failure (WAHA refused it, the session is not working) fails over to another number, up to WA_MAX_SESSIONS, and counts against
//     the number's health (the breaker rests a number that keeps failing);
//   - a send that MAY have gone out (a timeout, a reset, a 5xx) is never tried on another number: the caller learns `maybe_sent` and the player
//     asks for a new code if none arrives. Nothing is stored or logged but ids and codes: never the number or the text.
import { NotSentError, WahaError } from "@ebooktrivia/adapters";
import { type IdMobileE164, OTP_GAP_MS, toWaChatId, WA_MAX_SESSIONS } from "@ebooktrivia/core";
import { setTimeout as delay } from "node:timers/promises";
import type postgres from "postgres";
import type { Logger } from "../log.ts";
import { holdBack, raisePoolAlert } from "./deliver.ts";
import { cryptoRandom, sendLikeAHuman } from "./human.ts";
import { ContactCacheError, type ContactResolution, knownChatsOf, resolveContact } from "./contacts.ts";
import { claimSession, closeSend, discardSend, recordSessionOutcome, settleSend } from "./pool.ts";
import { type WahaAccess, WahaAccessError } from "./ports.ts";

/** An OTP consumer holds its claim for 120 s (OTP_LEASE_MS in otp-send.ts): a second code to the same contact waits no longer than this for its gap. */
export const OTP_CONTACT_WAIT_MS = 10_000;

export type PoolSendErrorCode =
  /** No number could take it (none WORKING, all at their cap or resting or held back by WhatsApp, all busy): nothing was sent. */
  | "no_number"
  /** Every number tried refused it: nothing was sent. */
  | "failed"
  /** A send may have gone out: not retried. */
  | "maybe_sent"
  /** The contact already got its messages for the hour, or its 30 to 60 s gap is still running: nothing was sent, try again later. */
  | "contact_limit"
  /** The phone is not on WhatsApp (WAHA's check-exists): nothing was sent, and no number would change it. */
  | "no_whatsapp";

/** Why the last number refused: WAHA's own answer (`waha`) or the worker's access to the number (`access`: no key, binding, session off). A code only. */
export type PoolRefusal = { readonly kind: "waha"; readonly code: string } | { readonly kind: "access"; readonly code: WahaAccessError["code"] };

export class PoolSendError extends Error {
  readonly code: PoolSendErrorCode;
  /** The last refusal, when a number was asked at all. */
  readonly refusal: PoolRefusal | undefined;
  /** contact_limit: when the contact may be written to again (its gap or its hour), when the pool knows it. */
  readonly retryAt: Date | undefined;
  constructor(code: PoolSendErrorCode, refusal?: PoolRefusal, retryAt?: Date) {
    super(`pool send: ${code}`);
    this.name = "PoolSendError";
    this.code = code;
    this.refusal = refusal;
    this.retryAt = retryAt;
  }
}

/** The port US-026's OTP sender sits behind. */
export interface PoolTextSender {
  /** Sends `text` to `to` from a pool number; resolves with the number's id, rejects with PoolSendError. `signal` ends the waits (a send that is aborted is not made). */
  sendText(input: { readonly to: IdMobileE164; readonly text: string; readonly signal?: AbortSignal }): Promise<{ readonly sessionId: string }>;
}

export function createPoolSender(deps: {
  readonly sql: postgres.Sql;
  readonly log: Logger;
  readonly waha: WahaAccess;
  readonly random?: () => number;
  /** The human-like pauses' random source (default: the operating system's CSPRNG). A test passes its own. */
  readonly humanRandom?: () => number;
  /** The share of the new-contact budget each warning leaves (default core DEFAULT_WARNING_CAP_FACTORS). */
  readonly warningCapFactors?: readonly [number, number];
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): PoolTextSender {
  const { sql, log } = deps;
  const random = deps.random ?? cryptoRandom;
  const sleep = deps.sleep ?? ((ms: number, signal?: AbortSignal) => delay(ms, undefined, signal === undefined ? {} : { signal }));
  return {
    async sendText({ to, text, signal }) {
      // WEBJS sends an empty text as an empty message (R11): refused before a number is claimed, before any "typing" is shown, and never an uncertain send.
      if (text.trim() === "") throw new NotSentError("text must not be empty");
      // A phone is one contact (the buyer's opener and a login code count together); the chat ids it is known by tell the pool which numbers already have a
      // chat with it. The chat id built from the phone is for matching history only: what is SENT to is what check-exists returns.
      const chats = await knownChatsOf(sql, to, toWaChatId(to));
      const abort = signal ?? new AbortController().signal;
      const tried: string[] = [];
      let refusal: PoolRefusal | undefined;
      while (tried.length < WA_MAX_SESSIONS) {
        const picked = await sql.begin((tx) =>
          claimSession(tx, {
            exclude: tried,
            kind: "otp",
            deliveryId: null,
            gap: OTP_GAP_MS,
            random,
            newContact: true,
            contact: to,
            contactChats: chats,
            maxContactWaitMs: OTP_CONTACT_WAIT_MS,
            ...(deps.warningCapFactors === undefined ? {} : { warningCapFactors: deps.warningCapFactors }),
          }),
        );
        if (picked.kind === "none") {
          if (picked.reason === "contact_capped" || picked.reason === "contact_wait") throw new PoolSendError("contact_limit", refusal, picked.retryAt);
          if (tried.length === 0) await raisePoolAlert(sql, picked.known === 0 ? "no_session_configured" : picked.reason, log);
          // Numbers tried and refused: that is a failure of the send, not a lack of numbers.
          throw new PoolSendError(tried.length > 0 ? "failed" : "no_number", refusal);
        }
        tried.push(picked.sessionId);
        try {
          await sleep(Math.max(0, picked.slot.startAt.getTime() - Date.now()), abort);
        } catch {
          // Aborted while waiting for the slot: nothing was sent, so the claim's ledger row is not a message.
          await discardSend(sql, picked.sendId);
          throw new PoolSendError("failed", refusal);
        }
        try {
          const result = await deps.waha.withSession(picked.sessionId, async ({ sessionName, client }) => {
            let contact: ContactResolution;
            try {
              contact = await resolveContact(sql, client, sessionName, to);
            } catch (error) {
              if (error instanceof WahaError) return { kind: "lookup_failed", code: error.code } as const;
              // Our own database failed (the contact cache): nothing was sent, so it is not an uncertain send either.
              if (error instanceof ContactCacheError) return { kind: "lookup_failed", code: "contact_cache_failed" } as const;
              throw error;
            }
            if (contact.kind === "no_whatsapp") return { kind: "no_whatsapp" } as const;
            return sendLikeAHuman(
              { log, random: deps.humanRandom, sleep: (ms, s) => sleep(ms, s) },
              { client, sessionName, sessionId: picked.sessionId, chatId: contact.chatId, textLength: text.length, kind: "otp", signal: abort, send: () => client.sendText(sessionName, contact.chatId, text) },
            );
          });
          // The phone is not on WhatsApp: nothing was sent, no number is penalised, and another number would not change it.
          if (result.kind === "no_whatsapp") {
            await discardSend(sql, picked.sendId);
            throw new PoolSendError("no_whatsapp");
          }
          // The lookup failed (5xx, timeout): nothing was sent and it says nothing of the number's sends; another number is asked.
          if (result.kind === "lookup_failed") {
            refusal = { kind: "waha", code: result.code };
            log.warn({ sessionId: picked.sessionId, code: result.code }, "WhatsApp could not be asked whether a number exists; trying another");
            await discardSend(sql, picked.sendId);
            continue;
          }
          // An abort during a wait: nothing was sent.
          if (result.kind === "not_sent") {
            await discardSend(sql, picked.sendId);
            throw new PoolSendError("failed", refusal);
          }
          await settleSend(sql, picked.sendId, "sent");
          await sql.begin((tx) => recordSessionOutcome(tx, picked.sessionId, true, new Date()));
          return { sessionId: picked.sessionId };
        } catch (error) {
          if (error instanceof PoolSendError) throw error;
          // An argument the adapter refused before it made any request (a malformed chat id or session name: exactly NotSentError): nothing was sent, so the claim is given back,
          // never `unknown`. Any other error, a plain RangeError included, may have been raised after the request left and takes the uncertain path below.
          if (error instanceof NotSentError) {
            await discardSend(sql, picked.sendId);
            throw new PoolSendError("failed", refusal);
          }
          if (error instanceof WahaError && (error.code === "reachout_timelock" || error.code === "message_capping")) {
            // WhatsApp refused a NEW contact from this number: nothing was sent. Held back (and alerted), not counted as failing; another number.
            refusal = { kind: "waha", code: error.code };
            await discardSend(sql, picked.sendId);
            await sql.begin((tx) => holdBack(tx, picked.sessionId, error.code === "reachout_timelock" ? "reachout_timelock" : "message_capping", new Date())).catch((holdError: unknown) => {
              log.error({ sessionId: picked.sessionId, err: holdError }, "the number could not be held back");
            });
            log.warn({ sessionId: picked.sessionId, code: error.code }, "WhatsApp refused a new contact from a number; trying another");
            continue;
          }
          // The request may have left: never another number (the player would get two codes).
          const certain = error instanceof WahaAccessError || (error instanceof WahaError && error.code !== "maybe_sent");
          // Only WahaError and WahaAccessError say anything about the number; any other error is a bug of ours, not the number's health.
          if (error instanceof WahaAccessError || error instanceof WahaError) {
            refusal = error instanceof WahaAccessError ? { kind: "access", code: error.code } : { kind: "waha", code: error.code };
            await sql.begin((tx) => recordSessionOutcome(tx, picked.sessionId, false, new Date())).catch((recordError: unknown) => {
              log.error({ sessionId: picked.sessionId, err: recordError }, "the pool's health could not be recorded");
            });
          }
          if (!certain) {
            // It may have gone out (WAHA's answer was lost, or something of ours failed after the request left): the ledger row stays, as `unknown`, never `reserved`.
            await settleSend(sql, picked.sendId, "unknown").catch(() => undefined);
            throw new PoolSendError("maybe_sent", refusal);
          }
          // WAHA refused it for sure: it was not sent, so it is neither a message to the contact nor a send of the number's day (the report counts it as the
          // number's failure).
          await closeSend(sql, picked.sendId, "retryable_failure");
          log.warn({ sessionId: picked.sessionId, code: refusal?.code ?? "failed" }, "a WhatsApp number refused a message; trying another");
        }
      }
      throw new PoolSendError("failed", refusal);
    },
  };
}
