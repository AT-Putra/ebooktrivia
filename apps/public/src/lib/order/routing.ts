// Host gating of the order status page and the legal pages (plan §3, M6.6, M6.8), decided by
// src/proxy.ts from the request's Host and path. Pure, so it is tested without a server.
//
//   order.<DOMAIN>   the order status page only, on its own origin:
//                      /{publicId}                      the page (rewritten to /order/{publicId})
//                      /?order_id={publicId}-{n}        the Midtrans dashboard's unfinish / error
//                                                       redirects, which cannot carry the id in the path
//                      /                                the page's shell: after the page stripped the
//                                                       id from the URL, a reload finds it in sessionStorage
//                      /api/v1/order/{status,claim}     the page's own polling and pixel claim
//                    anything else, malformed ids included, is the same 404 as an unknown order.
//   play.<DOMAIN>    /legal/{program}/{kind}/{version}; the player login (US-026, security review L2): the
//                    pages /login and /masuk (the magic link's confirm page), with their own nonce CSP, and
//                    every /api/v1/play/* route; and whatever else the play app serves.
//   other hosts      neither the order, the legal nor the play routes (404): they exist on their own host only.
// Without a configured DOMAIN no host is known, so the order and legal routes answer 404 (fail closed);
// every other path passes through untouched (the checkout and Cap routes, the mockups).
import { PUBLIC_ID_BODY, PUBLIC_ID_PATTERN } from "@ebooktrivia/core/public-id";

export type OrderRoute =
  /** Not ours: no change. */
  | { readonly kind: "pass" }
  /** 404 without a body. */
  | { readonly kind: "notFound" }
  /** The order page of `publicId` (null: not a valid id, the page answers its 404). */
  | { readonly kind: "orderPage"; readonly publicId: string | null }
  /** The shell of the order origin's root, which sends a tab that has an order in sessionStorage back to its page. */
  | { readonly kind: "orderShell" }
  | { readonly kind: "orderApi" }
  | { readonly kind: "legal" }
  /** A player login page on the play origin (/login, /masuk): the play CSP. */
  | { readonly kind: "playPage" }
  /** A play API route on the play origin (/api/v1/play/*): JSON, no CSP. */
  | { readonly kind: "playApi" };

/** The player login's pages (US-026). Every play route lives on play.<DOMAIN> only. */
export const PLAY_PAGE_PATHS: readonly string[] = ["/login", "/masuk"];
export const PLAY_API_PREFIX = "/api/v1/play";

export const ORDER_API_PATHS: readonly string[] = ["/api/v1/order/status", "/api/v1/order/claim"];

/** The Midtrans order id of an attempt, `{publicId}-{n}`: the public id is the first group. */
const ORDER_ID_PARAM = new RegExp(`^(${PUBLIC_ID_BODY})-[0-9]{1,3}$`);
const PAGE_PATH = /^\/([0-9A-Za-z]+)$/;

/** The host of a Host header: lowercase, without a port ("[::1]:3000" keeps its brackets). */
export function hostName(header: string | null): string {
  const host = (header ?? "").trim().toLowerCase();
  return host.replace(/:[0-9]{1,5}$/, "");
}

function decodedPath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * Next's pages-router data route, `/_next/data/{buildId}/{page}.json`. This app has no pages router, so it
 * is never a route of ours, but Next resolves it to the page path BEFORE the proxy runs (it rewrites
 * `/_next/data/{buildId}/order/{id}.json` to `/order/{id}`), and with skipProxyUrlNormalize the proxy then
 * sees the RAW path: a gate on the page path never fires, and the order API, the order page and the legal
 * pages would be reachable from any host. The build id is public (it is in every page's HTML), so the data
 * route is refused outright, on every host.
 */
const NEXT_DATA = /^\/_next\/data(\/|$)/i;

/** Decodes every segment on its own, the way a router does: a segment that does not decode stays as it is. */
function decodeSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

/** True when the raw path, or any spelling of it after up to three rounds of decoding, is a data route. */
export function isNextDataPath(pathname: string): boolean {
  let path = pathname;
  for (let round = 0; round < 4; round++) {
    if (NEXT_DATA.test(path)) return true;
    const next = decodeSegments(path);
    if (next === path) return false;
    path = next;
  }
  return NEXT_DATA.test(path);
}

export interface RouteInput {
  readonly host: string | null;
  readonly domain: string | null;
  readonly pathname: string;
  /** The `order_id` query parameter, if any. */
  readonly orderIdParam: string | null;
  /**
   * The play origin's host when it is not play.<DOMAIN>: the dev / test override PUBLIC_DEV_PLAY_ORIGIN (a
   * loopback address, refused in production by lib/config.ts and ignored there by the proxy).
   */
  readonly playHost?: string | null;
}

export function routeOrder(input: RouteInput): OrderRoute {
  if (isNextDataPath(input.pathname)) return { kind: "notFound" };
  const host = hostName(input.host);

  // The order origin matches the path AS SENT: an encoded spelling of a route is not that route.
  if (input.domain !== null && host === `order.${input.domain}`) {
    const path = input.pathname;
    if (ORDER_API_PATHS.includes(path)) return { kind: "orderApi" };
    if (path === "/") {
      const fromQuery = input.orderIdParam === null ? null : ORDER_ID_PARAM.exec(input.orderIdParam)?.[1];
      return fromQuery === undefined || fromQuery === null ? { kind: "orderShell" } : { kind: "orderPage", publicId: fromQuery };
    }
    const id = PAGE_PATH.exec(path)?.[1];
    return { kind: "orderPage", publicId: id !== undefined && PUBLIC_ID_PATTERN.test(id) ? id : null };
  }

  // Everywhere else the order and legal routes are not served; the check is on the decoded, lowercased
  // path so that no spelling reaches the internal route.
  const path = decodedPath(input.pathname);
  if (path === null) return { kind: "notFound" };
  const lower = path.toLowerCase();
  const internalOrder = lower === "/order" || lower.startsWith("/order/") || lower.startsWith("/api/v1/order/") || lower === "/api/v1/order";
  if (internalOrder) return { kind: "notFound" };
  const playHost = input.playHost ?? (input.domain === null ? null : `play.${input.domain}`);
  const onPlay = playHost !== null && host === playHost;
  if (lower === "/legal" || lower.startsWith("/legal/")) {
    return onPlay ? { kind: "legal" } : { kind: "notFound" };
  }
  if (PLAY_PAGE_PATHS.some((page) => lower === page || lower.startsWith(`${page}/`))) {
    return onPlay ? { kind: "playPage" } : { kind: "notFound" };
  }
  if (lower === PLAY_API_PREFIX || lower.startsWith(`${PLAY_API_PREFIX}/`)) {
    return onPlay ? { kind: "playApi" } : { kind: "notFound" };
  }
  return { kind: "pass" };
}
