// HTTP plumbing of the public API (US-020): the per-landing-page CORS rule, JSON answers, a bounded
// body reader. Contract: @ebooktrivia/core/sdk-contract and packages/sdk/README.md "CORS and Origin".
//
//   - The Origin must EQUAL one of the landing page's registered origins, `https://` + a host of
//     lp_domains (the console registers bare lowercase hosts). Only then is it reflected in
//     Access-Control-Allow-Origin (never `*`), with Vary: Origin.
//   - Access-Control-Allow-Credentials is NEVER sent: the SDK sends no cookies (`credentials:
//     "omit"`) and the API reads none.
//   - Preflight is answered per lpKey: Allow-Methods POST, OPTIONS; Allow-Headers content-type, accept.
//   - Any other origin gets 403 and no CORS headers at all (the browser reports a network error).
import type { SdkErrorBody, SdkErrorCode, SdkFieldErrors } from "@ebooktrivia/core/sdk-contract";

/** Every API answer: never cached, never sniffed, and the CORS answer depends on the Origin. */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  vary: "Origin",
};

export const PREFLIGHT_MAX_AGE_SECONDS = 600;
export const MAX_BODY_BYTES = 16 * 1024;

export const STATUS: Readonly<Record<SdkErrorCode, number>> = {
  validation: 400,
  captcha: 403,
  origin: 403,
  sales_closed: 409,
  rate_limited: 429,
  gateway: 502,
  unavailable: 503,
};

/** The registered origins of a landing page's hosts. */
export const originsOf = (hosts: readonly string[]): ReadonlySet<string> => new Set(hosts.map((host) => `https://${host}`));

/** The request's Origin when it is one of `allowed`, else null. */
export function allowedOrigin(request: Request, allowed: ReadonlySet<string>): string | null {
  const origin = request.headers.get("origin");
  return origin !== null && allowed.has(origin) ? origin : null;
}

const corsHeaders = (origin: string | null): Record<string, string> => (origin === null ? {} : { "access-control-allow-origin": origin });

export function json(status: number, body: unknown, origin: string | null, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", ...corsHeaders(origin), ...extra },
  });
}

export function errorResponse(error: SdkErrorCode, origin: string | null, options: { readonly fields?: SdkFieldErrors; readonly headers?: Record<string, string> } = {}): Response {
  const body: SdkErrorBody = { v: 1, error, ...(options.fields === undefined ? {} : { fields: options.fields }) };
  return json(STATUS[error], body, origin, options.headers);
}

/** 403 `origin`, with no CORS headers. */
export const originRefused = (): Response => errorResponse("origin", null);

/** The preflight of a POST route for `origin` (null = refused, no CORS headers). */
export function preflight(request: Request, origin: string | null): Response {
  const method = request.headers.get("access-control-request-method");
  if (origin === null || (method !== null && method !== "POST")) return new Response(null, { status: 403, headers: { ...BASE_HEADERS } });
  return new Response(null, {
    status: 204,
    headers: {
      ...BASE_HEADERS,
      ...corsHeaders(origin),
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, accept",
      "access-control-max-age": String(PREFLIGHT_MAX_AGE_SECONDS),
    },
  });
}

/**
 * The raw body bytes, read up to `maxBytes` (a signature covers the exact bytes, so a route that verifies one reads them
 * before parsing anything), or undefined when it is larger or there is none. The declared length is checked first, the
 * stream is cut off at the limit either way.
 */
export async function readRawBody(request: Request, maxBytes: number): Promise<Uint8Array | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return undefined;
  if (request.body === null) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export type BodyResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * The JSON body, read up to `maxBytes`: not JSON (content type or syntax) or too large is `{ok: false}`.
 * The JSON content type also forces a CORS preflight for every browser request.
 */
export async function readJsonBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<BodyResult> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) return { ok: false };
  const bytes = await readRawBody(request, maxBytes);
  if (bytes === undefined) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false };
  }
}
