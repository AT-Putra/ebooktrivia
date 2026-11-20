// POST /api/v1/checkout/{lp_key} and its preflight (US-020; contract @ebooktrivia/core/sdk-contract,
// packages/sdk/README.md). Order of the checks, each answering with the contract's error codes:
//
//   1. the landing page exists and the Origin is one of its registered origins   403 origin, no CORS
//   2. the Valkey rate limit per client IP (an IPv6 /64), and nothing else yet   429 rate_limited
//   3. the sales window: landing page, product and program active, now inside
//      [sales_start, sales_end - orders.sales_close_buffer_minutes]              409 sales_closed
//   4. the body (JSON, <= 16 KiB) against the contract and SDK_LIMITS: name, an
//      Indonesian mobile number in E.164, e-mail, consent present                  400 validation + fields
//      (a missing or malformed Cap token                                          403 captcha)
//   5. a published terms + privacy pair (none: checkout is closed)                409 sales_closed
//      and the consent equals its versions                                        400 consent: outdated
//   6. the deployment can take the order: enabled methods, the Midtrans key      503 unavailable
//      (before the Cap check, so a configuration error never burns a buyer's token)
//   7. the Cap token verifies, once, for THIS landing page                        403 captcha
//      (a captcha store that cannot answer                                        503 unavailable)
//   8. the Valkey rate limits per phone, then per landing page, in one call, only
//      for a request that passed the Cap check (junk tokens cannot spend a
//      victim's phone or the page's budget; security review P1-1)                 429 rate_limited
//   9. the order (orders.ts tx1), Snap OUTSIDE any transaction, tx2 (URL + MO)    200 / 502 gateway
// Anything unexpected (PostgreSQL, Valkey, the settings or the Midtrans key missing) is 503
// unavailable. Bad attribution is dropped and an unknown visit_id ignored; neither fails a checkout.
import { randomUUID } from "node:crypto";
import { type CapProvider, createSnapTransaction, type HttpFetch, MIDTRANS_ENDPOINTS, MidtransError } from "@ebooktrivia/adapters";
import { type MidtransMethod, midtransOrderId, salesState } from "@ebooktrivia/core";
import { SDK_PATTERNS, type SdkCheckoutResponse } from "@ebooktrivia/core/sdk-contract";
import type { SecretOpener } from "@ebooktrivia/crypto";
import { clientIp, throttleBucket } from "@ebooktrivia/edge";
import type { Sql } from "../db.ts";
import { allowedOrigin, errorResponse, json, originRefused, originsOf, preflight, readJsonBody } from "../http.ts";
import type { Logger } from "../log.ts";
import { hitRateLimits, phoneKey, type RateDecision, type Valkey, ValkeyUnavailable } from "../valkey.ts";
import {
  allowedAdnets,
  type CheckoutSettings,
  type LandingPage,
  landingPageHosts,
  loadCheckoutSettings,
  loadLandingPage,
  midtransServerKey,
  publishedLegal,
  ServerKeyUnavailable,
  SettingsUnavailable,
  visitBelongs,
} from "./data.ts";
import { openOrder, type OrderRef, snapCreated, snapFailed, waitForUrl } from "./orders.ts";
import { parseCheckoutRequest, sanitizeAttribution } from "./request.ts";

/** Bound of the Snap create call (the safe-fetch timeout the runtime builds `midtransFetch` with). */
export const SNAP_TIMEOUT_MS = 10_000;

export interface CheckoutDeps {
  readonly sql: Sql;
  readonly valkey: Valkey;
  /** The Cap provider of one landing page (its id): tokens are bound to the page they were solved for. */
  readonly capFor: (landingPageId: string) => Pick<CapProvider, "verify">;
  readonly opener: SecretOpener;
  /** How Snap is reached: safe-fetch with SNAP_TIMEOUT_MS in production. */
  readonly midtransFetch: HttpFetch;
  /** The base domain: Snap finish URL https://order.<domain>/{publicId}. */
  readonly domain: string;
  readonly log: Logger;
  /** How long a duplicate submit waits for the in-flight Snap URL of the same order. */
  readonly inFlightWaitMs?: number;
  readonly pollIntervalMs?: number;
}

const LP_KEY = new RegExp(SDK_PATTERNS.lpKey);

/** The finish redirect of Snap (AC-S10): the order status page (US-022). */
export const orderPageUrl = (domain: string, publicId: string): string => `https://order.${domain}/${publicId}`;

const rateLimited = (decision: Exclude<RateDecision, { allowed: true }>, origin: string): Response =>
  errorResponse("rate_limited", origin, { headers: { "retry-after": String(decision.retryAfterSeconds) } });

/** A store failure under a wrapper (CaptchaStoreUnavailable, ...) still is a Valkey outage. */
const isValkeyDown = (error: unknown): boolean => error instanceof ValkeyUnavailable || (error instanceof Error && error.cause instanceof ValkeyUnavailable);

export async function checkoutPreflight(deps: Pick<CheckoutDeps, "sql" | "log">, request: Request, lpKey: string): Promise<Response> {
  try {
    const page = LP_KEY.test(lpKey) ? await landingPageHosts(deps.sql, lpKey) : undefined;
    return preflight(request, page === undefined ? null : allowedOrigin(request, originsOf(page.hosts)));
  } catch (error) {
    deps.log("error", "checkout.preflight_failed", { lpKey }, error);
    return new Response(null, { status: 503, headers: { "cache-control": "no-store", vary: "Origin" } });
  }
}

function success(order: OrderRef, redirectUrl: string, deduped: boolean, origin: string): Response {
  const body: SdkCheckoutResponse = { v: 1, event_id: order.eventId, snap_redirect_url: redirectUrl, value_idr: order.amountIdr, deduped };
  return json(200, body, origin);
}

export async function handleCheckout(deps: CheckoutDeps, request: Request, lpKey: string): Promise<Response> {
  const requestId = randomUUID();
  const log: Logger = (level, event, fields, error) => {
    deps.log(level, event, { requestId, route: "checkout", lpKey: LP_KEY.test(lpKey) ? lpKey : "invalid", ...fields }, error);
  };
  let origin: string | null = null;
  try {
    const lp = LP_KEY.test(lpKey) ? await loadLandingPage(deps.sql, lpKey) : undefined;
    origin = lp === undefined ? null : allowedOrigin(request, originsOf(lp.hosts));
    if (lp === undefined || origin === null) {
      log("warn", "checkout.refused", { reason: "origin" });
      return originRefused();
    }
    const settings = await loadCheckoutSettings(deps.sql);
    const { limits } = settings;
    const ip = clientIp(request.headers);
    const perIp = await hitRateLimits(deps.valkey, [{ key: `checkout:ip:${throttleBucket(ip)}`, limit: limits["checkout.ip_cap"], windowMs: limits["checkout.ip_window_seconds"] * 1000 }]);
    if (!perIp.allowed) {
      log("warn", "checkout.refused", { reason: "rate_limited_ip" });
      return rateLimited(perIp, origin);
    }
    const sales = salesState(
      {
        landingPageActive: lp.active,
        productActive: lp.productActive,
        programStatus: lp.programStatus,
        salesStartAt: lp.salesStartAt,
        salesEndAt: lp.salesEndAt,
        closeBufferMinutes: limits["orders.sales_close_buffer_minutes"],
      },
      lp.now,
    );
    if (sales !== "open") {
      log("info", "checkout.refused", { reason: `sales_${sales}` });
      return errorResponse("sales_closed", origin);
    }

    const body = await readJsonBody(request);
    const parsed = body.ok ? parseCheckoutRequest(body.value) : ({ kind: "invalid" } as const);
    if (parsed.kind === "invalid") {
      log("info", "checkout.refused", { reason: "validation", detail: Object.keys(parsed.fields ?? {}).join(",") });
      return errorResponse("validation", origin, parsed.fields === undefined ? {} : { fields: parsed.fields });
    }
    if (parsed.kind === "captcha") {
      log("info", "checkout.refused", { reason: "captcha_missing" });
      return errorResponse("captcha", origin);
    }
    const { input } = parsed;
    const legal = await publishedLegal(deps.sql, lp.programId);
    if (legal === undefined) {
      log("warn", "checkout.refused", { reason: "no_published_legal_pages" });
      return errorResponse("sales_closed", origin);
    }
    if (input.consent.terms !== legal.terms.version || input.consent.privacy !== legal.privacy.version) {
      log("info", "checkout.refused", { reason: "consent_outdated" });
      return errorResponse("validation", origin, { fields: { consent: "outdated" } });
    }
    // Before the Cap check: a deployment that cannot take orders never spends a buyer's token.
    if (settings.enabledMethods.length === 0) throw new SettingsUnavailable("midtrans.enabled_methods");
    const serverKey = await midtransServerKey(deps.sql, deps.opener, settings.midtransEnvironment);

    if (!(await deps.capFor(lp.id).verify(input.capToken))) {
      log("info", "checkout.refused", { reason: "captcha" });
      return errorResponse("captcha", origin);
    }
    const perBuyer = await hitRateLimits(deps.valkey, [
      { key: `checkout:phone:${phoneKey(input.phone)}`, limit: limits["checkout.phone_cap"], windowMs: limits["checkout.phone_window_seconds"] * 1000 },
      { key: `checkout:lp:${lp.id}`, limit: limits["checkout.lp_cap"], windowMs: limits["checkout.lp_window_seconds"] * 1000 },
    ]);
    if (!perBuyer.allowed) {
      log("warn", "checkout.refused", { reason: perBuyer.index === 0 ? "rate_limited_phone" : "rate_limited_lp" });
      return rateLimited(perBuyer, origin);
    }

    const attribution = sanitizeAttribution(input.attribution, await allowedAdnets(deps.sql, lp.id));
    const visitId = input.visitId !== null && (await visitBelongs(deps.sql, input.visitId, lp.id)) ? input.visitId : null;
    const userAgent = request.headers.get("user-agent");
    const openInput = { lp, input, legal, attribution, visitId, ip, userAgent, expirySeconds: limits["orders.expiry_seconds"] };

    // Two passes at most: a duplicate submit that waited for an in-flight attempt which then failed
    // takes over the retry itself.
    for (let pass = 0; pass < 2; pass++) {
      const opened = await openOrder(deps.sql, openInput);
      switch (opened.kind) {
        case "closed":
          log("info", "checkout.refused", { reason: "payment_window_too_short" });
          return errorResponse("sales_closed", origin);
        case "deduped":
          log("info", "checkout.deduped", { orderId: opened.order.id });
          return success(opened.order, opened.redirectUrl, true, origin);
        case "in_flight": {
          if (pass > 0) return errorResponse("unavailable", origin);
          log("info", "checkout.in_flight_wait", { orderId: opened.order.id, attempt: opened.n });
          const waited = await waitForUrl(deps.sql, opened.order.id, { timeoutMs: deps.inFlightWaitMs ?? SNAP_TIMEOUT_MS + 2000, intervalMs: deps.pollIntervalMs ?? 200 });
          if (waited.kind === "url") {
            log("info", "checkout.deduped", { orderId: opened.order.id, kind: "in_flight" });
            return success(opened.order, waited.redirectUrl, true, origin);
          }
          if (waited.kind === "timeout") return errorResponse("unavailable", origin);
          continue;
        }
        case "snap":
          return await createSnap(deps, { settings, serverKey, lp, input: openInput.input, opened, origin, log });
      }
    }
    return errorResponse("unavailable", origin);
  } catch (error) {
    const reason = isValkeyDown(error)
      ? "valkey_unavailable"
      : error instanceof SettingsUnavailable
        ? "settings_unavailable"
        : error instanceof ServerKeyUnavailable
          ? "midtrans_key_unavailable"
          : "internal";
    log("error", "checkout.failed", { reason }, error);
    return errorResponse("unavailable", origin);
  }
}

/**
 * True when Midtrans certainly did not create the transaction: it refused it (4xx, the server key), or
 * the request was never sent. A timeout, a 5xx or an answer that fails our checks (bad JSON, a token or
 * redirect host that is not Snap's, even on a 2xx) may stand for a real transaction: its attempt stays
 * `requested` for reconciliation (US-021).
 */
const definitelyNotCreated = (error: unknown): boolean =>
  error instanceof MidtransError ? error.code === "rejected" || error.code === "unauthorized" : error instanceof RangeError;

async function createSnap(
  deps: CheckoutDeps,
  c: {
    readonly settings: CheckoutSettings;
    readonly serverKey: string;
    readonly lp: LandingPage;
    readonly input: { readonly name: string; readonly email: string; readonly phone: string };
    readonly opened: { readonly order: OrderRef; readonly n: number; readonly expiryMinutes: number; readonly snapExpiresAt: Date; readonly reused: boolean };
    readonly origin: string;
    readonly log: Logger;
  },
): Promise<Response> {
  const { order, n } = c.opened;
  const started = Date.now();
  let snap: { token: string; redirectUrl: string };
  try {
    snap = await createSnapTransaction(
      { serverKey: c.serverKey, ...MIDTRANS_ENDPOINTS[c.settings.midtransEnvironment], fetch: deps.midtransFetch },
      {
        midtransOrderId: midtransOrderId(order.publicId, n),
        grossAmountIdr: order.amountIdr,
        expiryMinutes: c.opened.expiryMinutes,
        item: { id: c.lp.productId, name: c.lp.productTitle },
        // What Snap needs to show and prefill the payment page; nothing else about the buyer. A reused
        // order belongs to the same buyer (D1), so these equal the stored details up to case and spaces.
        customer: { firstName: c.input.name, email: c.input.email, phone: c.input.phone },
        finishUrl: orderPageUrl(deps.domain, order.publicId),
        enabledPayments: [...c.settings.enabledMethods] satisfies MidtransMethod[],
      },
    );
  } catch (error) {
    const code = error instanceof MidtransError ? error.code : "error";
    await snapFailed(deps.sql, order, n, `snap:${code}`, definitelyNotCreated(error)).catch((writeError: unknown) => {
      c.log("error", "checkout.snap_failed_not_recorded", { orderId: order.id, attempt: n }, writeError);
    });
    c.log("warn", "checkout.snap_failed", { orderId: order.id, attempt: n, code, ms: Date.now() - started }, error);
    return errorResponse("gateway", c.origin);
  }
  if (!(await snapCreated(deps.sql, order, n, { ...snap, expiresAt: c.opened.snapExpiresAt }))) {
    c.log("warn", "checkout.snap_superseded", { orderId: order.id, attempt: n });
    return errorResponse("unavailable", c.origin);
  }
  c.log("info", "checkout.created", { orderId: order.id, attempt: n, outcome: c.opened.reused ? "retried" : "new", ms: Date.now() - started });
  return success(order, snap.redirectUrl, false, c.origin);
}
