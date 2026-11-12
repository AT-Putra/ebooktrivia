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

export type WahaErrorCode = "unauthorized" | "rejected" | "failed" | "maybe_sent" | "bad_response";

export class WahaError extends Error {
  readonly code: WahaErrorCode;
  constructor(code: WahaErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "WahaError";
    this.code = code;
  }
}

export interface WahaClientConfig {
  /** From assertWahaTarget(): https, host bound to the API key. */
  readonly target: URL;
  readonly apiKey: string;
  readonly fetch: HttpFetch;
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

export interface FetchedMessage {
  readonly messageId: string;
  readonly chat: ChatRef;
  readonly fromMe: boolean;
  readonly body: string;
  readonly hasMedia: boolean;
  /** Unix seconds. */
  readonly timestamp: number;
}

export interface WahaClient {
  sendText(session: string, chatId: string, text: string): Promise<SentMessage>;
  sendFile(session: string, chatId: string, file: FileToSend, caption?: string): Promise<SentMessage>;
  sessionStatus(session: string): Promise<string>;
  /** The phone (E.164) behind a @lid chat, or null when WAHA cannot resolve it. */
  resolveLid(session: string, lid: string): Promise<IdMobileE164 | null>;
  /** Most recent messages this session sent to `chatId`, newest first. */
  recentOutgoing(session: string, chatId: string, limit?: number): Promise<OutgoingMessage[]>;
  /** One message by id, from WAHA itself (the webhook body is only a hint), or null if unknown. */
  getMessage(session: string, messageId: string): Promise<FetchedMessage | null>;
}

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
    if (!SESSION_NAME.test(session)) throw new RangeError("invalid WAHA session name");
  };
  const assertChat = (chatId: string) => {
    if (!CHAT_ID.test(chatId)) throw new RangeError("invalid WhatsApp chat id");
  };

  async function call(path: readonly string[], init: { method: string; body?: unknown; query?: Record<string, string>; notFound?: unknown }, sending: boolean): Promise<unknown> {
    let response: HttpResponse;
    try {
      response = await config.fetch(url(path, init.query), {
        method: init.method,
        headers: { "x-api-key": config.apiKey, accept: "application/json", "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      if (error instanceof WahaError) throw error;
      const certain = error instanceof SafeFetchError && NOT_SENT.has(error.code);
      throw new WahaError(sending && !certain ? "maybe_sent" : "failed", "WAHA request failed", { cause: error });
    }
    if (response.status === 401 || response.status === 403) throw new WahaError("unauthorized", "WAHA refused the API key");
    if (response.status === 404 && init.notFound !== undefined) return init.notFound;
    if (response.status >= 500) throw new WahaError(sending ? "maybe_sent" : "failed", `WAHA error ${String(response.status)}`);
    if (response.status >= 400) throw new WahaError("rejected", `WAHA rejected the request (${String(response.status)})`);
    try {
      return await response.json();
    } catch (error) {
      throw new WahaError(sending ? "maybe_sent" : "bad_response", "WAHA answered without JSON", { cause: error });
    }
  }

  const sent = (body: unknown): SentMessage => {
    if (!isRecord(body)) throw new WahaError("maybe_sent", "WAHA send answer is not an object");
    const id = stringField(body, "id");
    const timestamp = body["timestamp"];
    if (id === undefined || typeof timestamp !== "number") throw new WahaError("maybe_sent", "WAHA send answer has no id/timestamp");
    return { id, timestamp };
  };

  return {
    async sendText(session, chatId, text) {
      assertSession(session);
      assertChat(chatId);
      return sent(await call(["api", "sendText"], { method: "POST", body: { session, chatId, text } }, true));
    },
    async sendFile(session, chatId, file, caption) {
      assertSession(session);
      assertChat(chatId);
      if (!file.url.startsWith("https://")) throw new RangeError("file.url must be https (a signFileUrl URL)");
      const body = { session, chatId, file: { url: file.url, filename: file.filename, mimetype: file.mimetype }, ...(caption === undefined ? {} : { caption }) };
      return sent(await call(["api", "sendFile"], { method: "POST", body }, true));
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
    async recentOutgoing(session, chatId, limit = 20) {
      assertSession(session);
      assertChat(chatId);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be 1..100");
      const query = { limit: String(limit), fromMe: "true", downloadMedia: "false" };
      const body = await call(["api", session, "chats", chatId, "messages"], { method: "GET", query }, false);
      if (!Array.isArray(body)) throw new WahaError("bad_response", "WAHA messages answer is not a list");
      return body.flatMap((m: unknown): OutgoingMessage[] => {
        if (!isRecord(m) || m["fromMe"] !== true) return [];
        const id = stringField(m, "id");
        const timestamp = m["timestamp"];
        if (id === undefined || typeof timestamp !== "number") return [];
        const media = m["media"];
        return [{ id, timestamp, filename: isRecord(media) ? stringField(media, "filename") : undefined }];
      });
    },
    async getMessage(session, messageId) {
      assertSession(session);
      const chatId = MESSAGE_ID.exec(messageId)?.[1];
      if (chatId === undefined) throw new RangeError("invalid WAHA message id");
      const body = await call(["api", session, "chats", chatId, "messages", messageId], { method: "GET", query: { downloadMedia: "false" }, notFound: null }, false);
      if (body === null) return null;
      if (!isRecord(body)) throw new WahaError("bad_response", "WAHA message answer is not an object");
      const timestamp = body["timestamp"];
      const fromMe = body["fromMe"];
      if (stringField(body, "id") !== messageId || typeof timestamp !== "number" || typeof fromMe !== "boolean") {
        throw new WahaError("bad_response", "WAHA message answer is for another message or incomplete");
      }
      const text = body["body"];
      return { messageId, chat: parseChatId(chatId), fromMe, body: typeof text === "string" ? text : "", hasMedia: body["hasMedia"] === true, timestamp };
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
 * header, when present, must say sha512. Verify BEFORE parsing the body.
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
    return status === undefined ? undefined : { kind: "session.status", session, eventTimestampMs, status };
  }
  return undefined;
}
