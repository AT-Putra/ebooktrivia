// POST /api/v1/cap/{lp_key}/challenge and /redeem (US-020): the Cap widget protocol of the SDK
// (@cap.js/widget 0.1.62 against the CapProvider of packages/adapters, @cap.js/server 4.0.5).
//   - the same Origin / CORS rule as checkout: the landing page's registered origins only;
//   - one Cap provider PER LANDING PAGE, stateless (packages/adapters captcha.ts): challenges and
//     redeemed tokens are signed with CAPTCHA_HMAC_KEY and carry the page's id, so a token solved for
//     one page fails on every other (review P2-3), and neither route stores anything: a flood of
//     challenge or redeem requests cannot fill Valkey (Owner decision, US-020). Only a checkout's
//     verify writes, one single-use mark per token;
//   - Valkey rate limits, counted over both routes per captcha.ip_window_seconds and in this order,
//     stopping at the first one over: captcha.ip48_cap per IPv6 /48 (IPv4 has no /48 bucket), then
//     captcha.ip_cap per client IP (an IPv6 /64);
//   - Valkey down: 503 unavailable (fail closed), like checkout.
import { type CapProvider, type CapProviderConfig, createCapProvider } from "@ebooktrivia/adapters";
import { SDK_PATTERNS } from "@ebooktrivia/core/sdk-contract";
import { clientIp, throttleBucket, throttleBucket48 } from "@ebooktrivia/edge";
import { landingPageHosts, loadCaptchaSettings } from "./checkout/data.ts";
import type { Sql } from "./db.ts";
import { allowedOrigin, errorResponse, json, originRefused, originsOf, preflight, readJsonBody } from "./http.ts";
import type { Logger } from "./log.ts";
import { hitRateLimits, isValkeyUnavailable, type RateLimit, type Valkey, valkeyCapTokenMarks } from "./valkey.ts";

export interface CapRouteDeps {
  readonly sql: Sql;
  readonly valkey: Valkey;
  /** The Cap provider of one landing page (its id). */
  readonly capFor: (landingPageId: string) => Pick<CapProvider, "challenge" | "redeem">;
  readonly log: Logger;
}

export type CapAction = "challenge" | "redeem";

const LP_KEY = new RegExp(SDK_PATTERNS.lpKey);
/** A redeem body is a challenge token and 50 small numbers: a few hundred bytes. */
const MAX_REDEEM_BYTES = 8 * 1024;
/** Providers kept in memory at most; past it the cache starts over (a provider holds no state of its own). */
const MAX_CACHED_PROVIDERS = 1000;

/** One stateless Cap provider per landing page, all signed with `key`, sharing the Valkey token marks. */
export function capProviders(valkey: Valkey, key: Uint8Array, options: Omit<CapProviderConfig, "key" | "scope" | "replay"> = {}): (landingPageId: string) => CapProvider {
  const cache = new Map<string, CapProvider>();
  const replay = valkeyCapTokenMarks(valkey);
  return (landingPageId) => {
    let provider = cache.get(landingPageId);
    if (provider === undefined) {
      if (cache.size >= MAX_CACHED_PROVIDERS) cache.clear();
      provider = createCapProvider({ ...options, key, scope: landingPageId, replay });
      cache.set(landingPageId, provider);
    }
    return provider;
  };
}

async function originFor(sql: Sql, request: Request, lpKey: string): Promise<{ readonly id: string; readonly origin: string | null } | undefined> {
  const page = LP_KEY.test(lpKey) ? await landingPageHosts(sql, lpKey) : undefined;
  return page === undefined ? undefined : { id: page.id, origin: allowedOrigin(request, originsOf(page.hosts)) };
}

export async function capPreflight(deps: Pick<CapRouteDeps, "sql" | "log">, request: Request, lpKey: string): Promise<Response> {
  try {
    return preflight(request, (await originFor(deps.sql, request, lpKey))?.origin ?? null);
  } catch (error) {
    deps.log("error", "cap.preflight_failed", { lpKey: LP_KEY.test(lpKey) ? lpKey : "invalid" }, error);
    return new Response(null, { status: 503, headers: { "cache-control": "no-store", vary: "Origin" } });
  }
}

export async function handleCap(deps: CapRouteDeps, action: CapAction, request: Request, lpKey: string): Promise<Response> {
  const fields = { route: `cap.${action}`, lpKey: LP_KEY.test(lpKey) ? lpKey : "invalid" };
  let origin: string | null = null;
  try {
    const page = await originFor(deps.sql, request, lpKey);
    origin = page?.origin ?? null;
    if (page === undefined || origin === null) {
      deps.log("warn", "cap.refused", { ...fields, reason: "origin" });
      return originRefused();
    }
    const settings = await loadCaptchaSettings(deps.sql);
    const windowMs = settings["captcha.ip_window_seconds"] * 1000;
    const ip = clientIp(request.headers);
    const network = throttleBucket48(ip);
    // The /48 first: a /48 over its cap never creates a counter for yet another of its /64s (review P2-4).
    const limits: RateLimit[] = [
      ...(network === null ? [] : [{ key: `captcha:ip48:${network}`, limit: settings["captcha.ip48_cap"], windowMs }]),
      { key: `captcha:ip:${throttleBucket(ip)}`, limit: settings["captcha.ip_cap"], windowMs },
    ];
    const limit = await hitRateLimits(deps.valkey, limits);
    if (!limit.allowed) {
      deps.log("warn", "cap.refused", { ...fields, reason: limits[limit.index]?.key.startsWith("captcha:ip48:") === true ? "rate_limited_ip48" : "rate_limited_ip" });
      return errorResponse("rate_limited", origin, { headers: { "retry-after": String(limit.retryAfterSeconds) } });
    }
    const cap = deps.capFor(page.id);
    if (action === "challenge") return json(200, await cap.challenge(), origin);
    const body = await readJsonBody(request, MAX_REDEEM_BYTES);
    // An unparseable body is a failed redeem, the answer Cap itself gives.
    return json(200, body.ok ? await cap.redeem(body.value) : { success: false }, origin);
  } catch (error) {
    deps.log("error", "cap.failed", { ...fields, reason: isValkeyUnavailable(error) ? "valkey_unavailable" : "internal" }, error);
    return errorResponse("unavailable", origin);
  }
}
