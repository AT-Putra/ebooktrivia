// The SDK's calls to the public API (contract: @ebooktrivia/core/sdk-contract, packages/sdk/README.md).
// Every request is a CORS request from a third-party origin without cookies (`credentials: "omit"`).
// Responses are parsed by hand and checked field by field: a body that does not have the contract's
// shape is an error, never a partly trusted object.
import {
  SDK_LIMITS,
  SDK_PATTERNS,
  SDK_ROUTES,
  type SdkAttribution,
  type SdkCheckoutRequest,
  type SdkCheckoutResponse,
  type SdkErrorCode,
  type SdkFieldErrors,
  type SdkLpConfig,
  type SdkVisitRequest,
} from "@ebooktrivia/core/sdk-contract";

const TIMEOUT_MS = 30_000;
const UUID = new RegExp(SDK_PATTERNS.uuid);
const SLUG = new RegExp(SDK_PATTERNS.slug);
const PARAM = new RegExp(SDK_PATTERNS.clickidParam);
const PIXEL_ID = { meta: new RegExp(SDK_PATTERNS.metaPixel), tiktok: new RegExp(SDK_PATTERNS.tiktokPixel), gtag: new RegExp(SDK_PATTERNS.googleAds) } as const;
const ERROR_CODES: readonly string[] = ["validation", "captcha", "origin", "sales_closed", "rate_limited", "gateway", "unavailable"];

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type CheckoutResult =
  | { readonly ok: true; readonly response: SdkCheckoutResponse }
  | { readonly ok: false; readonly error: SdkErrorCode | "network"; readonly fields?: SdkFieldErrors };

export interface Api {
  config(): Promise<SdkLpConfig | null>;
  visit(attribution: SdkAttribution): Promise<string | null>;
  checkout(request: Omit<SdkCheckoutRequest, "v">): Promise<CheckoutResult>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** `{lp_key}` filled into a route template. */
export const route = (template: string, lpKey: string): string => template.replace("{lp_key}", encodeURIComponent(lpKey));

export function parseConfig(value: unknown, lpKey: string): SdkLpConfig | null {
  if (!isRecord(value) || value["v"] !== 1 || value["lp_key"] !== lpKey || typeof value["checkout_open"] !== "boolean") return null;
  const env = value["midtrans_env"];
  if (env !== "sandbox" && env !== "production") return null;
  const rawAdnets = value["adnets"];
  if (!Array.isArray(rawAdnets) || rawAdnets.length > SDK_LIMITS.adnetsMax) return null;
  const adnets: { slug: string; clickid_param: string }[] = [];
  for (const entry of rawAdnets as unknown[]) {
    if (!isRecord(entry)) return null;
    const { slug, clickid_param: param } = entry;
    if (typeof slug !== "string" || typeof param !== "string") return null;
    if (!SLUG.test(slug) || slug.length > SDK_LIMITS.adnetSlug || !PARAM.test(param)) return null;
    adnets.push({ slug, clickid_param: param });
  }
  const rawPixels = value["pixels"];
  if (!isRecord(rawPixels)) return null;
  const pixels: { meta?: string; tiktok?: string; gtag?: string } = {};
  for (const key of ["meta", "tiktok", "gtag"] as const) {
    const id = rawPixels[key];
    if (id === undefined) continue;
    // Pixel ids end up in vendor script URLs and calls, so each is held to its vendor's format.
    if (typeof id !== "string" || !PIXEL_ID[key].test(id)) return null;
    pixels[key] = id;
  }
  let legal: SdkLpConfig["legal"] = null;
  const rawLegal = value["legal"];
  if (rawLegal !== null) {
    if (!isRecord(rawLegal)) return null;
    const { play_origin: origin, program, terms, privacy } = rawLegal;
    if (typeof origin !== "string" || typeof program !== "string" || !SLUG.test(program) || program.length > 64) return null;
    if (!isInt(terms, 1, SDK_LIMITS.policyVersionMax) || !isInt(privacy, 1, SDK_LIMITS.policyVersionMax)) return null;
    legal = { play_origin: origin, program, terms, privacy };
  }
  return { v: 1, lp_key: lpKey, checkout_open: value["checkout_open"], adnets, pixels, midtrans_env: env, legal };
}

export function parseCheckoutResponse(value: unknown): SdkCheckoutResponse | null {
  if (!isRecord(value) || value["v"] !== 1) return null;
  const { event_id: eventId, snap_redirect_url: url, value_idr: valueIdr, deduped } = value;
  if (typeof eventId !== "string" || !UUID.test(eventId) || typeof url !== "string" || typeof deduped !== "boolean") return null;
  if (!isInt(valueIdr, 0, SDK_LIMITS.valueIdrMax)) return null;
  return { v: 1, event_id: eventId, snap_redirect_url: url, value_idr: valueIdr, deduped };
}

const FIELD_CODES: Readonly<Record<string, readonly string[]>> = {
  name: ["required", "too_long"],
  phone: ["empty", "invalid_characters", "not_indonesian", "not_mobile", "invalid_length"],
  email: ["required", "invalid"],
  consent: ["required", "outdated"],
};

function parseFields(value: unknown): SdkFieldErrors | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [field, codes] of Object.entries(FIELD_CODES)) {
    const code = value[field];
    if (typeof code === "string" && codes.includes(code)) out[field] = code;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** What went wrong, from the HTTP status and (when it parses) the error body. */
export function parseError(status: number, body: unknown): { error: SdkErrorCode; fields?: SdkFieldErrors } {
  if (isRecord(body) && body["v"] === 1 && typeof body["error"] === "string" && ERROR_CODES.includes(body["error"])) {
    const fields = parseFields(body["fields"]);
    return { error: body["error"] as SdkErrorCode, ...(fields === undefined ? {} : { fields }) };
  }
  if (status === 429) return { error: "rate_limited" };
  if (status === 403) return { error: "captcha" };
  if (status === 409) return { error: "sales_closed" };
  return { error: status === 400 ? "validation" : "unavailable" };
}

export function createApi(origin: string, lpKey: string, fetchImpl: Fetch): Api {
  const url = (template: string): string => origin + route(template, lpKey);
  const send = (target: string, method: "GET" | "POST", body?: unknown, keepalive = false): Promise<Response> =>
    fetchImpl(target, {
      method,
      credentials: "omit",
      mode: "cors",
      cache: "no-store",
      redirect: "error",
      keepalive,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  const json = async (response: Response): Promise<unknown> => {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  };

  return {
    async config() {
      try {
        const response = await send(url(SDK_ROUTES.config), "GET");
        return response.ok ? parseConfig(await json(response), lpKey) : null;
      } catch {
        return null;
      }
    },
    async visit(attribution) {
      const request: SdkVisitRequest = { v: 1, attribution };
      try {
        const response = await send(url(SDK_ROUTES.visit), "POST", request, true);
        const body = response.ok ? await json(response) : undefined;
        return isRecord(body) && body["v"] === 1 && typeof body["visit_id"] === "string" && UUID.test(body["visit_id"]) ? body["visit_id"] : null;
      } catch {
        return null;
      }
    },
    async checkout(request) {
      let response: Response;
      try {
        response = await send(url(SDK_ROUTES.checkout), "POST", { v: 1, ...request });
      } catch {
        return { ok: false, error: "network" };
      }
      const body = await json(response);
      if (response.ok) {
        const parsed = parseCheckoutResponse(body);
        return parsed === null ? { ok: false, error: "unavailable" } : { ok: true, response: parsed };
      }
      return { ok: false, ...parseError(response.status, body) };
    },
  };
}
