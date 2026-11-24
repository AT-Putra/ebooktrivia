// WAHA adapter (plan M3.3; AC-D1/D6, AC-Q1 OTP): sends, session status, LID resolution, recent
// outgoing lookup, webhook HMAC and inbound/ack parsing.
//
//   - Construct it with the URL returned by @ebooktrivia/crypto assertWahaTarget(server, secret),
//     never with a raw base_url: that check binds the decrypted API key to the server's host.
//   - Request URLs are built from encodeURIComponent()-ed path segments and must keep the target's
//     origin (security review US-011: new URL("//evil.example/x", target) would escape it).
//   - Send failures are classified for the delivery machine (core delivery-machine.ts):
//       failed      the request certainly did not reach WAHA, or WAHA rejected it (4xx);
//       maybe_sent  it may have been sent (timeout, connection reset after writing, 5xx). The
//                   machine then reconciles through recentOutgoing(), never by resending blindly.
//   - Webhooks: each WAHA server has its own webhook path and HMAC secret. The caller MUST take
//     the event's `session` as belonging to the server whose secret verified the HMAC (look the
//     session up under that server only), never as a global session name, and MUST refuse events
//     whose eventTimestampMs is outside its replay window. Inbound messages are re-fetched with
//     getMessage() on that same server before anything acts on them (plan M8).

import { createHmac, timingSafeEqual } from "node:crypto";
import { type IdMobileE164, normalizeIdMobile } from "@ebooktrivia/core";
import { type HttpFetch, type HttpResponse, isRecord, stringField } from "./http.ts";
import { SafeFetchError } from "./safe-fetch.ts";

export type WahaErrorCode =
  | "unauthorized"
  | "rejected"
  | "failed"
  | "maybe_sent"
  | "bad_response"
  /** WhatsApp refused a message to a NEW contact: "server returned error 463" (reachout timelock). The send certainly did not happen; the session stays WORKING. */
  | "reachout_timelock"
  /** "server returned error 475" (message capping: the quota of new contacts of this cycle is used). Same: not sent, session WORKING. */
  | "message_capping";

export class WahaError extends Error {
  readonly code: WahaErrorCode;
  constructor(code: WahaErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "WahaError";
    this.code = code;
  }
}

/**
 * An argument the client refused BEFORE any request was made (a malformed session name or chat id, an empty text, a file URL that is not https): nothing was sent, whatever the
 * caller does next. Thrown ONLY by those checks, so a caller can treat exactly this class as "not sent" (security / code review US-005): any other error, a plain RangeError
 * included, may have been raised after the request left and stays on the uncertain path. It is a RangeError, so callers that only care about bad input still catch it.
 */
export class NotSentError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "NotSentError";
  }
}

export interface WahaClientConfig {
  /** From assertWahaTarget(): https, host bound to the API key. */
  readonly target: URL;
  readonly apiKey: string;
  readonly fetch: HttpFetch;
  /** The time budget of one seen / typing / presence call (they are best effort and never held against a send). Default 3000 ms. */
  readonly presenceTimeoutMs?: number;
  /** The time budget of a check-exists lookup (WhatsApp is asked). Default 10000 ms. */
  readonly lookupTimeoutMs?: number;
}

export interface SentMessage {
  readonly id: string;
  /** Unix seconds. */
  readonly timestamp: number;
}

export interface OutgoingMessage extends SentMessage {
  readonly filename: string | undefined;
}

export interface FileToSend {
  /** A signed, short-lived URL to the PDF (signFileUrl), fetched by WAHA. */
  readonly url: string;
  readonly filename: string;
  readonly mimetype: string;
}

/** SafeFetch failures that happen before any byte is sent: the message was certainly not sent. */
const NOT_SENT = new Set(["invalid_url", "scheme_not_allowed", "blocked_address", "dns_failed"]);

const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CHAT_ID = /^[0-9]{5,20}@(?:c\.us|lid)$/;
/** WAHA message ids: "{fromMe}_{chatId}_{key}", e.g. "false_628123456789@c.us_3EB0AAAA0001". */
const MESSAGE_ID = /^(?:true|false)_([0-9]{5,20}@(?:c\.us|lid))_[A-Za-z0-9]{1,64}$/;
/** A message id of a message WE sent (`true_`) in `chatId`: what a send answer must carry. */
const isOurMessageIn = (id: string, chatId: string): boolean => id.startsWith("true_") && MESSAGE_ID.exec(id)?.[1] === chatId;

export interface ContactCheck {
  readonly numberExists: boolean;
  /** Where to send: `<digits>@c.us` or `<lid>@lid`. Null when the number is not on WhatsApp. */
  readonly chatId: string | null;
  /** The `<lid>@lid` when the chat id is one (the key of an inbound @lid match). */
  readonly lid: string | null;
  /** The phone WAHA reports for the contact (`pn`), when it does. */
  readonly phone: IdMobileE164 | null;
}

export interface FetchedMessage {
  readonly messageId: string;
  readonly chat: ChatRef;
  readonly fromMe: boolean;
  readonly body: string;
  readonly hasMedia: boolean;
  /**
   * The size in bytes of the file WAHA delivered, when the engine says (WEBJS: `_data.size`, recorded in US-005 R11). WAHA does not refuse a file URL it cannot
   * fetch: it sends the error page as the document, so this is how a wrong file is told from the right one. Absent when the answer does not carry it.
   */
  readonly mediaSize?: number;
  /** Unix seconds. */
  readonly timestamp: number;
}

export interface WahaClient {
  sendText(session: string, chatId: string, text: string): Promise<SentMessage>;
  sendFile(session: string, chatId: string, file: FileToSend, caption?: string): Promise<SentMessage>;
  sessionStatus(session: string): Promise<string>;
  /** The phone (E.164) behind a @lid chat, or null when WAHA cannot resolve it (VERIFIED live: an unknown @lid answers 200 {lid, pn: null}, not a 404). */
  resolveLid(session: string, lid: string): Promise<IdMobileE164 | null>;
  /**
   * Messages this session sent to `chatId`, newest first. `limit` is the page size (1..100). With `since` it pages on until the page that reaches back to that
   * moment (at most RECENT_MAX_PAGES pages), so a chatty buyer cannot push a send out of the window and make an uncertain send look "not sent"; without it, one page.
   * The filter is WAHA's `filter.fromMe=true` (the instance ignores a bare `fromMe`), and every message is checked on our side again.
   */
  recentOutgoing(session: string, chatId: string, limit?: number, since?: Date): Promise<OutgoingMessage[]>;
  /**
   * One message by id, from WAHA itself (the webhook body is only a hint), or null if unknown. `timeoutMs`: the budget of THIS call alone (default: the client's
   * whole-request timeout), for a caller working inside a lease (the read-back after a file send, US-005).
   */
  getMessage(session: string, messageId: string, options?: { readonly timeoutMs?: number }): Promise<FetchedMessage | null>;

  // --- human-like sending (US-025; WAHA docs "How to avoid blocking", "Presence", "Chats") --------------------------------------------------
  // Every call below is BEST EFFORT: the caller (apps/worker/src/delivery/human.ts) catches its failure and goes on, and each has a short budget
  // (presenceTimeoutMs). The bodies and the answers are RECORDED on the Owner's WAHA 2026.10.1 (WEBJS, US-005, docs/spikes/R11.md): the "presence" bodies are
  // {chatId, presence: "typing" | "paused"} and {presence: "offline"}, sendSeen's is {session, chatId, messageIds?}; presence and sendSeen-with-ids answer 201 with
  // NO BODY (hence `emptyOk`), startTyping and stopTyping 201 {"result": true}. sendSeen still falls back to the documented
  // POST /api/{session}/chats/{chatId}/messages/read ({}: every unread message of the chat) when WAHA answers 4xx (another engine).
  /** Marks the chat's messages as read (`messageIds`: only these, where the engine supports it). */
  sendSeen(session: string, chatId: string, messageIds?: readonly string[]): Promise<void>;
  /** The "typing..." presence in a chat: POST /api/{session}/presence {chatId, presence: "typing"}. */
  startTyping(session: string, chatId: string): Promise<void>;
  /** The typing presence ends: POST /api/{session}/presence {chatId, presence: "paused"}. */
  stopTyping(session: string, chatId: string): Promise<void>;
  /** The session shows offline again (WAHA: while it shows online the phone gets no notifications): POST /api/{session}/presence {presence: "offline"}. */
  setOffline(session: string): Promise<void>;

  // --- first contact (WAHA docs, Contacts: check-exists; LIDs) -----------------------------------------------------------------------------------
  /**
   * Is `phone` (E.164, with the plus or digits) on WhatsApp, and what is its chat id: GET /api/contacts/check-exists?phone=<digits>&session=<name> answers
   * {numberExists, chatId[, pn]}. SEND TO THE RETURNED chatId: since the LID rollout it can be `<lid>@lid`, so a first contact is never addressed as
   * `<phone>@c.us` by us. `lid` is set when the chat id is a @lid; `phone` is the `pn` WAHA gives back. RECORDED (US-005, WEBJS): the test phone came back as
   * a @lid with NO `pn`, and a number that is not on WhatsApp as {numberExists: false}. A failure (5xx, timeout) is a WahaError "failed":
   * a lookup is never a send, so it is never maybe_sent.
   */
  checkExists(session: string, phone: string): Promise<ContactCheck>;

  // --- WhatsApp's ban signals (WAHA docs, Sessions: Reachout timelock, Message capping) -------------------------------------------------------
  /**
   * GET /api/sessions/{session}/timelock; null when WAHA has no such state for this engine (a 404). VERIFIED live (US-005 audit, WAHA 2026.10.1, WEBJS and CORE):
   * an account with no timelock answers 200 {isActive: false, ...}.
   */
  reachoutTimelock(session: string): Promise<{ readonly isActive: boolean; readonly endsAt: Date | null } | null>;
  /**
   * GET /api/sessions/{session}/capping; null when unsupported (404). `status`: NONE | FIRST_WARNING | SECOND_WARNING | CAPPED (open-ended). VERIFIED live (US-005
   * audit, WAHA 2026.10.1): an account with no capping state answers 200 {cappingStatus: "NONE", totalQuota: -1, mvStatus: "NOT_ELIGIBLE", ...}.
   */
  messageCapping(session: string): Promise<{ readonly status: string; readonly cycleEnd: Date | null; readonly totalQuota: number | null; readonly usedQuota: number | null } | null>;
}

/** WAHA reports WhatsApp's refusals as an error text: "server returned error 463" / "475". */
const BAN_SIGNAL = /server returned error (463|475)\b/i;
const BAN_CODES = { "463": "reachout_timelock", "475": "message_capping" } as const;
const PRESENCE_TIMEOUT_MS = 3000;
const LOOKUP_TIMEOUT_MS = 10_000;
/** The most pages recentOutgoing reads to reach back to its `since` (100 messages each). */
export const RECENT_MAX_PAGES = 10;

export function createWahaClient(config: WahaClientConfig): WahaClient {
  if (config.target.protocol !== "https:" && config.target.protocol !== "http:") throw new RangeError("target must be an http(s) URL");
  const base = config.target.pathname.replace(/\/+$/, "");

  const url = (segments: readonly string[], query?: Record<string, string>): string => {
    const built = new URL(config.target.origin);
    built.pathname = `${base}/${segments.map((s) => encodeURIComponent(s)).join("/")}`;
    for (const [key, value] of Object.entries(query ?? {})) built.searchParams.set(key, value);
    if (built.origin !== config.target.origin) throw new WahaError("failed", "request URL left the WAHA origin");
    return built.href;
  };

  const assertSession = (session: string) => {
    if (!SESSION_NAME.test(session)) throw new NotSentError("invalid WAHA session name");
  };
  const assertChat = (chatId: string) => {
    if (!CHAT_ID.test(chatId)) throw new NotSentError("invalid WhatsApp chat id");
  };

  /**
   * `emptyOk`: a 2xx answer with an EMPTY body is a success (the answer is then undefined). Recorded on the Owner's WEBJS instance (US-005, R11): POST /api/{session}/presence
   * and sendSeen with messageIds answer 201 and no body at all. Only those calls say so; every other call keeps requiring JSON.
   */
  async function call(path: readonly string[], init: { method: "GET" | "POST"; body?: unknown; query?: Record<string, string>; notFound?: unknown; budgetMs?: number; emptyOk?: boolean }, sending: boolean): Promise<unknown> {
    let response: HttpResponse;
    try {
      response = await config.fetch(url(path, init.query), {
        method: init.method,
        headers: { "x-api-key": config.apiKey, accept: "application/json", "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(init.budgetMs === undefined ? {} : { signal: AbortSignal.timeout(init.budgetMs) }),
      });
    } catch (error) {
      if (error instanceof WahaError) throw error;
      const certain = error instanceof SafeFetchError && NOT_SENT.has(error.code);
      throw new WahaError(sending && !certain ? "maybe_sent" : "failed", "WAHA request failed", { cause: error });
    }
    if (sending && response.status >= 400) {
      // WhatsApp's own refusal of a new contact (463 / 475): WAHA says it in the error text, whatever status carries it (even a 5xx). The message
      // was NOT sent, so it is a definite failure, never maybe_sent. Only the error text is read, and only to look for the code.
      const ban = BAN_SIGNAL.exec(await errorText(response));
      if (ban?.[1] !== undefined) throw new WahaError(BAN_CODES[ban[1] as keyof typeof BAN_CODES], `WhatsApp refused the message (${ban[1]})`);
    }
    if (response.status === 401 || response.status === 403) throw new WahaError("unauthorized", "WAHA refused the API key");
    if (response.status === 404 && init.notFound !== undefined) return init.notFound;
    if (response.status >= 500) throw new WahaError(sending ? "maybe_sent" : "failed", `WAHA error ${String(response.status)}`);
    if (response.status >= 400) throw new WahaError("rejected", `WAHA rejected the request (${String(response.status)})`);
    if (init.emptyOk === true) {
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw new WahaError("bad_response", "WAHA answer could not be read", { cause: error });
      }
      if (text.trim() === "") return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw new WahaError("bad_response", "WAHA answered without JSON", { cause: error });
      }
    }
    try {
      return await response.json();
    } catch (error) {
      throw new WahaError(sending ? "maybe_sent" : "bad_response", "WAHA answered without JSON", { cause: error });
    }
  }

  /** The start of an error answer's text (at most 2 KB), or "" when it cannot be read. */
  async function errorText(response: HttpResponse): Promise<string> {
    try {
      return response.textPrefix === undefined ? (await response.text()).slice(0, 2048) : await response.textPrefix(2048);
    } catch {
      return "";
    }
  }

  const presenceBudget = config.presenceTimeoutMs ?? PRESENCE_TIMEOUT_MS;
  const unix = (value: unknown): Date | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null);

  /**
   * The id and time of a send answer, BOUND to the message we asked for (security review US-005, LOW-1): the id must be one of OUR messages (`true_`) in the chat we
   * sent to (`true_<chatId>_<key>`), whichever form WAHA answers it in; anything else is an answer we cannot tie to this send, so it is `maybe_sent` (the message may
   * well have gone out: it is never resent). The documented answer is a WAMessage whose `id` is a string; the Owner's WEBJS instance answers the raw whatsapp-web.js
   * message instead (US-005, R11, recorded for sendText and sendFile): `id` is an OBJECT {fromMe, remote, id, $1, _serialized} and `_serialized` holds the string id
   * the message list shows. `timestamp` is a number (unix seconds); `source` is absent on this shape and is not needed.
   */
  const sent = (body: unknown, chatId: string): SentMessage => {
    if (!isRecord(body)) throw new WahaError("maybe_sent", "WAHA send answer is not an object");
    const rawId = body["id"];
    const id = typeof rawId === "string" ? rawId : isRecord(rawId) ? stringField(rawId, "_serialized") : undefined;
    const timestamp = body["timestamp"];
    if (id === undefined || !isOurMessageIn(id, chatId) || typeof timestamp !== "number") throw new WahaError("maybe_sent", "WAHA send answer is not our message in this chat");
    return { id, timestamp };
  };

  return {
    async sendText(session, chatId, text) {
      assertSession(session);
      assertChat(chatId);
      // WEBJS does not validate it: a send with an empty text is SENT as an empty message (recorded, US-005 R11). Refused here, before WAHA is called.
      if (text.trim() === "") throw new NotSentError("text must not be empty");
      return sent(await call(["api", "sendText"], { method: "POST", body: { session, chatId, text } }, true), chatId);
    },
    async sendFile(session, chatId, file, caption) {
      assertSession(session);
      assertChat(chatId);
      if (!file.url.startsWith("https://")) throw new NotSentError("file.url must be https (a signFileUrl URL)");
      const body = { session, chatId, file: { url: file.url, filename: file.filename, mimetype: file.mimetype }, ...(caption === undefined ? {} : { caption }) };
      return sent(await call(["api", "sendFile"], { method: "POST", body }, true), chatId);
    },
    async sessionStatus(session) {
      assertSession(session);
      const body = await call(["api", "sessions", session], { method: "GET" }, false);
      const status = isRecord(body) ? stringField(body, "status") : undefined;
      if (status === undefined) throw new WahaError("bad_response", "WAHA session answer has no status");
      return status;
    },
    async resolveLid(session, lid) {
      assertSession(session);
      if (!/^[0-9]{5,20}@lid$/.test(lid)) throw new RangeError("invalid @lid");
      const body = await call(["api", session, "lids", lid], { method: "GET" }, false);
      if (!isRecord(body)) throw new WahaError("bad_response", "WAHA lid answer is not an object");
      const pn = body["pn"];
      if (pn === null || pn === undefined) return null;
      if (typeof pn !== "string") throw new WahaError("bad_response", "WAHA lid answer has a non-string pn");
      return phoneOfChat(pn);
    },
    async recentOutgoing(session, chatId, limit = 20, since) {
      assertSession(session);
      assertChat(chatId);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be 1..100");
      const found: OutgoingMessage[] = [];
      for (let page = 0; page < (since === undefined ? 1 : RECENT_MAX_PAGES); page++) {
        const query = { limit: String(limit), ...(page === 0 ? {} : { offset: String(page * limit) }), "filter.fromMe": "true", downloadMedia: "false" };
        const body = await call(["api", session, "chats", chatId, "messages"], { method: "GET", query }, false);
        if (!Array.isArray(body)) throw new WahaError("bad_response", "WAHA messages answer is not a list");
        let oldest = Number.POSITIVE_INFINITY;
        for (const m of body) {
          if (!isRecord(m)) continue;
          const timestamp = m["timestamp"];
          if (typeof timestamp === "number") oldest = Math.min(oldest, timestamp);
          const id = stringField(m, "id");
          // The backstop: whatever the instance did with the filter, only our own messages count.
          if (m["fromMe"] !== true || id === undefined || typeof timestamp !== "number") continue;
          const media = m["media"];
          found.push({ id, timestamp, filename: isRecord(media) ? stringField(media, "filename") : undefined });
        }
        // The page reaches back to `since`, or it was the last one: covered.
        if (since === undefined || body.length < limit || oldest * 1000 < since.getTime()) break;
      }
      return found;
    },
    async getMessage(session, messageId, options) {
      assertSession(session);
      const chatId = MESSAGE_ID.exec(messageId)?.[1];
      if (chatId === undefined) throw new RangeError("invalid WAHA message id");
      const budgetMs = options?.timeoutMs;
      const body = await call(
        ["api", session, "chats", chatId, "messages", messageId],
        { method: "GET", query: { downloadMedia: "false" }, notFound: null, ...(budgetMs === undefined ? {} : { budgetMs }) },
        false,
      );
      if (body === null) return null;
      if (!isRecord(body)) throw new WahaError("bad_response", "WAHA message answer is not an object");
      const timestamp = body["timestamp"];
      const fromMe = body["fromMe"];
      if (stringField(body, "id") !== messageId || typeof timestamp !== "number" || typeof fromMe !== "boolean") {
        throw new WahaError("bad_response", "WAHA message answer is for another message or incomplete");
      }
      const text = body["body"];
      const data = body["_data"];
      const size = isRecord(data) ? data["size"] : undefined;
      const mediaSize = typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : undefined;
      return { messageId, chat: parseChatId(chatId), fromMe, body: typeof text === "string" ? text : "", hasMedia: body["hasMedia"] === true, ...(mediaSize === undefined ? {} : { mediaSize }), timestamp };
    },

    async sendSeen(session, chatId, messageIds) {
      assertSession(session);
      assertChat(chatId);
      const ids = messageIds === undefined || messageIds.length === 0 ? undefined : messageIds.filter((id) => MESSAGE_ID.test(id));
      try {
        await call(["api", "sendSeen"], { method: "POST", body: { session, chatId, ...(ids === undefined || ids.length === 0 ? {} : { messageIds: ids }) }, budgetMs: presenceBudget, emptyOk: true }, false);
      } catch (error) {
        // An instance without POST /api/sendSeen answers 4xx: the documented "read the chat" call does the same for every unread message.
        if (!(error instanceof WahaError) || error.code !== "rejected") throw error;
        await call(["api", session, "chats", chatId, "messages", "read"], { method: "POST", body: {}, budgetMs: presenceBudget, emptyOk: true }, false);
      }
    },
    async startTyping(session, chatId) {
      assertSession(session);
      assertChat(chatId);
      await call(["api", session, "presence"], { method: "POST", body: { chatId, presence: "typing" }, budgetMs: presenceBudget, emptyOk: true }, false);
    },
    async stopTyping(session, chatId) {
      assertSession(session);
      assertChat(chatId);
      await call(["api", session, "presence"], { method: "POST", body: { chatId, presence: "paused" }, budgetMs: presenceBudget, emptyOk: true }, false);
    },
    async setOffline(session) {
      assertSession(session);
      await call(["api", session, "presence"], { method: "POST", body: { presence: "offline" }, budgetMs: presenceBudget, emptyOk: true }, false);
    },

    async checkExists(session, phone) {
      assertSession(session);
      const digits = phone.replace(/^\+/, "");
      if (!/^[0-9]{8,15}$/.test(digits)) throw new RangeError("invalid phone number");
      const body = await call(["api", "contacts", "check-exists"], { method: "GET", query: { phone: digits, session }, budgetMs: config.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS }, false);
      if (!isRecord(body) || typeof body["numberExists"] !== "boolean") throw new WahaError("bad_response", "WAHA check-exists answer has no numberExists");
      if (!body["numberExists"]) return { numberExists: false, chatId: null, lid: null, phone: null };
      const chatId = stringField(body, "chatId");
      if (chatId === undefined || !CHAT_ID.test(chatId)) throw new WahaError("bad_response", "WAHA check-exists answer has no usable chatId");
      const pn = stringField(body, "pn");
      return { numberExists: true, chatId, lid: chatId.endsWith("@lid") ? chatId : null, phone: pn === undefined ? null : phoneOfChat(pn) };
    },

    async reachoutTimelock(session) {
      assertSession(session);
      const body = await call(["api", "sessions", session, "timelock"], { method: "GET", notFound: null, budgetMs: presenceBudget }, false);
      if (body === null) return null;
      if (!isRecord(body) || typeof body["isActive"] !== "boolean") throw new WahaError("bad_response", "WAHA timelock answer has no isActive");
      return { isActive: body["isActive"], endsAt: unix(body["timeEnforcementEnds"]) };
    },
    async messageCapping(session) {
      assertSession(session);
      const body = await call(["api", "sessions", session, "capping"], { method: "GET", notFound: null, budgetMs: presenceBudget }, false);
      if (body === null) return null;
      const status = isRecord(body) ? stringField(body, "cappingStatus") : undefined;
      if (!isRecord(body) || status === undefined) throw new WahaError("bad_response", "WAHA capping answer has no cappingStatus");
      const quota = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= -1 && v <= 1_000_000 ? v : null);
      return { status, cycleEnd: unix(body["cycleEnd"]), totalQuota: quota(body["totalQuota"]), usedQuota: quota(body["usedQuota"]) };
    },
  };
}

// --- chat ids, @lid -----------------------------------------------------------------------------

export type ChatRef =
  | { readonly kind: "phone"; readonly chatId: string; readonly phone: IdMobileE164 }
  | { readonly kind: "lid"; readonly chatId: string; readonly lid: string }
  | { readonly kind: "other"; readonly chatId: string };

/** "628123456789@c.us" or "+62 812..." -> E.164 Indonesian mobile, or null. */
export function phoneOfChat(value: string): IdMobileE164 | null {
  const digits = value.replace(/@c\.us$/, "");
  const result = normalizeIdMobile(digits.startsWith("+") ? digits : `+${digits}`);
  return result.ok ? result.e164 : null;
}

/** A person's chat: a phone number of ANY country (`<digits>@c.us`) or an `@lid`. Never a group, a status, a broadcast or a channel (parseChatId calls the foreign numbers "other" too). */
export function isPersonalChatId(chatId: string): boolean {
  return CHAT_ID.test(chatId);
}

/** Classifies a WhatsApp chat id. Groups, broadcasts and non-Indonesian numbers are "other". */
export function parseChatId(chatId: string): ChatRef {
  if (/^[0-9]{5,20}@lid$/.test(chatId)) return { kind: "lid", chatId, lid: chatId };
  if (/^[0-9]{5,20}@c\.us$/.test(chatId)) {
    const phone = phoneOfChat(chatId);
    if (phone !== null) return { kind: "phone", chatId, phone };
  }
  return { kind: "other", chatId };
}

// --- webhooks -------------------------------------------------------------------------------------

/**
 * Verifies X-Webhook-Hmac (hex HMAC-SHA512 of the exact raw body) in constant time. The algorithm
 * header (X-Webhook-Hmac-Algorithm), when present, must say sha512. Verify BEFORE parsing the body.
 * As the WAHA docs describe it; VERIFY WITH A REAL DELIVERY ON STAGING (US-005 has not seen a signed webhook of the Owner's instance yet).
 */
export function verifyWebhookHmac(rawBody: string | Uint8Array, headers: { hmac: string | undefined; algorithm?: string | undefined }, secret: string): boolean {
  if (headers.hmac === undefined || secret === "") return false;
  if (headers.algorithm !== undefined && headers.algorithm.toLowerCase() !== "sha512") return false;
  const expected = Buffer.from(createHmac("sha512", secret).update(rawBody).digest("hex"), "ascii");
  const given = Buffer.from(headers.hmac.toLowerCase(), "ascii");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type DeliveryAck = "queued" | "sent" | "delivered" | "read" | "failed";

/** WAHA ack numbers to delivery states (AC-D6): -1 ERROR, 0 PENDING, 1 SERVER, 2 DEVICE, 3 READ, 4 PLAYED. */
export function mapAck(ack: number): DeliveryAck | undefined {
  switch (ack) {
    case -1:
      return "failed";
    case 0:
      return "queued";
    case 1:
      return "sent";
    case 2:
      return "delivered";
    case 3:
    case 4:
      return "read";
    default:
      return undefined;
  }
}

export interface InboundMessage {
  readonly kind: "message";
  readonly session: string;
  /** The webhook's own timestamp (ms since epoch), for the caller's replay window. */
  readonly eventTimestampMs: number | undefined;
  readonly messageId: string;
  readonly chat: ChatRef;
  readonly body: string;
  readonly hasMedia: boolean;
  readonly timestamp: number;
}

export interface AckEvent {
  readonly kind: "ack";
  readonly session: string;
  readonly eventTimestampMs: number | undefined;
  readonly messageId: string;
  readonly status: DeliveryAck;
}

export interface SessionStatusEvent {
  readonly kind: "session.status";
  readonly session: string;
  readonly eventTimestampMs: number | undefined;
  readonly status: string;
  /**
   * WhatsApp's limits on the number, when the event carries them (WAHA docs: payload.data.reachoutTimelock {isActive, timeEnforcementEnds} and
   * payload.data.messageCapping {cappingStatus, totalQuota, usedQuota, cycleStart, cycleEnd}); the raw objects, which record_waha_session_state checks.
   * The shapes are the documented ones, which GET /api/sessions/{session}/timelock and /capping and `me` of the session answer too (RECORDED, US-005); a real
   * session.status webhook delivery was not recorded (no public URL): verify it on staging (US-014 / US-032).
   */
  readonly reachoutTimelock: Record<string, unknown> | undefined;
  readonly messageCapping: Record<string, unknown> | undefined;
}

/**
 * Parses a verified webhook body. Returns undefined for events we do not handle and for our own
 * outgoing messages. Inbound rows are only a hint: the worker re-fetches the message from WAHA by
 * id before acting (plan M2.2 enqueue_waha_inbound).
 */
export function parseWebhookEvent(body: unknown): InboundMessage | AckEvent | SessionStatusEvent | undefined {
  if (!isRecord(body)) return undefined;
  const event = stringField(body, "event");
  const session = stringField(body, "session");
  const payload = body["payload"];
  if (event === undefined || session === undefined || !isRecord(payload)) return undefined;
  const eventTimestampMs = typeof body["timestamp"] === "number" && Number.isFinite(body["timestamp"]) ? body["timestamp"] : undefined;
  if (event === "message") {
    const messageId = stringField(payload, "id");
    const from = stringField(payload, "from");
    const timestamp = payload["timestamp"];
    if (payload["fromMe"] !== false || messageId === undefined || from === undefined || typeof timestamp !== "number") return undefined;
    const text = payload["body"];
    return { kind: "message", session, eventTimestampMs, messageId, chat: parseChatId(from), body: typeof text === "string" ? text : "", hasMedia: payload["hasMedia"] === true, timestamp };
  }
  if (event === "message.ack") {
    const messageId = stringField(payload, "id");
    const ack = payload["ack"];
    const status = typeof ack === "number" ? mapAck(ack) : undefined;
    if (messageId === undefined || status === undefined) return undefined;
    return { kind: "ack", session, eventTimestampMs, messageId, status };
  }
  if (event === "session.status") {
    const status = stringField(payload, "status");
    if (status === undefined) return undefined;
    const data = payload["data"];
    const timelock = isRecord(data) ? data["reachoutTimelock"] : undefined;
    const capping = isRecord(data) ? data["messageCapping"] : undefined;
    return { kind: "session.status", session, eventTimestampMs, status, reachoutTimelock: isRecord(timelock) ? timelock : undefined, messageCapping: isRecord(capping) ? capping : undefined };
  }
  return undefined;
}
