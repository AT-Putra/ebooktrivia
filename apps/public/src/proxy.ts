// Runs before every request except Next's static assets (plan §3 "proxy.ts: nonce CSP, host gating"; US-022).
// For the order status page (order.<DOMAIN>) and the legal pages (play.<DOMAIN>/legal) it:
//   - gates the routes by host (lib/order/routing.ts): the order page, its two API routes and nothing else
//     on the order origin, the legal pages on the play origin only, and 404 for those routes anywhere else;
//   - rewrites /{publicId} (and the Midtrans dashboard's /?order_id={publicId}-{n}) to the page's internal
//     route /order/{publicId}; every other path on the order origin, malformed ids included, is the same 404
//     page as an unknown order. A rewrite is made with an absolute URL, and Next only treats it as internal
//     when its origin equals the address Next itself listens on: next.config.ts sets skipProxyUrlNormalize so
//     the proxy's request URL has that origin (without it the origin is "localhost", and behind the edge
//     listener, which binds EDGE_HOST, every rewrite was an external one and answered an empty 404). Next also
//     reports a rewrite to the client in x-middleware-rewrite (/order/{publicId}): Caddy strips it and keeps it
//     out of the order site's log (infra/caddy/Caddyfile);
//   - sets a per-request nonce CSP (request and response; Next puts the nonce on its scripts), built from the
//     vendors THIS order's landing page has pixel ids for (lib/order/csp.ts), and the other security headers,
//     among them Referrer-Policy: strict-origin on the order origin (lib/order/csp.ts ORDER_HEADERS);
//   - drops the Cookie request header on the order origin (Caddy already removes it in both directions; the
//     page never reads one);
//   - rate-limits the order page's lookups per client IP before touching the database (fail closed).
// The player login (US-026, security review L2) lives on play.<DOMAIN> only: /login, /masuk and /api/v1/play/*
// answer 404 on every other host; the two pages get the play nonce CSP (lib/order/csp.ts
// playContentSecurityPolicy) and PLAY_HEADERS, the API routes pass through (they answer JSON with their own
// headers and check the Origin themselves). The trivia pages (US-027): play.<DOMAIN>/, /{programSlug} and
// /{programSlug}/set/{n} are rewritten to their internal /trivia/... routes (a 404 on every host when asked for
// directly) with the trivia nonce CSP (lib/order/csp.ts triviaContentSecurityPolicy) and PLAY_HEADERS.
// The API routes, the signed files, the Cap files and the mockups pass through untouched; every other page (the 404
// page, robots.txt, the api origin's /) gets the trivia nonce CSP and PLAY_HEADERS (US-031, defaultPage).
// The vendor lookup runs the same SECURITY DEFINER read as the page (get_order_status), once per page load.
import { randomBytes } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { contentSecurityPolicy, LEGAL_HEADERS, ORDER_HEADERS, PLAY_HEADERS, playContentSecurityPolicy, triviaContentSecurityPolicy } from "./lib/order/csp.ts";
import { getOrderStatus } from "./lib/order/data.ts";
import { orderRateLimit } from "./lib/order/handler.ts";
import { routeOrder } from "./lib/order/routing.ts";
import { type Vendor, vendorsOf } from "./lib/order/vendors.ts";
import { logEvent } from "./lib/log.ts";
import { getRuntime, type PublicRuntime } from "./lib/runtime.ts";
import { t } from "./lib/t.ts";

function configuredDomain(): string | null {
  const domain = process.env["DOMAIN"]?.trim().toLowerCase();
  return domain === undefined || domain === "" ? null : domain;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The dev / test play origin's host (PUBLIC_DEV_PLAY_ORIGIN: the e2e server on 127.0.0.1), a loopback host only.
 * NODE_ENV cannot gate it here: Next inlines it in the proxy bundle as "production" at build time, and the e2e
 * runs that production build. In production lib/config.ts refuses the variable (the app's API does not start),
 * and Caddy never forwards a loopback Host, so it can only take the login off the real play host, never expose it.
 */
function devPlayHost(): string | null {
  const raw = process.env["PUBLIC_DEV_PLAY_ORIGIN"];
  if (raw === undefined || raw === "") return null;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) ? host : null;
  } catch {
    return null;
  }
}

const text = (status: number, body: string, headers: Record<string, string> = {}): NextResponse =>
  new NextResponse(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...ORDER_HEADERS, ...headers } });

/** Continues to `target` (a rewrite) or to the request's own route, with a fresh nonce CSP for `vendors`. */
function secured(request: NextRequest, target: string | null, vendors: readonly Vendor[], headers: Readonly<Record<string, string>>, dropCookie: boolean): NextResponse {
  return withNonceCsp(
    request,
    target,
    (nonce, https) => contentSecurityPolicy({ nonce, vendors, dev: process.env["NODE_ENV"] === "development", https }),
    headers,
    dropCookie,
  );
}

/** A fresh nonce, the CSP `policy` builds with it, on the request (Next puts the nonce on its scripts) and the answer. */
function withNonceCsp(
  request: NextRequest,
  target: string | null,
  policy: (nonce: string, https: boolean) => string,
  headers: Readonly<Record<string, string>>,
  dropCookie: boolean,
): NextResponse {
  const nonce = randomBytes(16).toString("base64");
  // Caddy terminates TLS and tells the app which scheme the browser used.
  const csp = policy(nonce, request.headers.get("x-forwarded-proto") === "https");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-nonce", nonce);
  if (dropCookie) requestHeaders.delete("cookie");
  const init = { request: { headers: requestHeaders } };
  const response = target === null ? NextResponse.next(init) : NextResponse.rewrite(new URL(target, request.url), init);
  response.headers.set("content-security-policy", csp);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

async function runtimeOrNull(): Promise<PublicRuntime | null> {
  try {
    return await getRuntime();
  } catch (error) {
    logEvent("error", "runtime.unavailable", { route: "order.proxy" }, error);
    return null;
  }
}

/** The 404 of an unknown order, a malformed id and every path the order origin does not serve. */
const unknownOrder = (request: NextRequest): NextResponse => secured(request, "/order/x", [], ORDER_HEADERS, true);

/**
 * What the proxy hands through UNCHANGED: route handlers that answer with their own headers (the API, the signed files),
 * the self-hosted Cap files, the mockups (development only, ENABLE_MOCKUPS) and the deep /healthz (US-015: JSON, which
 * Caddy shows to the monitor's address on api.<DOMAIN> only).
 */
const OWN_HEADERS = /^\/(?:api|files|cap|mockups|healthz)(?:\/|$)/;

/**
 * Every other page (US-031, found by the ZAP baseline: api.<DOMAIN>/, /robots.txt, the 404 page on the play and api
 * origins): the strictest policy of the app, the trivia one (the nonce and 'strict-dynamic', no vendor, no worker, no
 * form), and the play headers (never cached, framed or indexed, no Referer).
 */
const defaultPage = (request: NextRequest): NextResponse =>
  OWN_HEADERS.test(request.nextUrl.pathname) ? NextResponse.next() : withNonceCsp(request, null, (nonce, https) => triviaContentSecurityPolicy({ nonce, https }), PLAY_HEADERS, false);

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const route = routeOrder({
    host: request.headers.get("host"),
    domain: configuredDomain(),
    pathname: request.nextUrl.pathname,
    orderIdParam: request.nextUrl.searchParams.get("order_id"),
    playHost: devPlayHost(),
  });
  switch (route.kind) {
    case "pass":
      return defaultPage(request);
    case "notFound":
      return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
    case "orderApi": {
      const requestHeaders = new Headers(request.headers);
      requestHeaders.delete("cookie");
      const response = NextResponse.next({ request: { headers: requestHeaders } });
      for (const [name, value] of Object.entries(ORDER_HEADERS)) response.headers.set(name, value);
      return response;
    }
    case "legal":
      return secured(request, null, [], LEGAL_HEADERS, false);
    case "playPage":
      return withNonceCsp(request, null, (nonce, https) => playContentSecurityPolicy({ nonce, https }), PLAY_HEADERS, false);
    case "playApi":
      return NextResponse.next();
    case "trivia":
      return withNonceCsp(request, route.target, (nonce, https) => triviaContentSecurityPolicy({ nonce, https }), PLAY_HEADERS, false);
    case "orderShell":
      return secured(request, "/order", [], ORDER_HEADERS, true);
    case "orderPage": {
      if (route.publicId === null) return unknownOrder(request);
      const rt = await runtimeOrNull();
      if (rt === null) return text(503, t("order.unavailable"), { "retry-after": "5" });
      const limited = await orderRateLimit(rt.order, request.headers, "order.page");
      if (limited !== undefined) {
        return limited.status === 429 ? text(429, t("order.rateLimited"), { "retry-after": limited.headers.get("retry-after") ?? "10" }) : text(503, t("order.unavailable"), { "retry-after": "5" });
      }
      try {
        const record = await getOrderStatus(rt.order.sql, route.publicId);
        return secured(request, `/order/${route.publicId}`, record === undefined ? [] : vendorsOf(record.pixels), ORDER_HEADERS, true);
      } catch (error) {
        logEvent("error", "order.failed", { route: "order.proxy", reason: "internal" }, error);
        return text(503, t("order.unavailable"), { "retry-after": "5" });
      }
    }
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|assets/|icon\\.svg).*)"],
};
