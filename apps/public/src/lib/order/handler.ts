// POST /api/v1/order/status and /api/v1/order/claim (US-022): the two same-origin routes of the order
// status page (order.<DOMAIN>). Contract: ./contract.ts. The publicId in the body is the capability:
//
//   1. the Origin must be the order origin (order.<DOMAIN>); there is no CORS here, the page calls its own
//      origin, and a request from anywhere else is 403 with no CORS headers;
//   2. a Valkey rate limit per client IP (an IPv6 /64), counted BEFORE anything is read, fail closed:
//      Valkey down is 503, never "allowed";
//   3. the body (JSON, at most 1 KiB) must hold a well-formed id that exists; a missing body, not JSON, a
//      malformed id and an unknown id all get the SAME 404, so the route is no oracle for ids;
//   4. /status answers the page state and nothing else; /claim answers `fire: true` with the pixel
//      contract's values and the landing page's pixel ids to the ONE call that wins the exactly-once
//      claim (claim_browser_mt, packages/db/sql/functions.sql), and `fire: false` to every other.
// Nothing here logs a public id, a name or a phone number (lib/log.ts allows ids of orders only).
import { clientIp, throttleBucket } from "@ebooktrivia/edge";
import type { Sql } from "../db.ts";
import { json, readJsonBody } from "../http.ts";
import type { Logger } from "../log.ts";
import { hitRateLimits, type Valkey, ValkeyUnavailable } from "../valkey.ts";
import type { OrderClaimBody, OrderErrorBody, OrderErrorCode, OrderStatusBody } from "./contract.ts";
import { claimBrowserMt, getOrderStatus, isPublicId } from "./data.ts";
import { pageState } from "./view.ts";

/**
 * Requests (page loads, status polls and claims together) per client IP and window. A poll every few
 * seconds for a minute or two is the heaviest honest use, and many buyers share a mobile carrier's
 * address (Owner decision D2, US-020), so this is a flood guard, not a per-buyer limit. Constants, not
 * admin settings: nothing here is worth a migration.
 */
export const ORDER_IP_LIMIT = 1200;
export const ORDER_IP_WINDOW_MS = 60_000;
export const MAX_ORDER_BODY_BYTES = 1024;

export interface OrderDeps {
  readonly sql: Sql;
  readonly valkey: Valkey;
  /** The base domain: the order origin is order.<domain>. */
  readonly domain: string;
  readonly log: Logger;
}

const STATUS: Readonly<Record<OrderErrorCode, number>> = { not_found: 404, origin: 403, rate_limited: 429, unavailable: 503 };

function failure(code: OrderErrorCode, extra: Record<string, string> = {}): Response {
  const body: OrderErrorBody = { v: 1, error: code };
  return json(STATUS[code], body, null, extra);
}

/** True when the request's Origin is the order origin (any scheme and port: the host decides). */
export function fromOrderOrigin(request: Request, domain: string): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).hostname === `order.${domain}`;
  } catch {
    return false;
  }
}

/**
 * Counts one request of this client against the order rate limit: undefined when it may go on, else
 * the refusal to send. Valkey trouble is the 503 refusal (fail closed).
 */
export async function orderRateLimit(deps: Pick<OrderDeps, "valkey" | "log">, headers: Headers, route: string): Promise<Response | undefined> {
  try {
    const decision = await hitRateLimits(deps.valkey, [{ key: `order:ip:${throttleBucket(clientIp(headers))}`, limit: ORDER_IP_LIMIT, windowMs: ORDER_IP_WINDOW_MS }]);
    if (decision.allowed) return undefined;
    deps.log("warn", "order.refused", { route, reason: "rate_limited_ip" });
    return failure("rate_limited", { "retry-after": String(decision.retryAfterSeconds) });
  } catch (error) {
    deps.log("error", "order.failed", { route, reason: error instanceof ValkeyUnavailable ? "valkey_unavailable" : "internal" }, error);
    return failure("unavailable");
  }
}

async function publicIdOf(request: Request): Promise<string | undefined> {
  const body = await readJsonBody(request, MAX_ORDER_BODY_BYTES);
  if (!body.ok || typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) return undefined;
  const id: unknown = Reflect.get(body.value, "id");
  return isPublicId(id) ? id : undefined;
}

export type OrderRoute = "status" | "claim";

export async function handleOrderApi(deps: OrderDeps, route: OrderRoute, request: Request): Promise<Response> {
  const fields = { route: `order.${route}` };
  try {
    if (!fromOrderOrigin(request, deps.domain)) {
      deps.log("warn", "order.refused", { ...fields, reason: "origin" });
      return failure("origin");
    }
    const limited = await orderRateLimit(deps, request.headers, fields.route);
    if (limited !== undefined) return limited;
    const id = await publicIdOf(request);
    if (id === undefined) return failure("not_found");

    if (route === "status") {
      const order = await getOrderStatus(deps.sql, id);
      if (order === undefined) return failure("not_found");
      const body: OrderStatusBody = { v: 1, status: pageState(order.status) };
      return json(200, body, null);
    }

    // The claim answers an unknown id like any other (not_found); a known one that is not claimable
    // (not paid, or claimed already) is `fire: false`, the same for every caller but the winner.
    const claim = await claimBrowserMt(deps.sql, id);
    if (claim === undefined) {
      if ((await getOrderStatus(deps.sql, id)) === undefined) return failure("not_found");
      const none: OrderClaimBody = { v: 1, fire: false };
      return json(200, none, null);
    }
    deps.log("info", "order.mt_claimed", fields);
    const won: OrderClaimBody = { v: 1, fire: true, event_id: claim.eventId, transaction_id: claim.transactionId, value_idr: claim.valueIdr, pixels: claim.pixels };
    return json(200, won, null);
  } catch (error) {
    deps.log("error", "order.failed", { ...fields, reason: error instanceof ValkeyUnavailable ? "valkey_unavailable" : "internal" }, error);
    return failure("unavailable");
  }
}
