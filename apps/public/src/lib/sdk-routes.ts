// GET /api/v1/lp/{lp_key}/config and POST /api/v1/visit/{lp_key} (US-024; the wire contract of the landing-page
// SDK: @ebooktrivia/core/sdk-contract and packages/sdk/README.md). Both answer CORS for the landing page's
// registered origins only, exactly like checkout (lib/http.ts); an Origin that is not registered gets 403 and no CORS
// headers at all, and so does an unknown landing page (one answer for both: no way to probe which keys exist).
//
// config   `SdkLpConfig`, built from what the checkout itself reads (lib/checkout/data.ts), so the SDK and the
//          checkout never disagree: `checkout_open` is the checkout's own sales-window rule plus "a published terms +
//          privacy pair exists" plus "a payment method is enabled"; the adnets are the ACTIVE ones allowed on the
//          page; the pixels are the page's ids that are in their vendor's format (a malformed one is left out, the
//          SDK refuses a config that has one); midtrans_env is the deployment's. Cache-Control: public, max-age=60.
//          The database part is kept in memory for a few seconds per landing page (every page view of an ad
//          campaign asks), so a burst costs one set of queries, not one per visitor, and it is bounded (LRU, never
//          "clear everything"). A per-IP token bucket in memory (bounded, LRU) keeps one address from asking for
//          ever more; over it the answer is the one an unknown key gets (403 origin, no CORS headers): the wire
//          contract has no other "no", and the SDK treats every failure as "this page cannot take orders now".
//          No Valkey: it is a read of public settings and must not depend on it.
// visit    the visit beacon: stores a `visits` row (the sanitised attribution, the client IP and a hash of the user
//          agent) and answers 200 {v, visit_id}. Best effort in both directions: a body that is not the contract's,
//          or an attribution value that is not in shape, is DROPPED (204 / the value is left out), never rejected;
//          an adnet the page does not allow makes the visit organic; the id belongs to this landing page only
//          (checkout checks that with visitBelongs). Per-IP Valkey limit, taken BEFORE any database read (a flood of
//          beacons costs one Valkey call each, not a query); over it or with Valkey down the answer is an error the
//          SDK ignores (no CORS headers: the origin was not looked up), and the checkout then simply carries no
//          visit_id: a sale never depends on it.
import { salesState } from "@ebooktrivia/core";
import { SDK_PATTERNS, type SdkLpConfig, type SdkVisitResponse } from "@ebooktrivia/core/sdk-contract";
import { clientIp, throttleBucket } from "@ebooktrivia/edge";
import { allowedAdnets, isSettingsUnavailable, landingPageHosts, loadCheckoutSettings, loadLandingPage, publishedLegal, sdkPageDetails } from "./checkout/data.ts";
import { uaHash } from "./checkout/orders.ts";
import { sanitizeAttribution } from "./checkout/request.ts";
import type { Sql } from "./db.ts";
import { allowedOrigin, errorResponse, json, originRefused, originsOf, readJsonBody } from "./http.ts";
import type { Logger } from "./log.ts";
import { hitRateLimits, isValkeyUnavailable, type Valkey } from "./valkey.ts";

const LP_KEY = new RegExp(SDK_PATTERNS.lpKey);
const PIXEL_FORMAT = { meta: new RegExp(SDK_PATTERNS.metaPixel), tiktok: new RegExp(SDK_PATTERNS.tiktokPixel), gtag: new RegExp(SDK_PATTERNS.googleAds) } as const;

/** How long the database part of a config is reused (a sales window or a pixel edit reaches the SDK within this). */
export const CONFIG_CACHE_MS = 5000;
/** Entries kept at most; past it the least recently used one goes (never the whole cache at once). */
export const MAX_CACHED_CONFIGS = 1000;
/** One visit beacon per page view: a generous per-IP budget (a mobile carrier shares one address among many). */
export const VISIT_IP_LIMIT = 300;
export const VISIT_IP_WINDOW_MS = 10 * 60_000;
/** The config: 120 requests of a burst per address, then 4 a second; a page view asks once, and the browser keeps the answer a minute. */
export const CONFIG_BUCKET = { capacity: 120, refillPerSecond: 4, maxKeys: 10_000 } as const;

interface ConfigData {
  readonly landingPageId: string;
  readonly hosts: readonly string[];
  readonly config: SdkLpConfig;
}

export type ConfigCache = (lpKey: string, load: () => Promise<ConfigData | undefined>) => Promise<ConfigData | undefined>;

/**
 * Remembers each landing page's config for `ttlMs` (also "no such page"), at most `max` pages: a full cache drops its
 * least recently used page. A failed load is never remembered.
 */
export function createConfigCache(ttlMs = CONFIG_CACHE_MS, now: () => number = Date.now, max = MAX_CACHED_CONFIGS): ConfigCache {
  const entries = new Map<string, { readonly at: number; readonly value: Promise<ConfigData | undefined> }>();
  return (lpKey, load) => {
    const hit = entries.get(lpKey);
    if (hit !== undefined && now() - hit.at < ttlMs) {
      // Most recently used: a Map iterates in insertion order, so re-inserting moves it to the back.
      entries.delete(lpKey);
      entries.set(lpKey, hit);
      return hit.value;
    }
    entries.delete(lpKey);
    while (entries.size >= max) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
    const value = load();
    entries.set(lpKey, { at: now(), value });
    value.catch(() => {
      if (entries.get(lpKey)?.value === value) entries.delete(lpKey);
    });
    return value;
  };
}

export interface TokenBuckets {
  /** True when `key` may make a request now (and uses one token of it). */
  take(key: string): boolean;
}

/**
 * Per-key token buckets in memory, for a route that must not depend on Valkey: `capacity` tokens of burst, refilled
 * at `refillPerSecond`. Memory is bounded: at most `maxKeys` keys, the least recently used one is forgotten (an
 * address forgotten starts with a full bucket, which only ever favours the caller that was quiet).
 */
export function createTokenBuckets(options: { readonly capacity: number; readonly refillPerSecond: number; readonly maxKeys: number }, now: () => number = Date.now): TokenBuckets {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key) {
      const t = now();
      const found = buckets.get(key);
      buckets.delete(key);
      if (found === undefined) {
        while (buckets.size >= options.maxKeys) {
          const oldest = buckets.keys().next();
          if (oldest.done === true) break;
          buckets.delete(oldest.value);
        }
      }
      const tokens = Math.min(options.capacity, (found?.tokens ?? options.capacity) + (found === undefined ? 0 : ((t - found.at) / 1000) * options.refillPerSecond));
      const allowed = tokens >= 1;
      buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, at: t });
      return allowed;
    },
  };
}

export interface SdkRouteDeps {
  readonly sql: Sql;
  readonly valkey: Valkey;
  /** The base domain: the legal pages live on https://play.<domain>. */
  readonly domain: string;
  readonly configCache: ConfigCache;
  /** Per-address budget of the config route (createTokenBuckets(CONFIG_BUCKET)). */
  readonly configLimit: TokenBuckets;
  readonly log: Logger;
}

async function loadConfig(sql: Sql, domain: string, lpKey: string): Promise<ConfigData | undefined> {
  const lp = await loadLandingPage(sql, lpKey);
  if (lp === undefined) return undefined;
  const settings = await loadCheckoutSettings(sql);
  const legal = await publishedLegal(sql, lp.programId);
  const details = await sdkPageDetails(sql, lp.id, lp.programId);
  const sales = salesState(
    {
      landingPageActive: lp.active,
      productActive: lp.productActive,
      programStatus: lp.programStatus,
      salesStartAt: lp.salesStartAt,
      salesEndAt: lp.salesEndAt,
      closeBufferMinutes: settings.limits["orders.sales_close_buffer_minutes"],
    },
    lp.now,
  );
  const pixels: { meta?: string; tiktok?: string; gtag?: string } = {};
  for (const key of ["meta", "tiktok", "gtag"] as const) {
    const id = details.pixels[key];
    if (typeof id === "string" && PIXEL_FORMAT[key].test(id)) pixels[key] = id;
  }
  const config: SdkLpConfig = {
    v: 1,
    lp_key: lpKey,
    checkout_open: sales === "open" && legal !== undefined && settings.enabledMethods.length > 0,
    adnets: details.adnets,
    pixels,
    midtrans_env: settings.midtransEnvironment,
    legal: legal === undefined ? null : { play_origin: `https://play.${domain}`, program: details.programSlug, terms: legal.terms.version, privacy: legal.privacy.version },
  };
  return { landingPageId: lp.id, hosts: lp.hosts, config };
}

const unavailable = (origin: string | null): Response => errorResponse("unavailable", origin);

export async function handleConfig(deps: SdkRouteDeps, request: Request, lpKey: string): Promise<Response> {
  const fields = { route: "sdk.config", lpKey: LP_KEY.test(lpKey) ? lpKey : "invalid" };
  try {
    // The budget first: an address over it gets what an unknown key gets, before anything is read.
    if (LP_KEY.test(lpKey) && !deps.configLimit.take(throttleBucket(clientIp(request.headers)))) {
      deps.log("warn", "sdk.refused", { ...fields, reason: "rate_limited_ip" });
      return originRefused();
    }
    const data = LP_KEY.test(lpKey) ? await deps.configCache(lpKey, () => loadConfig(deps.sql, deps.domain, lpKey)) : undefined;
    const origin = data === undefined ? null : allowedOrigin(request, originsOf(data.hosts));
    if (data === undefined || origin === null) {
      deps.log("warn", "sdk.refused", { ...fields, reason: "origin" });
      return originRefused();
    }
    // Public and cacheable for a minute: the ACAO above depends on the Origin, which Vary: Origin (json()) says.
    return json(200, data.config, origin, { "cache-control": "public, max-age=60" });
  } catch (error) {
    deps.log("error", "sdk.failed", { ...fields, reason: isSettingsUnavailable(error) ? "settings_unavailable" : "internal" }, error);
    return unavailable(null);
  }
}

export async function handleVisit(deps: SdkRouteDeps, request: Request, lpKey: string): Promise<Response> {
  const fields = { route: "sdk.visit", lpKey: LP_KEY.test(lpKey) ? lpKey : "invalid" };
  let origin: string | null = null;
  try {
    if (!LP_KEY.test(lpKey)) {
      deps.log("warn", "sdk.refused", { ...fields, reason: "origin" });
      return originRefused();
    }
    // The limit BEFORE the landing page is read: a flood of beacons costs a Valkey call each, not a query. The origin is
    // not known yet, so a refusal carries no CORS headers (the SDK ignores every failure of this route anyway).
    const ip = clientIp(request.headers);
    const limit = await hitRateLimits(deps.valkey, [{ key: `visit:ip:${throttleBucket(ip)}`, limit: VISIT_IP_LIMIT, windowMs: VISIT_IP_WINDOW_MS }]);
    if (!limit.allowed) {
      deps.log("warn", "sdk.refused", { ...fields, reason: "rate_limited_ip" });
      return errorResponse("rate_limited", null, { headers: { "retry-after": String(limit.retryAfterSeconds) } });
    }
    const page = await landingPageHosts(deps.sql, lpKey);
    origin = page === undefined ? null : allowedOrigin(request, originsOf(page.hosts));
    if (page === undefined || origin === null) {
      deps.log("warn", "sdk.refused", { ...fields, reason: "origin" });
      return originRefused();
    }
    const body = await readJsonBody(request);
    const envelope = body.ok && typeof body.value === "object" && body.value !== null && !Array.isArray(body.value) ? (body.value as Record<string, unknown>) : undefined;
    if (envelope === undefined || envelope["v"] !== 1) {
      // Nothing to record, and nothing the SDK could do about it: no content.
      deps.log("info", "sdk.visit_dropped", { ...fields, reason: "body" });
      return new Response(null, { status: 204, headers: { "cache-control": "no-store", vary: "Origin", "access-control-allow-origin": origin } });
    }
    const attribution = sanitizeAttribution(envelope["attribution"], await allowedAdnets(deps.sql, page.id));
    const values = attribution.values;
    const [row] = await deps.sql<{ id: string }[]>`
      INSERT INTO public.visits ${deps.sql({
        landing_page_id: page.id,
        adnet_id: attribution.adnetId,
        clickid: values.clickid ?? null,
        sub_id: values.sub_id ?? null,
        pub: values.pub ?? null,
        utm_source: values.utm_source ?? null,
        utm_medium: values.utm_medium ?? null,
        utm_campaign: values.utm_campaign ?? null,
        utm_content: values.utm_content ?? null,
        utm_term: values.utm_term ?? null,
        fbclid: values.fbclid ?? null,
        fbp: values.fbp ?? null,
        fbc: values.fbc ?? null,
        ttclid: values.ttclid ?? null,
        gclid: values.gclid ?? null,
        ip,
        ua_hash: uaHash(request.headers.get("user-agent")),
      })}
      RETURNING id`;
    if (row === undefined) throw new Error("visit insert returned no row");
    const response: SdkVisitResponse = { v: 1, visit_id: row.id };
    return json(200, response, origin);
  } catch (error) {
    const down = isValkeyUnavailable(error);
    deps.log("error", "sdk.failed", { ...fields, reason: down ? "valkey_unavailable" : "internal" }, error);
    return unavailable(origin);
  }
}
