// POST /api/v1/webhooks/midtrans (US-021; plan M6.3; AC-S6, AC-S7): the Midtrans notification inbox.
// Server to server on api.<DOMAIN>: no CORS (no Origin is checked or reflected), no cookies. Order:
//
//   1. the JSON body, at most 16 KiB, with every signed field
//      (adapters parseNotification, the one place notification shapes are read)  400
//   2. a signature_key of 128 hex digits, before any Valkey or database work   401
//   3. the Valkey rate limits per IPv6 /48, then per client IP (an IPv6 /64),
//      FAIL CLOSED                                                               429, Valkey down 503
//   4. the deployment's Midtrans server key (sealed payment secret), cached for
//      a minute (checkout/data.ts createMidtransKeyCache): a forged notification
//      costs no database read                                                    missing 503
//   5. the signature, in constant time: sha512(order_id + status_code +
//      gross_amount + server key), gross_amount as the signed string           401, logged without PII
//   6. an order id the worker can re-query; any other id is signed by Midtrans
//      but not one of ours (e.g. a dashboard test): acknowledged and dropped     200
//   7. ONE transaction: INSERT ... ON CONFLICT DO NOTHING into
//      payment_notifications, then enqueue_notification(id) (SECURITY DEFINER,
//      one outbox row per inbox row); the signature is stored lowercased          200 new or duplicate
//      any database error or other unexpected failure                             503 (Midtrans retries)
//
// Why 503 and not 500 (Midtrans docs, read 2026-11-21): a 2xx is final; a 500 is retried ONCE (about 2 minutes
// later), a 503 four times (about 2, 10, 30 and 90 minutes later), 400 / 404 twice, any other failure five
// times. A database outage longer than two minutes would lose a 500's notification (the nightly reconciliation
// still finds the payment, a day late), so every failure we want retried answers 503.
//
// The body is UNTRUSTED. Only the signed fields, the status label (normalised: the signature does not
// cover it) and a whitelisted summary are stored; the worker takes status, amount and currency from its
// own re-query, so a replayed or edited body can only cause a re-query. The route reads no order.
import { randomUUID } from "node:crypto";
import { isMidtransOrderId, isSignatureShape, parseNotification, verifySignature } from "@ebooktrivia/adapters";
import type { SecretOpener } from "@ebooktrivia/crypto";
import { clientIp, throttleBucket, throttleBucket48 } from "@ebooktrivia/edge";
import { isServerKeyUnavailable, isSettingsUnavailable, type MidtransKeyCache } from "../checkout/data.ts";
import type { Sql } from "../db.ts";
import { json, readJsonBody } from "../http.ts";
import type { Logger } from "../log.ts";
import { hitRateLimits, isValkeyUnavailable, type RateLimit, type Valkey } from "../valkey.ts";

/** Notifications per client IP per window. Midtrans sends from a few addresses; bursts follow settlement batches. */
export const WEBHOOK_IP_CAP = 600;
/** The same per IPv6 /48 (IPv4 has no /48 bucket), counted first, as on the Cap routes. */
export const WEBHOOK_IP48_CAP = 3000;
export const WEBHOOK_IP_WINDOW_MS = 60_000;

export interface MidtransWebhookDeps {
  readonly sql: Sql;
  readonly valkey: Valkey;
  readonly opener: SecretOpener;
  /** The server key, cached per process (checkout/data.ts createMidtransKeyCache). */
  readonly serverKey: MidtransKeyCache;
  readonly log: Logger;
}

type Answer = "ok" | "ignored" | "invalid" | "signature" | "rate_limited" | "unavailable";

const STATUS: Readonly<Record<Answer, number>> = { ok: 200, ignored: 200, invalid: 400, signature: 401, rate_limited: 429, unavailable: 503 };

const answer = (kind: Answer, extra: Record<string, string> = {}): Response =>
  json(STATUS[kind], kind === "ok" || kind === "ignored" ? { v: 1, ok: true } : { v: 1, error: kind }, null, extra);

export async function handleMidtransNotification(deps: MidtransWebhookDeps, request: Request): Promise<Response> {
  const requestId = randomUUID();
  const log: Logger = (level, event, fields, error) => {
    deps.log(level, event, { requestId, route: "webhook_midtrans", ...fields }, error);
  };
  try {
    const body = await readJsonBody(request);
    const notification = body.ok ? parseNotification(body.value) : undefined;
    if (notification === undefined) {
      log("warn", "webhook.midtrans.refused", { reason: "invalid_body" });
      return answer("invalid");
    }
    if (!isSignatureShape(notification.signed.signature_key)) {
      log("warn", "webhook.midtrans.refused", { reason: "bad_signature" });
      return answer("signature");
    }

    const ip = clientIp(request.headers);
    const network = throttleBucket48(ip);
    const limits: RateLimit[] = [
      ...(network === null ? [] : [{ key: `webhook:midtrans:ip48:${network}`, limit: WEBHOOK_IP48_CAP, windowMs: WEBHOOK_IP_WINDOW_MS }]),
      { key: `webhook:midtrans:ip:${throttleBucket(ip)}`, limit: WEBHOOK_IP_CAP, windowMs: WEBHOOK_IP_WINDOW_MS },
    ];
    const limited = await hitRateLimits(deps.valkey, limits);
    if (!limited.allowed) {
      log("warn", "webhook.midtrans.refused", { reason: limits[limited.index]?.key.includes(":ip48:") === true ? "rate_limited_ip48" : "rate_limited_ip" });
      return answer("rate_limited", { "retry-after": String(limited.retryAfterSeconds) });
    }

    const serverKey = await deps.serverKey(deps.sql, deps.opener);
    if (!verifySignature(notification.signed, serverKey)) {
      log("warn", "webhook.midtrans.refused", { reason: "bad_signature" });
      return answer("signature");
    }
    const { signed } = notification;
    if (!isMidtransOrderId(signed.order_id)) {
      log("warn", "webhook.midtrans.ignored", { reason: "foreign_order_id" });
      return answer("ignored");
    }

    const outcome = await deps.sql.begin(async (tx) => {
      const key = [signed.order_id, notification.transactionStatus, signed.status_code, signed.signature_key.toLowerCase()] as const;
      const [inserted] = await tx<{ id: string }[]>`
        INSERT INTO public.payment_notifications (midtrans_order_id, transaction_status, status_code, signature, raw)
        VALUES (${key[0]}, ${key[1]}, ${key[2]}, ${key[3]}, ${JSON.stringify(notification.summary)}::text::jsonb)
        ON CONFLICT ON CONSTRAINT payment_notifications_dedupe_key DO NOTHING
        RETURNING id`;
      const id =
        inserted?.id ??
        (
          await tx<{ id: string }[]>`
            SELECT id FROM public.payment_notifications
             WHERE midtrans_order_id = ${key[0]} AND transaction_status = ${key[1]} AND status_code = ${key[2]} AND signature = ${key[3]}`
        )[0]?.id;
      if (id === undefined) throw new Error("the notification row vanished");
      await tx`SELECT public.enqueue_notification(${id}::uuid)`;
      return inserted === undefined ? "duplicate" : "new";
    });
    log("info", "webhook.midtrans.stored", { outcome, status: notification.transactionStatus });
    return answer("ok");
  } catch (error) {
    if (isValkeyUnavailable(error) || isSettingsUnavailable(error) || isServerKeyUnavailable(error)) {
      log("error", "webhook.midtrans.failed", { reason: isValkeyUnavailable(error) ? "valkey_unavailable" : "midtrans_key_unavailable" }, error);
      return answer("unavailable");
    }
    // A real database error (or anything unexpected): 503, so Midtrans delivers the notification again, four times (a 500 only once).
    log("error", "webhook.midtrans.failed", { reason: "internal" }, error);
    return answer("unavailable");
  }
}
