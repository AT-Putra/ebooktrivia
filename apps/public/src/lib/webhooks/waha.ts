// POST /api/v1/webhooks/waha (US-025; plan M8.3; spec AC-D6, AC-D8): the WAHA webhook, server to server on api.<DOMAIN>
// (no CORS, no cookies). The webhook is UNTRUSTED input: a stranger who can reach this URL, or a leaked secret, must not be able to
// drive a send. Order:
//
//   1. the raw body, at most 64 KiB                                                              413
//   2. WAHA_WEBHOOK_HMAC_SECRET configured (a plain env secret of public.env: public holds no
//      messaging key), else the route is closed                                                  503
//   3. X-Webhook-Hmac (hex HMAC-SHA512 of the EXACT raw body, constant time) BEFORE anything is
//      parsed; a missing or wrong one, or another algorithm                                      401, nothing logged but the reason
//   4. the JSON body, then adapters parseWebhookEvent; an event we do not handle (our own
//      messages, a session status without limits, other shapes) is acknowledged and dropped     200
//   5. the replay window of the event's own timestamp (60 minutes back, 5 forward); older or
//      undated events are dropped (the message_id dedupe below is the other half)                200
//   6. kind `message`: only a person's chat (@c.us or @lid); then a Valkey rate limit per sender and one
//      global, FAIL CLOSED (Valkey down: 503, WAHA retries), over the limit: dropped 200, BEFORE any database
//      query (a flood of chatter from one sender costs Valkey, never PostgreSQL); then only a message whose
//      text holds something shaped like an order code is kept (a stranger chatting with a pool number
//      costs nothing)
//        then ONE transaction: INSERT ... ON CONFLICT (message_id) DO NOTHING into waha_inbound
//        (a duplicate is acknowledged and handled once) and enqueue_waha_inbound(id) (SECURITY DEFINER,
//        one outbox row per message). The row stores the sender's chat id and a whitelisted summary
//        and NOT the text: the worker re-fetches the message from WAHA by id and acts on that only. 200
//        A message with NO order code is kept too when it answers our WhatsApp opener (the opener only asks
//        the buyer to reply, Owner decision D7): waha_reply_expected(session, chat), a SECURITY DEFINER boolean.
//      kind `ack` (AC-D6): record_waha_ack(message id, ack) moves deliveries.wa_ack forward only      200
//      kind `session.status` WITH WhatsApp's limits on the number (data.reachoutTimelock, data.messageCapping:
//        the likely cause of first messages that silently do not arrive): a global rate limit, then
//        record_waha_session_state(session, timelock, capping), which checks every value and only ever
//        extends a block; the worker's poll raises the alert on the state it finds               200
//      any database error                                                                             500 (WAHA retries)
// No phone, message text, signature or secret is logged: ids, kinds and outcome codes only.
import { createHash, randomUUID } from "node:crypto";
import { parseWebhookEvent, verifyWebhookHmac } from "@ebooktrivia/adapters";
import { extractOrderCodes } from "@ebooktrivia/core";
import type { Sql } from "../db.ts";
import { json, readRawBody } from "../http.ts";
import type { Logger } from "../log.ts";
import { hitRateLimits, type RateLimit, type Valkey, ValkeyUnavailable } from "../valkey.ts";

export const WAHA_BODY_MAX_BYTES = 64 * 1024;
/** Messages kept per sender (a chat id) per window: a buyer asks once or twice; more is noise or abuse. */
export const WAHA_SENDER_CAP = 10;
export const WAHA_SENDER_WINDOW_MS = 10 * 60_000;
/** Events (messages and acks) per window across all senders. */
export const WAHA_GLOBAL_CAP = 6000;
export const WAHA_GLOBAL_WINDOW_MS = 60_000;
export const WAHA_REPLAY_PAST_MS = 60 * 60_000;
export const WAHA_REPLAY_FUTURE_MS = 5 * 60_000;

export interface WahaWebhookDeps {
  readonly sql: Sql;
  readonly valkey: Valkey;
  /** WAHA_WEBHOOK_HMAC_SECRET; undefined closes the route. */
  readonly hmacSecret: string | undefined;
  readonly log: Logger;
  /** Default Date.now; injectable for the replay window. */
  readonly now?: () => number;
}

type Answer = "ok" | "ignored" | "invalid" | "too_large" | "signature" | "unavailable" | "internal";
const STATUS: Readonly<Record<Answer, number>> = { ok: 200, ignored: 200, invalid: 400, too_large: 413, signature: 401, unavailable: 503, internal: 500 };
const answer = (kind: Answer): Response => json(STATUS[kind], kind === "ok" || kind === "ignored" ? { v: 1, ok: true } : { v: 1, error: kind }, null);

const digest = (value: string): string => createHash("sha256").update(`ebooktrivia/waha-sender/v1|${value}`).digest("hex").slice(0, 32);

export async function handleWahaWebhook(deps: WahaWebhookDeps, request: Request): Promise<Response> {
  const requestId = randomUUID();
  const log: Logger = (level, event, fields, error) => {
    deps.log(level, event, { requestId, route: "webhook_waha", ...fields }, error);
  };
  const now = (deps.now ?? Date.now)();
  try {
    const raw = await readRawBody(request, WAHA_BODY_MAX_BYTES);
    if (raw === undefined) {
      log("warn", "webhook.waha.refused", { reason: "body_missing_or_too_large" });
      return answer("too_large");
    }
    if (deps.hmacSecret === undefined) {
      log("error", "webhook.waha.refused", { reason: "secret_not_configured" });
      return answer("unavailable");
    }
    const verified = verifyWebhookHmac(raw, { hmac: request.headers.get("x-webhook-hmac") ?? undefined, algorithm: request.headers.get("x-webhook-hmac-algorithm") ?? undefined }, deps.hmacSecret);
    if (!verified) {
      log("warn", "webhook.waha.refused", { reason: "bad_hmac" });
      return answer("signature");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      log("warn", "webhook.waha.refused", { reason: "invalid_body" });
      return answer("invalid");
    }
    const event = parseWebhookEvent(parsed);
    // A session.status event is only of interest when it carries WhatsApp's limits on the number (WAHA docs: data.reachoutTimelock, data.messageCapping).
    if (event === undefined || (event.kind === "session.status" && event.reachoutTimelock === undefined && event.messageCapping === undefined)) {
      log("info", "webhook.waha.ignored", { reason: "not_handled" });
      return answer("ignored");
    }
    if (event.eventTimestampMs === undefined || event.eventTimestampMs < now - WAHA_REPLAY_PAST_MS || event.eventTimestampMs > now + WAHA_REPLAY_FUTURE_MS) {
      log("warn", "webhook.waha.ignored", { reason: "outside_replay_window", kind: event.kind });
      return answer("ignored");
    }

    if (event.kind === "session.status") {
      const limited = await hitRateLimits(deps.valkey, [{ key: "webhook:waha:all", limit: WAHA_GLOBAL_CAP, windowMs: WAHA_GLOBAL_WINDOW_MS }]);
      if (!limited.allowed) {
        log("warn", "webhook.waha.ignored", { reason: "rate_limited_global", kind: "session.status" });
        return answer("ignored");
      }
      // The function checks every value and only ever extends a block (sql/functions.sql); the worker's poll raises the alert on the state it finds.
      const json = (value: Record<string, unknown> | undefined): string | null => (value === undefined ? null : JSON.stringify(value));
      const [row] = await deps.sql<{ recorded: boolean }[]>`
        SELECT public.record_waha_session_state(${event.session}, ${json(event.reachoutTimelock)}::text::jsonb, ${json(event.messageCapping)}::text::jsonb) AS recorded`;
      log("info", "webhook.waha.session_state", { outcome: row?.recorded === true ? "recorded" : "unchanged" });
      return answer("ok");
    }

    if (event.kind === "ack") {
      const limited = await hitRateLimits(deps.valkey, [{ key: "webhook:waha:all", limit: WAHA_GLOBAL_CAP, windowMs: WAHA_GLOBAL_WINDOW_MS }]);
      if (!limited.allowed) {
        log("warn", "webhook.waha.ignored", { reason: "rate_limited_global", kind: "ack" });
        return answer("ignored");
      }
      const [row] = await deps.sql<{ changed: boolean }[]>`SELECT public.record_waha_ack(${event.messageId}, ${event.status}) AS changed`;
      log("info", "webhook.waha.ack", { outcome: row?.changed === true ? "recorded" : "unchanged", status: event.status });
      return answer("ok");
    }

    // A message: only a person's chat, and only one that mentions something shaped like an order code (the worker decides on the
    // re-fetched text; this only keeps chatter out of the database).
    if (event.chat.kind === "other") {
      log("info", "webhook.waha.ignored", { reason: "not_a_person" });
      return answer("ignored");
    }
    // The rate limits come FIRST: no database query (not even waha_reply_expected) is made for a sender over its limit.
    const limits: RateLimit[] = [
      { key: `webhook:waha:from:${digest(event.chat.chatId)}`, limit: WAHA_SENDER_CAP, windowMs: WAHA_SENDER_WINDOW_MS },
      { key: "webhook:waha:all", limit: WAHA_GLOBAL_CAP, windowMs: WAHA_GLOBAL_WINDOW_MS },
    ];
    const limited = await hitRateLimits(deps.valkey, limits);
    if (!limited.allowed) {
      log("warn", "webhook.waha.ignored", { reason: limited.index === 0 ? "rate_limited_sender" : "rate_limited_global", kind: "message" });
      return answer("ignored");
    }
    if (extractOrderCodes(event.body).length === 0) {
      // A reply to our WhatsApp opener carries no code (Owner decision D7: it only asks the buyer to reply): it is kept when this chat owes us one.
      const [expected] = await deps.sql<{ expected: boolean }[]>`SELECT public.waha_reply_expected(${event.session}, ${event.chat.chatId}) AS expected`;
      if (expected?.expected !== true) {
        log("info", "webhook.waha.ignored", { reason: "no_order_code" });
        return answer("ignored");
      }
    }

    const summary = { v: 1, timestamp: event.timestamp, hasMedia: event.hasMedia };
    const outcome = await deps.sql.begin(async (tx) => {
      const [inserted] = await tx<{ id: string }[]>`
        INSERT INTO public.waha_inbound (message_id, session_name, from_jid, raw)
        VALUES (${event.messageId}, ${event.session}, ${event.chat.chatId}, ${JSON.stringify(summary)}::text::jsonb)
        ON CONFLICT ON CONSTRAINT waha_inbound_message_id_key DO NOTHING
        RETURNING id`;
      const id = inserted?.id ?? (await tx<{ id: string }[]>`SELECT id FROM public.waha_inbound WHERE message_id = ${event.messageId}`)[0]?.id;
      if (id === undefined) throw new Error("the inbound row vanished");
      await tx`SELECT public.enqueue_waha_inbound(${id}::uuid)`;
      return inserted === undefined ? "duplicate" : "new";
    });
    log("info", "webhook.waha.stored", { outcome, kind: "message" });
    return answer("ok");
  } catch (error) {
    if (error instanceof ValkeyUnavailable) {
      log("error", "webhook.waha.failed", { reason: "valkey_unavailable" }, error);
      return answer("unavailable");
    }
    // A real database error (or anything unexpected): 500, so WAHA delivers the webhook again.
    log("error", "webhook.waha.failed", { reason: "internal" }, error);
    return answer("internal");
  }
}
