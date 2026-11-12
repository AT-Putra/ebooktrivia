// Conversion requests (plan M3.4 / M7; AC-T2-T8): S2S postbacks, Meta Conversions API and TikTok
// Events API. These functions only BUILD requests and CLASSIFY results; the worker (M7) claims a
// conversion_events row (core conversion-machine), sends with safe-fetch, and records the outcome.
//
//   - S2S URLs come from core renderPostbackUrl: {secret:name} resolves only for the adnet + host
//     the secret is bound to, and the redacted twin is what gets logged (AC-T7).
//   - Meta CAPI and TikTok share the browser pixel's event_id for dedupe (AC-T6), carry IDR values
//     and SHA-256 hashes of the normalised email / phone, never the plain values.
//   - Access tokens travel in the body (Meta) or a header (TikTok), never in the URL, and are
//     redacted from the log form.
//   - Refunds: neither Meta nor TikTok has a standard refund event, so buildMetaCapiRequest /
//     buildTikTokEventRequest return null for kind "refund" (AC-T8 "where supported"); the S2S
//     reversal template covers adnets.
//   - API versions are configuration (verify the current Graph API version and TikTok endpoint
//     when M7 goes live against the real platforms).

import { createHash } from "node:crypto";
import {
  type ConversionOutcome,
  conversionOutcomeFromHttp,
  type IdMobileE164,
  type PostbackBinding,
  type PostbackValues,
  renderPostbackUrl,
  renderPostbackUrlRedacted,
  type SecretResolver,
} from "@ebooktrivia/core";
import type { HttpFetch } from "./http.ts";
import { SafeFetchError } from "./safe-fetch.ts";

export interface PreparedRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  /** May carry access tokens (TikTok Access-Token): NEVER log the headers; log `redacted` only. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Log form (AC-T7): secrets, hashed PII and client identifiers (IP, UA, click ids, page URL) replaced. */
  readonly redacted: { readonly url: string; readonly body?: string };
}

const REDACTED = "[redacted]";
/** Replaces the present (non-undefined) values of `keys` with "[redacted]". */
const redact = <T extends Record<string, unknown>>(record: T, keys: readonly (keyof T & string)[]): T =>
  Object.fromEntries(Object.entries(record).map(([k, v]) => [k, (keys as readonly string[]).includes(k) && v !== undefined ? REDACTED : v])) as T;

/** S2S postback (MO, MT or reversal) for one adnet. */
export function buildS2sRequest(input: {
  readonly template: string;
  readonly values: PostbackValues;
  readonly binding: PostbackBinding;
  readonly resolve: SecretResolver;
}): PreparedRequest {
  const url = renderPostbackUrl(input.template, input.values, input.binding, input.resolve);
  return { method: "GET", url, headers: { accept: "*/*" }, redacted: { url: renderPostbackUrlRedacted(input.template, input.values, input.binding) } };
}

export interface ConversionEvent {
  readonly kind: "mo" | "mt" | "refund";
  /** Shared with the browser pixel (orders.event_id) for dedupe. */
  readonly eventId: string;
  readonly eventTime: Date;
  /** orders.public_id */
  readonly orderId: string;
  /** Integer IDR. */
  readonly valueIdr: number;
  readonly email?: string;
  readonly phone?: IdMobileE164;
  readonly clientIp?: string;
  readonly userAgent?: string;
  readonly pageUrl?: string;
  readonly fbp?: string;
  readonly fbc?: string;
  readonly ttclid?: string;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Meta and TikTok both expect the email trimmed and lowercased before hashing. */
export const hashEmail = (email: string): string => sha256(email.trim().toLowerCase());
/** Meta: digits only, with country code, no "+". */
export const hashPhoneForMeta = (phone: IdMobileE164): string => sha256(phone.replace(/^\+/, ""));
/** TikTok: E.164 with "+". */
export const hashPhoneForTikTok = (phone: IdMobileE164): string => sha256(phone);

function assertEvent(event: ConversionEvent): void {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(event.eventId)) throw new RangeError("eventId must be 8-64 URL-safe characters");
  if (!Number.isSafeInteger(event.valueIdr) || event.valueIdr < 0) throw new RangeError("valueIdr must be a non-negative integer");
  if (Number.isNaN(event.eventTime.getTime())) throw new RangeError("eventTime must be a valid Date");
}

const unixSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);
const defined = <T extends Record<string, unknown>>(record: T): Partial<T> =>
  Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as Partial<T>;

export const META_EVENT_NAMES = { mo: "InitiateCheckout", mt: "Purchase" } as const;
export const TIKTOK_EVENT_NAMES = { mo: "InitiateCheckout", mt: "CompletePayment" } as const;

/** POST https://graph.facebook.com/{apiVersion}/{pixelId}/events, or null for a refund. */
export function buildMetaCapiRequest(input: {
  readonly apiVersion: string;
  readonly pixelId: string;
  readonly accessToken: string;
  readonly event: ConversionEvent;
  readonly testEventCode?: string;
}): PreparedRequest | null {
  const { event } = input;
  if (event.kind === "refund") return null;
  assertEvent(event);
  if (!/^v\d{1,3}\.\d$/.test(input.apiVersion)) throw new RangeError("apiVersion must look like v24.0");
  if (!/^\d{5,20}$/.test(input.pixelId)) throw new RangeError("pixelId must be numeric");
  const userData = defined({
    em: event.email === undefined ? undefined : [hashEmail(event.email)],
    ph: event.phone === undefined ? undefined : [hashPhoneForMeta(event.phone)],
    client_ip_address: event.clientIp,
    client_user_agent: event.userAgent,
    fbp: event.fbp,
    fbc: event.fbc,
  });
  const data = [
    defined({
      event_name: META_EVENT_NAMES[event.kind],
      event_time: unixSeconds(event.eventTime),
      event_id: event.eventId,
      action_source: "website",
      event_source_url: event.pageUrl,
      user_data: userData,
      custom_data: { currency: "IDR", value: event.valueIdr, order_id: event.orderId },
    }),
  ];
  const body = defined({ data, access_token: input.accessToken, test_event_code: input.testEventCode });
  const redactedUser = redact(
    defined({ ...userData, em: userData.em === undefined ? undefined : ["[sha256]"], ph: userData.ph === undefined ? undefined : ["[sha256]"] }),
    ["client_ip_address", "client_user_agent", "fbp", "fbc"],
  );
  const redactedEvent = redact({ ...data[0], user_data: redactedUser }, ["event_source_url"]);
  const url = `https://graph.facebook.com/${input.apiVersion}/${input.pixelId}/events`;
  return {
    method: "POST",
    url,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    redacted: { url, body: JSON.stringify({ ...body, access_token: "[secret]", data: [redactedEvent] }) },
  };
}

export const TIKTOK_EVENTS_URL = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

/** POST {TIKTOK_EVENTS_URL} with the Access-Token header, or null for a refund. */
export function buildTikTokEventRequest(input: {
  readonly pixelCode: string;
  readonly accessToken: string;
  readonly event: ConversionEvent;
  readonly testEventCode?: string;
  readonly endpoint?: string;
}): PreparedRequest | null {
  const { event } = input;
  if (event.kind === "refund") return null;
  assertEvent(event);
  if (!/^[A-Z0-9]{8,32}$/.test(input.pixelCode)) throw new RangeError("pixelCode must be an uppercase TikTok pixel code");
  const user = defined({
    email: event.email === undefined ? undefined : hashEmail(event.email),
    phone: event.phone === undefined ? undefined : hashPhoneForTikTok(event.phone),
    ttclid: event.ttclid,
    ip: event.clientIp,
    user_agent: event.userAgent,
  });
  const data = [
    defined({
      event: TIKTOK_EVENT_NAMES[event.kind],
      event_time: unixSeconds(event.eventTime),
      event_id: event.eventId,
      user,
      properties: { currency: "IDR", value: event.valueIdr, order_id: event.orderId },
      page: event.pageUrl === undefined ? undefined : { url: event.pageUrl },
    }),
  ];
  const body = defined({ event_source: "web", event_source_id: input.pixelCode, test_event_code: input.testEventCode, data });
  const url = input.endpoint ?? TIKTOK_EVENTS_URL;
  if (!url.startsWith("https://")) throw new RangeError("endpoint must be https");
  const redactedUser = redact(
    defined({ ...user, email: user.email === undefined ? undefined : "[sha256]", phone: user.phone === undefined ? undefined : "[sha256]" }),
    ["ip", "user_agent", "ttclid"],
  );
  const redactedPage = event.pageUrl === undefined ? {} : { page: { url: REDACTED } };
  return {
    method: "POST",
    url,
    headers: { "content-type": "application/json", accept: "application/json", "access-token": input.accessToken },
    body: JSON.stringify(body),
    redacted: { url, body: JSON.stringify({ ...body, data: [{ ...data[0], user: redactedUser, ...redactedPage }] }) },
  };
}

/** What the worker records per attempt (conversion_attempts, AC-T7). */
export interface ConversionAttemptResult {
  readonly outcome: ConversionOutcome;
  readonly latencyMs: number;
  /** First 1 KiB of the response body, for the log. */
  readonly responseSnippet: string;
}

const NOT_SENT = new Set(["invalid_url", "scheme_not_allowed", "blocked_address", "dns_failed"]);
const SNIPPET_BYTES = 1024;

/**
 * Sends a prepared request and classifies the result for core recordConversionOutcome: 2xx sent,
 * other statuses failed (retried per AC-T3), and a transport error after the request may have
 * left (timeout, reset) maybe_sent; errors before any byte left are failed.
 */
export async function sendConversion(fetch: HttpFetch, request: PreparedRequest, now: () => number = Date.now): Promise<ConversionAttemptResult> {
  const started = now();
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    // Only the first 1 KiB is read; safe-fetch cancels the rest (stubs without textPrefix fall back).
    const text = await (response.textPrefix === undefined ? response.text() : response.textPrefix(SNIPPET_BYTES)).catch(() => "");
    return { outcome: conversionOutcomeFromHttp(response.status), latencyMs: now() - started, responseSnippet: text.slice(0, SNIPPET_BYTES) };
  } catch (error) {
    // A refused redirect is an HTTP answer: a failed attempt to retry (AC-T3), like any non-2xx.
    if (error instanceof SafeFetchError && error.code === "redirect_refused" && error.httpStatus !== undefined) {
      return { outcome: conversionOutcomeFromHttp(error.httpStatus), latencyMs: now() - started, responseSnippet: "" };
    }
    const message = error instanceof Error ? error.message : "request failed";
    const certain = error instanceof SafeFetchError && NOT_SENT.has(error.code);
    const outcome: ConversionOutcome = certain ? { kind: "failed", httpStatus: null, error: message } : { kind: "maybe_sent", error: message };
    return { outcome, latencyMs: now() - started, responseSnippet: "" };
  }
}
