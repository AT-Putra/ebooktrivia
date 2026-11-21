// Conversions: which sinks an order has, what an S2S postback carries, when a reversal goes out, and how a
// log is kept free of secrets (plan M7; spec AC-T2-T8, US-024). Pure: the worker (apps/worker conversions.ts)
// reads the rows, sends with safe-fetch and records the outcome with conversion-machine.ts.
//
// Sinks: S2S (the adnet's postback, for an attributed order), Meta CAPI and the TikTok Events API (when
// the landing page has that pixel). Google is browser-only (plan §10 item 2), so it never has a row.
// An organic order has pixels / CAPI rows only (AC-T8): no S2S, whatever the adnet settings say.

import type { ConversionStatus } from "./conversion-machine.ts";
import { hasPixel, type MtSink, type MtSource } from "./payment.ts";
import { SDK_PATTERNS } from "./sdk-contract.ts";

export const CONVERSION_KINDS = ["mo", "mt", "reversal"] as const;
export type ConversionKind = (typeof CONVERSION_KINDS)[number];

/** The first 4 KB of a sink's answer is kept in the log (AC-T7; conversion_attempts_response_excerpt_check). */
export const CONVERSION_EXCERPT_MAX = 4096;

// ---------------------------------------------------------------- CAPI credentials

/**
 * The fixed API hosts of the platforms' server-side APIs. A CAPI access token is a conversions-scope secret
 * with no adnet, bound to exactly its platform's host (settings_secrets_binding_check): the adapters only
 * ever send it there, so the host is a constant and needs no column or clear-on-change trigger.
 */
export const CAPI_HOSTS = { meta: "graph.facebook.com", tiktok: "business-api.tiktok.com" } as const;
export type CapiPlatform = keyof typeof CAPI_HOSTS;

const PIXEL_ID: Readonly<Record<CapiPlatform, RegExp>> = {
  meta: new RegExp(SDK_PATTERNS.metaPixel),
  tiktok: new RegExp(SDK_PATTERNS.tiktokPixel),
};

/** settings_secrets.name of a pixel's CAPI access token: `capi.meta.<pixel id>`, `capi.tiktok.<pixel code, lowercase>`. */
export function capiSecretName(platform: CapiPlatform, pixelId: string): string {
  if (!PIXEL_ID[platform].test(pixelId)) throw new RangeError(`not a ${platform} pixel id`);
  return `capi.${platform}.${pixelId.toLowerCase()}`;
}

// ---------------------------------------------------------------- the rows of an order

export interface MoSource extends MtSource {
  /** The adnet has an MO postback template (adnets.mo_url_template IS NOT NULL). */
  readonly adnetHasMoTemplate: boolean;
}

/**
 * The sinks that get one MO row when the order's Snap payment exists (AC-T3, §10 item 22): S2S only for an
 * attributed click whose adnet has an MO template, and a CAPI InitiateCheckout for each pixel the page has.
 */
export function moSinks(source: MoSource): MtSink[] {
  const sinks: MtSink[] = [];
  if (source.adnetId !== null && source.clickid !== null && source.clickid !== "" && source.adnetHasMoTemplate) sinks.push("s2s");
  if (hasPixel(source.pixels, "meta")) sinks.push("meta");
  if (hasPixel(source.pixels, "tiktok")) sinks.push("tiktok");
  return sinks;
}

// ---------------------------------------------------------------- S2S values

/**
 * The {status} an adnet receives: the order exists (MO), was paid (MT), or was refunded after an MT (reversal).
 * Adnets that want other words put them in the template's static text; {status} is only the event's name.
 */
export function postbackStatus(kind: ConversionKind): "pending" | "approved" | "reversed" {
  return kind === "mo" ? "pending" : kind === "mt" ? "approved" : "reversed";
}

/** The {payout} of an event: nothing is earned at MO ("0"); the MT earns the adnet's fixed payout and a reversal takes it back. */
export function postbackPayout(kind: ConversionKind, payoutIdr: number): string {
  if (!Number.isSafeInteger(payoutIdr) || payoutIdr < 0) throw new RangeError("payoutIdr must be a non-negative integer");
  return kind === "mo" ? "0" : String(payoutIdr);
}

// ---------------------------------------------------------------- reversals

/** last_error of a reversal that did not go out because its MT never reached the sink. */
export const REVERSAL_SKIPPED = "skipped: the MT never reached its sink";

/** last_error of an S2S MT row created already failed: the order's adnet has no MT postback template (AC-T4: visibly failed, at once). */
export const NO_MT_TEMPLATE = "the adnet has no mt postback template";

export type ReversalVerdict = "send" | "wait" | "skip";

/**
 * Whether the reversal of a refunded order may go out, judged by the MT row of the same sink (AC-T8). The
 * judgement is the row's sticky `maybe_counted` mark (set on a 2xx and on every uncertain send: a timeout, a
 * refused redirect, an expired lease; never cleared, not by an Owner re-fire and not by payments), not its
 * current status or last error, which a re-fire or a cancellation rewrites:
 *   sending                  the MT request is in flight: wait for it (a reversal must not overtake it);
 *   sent, or maybe counted   the sink may have counted the MT: reverse it, whatever state the row is in now;
 *   anything else            the MT never reached its sink (never sent, every attempt answered with an error,
 *                            cancelled before it left, or no MT row): skip, there is nothing to reverse.
 */
export function reversalVerdict(mt: { readonly status: ConversionStatus; readonly maybeCounted: boolean } | undefined): ReversalVerdict {
  if (mt === undefined) return "skip";
  if (mt.status === "sending") return "wait";
  return mt.maybeCounted || mt.status === "sent" ? "send" : "skip";
}

// ---------------------------------------------------------------- redaction

/** The form of a value in a URL query, as renderPostbackUrl writes it (encodeURIComponent plus !'()*). */
const urlEncoded = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`);
/** The form of a value inside a JSON string (an answer that echoes the request body). */
const jsonEscaped = (value: string): string => JSON.stringify(value).slice(1, -1);

export const REDACTED_SECRET = "***";
/** A trailing fragment of a secret shorter than this is not treated as the start of one (it would eat ordinary text). */
const PARTIAL_SECRET_MIN = 3;

/**
 * `text` with every secret value, in the forms a sink may echo it (raw, URL-encoded, JSON-escaped), replaced by
 * `***` (AC-T7: a log never holds a secret; a sink that echoes the request URL or body must not put one there).
 * Longest first, so a secret that contains another is replaced whole.
 */
export function redactSecretValues(text: string, secrets: readonly string[]): string {
  const forms = [...new Set(secrets.filter((s) => s !== "").flatMap((s) => [s, urlEncoded(s), jsonEscaped(s)]))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const form of forms) out = out.split(form).join(REDACTED_SECRET);
  // A text cut at a byte limit may end inside a secret: its first characters must not survive either.
  for (const form of forms) {
    for (let k = Math.min(form.length - 1, out.length); k >= PARTIAL_SECRET_MIN; k--) {
      if (out.endsWith(form.slice(0, k))) {
        out = out.slice(0, out.length - k) + REDACTED_SECRET;
        break;
      }
    }
  }
  return out;
}
