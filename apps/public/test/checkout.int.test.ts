// US-020 acceptance criteria 1-4: the checkout API against PostgreSQL (as the public_rw login),
// Valkey (ACL user `public`) and infra/midtrans-stub (its Hono app, in-process).
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_SNAP_ATTEMPTS, normalizeBuyerText } from "@ebooktrivia/core";
import type { IdMobileE164 } from "@ebooktrivia/core/phone";
import type { SdkCheckoutResponse, SdkErrorBody } from "@ebooktrivia/core/sdk-contract";
import { describe, expect, it } from "vitest";
import { capProviders } from "../src/lib/cap-routes.ts";
import { loadLandingPage, publishedLegal } from "../src/lib/checkout/data.ts";
import { checkoutPreflight, type CheckoutDeps, handleCheckout } from "../src/lib/checkout/handler.ts";
import { openOrder, type OpenOrderInput, snapCreated, snapFailed } from "../src/lib/checkout/orders.ts";
import { sanitizeAttribution } from "../src/lib/checkout/request.ts";
import { createMidtransFetch } from "../src/lib/runtime.ts";
import {
  apiRequest,
  attemptsOf,
  capToken,
  checkoutBody,
  checkoutDeps,
  createShop,
  DOMAIN,
  freshIp,
  moRowsOf,
  newValkey,
  one,
  ordersOf,
  PRICE_IDR,
  publicSql,
  type RequestOptions,
  CAPTCHA_KEY,
  root,
  type Shop,
  SMALL_CHALLENGES,
  uniquePhone,
  withSettings,
} from "./support.ts";

const post = (deps: CheckoutDeps, shop: Shop, body: unknown, options: RequestOptions = {}): Promise<Response> =>
  handleCheckout(deps, apiRequest(`/api/v1/checkout/${shop.lpKey}`, body, { origin: shop.origin, ...options }), shop.lpKey);

async function ok(response: Response): Promise<SdkCheckoutResponse> {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body as SdkCheckoutResponse;
}

async function failed(response: Response): Promise<{ status: number; body: SdkErrorBody }> {
  return { status: response.status, body: (await response.json()) as SdkErrorBody };
}

/** What the handler passes to tx1 (orders.ts openOrder), for driving tx1 / tx2 directly. */
async function tx1Input(shop: Shop, phone: string): Promise<OpenOrderInput> {
  const lp = await loadLandingPage(publicSql, shop.lpKey);
  const legal = await publishedLegal(publicSql, shop.programId);
  if (lp === undefined || legal === undefined) throw new Error("fixture");
  return {
    lp,
    // The buyer of checkoutBody (support.ts), so a checkout of the same phone is the same buyer (D1).
    input: { name: "Budi Santoso", phone: phone as IdMobileE164, email: "budi@example.test", capToken: "unused", consent: { terms: legal.terms.version, privacy: legal.privacy.version }, attribution: {}, visitId: null },
    legal,
    attribution: sanitizeAttribution({}, new Map()),
    visitId: null,
    ip: null,
    userAgent: null,
    expirySeconds: 86_400,
  };
}

const without = (body: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(body).filter(([k]) => k !== key));

const SNAP_URL = /^https:\/\/app\.sandbox\.midtrans\.com\/snap\/v4\/redirection\/[0-9a-f-]{36}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("criterion 1: Origin and CORS (per landing page)", () => {
  it("answers the registered origin with CORS for exactly that origin, never credentials", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    const response = await post(deps, shop, await checkoutBody(shop));
    expect(response.headers.get("access-control-allow-origin")).toBe(shop.origin);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    await ok(response);
  });

  it("refuses any other origin with 403 origin and no CORS headers, before anything else happens", async () => {
    const shop = await createShop();
    const other = await createShop();
    const deps = checkoutDeps();
    for (const origin of [null, "https://evil.example.test", other.origin, `http://${shop.host}`, `https://${shop.host.toUpperCase()}`, `${shop.origin}/`, `${shop.origin}:443`, "null"]) {
      const response = await post(deps, shop, await checkoutBody(shop), { origin });
      expect(await failed(response), String(origin)).toEqual({ status: 403, body: { v: 1, error: "origin" } });
      expect(response.headers.get("access-control-allow-origin"), String(origin)).toBeNull();
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
    for (const lpKey of ["lp_Unknown0123456789", "not-a-key", "lp_x"]) {
      const response = await handleCheckout(deps, apiRequest(`/api/v1/checkout/${lpKey}`, await checkoutBody(shop), { origin: shop.origin }), lpKey);
      expect(await failed(response)).toEqual({ status: 403, body: { v: 1, error: "origin" } });
    }
    expect(deps.stub.calls).toHaveLength(0);
    expect(await ordersOf(shop)).toHaveLength(0);
  });

  it("answers the preflight per lpKey: content-type and accept, POST, no credentials; nothing for another origin", async () => {
    const shop = await createShop();
    const other = await createShop();
    const deps = checkoutDeps();
    const preflight = (s: Shop, origin: string, method = "POST") =>
      checkoutPreflight(deps, apiRequest(`/api/v1/checkout/${s.lpKey}`, undefined, { method: "OPTIONS", origin, headers: { "access-control-request-method": method, "access-control-request-headers": "content-type" } }), s.lpKey);
    const allowed = await preflight(shop, shop.origin);
    expect(allowed.status).toBe(204);
    expect(Object.fromEntries([...allowed.headers].filter(([k]) => k.startsWith("access-control-") || k === "vary"))).toEqual({
      "access-control-allow-origin": shop.origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, accept",
      "access-control-max-age": "600",
      vary: "Origin",
    });
    // The other page's origin is valid for the other page only.
    expect((await preflight(other, other.origin)).headers.get("access-control-allow-origin")).toBe(other.origin);
    for (const refused of [await preflight(shop, other.origin), await preflight(shop, "https://evil.example.test"), await preflight(shop, shop.origin, "PUT")]) {
      expect(refused.status).toBe(403);
      expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("criterion 1: Cap, rate limits, phone, consent", () => {
  it("requires a Cap token that verifies, and accepts it once", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    const withoutToken = without(await checkoutBody(shop), "cap_token");
    expect(await failed(await post(deps, shop, withoutToken))).toEqual({ status: 403, body: { v: 1, error: "captcha" } });
    for (const token of ["", "x".repeat(300), "not-a-cap-token", `${randomBytes(8).toString("hex")}:${randomBytes(15).toString("hex")}`]) {
      expect((await failed(await post(deps, shop, await checkoutBody(shop, { cap_token: token })))).body.error, token.slice(0, 20)).toBe("captcha");
    }
    const token = await capToken(shop);
    await ok(await post(deps, shop, await checkoutBody(shop, { cap_token: token })));
    // Single use: the same token for another buyer is refused.
    expect(await failed(await post(deps, shop, await checkoutBody(shop, { cap_token: token })))).toEqual({ status: 403, body: { v: 1, error: "captcha" } });
    expect(deps.stub.calls).toHaveLength(1);
  });

  it("binds a Cap token to the landing page it was solved for (security review P2-3)", async () => {
    const shopA = await createShop();
    const shopB = await createShop();
    const deps = checkoutDeps();
    const solvedOnA = await capToken(shopA);
    expect(await failed(await post(deps, shopB, await checkoutBody(shopB, { cap_token: solvedOnA })))).toEqual({ status: 403, body: { v: 1, error: "captcha" } });
    // Refused on B without being spent: it still works, once, on A.
    await ok(await post(deps, shopA, await checkoutBody(shopA, { cap_token: solvedOnA })));
    expect(deps.stub.calls).toHaveLength(1);
  });

  it("answers 503, not 403 captcha, when the captcha store cannot answer (security review P2-5)", async () => {
    const shop = await createShop();
    const down = await newValkey(1);
    // Rate limits on the working Valkey, the Cap provider on one that is down.
    const deps = checkoutDeps({ capFor: capProviders(down, CAPTCHA_KEY, SMALL_CHALLENGES) });
    const response = await post(deps, shop, await checkoutBody(shop));
    expect(await failed(response)).toEqual({ status: 503, body: { v: 1, error: "unavailable" } });
    expect(deps.logs.lines.some((l) => l.includes('"reason":"valkey_unavailable"'))).toBe(true);
    expect(await ordersOf(shop)).toHaveLength(0);
  });

  it("checks the deployment before the Cap token, so a configuration error never burns it (code review)", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    const token = await capToken(shop);
    await withSettings({ "midtrans.environment": "production" }, async () => {
      expect((await failed(await post(deps, shop, await checkoutBody(shop, { cap_token: token })))).status).toBe(503);
    });
    await withSettings({ "midtrans.enabled_methods": [] }, async () => {
      expect((await failed(await post(deps, shop, await checkoutBody(shop, { cap_token: token })))).status).toBe(503);
    });
    await ok(await post(deps, shop, await checkoutBody(shop, { cap_token: token })));
  });

  it("limits checkouts per client IP (an IPv6 /64), with Retry-After", async () => {
    await withSettings({ "checkout.ip_cap": 2, "checkout.ip_window_seconds": 600 }, async () => {
      const shop = await createShop();
      const deps = checkoutDeps();
      const ip = freshIp();
      const sameNetwork = ip.replace(/::1$/, "::abcd");
      await ok(await post(deps, shop, await checkoutBody(shop), { ip }));
      await ok(await post(deps, shop, await checkoutBody(shop), { ip: sameNetwork }));
      const limited = await post(deps, shop, await checkoutBody(shop), { ip });
      expect(await failed(limited)).toEqual({ status: 429, body: { v: 1, error: "rate_limited" } });
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(500);
      expect(limited.headers.get("access-control-allow-origin")).toBe(shop.origin);
      await ok(await post(deps, shop, await checkoutBody(shop), { ip: freshIp() }));
    });
  });

  it("limits checkouts per phone, across IPs", async () => {
    await withSettings({ "checkout.phone_cap": 1 }, async () => {
      const shop = await createShop();
      const other = await createShop();
      const deps = checkoutDeps();
      const phone = uniquePhone();
      await ok(await post(deps, shop, await checkoutBody(shop, { phone })));
      expect((await failed(await post(deps, other, await checkoutBody(other, { phone })))).body.error).toBe("rate_limited");
      await ok(await post(deps, other, await checkoutBody(other)));
    });
  });

  it("limits checkouts per landing page", async () => {
    await withSettings({ "checkout.lp_cap": 2 }, async () => {
      const shop = await createShop();
      const other = await createShop();
      const deps = checkoutDeps();
      await ok(await post(deps, shop, await checkoutBody(shop)));
      await ok(await post(deps, shop, await checkoutBody(shop)));
      expect((await failed(await post(deps, shop, await checkoutBody(shop)))).body.error).toBe("rate_limited");
      await ok(await post(deps, other, await checkoutBody(other)));
    });
  });

  it("counts only the per-IP limit before the Cap check: one IP over its limit never spends the page's budget (B1/M1, P1-1)", async () => {
    await withSettings({ "checkout.ip_cap": 2, "checkout.lp_cap": 3 }, async () => {
      const shop = await createShop();
      const deps = checkoutDeps();
      const ip = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await post(deps, shop, await checkoutBody(shop), { ip })).status);
      expect(statuses).toEqual([200, 200, 429, 429, 429]);
      // The page has counted 2 of its 3: a fresh client still gets through.
      await ok(await post(deps, shop, await checkoutBody(shop), { ip: freshIp() }));
    });
  });

  it("never lets junk Cap tokens carrying a victim's phone spend that phone's limit (P1-1)", async () => {
    await withSettings({ "checkout.phone_cap": 2 }, async () => {
      const shop = await createShop();
      const deps = checkoutDeps();
      const victim = uniquePhone();
      for (let i = 0; i < 6; i++) {
        const junk = `${randomBytes(8).toString("hex")}:${randomBytes(15).toString("hex")}`;
        expect((await failed(await post(deps, shop, await checkoutBody(shop, { phone: victim, cap_token: junk })))).body.error).toBe("captcha");
      }
      await ok(await post(deps, shop, await checkoutBody(shop, { phone: victim })));
    });
  });

  it("accepts an Indonesian mobile number in any common form and stores it as E.164; refuses the rest with the core codes", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    const digits = String(10_000_000 + Math.floor(Math.random() * 89_999_999));
    await ok(await post(deps, shop, await checkoutBody(shop, { phone: `0812-${digits.slice(0, 4)}-${digits.slice(4)}` })));
    expect((await ordersOf(shop))[0]?.buyer_phone).toBe(`+62812${digits}`);
    for (const [phone, code] of [
      ["", "empty"],
      ["+1 202 555 0100", "not_indonesian"],
      ["021 2345 6789", "not_mobile"],
      ["0812abc", "invalid_characters"],
      ["0812", "invalid_length"],
      [12345, "empty"],
    ] as const) {
      expect(await failed(await post(deps, shop, await checkoutBody(shop, { phone }))), String(phone)).toEqual({ status: 400, body: { v: 1, error: "validation", fields: { phone: code } } });
    }
  });

  it("requires consent and compares it with the newest PUBLISHED terms + privacy pair; stores it with a timestamp", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    const withoutConsent = without(await checkoutBody(shop), "consent");
    expect(await failed(await post(deps, shop, withoutConsent))).toEqual({ status: 400, body: { v: 1, error: "validation", fields: { consent: "required" } } });
    expect((await failed(await post(deps, shop, await checkoutBody(shop, { consent: { terms: "2", privacy: 1 } })))).body.fields).toEqual({ consent: "required" });
    // An older version, and the newer DRAFT (terms 3, never published): outdated.
    for (const consent of [{ terms: 1, privacy: 1 }, { terms: 3, privacy: 1 }, { terms: 2, privacy: 2 }]) {
      expect(await failed(await post(deps, shop, await checkoutBody(shop, { consent }))), JSON.stringify(consent)).toEqual({ status: 400, body: { v: 1, error: "validation", fields: { consent: "outdated" } } });
    }
    const ip = freshIp();
    const answer = await ok(await post(deps, shop, await checkoutBody(shop), { ip }));
    const order = await one(root<{ id: string }[]>`SELECT id FROM orders WHERE event_id = ${answer.event_id}`);
    const consents = await root<{ legal_page_id: string; consented_at: Date; ip: string; has_ua: boolean }[]>`
      SELECT legal_page_id, consented_at, host(ip) AS ip, ua_hash IS NOT NULL AS has_ua FROM consents WHERE order_id = ${order.id} ORDER BY legal_page_id`;
    expect(consents.map((c) => c.legal_page_id).sort()).toEqual([shop.terms.id, shop.privacy.id].sort());
    for (const c of consents) {
      expect(c.consented_at).toBeInstanceOf(Date);
      expect(c.ip).toBe(ip);
      expect(c.has_ua).toBe(true);
    }
  });

  it("applies SDK_LIMITS to every field and answers the contract's field codes together", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    expect((await failed(await post(deps, shop, await checkoutBody(shop, { name: "x".repeat(121), email: "nope", phone: "" })))).body).toEqual({
      v: 1,
      error: "validation",
      fields: { name: "too_long", email: "invalid", phone: "empty" },
    });
    expect((await failed(await post(deps, shop, await checkoutBody(shop, { name: "  \u0000 ", email: `${"a".repeat(250)}@x.id` })))).body.fields).toEqual({ name: "required", email: "invalid" });
    expect((await failed(await post(deps, shop, await checkoutBody(shop, { email: " " })))).body.fields).toEqual({ email: "required" });
    // 120 characters once trimmed is the limit, inclusive.
    await ok(await post(deps, shop, await checkoutBody(shop, { name: `  ${"a".repeat(120)}  ` })));
    expect(await failed(await post(deps, shop, { ...(await checkoutBody(shop)), v: 2 }))).toEqual({ status: 400, body: { v: 1, error: "validation" } });
    expect((await failed(await post(deps, shop, "{not json"))).body).toEqual({ v: 1, error: "validation" });
    expect((await failed(await post(deps, shop, await checkoutBody(shop), { contentType: "text/plain" }))).body).toEqual({ v: 1, error: "validation" });
    const huge = await checkoutBody(shop, { attribution: { utm_source: "x".repeat(17 * 1024) } });
    expect((await failed(await post(deps, shop, huge))).body).toEqual({ v: 1, error: "validation" });
  });
});

describe("criterion 2: sales window and dedupe", () => {
  it("refuses when now > sales_end - 30 min, configurable; and before sales_start, for an inactive page / product / program, without legal pages", async () => {
    const closing = await createShop({ salesEndAt: new Date(Date.now() + 29 * 60_000) });
    const deps = checkoutDeps();
    expect(await failed(await post(deps, closing, await checkoutBody(closing)))).toEqual({ status: 409, body: { v: 1, error: "sales_closed" } });
    await withSettings({ "orders.sales_close_buffer_minutes": 5 }, async () => {
      await ok(await post(deps, closing, await checkoutBody(closing)));
    });
    for (const options of [
      { salesStartAt: new Date(Date.now() + 60_000) },
      { lpActive: false },
      { productActive: false },
      { programStatus: "draft" },
      { programStatus: "awaiting_confirmation" },
      { published: false },
    ]) {
      const shop = await createShop(options);
      expect(await failed(await post(deps, shop, await checkoutBody(shop))), JSON.stringify(options)).toEqual({ status: 409, body: { v: 1, error: "sales_closed" } });
    }
    expect(deps.stub.calls).toHaveLength(1);
  });

  it("dedupes a pending order of the same buyer (phone, name, e-mail) on the landing page within 30 min: same event_id and URL, no Snap, no MO", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    const phone = uniquePhone();
    const first = await ok(await post(deps, shop, await checkoutBody(shop, { phone })));
    expect(first).toMatchObject({ v: 1, value_idr: PRICE_IDR, deduped: false });
    expect(first.event_id).toMatch(UUID);
    expect(first.snap_redirect_url).toMatch(SNAP_URL);
    // The same buyer up to case and whitespace (Owner decision D1).
    const again = await ok(await post(deps, shop, await checkoutBody(shop, { phone, name: "  BUDI   santoso ", email: " Budi@Example.TEST " }), { ip: freshIp() }));
    expect(again).toEqual({ ...first, deduped: true });
    expect(deps.stub.calls).toHaveLength(1);
    const [order] = await ordersOf(shop);
    expect((await ordersOf(shop)).length).toBe(1);
    expect(await moRowsOf(order?.id ?? "")).toHaveLength(1);
    // Another landing page of the same phone is another order.
    const other = await createShop();
    expect((await ok(await post(deps, other, await checkoutBody(other, { phone })))).deduped).toBe(false);

    // After 30 minutes it is a new order (new event id, new Snap transaction, its own MO).
    await root`UPDATE orders SET created_at = now() - interval '31 minutes' WHERE id = ${order?.id ?? ""}`;
    const later = await ok(await post(deps, shop, await checkoutBody(shop, { phone })));
    expect(later.deduped).toBe(false);
    expect(later.event_id).not.toBe(first.event_id);
    expect(await ordersOf(shop)).toHaveLength(2);
  });

  it("gives another buyer on the same phone an order of its own: never the first buyer's URL or event_id (D1)", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    const phone = uniquePhone();
    const first = await ok(await post(deps, shop, await checkoutBody(shop, { phone })));
    for (const other of [{ name: "Budi Lain" }, { email: "lain@example.test" }]) {
      const answer = await ok(await post(deps, shop, await checkoutBody(shop, { phone, ...other }), { ip: freshIp() }));
      expect(answer.deduped, JSON.stringify(other)).toBe(false);
      expect(answer.event_id).not.toBe(first.event_id);
      expect(answer.snap_redirect_url).not.toBe(first.snap_redirect_url);
    }
    expect(await ordersOf(shop)).toHaveLength(3);
    expect(deps.stub.calls).toHaveLength(3);
  });

  it("does not make another buyer on the same phone wait for the first buyer's in-flight attempt (D1)", async () => {
    const shop = await createShop();
    const phone = uniquePhone();
    const inFlight = await openOrder(publicSql, await tx1Input(shop, phone));
    if (inFlight.kind !== "snap") throw new Error("expected a new order");
    const deps = checkoutDeps({ inFlightWaitMs: 5000 });
    const answer = await ok(await post(deps, shop, await checkoutBody(shop, { phone, name: "Siti Lain" })));
    expect(answer.deduped).toBe(false);
    expect(answer.event_id).not.toBe(inFlight.order.eventId);
    expect(await ordersOf(shop)).toHaveLength(2);
    expect(deps.stub.calls).toHaveLength(1);
  });

  it("creates ONE order for simultaneous submits of the same phone + landing page; the others get its URL as deduped", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    deps.stub.delayMs = 400;
    const phone = uniquePhone();
    const bodies = await Promise.all(Array.from({ length: 6 }, () => checkoutBody(shop, { phone })));
    const answers = await Promise.all(bodies.map(async (body) => ok(await post(deps, shop, body, { ip: freshIp() }))));
    const orders = await ordersOf(shop);
    expect(orders).toHaveLength(1);
    expect(deps.stub.calls).toHaveLength(1);
    expect(new Set(answers.map((a) => a.event_id))).toEqual(new Set([orders[0]?.event_id]));
    expect(new Set(answers.map((a) => a.snap_redirect_url))).toEqual(new Set([orders[0]?.snap_redirect_url]));
    expect(answers.filter((a) => !a.deduped)).toHaveLength(1);
    expect(await moRowsOf(orders[0]?.id ?? "")).toHaveLength(1);
    expect(await attemptsOf(orders[0]?.id ?? "")).toHaveLength(1);
  });

  it("never returns a missing URL: a duplicate that waits too long for the in-flight attempt is told to retry", async () => {
    const shop = await createShop();
    const phone = uniquePhone();
    // tx1 of a request whose Snap call has not returned yet.
    const opened = await openOrder(publicSql, await tx1Input(shop, phone));
    expect(opened.kind).toBe("snap");
    const deps = checkoutDeps({ inFlightWaitMs: 300 });
    expect(await failed(await post(deps, shop, await checkoutBody(shop, { phone })))).toEqual({ status: 503, body: { v: 1, error: "unavailable" } });
    expect(deps.stub.calls).toHaveLength(0);
  });
});

describe("criterion 3: Snap and MO", () => {
  it("calls Snap with {publicId}-1, the catalog price (never the client's), expiry min(order expiry, sales_end), the enabled methods and the order page", async () => {
    const salesEnd = new Date(Date.now() + 2 * 3_600_000);
    const shop = await createShop({ salesEndAt: salesEnd });
    const far = await createShop();
    const deps = checkoutDeps();
    const answer = await ok(await post(deps, shop, await checkoutBody(shop, { value_idr: 1, amount_idr: 1, price: 1, gross_amount: 1 })));
    await ok(await post(deps, far, await checkoutBody(far)));
    const [order] = await ordersOf(shop);
    if (order === undefined) throw new Error("no order");
    expect(answer.value_idr).toBe(PRICE_IDR);
    expect(order.amount_idr).toBe(String(PRICE_IDR));
    const [call, farCall] = deps.stub.calls;
    expect(call?.url).toBe("https://app.sandbox.midtrans.com/snap/v1/transactions");
    expect(call?.authorization).toBe(`Basic ${Buffer.from("SB-Mid-server-PUBLICINT0123456789:").toString("base64")}`);
    expect(call?.body).toMatchObject({
      transaction_details: { order_id: `${order.public_id}-1`, gross_amount: PRICE_IDR },
      item_details: [{ id: shop.productId, price: PRICE_IDR, quantity: 1 }],
      customer_details: { first_name: "Budi Santoso", email: "budi@example.test", phone: order.buyer_phone },
      // The seeded default (Owner D11): every method but shopeepay, bri_va, cimb_va and kredivo.
      enabled_payments: ["other_qris", "gopay", "bca_va", "bni_va", "permata_va", "echannel", "other_va", "credit_card", "indomaret", "akulaku"],
      callbacks: { finish: `https://order.${DOMAIN}/${order.public_id}` },
      // credit_card is enabled by default, so 3-D Secure is asked for explicitly (the sandbox account does not default to it, R12).
      credit_card: { secure: true },
    });
    // sales_end (2 h away) comes first: 120 minutes less the one-minute margin, rounded down.
    expect((call?.body["expiry"] as { duration: number }).duration).toBeGreaterThanOrEqual(117);
    expect((call?.body["expiry"] as { duration: number }).duration).toBeLessThanOrEqual(118);
    // The 24 h order expiry comes first.
    expect(farCall?.body["expiry"]).toMatchObject({ unit: "minutes", duration: 24 * 60 - 1 });
    expect(order.snap_expires_at?.getTime() ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(salesEnd.getTime() - 60_000);
    // Midtrans counts the window from expiry.start_time (WIB, whole seconds), not from the buyer's method choice (recorded, US-005):
    // start_time + duration is our snap_expires_at.
    const expiry = call?.body["expiry"] as { start_time: string; duration: number };
    expect(expiry.start_time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+0700$/);
    const windowEnd = Date.parse(expiry.start_time.replace(" +0700", "+07:00").replace(" ", "T")) + expiry.duration * 60_000;
    expect(Math.abs(windowEnd - (order.snap_expires_at?.getTime() ?? Number.NaN))).toBeLessThan(1000);
    expect(order.expires_at.getTime() - order.created_at.getTime()).toBeGreaterThan(86_399_000);
  });

  it("Owner D11: Snap gets ONLY the methods the Owner enabled; switching one off takes it out of the next checkout, none enabled is a 503 and no order", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    // shopeepay, bri_va, cimb_va and kredivo are OFF in the default: they never reach Snap.
    await ok(await post(deps, shop, await checkoutBody(shop)));
    const [defaultCall] = deps.stub.calls;
    expect(defaultCall?.body["enabled_payments"]).not.toEqual(expect.arrayContaining(["shopeepay"]));
    for (const off of ["shopeepay", "bri_va", "cimb_va", "kredivo"]) expect(defaultCall?.body["enabled_payments"], off).not.toContain(off);

    const other = await createShop();
    await withSettings({ "midtrans.enabled_methods": ["credit_card", "gopay"] }, async () => {
      await ok(await post(deps, other, await checkoutBody(other)));
    });
    expect(deps.stub.calls[1]?.body["enabled_payments"]).toEqual(["credit_card", "gopay"]);
    expect(deps.stub.calls[1]?.body["credit_card"]).toEqual({ secure: true });
    // Without the card enabled there is nothing to secure: no credit_card block at all.
    const noCard = await createShop();
    await withSettings({ "midtrans.enabled_methods": ["gopay"] }, async () => {
      await ok(await post(deps, noCard, await checkoutBody(noCard)));
    });
    expect(deps.stub.calls[2]?.body["enabled_payments"]).toEqual(["gopay"]);
    expect(deps.stub.calls[2]?.body).not.toHaveProperty("credit_card");

    const none = await createShop();
    await withSettings({ "midtrans.enabled_methods": [] }, async () => {
      expect(await failed(await post(deps, none, await checkoutBody(none)))).toEqual({ status: 503, body: { v: 1, error: "unavailable" } });
    });
    expect(await ordersOf(none)).toHaveLength(0);
    expect(deps.stub.calls).toHaveLength(3);
  });

  it("enqueues the MO only after Snap succeeded (tx2), once", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    deps.stub.failures.push("400");
    const phone = uniquePhone();
    expect(await failed(await post(deps, shop, await checkoutBody(shop, { phone })))).toEqual({ status: 502, body: { v: 1, error: "gateway" } });
    const [order] = await ordersOf(shop);
    if (order === undefined) throw new Error("no order");
    expect(order).toMatchObject({ status: "snap_create_failed", snap_redirect_url: null, mo_outbox_id: null, snap_attempt_count: 1 });
    expect(await moRowsOf(order.id)).toHaveLength(0);
    expect(await attemptsOf(order.id)).toEqual([{ n: 1, midtrans_order_id: `${order.public_id}-1`, status: "failed", redirect_url: null, error: "snap:rejected" }]);

    // The same buyer, typed differently: the retry sends Snap the same buyer (D1; code review M3).
    const retried = await ok(await post(deps, shop, await checkoutBody(shop, { phone, name: " budi  SANTOSO", email: "BUDI@example.test " })));
    const customers = deps.stub.calls.map((c) => c.body["customer_details"] as { first_name: string; email: string; phone: string });
    expect(customers.map((c) => [normalizeBuyerText(c.first_name), normalizeBuyerText(c.email), c.phone])).toEqual([
      ["budi santoso", "budi@example.test", phone],
      ["budi santoso", "budi@example.test", phone],
    ]);
    const after = await one(root<{ status: string; snap_attempt_count: number; mo_outbox_id: string | null; snap_redirect_url: string | null; event_id: string }[]>`
      SELECT status::text AS status, snap_attempt_count, mo_outbox_id, snap_redirect_url, event_id FROM orders WHERE id = ${order.id}`);
    expect(after).toMatchObject({ status: "pending", snap_attempt_count: 2, snap_redirect_url: retried.snap_redirect_url, event_id: order.event_id });
    expect(retried).toMatchObject({ event_id: order.event_id, deduped: false });
    expect(deps.stub.calls.map((c) => (c.body["transaction_details"] as { order_id: string }).order_id)).toEqual([`${order.public_id}-1`, `${order.public_id}-2`]);
    const mo = await moRowsOf(order.id);
    expect(mo).toHaveLength(1);
    expect(after.mo_outbox_id).toBe(mo[0]?.id);
    expect((await attemptsOf(order.id)).map((a) => [a.n, a.status])).toEqual([
      [1, "failed"],
      [2, "created"],
    ]);
    // A further submit is deduped: no third attempt, no second MO.
    expect((await ok(await post(deps, shop, await checkoutBody(shop, { phone })))).deduped).toBe(true);
    expect(await moRowsOf(order.id)).toHaveLength(1);
    expect(await ordersOf(shop)).toHaveLength(1);
  });

  it("keeps an attempt of unknown outcome (timeout, 5xx) as requested and retries with n + 1", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    deps.stub.failures.push("network", "500");
    const phone = uniquePhone();
    expect((await failed(await post(deps, shop, await checkoutBody(shop, { phone })))).status).toBe(502);
    expect((await failed(await post(deps, shop, await checkoutBody(shop, { phone })))).status).toBe(502);
    await ok(await post(deps, shop, await checkoutBody(shop, { phone })));
    const [order] = await ordersOf(shop);
    expect((await attemptsOf(order?.id ?? "")).map((a) => [a.n, a.status, a.error])).toEqual([
      [1, "requested", "snap:unavailable"],
      [2, "requested", "snap:unavailable"],
      [3, "created", null],
    ]);
  });

  it("treats a pending order still without a URL 60 s after its attempt (a crash before tx2) as snap_create_failed: reused with n + 1, one MO", async () => {
    const shop = await createShop();
    const phone = uniquePhone();
    const opened = await openOrder(publicSql, await tx1Input(shop, phone));
    if (opened.kind !== "snap") throw new Error("expected a new order");
    // The process died after Snap answered: attempt 1 exists (maybe at Midtrans too), no URL was stored.
    await root`UPDATE midtrans_attempts SET created_at = now() - interval '61 seconds' WHERE order_id = ${opened.order.id}`;
    const deps = checkoutDeps();
    const answer = await ok(await post(deps, shop, await checkoutBody(shop, { phone })));
    expect(answer).toMatchObject({ event_id: opened.order.eventId, deduped: false });
    expect(deps.stub.calls.map((c) => (c.body["transaction_details"] as { order_id: string }).order_id)).toEqual([`${opened.order.publicId}-2`]);
    expect((await attemptsOf(opened.order.id)).map((a) => [a.n, a.status])).toEqual([
      [1, "requested"],
      [2, "created"],
    ]);
    expect(await moRowsOf(opened.order.id)).toHaveLength(1);
    expect(await ordersOf(shop)).toHaveLength(1);
  });

  it("stores a late Snap answer of a superseded attempt on its attempt row only: no URL, no MO", async () => {
    const shop = await createShop();
    const phone = uniquePhone();
    const input = await tx1Input(shop, phone);
    const first = await openOrder(publicSql, input);
    if (first.kind !== "snap") throw new Error("expected a new order");
    await root`UPDATE midtrans_attempts SET created_at = now() - interval '61 seconds' WHERE order_id = ${first.order.id}`;
    const second = await openOrder(publicSql, input);
    expect(second).toMatchObject({ kind: "snap", n: 2, reused: true });
    const url = "https://app.sandbox.midtrans.com/snap/v4/redirection/late";
    expect(await snapCreated(publicSql, first.order, 1, { token: "t1", redirectUrl: url, expiresAt: new Date(Date.now() + 3_600_000) })).toBe(false);
    expect(await moRowsOf(first.order.id)).toHaveLength(0);
    expect((await attemptsOf(first.order.id)).map((a) => [a.n, a.status, a.redirect_url])).toEqual([
      [1, "created", url],
      [2, "requested", null],
    ]);
    expect(await snapCreated(publicSql, first.order, 2, { token: "t2", redirectUrl: `${url}2`, expiresAt: new Date(Date.now() + 3_600_000) })).toBe(true);
    expect(await snapCreated(publicSql, first.order, 2, { token: "t2", redirectUrl: `${url}2`, expiresAt: new Date(Date.now() + 3_600_000) })).toBe(false);
    expect(await moRowsOf(first.order.id)).toHaveLength(1);
  });

  it(`stops an order after ${String(MAX_SNAP_ATTEMPTS)} attempts (rows kept), and never blocks its buyer: the next submit is a new order (M2)`, async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    deps.stub.failures.push(...Array.from({ length: MAX_SNAP_ATTEMPTS }, () => "400" as const));
    const phone = uniquePhone();
    for (let i = 0; i < MAX_SNAP_ATTEMPTS; i++) expect((await failed(await post(deps, shop, await checkoutBody(shop, { phone })))).body.error).toBe("gateway");
    const fresh = await ok(await post(deps, shop, await checkoutBody(shop, { phone })));
    expect(fresh.deduped).toBe(false);
    expect(deps.stub.calls).toHaveLength(MAX_SNAP_ATTEMPTS + 1);
    const [exhausted, next] = await ordersOf(shop);
    expect(exhausted).toMatchObject({ status: "snap_create_failed", snap_attempt_count: MAX_SNAP_ATTEMPTS });
    expect(await attemptsOf(exhausted?.id ?? "")).toHaveLength(MAX_SNAP_ATTEMPTS);
    expect(next).toMatchObject({ status: "pending", snap_attempt_count: 1, event_id: fresh.event_id });
    expect((deps.stub.calls.at(-1)?.body["transaction_details"] as { order_id: string }).order_id).toBe(`${next?.public_id ?? ""}-1`);
  });

  it("keeps a 2xx Snap answer that fails the token / host check as requested (it may be a real transaction; US-021 re-queries it)", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    deps.stub.failures.push("bad_host");
    expect(await failed(await post(deps, shop, await checkoutBody(shop)))).toEqual({ status: 502, body: { v: 1, error: "gateway" } });
    const [order] = await ordersOf(shop);
    expect(order).toMatchObject({ status: "snap_create_failed", snap_redirect_url: null });
    expect((await attemptsOf(order?.id ?? "")).map((a) => [a.n, a.status, a.error, a.redirect_url])).toEqual([[1, "requested", "snap:bad_response", null]]);
    expect(await moRowsOf(order?.id ?? "")).toHaveLength(0);
  });

  it("lets a waiting duplicate take over with n + 1 when the attempt it waited for fails", async () => {
    const shop = await createShop();
    const phone = uniquePhone();
    // The leader: its tx1 committed, its Snap call has not returned.
    const leader = await openOrder(publicSql, await tx1Input(shop, phone));
    if (leader.kind !== "snap") throw new Error("expected a new order");
    const deps = checkoutDeps();
    const waiter = post(deps, shop, await checkoutBody(shop, { phone }));
    // Wait until the waiter has found the attempt in flight, then let the leader's Snap call fail.
    const deadline = Date.now() + 4000;
    while (!deps.logs.lines.some((l) => l.includes('"event":"checkout.in_flight_wait"'))) {
      if (Date.now() > deadline) throw new Error("the waiter never logged checkout.in_flight_wait: it did not find the attempt in flight");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await snapFailed(publicSql, leader.order, 1, "snap:rejected", true);
    const answer = await ok(await waiter);
    expect(answer).toMatchObject({ deduped: false, event_id: leader.order.eventId });
    expect(await ordersOf(shop)).toHaveLength(1);
    expect(deps.stub.calls.map((c) => (c.body["transaction_details"] as { order_id: string }).order_id)).toEqual([`${leader.order.publicId}-2`]);
    expect((await attemptsOf(leader.order.id)).map((a) => [a.n, a.status])).toEqual([
      [1, "failed"],
      [2, "created"],
    ]);
    expect(await moRowsOf(leader.order.id)).toHaveLength(1);
  });

  it("stores the URL of attempt n even after the sweeper marked it snap_create_failed, while it is still the latest", async () => {
    const shop = await createShop();
    const opened = await openOrder(publicSql, await tx1Input(shop, uniquePhone()));
    if (opened.kind !== "snap") throw new Error("expected a new order");
    // apps/worker failStaleSnapCreates, as worker_rw.
    await root`UPDATE orders SET status = 'snap_create_failed' WHERE id = ${opened.order.id}`;
    const url = "https://app.sandbox.midtrans.com/snap/v4/redirection/slow";
    expect(await snapCreated(publicSql, opened.order, 1, { token: "t", redirectUrl: url, expiresAt: new Date(Date.now() + 3_600_000) })).toBe(true);
    expect((await ordersOf(shop))[0]).toMatchObject({ status: "pending", snap_redirect_url: url, snap_attempt_count: 1 });
    expect(await moRowsOf(opened.order.id)).toHaveLength(1);
  });

  it("bounds a hanging Snap call with the safe-fetch timeout: 502, the attempt stays requested", async () => {
    const shop = await createShop();
    const hanging = createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const midtrans = createMidtransFetch({ stubUrl: `http://127.0.0.1:${String((hanging.address() as AddressInfo).port)}`, timeoutMs: 300 });
    try {
      const deps = checkoutDeps({ midtransFetch: midtrans.fetch });
      const started = Date.now();
      expect(await failed(await post(deps, shop, await checkoutBody(shop)))).toEqual({ status: 502, body: { v: 1, error: "gateway" } });
      expect(Date.now() - started).toBeLessThan(5000);
      const [order] = await ordersOf(shop);
      expect((await attemptsOf(order?.id ?? "")).map((a) => [a.status, a.error])).toEqual([["requested", "snap:unavailable"]]);
    } finally {
      hanging.closeAllConnections();
      hanging.close();
      await midtrans.close().catch(() => undefined);
    }
  });

  it("uses the deployment's midtrans.environment (never a per-page setting): production without its key takes no order", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    await withSettings({ "midtrans.environment": "production" }, async () => {
      expect(await failed(await post(deps, shop, await checkoutBody(shop)))).toEqual({ status: 503, body: { v: 1, error: "unavailable" } });
    });
    expect(deps.stub.calls).toHaveLength(0);
    expect(await ordersOf(shop)).toHaveLength(0);
    expect(deps.logs.lines.some((l) => l.includes('"reason":"midtrans_key_unavailable"'))).toBe(true);
  });
});

describe("attribution and visit_id (US-019 follow-ups): dropped or ignored, never a failure", () => {
  it("drops bad values, keeps good ones, and makes an adnet the page does not allow organic", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    const fbc = "fb.1.1700000000000.IwAR0abc";
    const good = await ok(
      await post(
        deps,
        shop,
        await checkoutBody(shop, {
          attribution: { adnet: shop.adnet.slug, clickid: "CLK-123", sub_id: "budi@example.test", utm_source: "  Newsletter  ", fbp: "fb.1.bad", fbc, gclid: "x".repeat(513), evil: "1" },
        }),
      ),
    );
    expect(good.deduped).toBe(false);
    const [stored] = await ordersOf(shop);
    expect(stored).toMatchObject({ adnet_id: shop.adnet.id, clickid: "CLK-123", sub_id: null, utm_source: "Newsletter", fbp: null, fbc, gclid: null });

    const organic = await createShop();
    await ok(await post(deps, organic, await checkoutBody(organic, { attribution: { adnet: organic.foreignAdnet.slug, clickid: "CLK-9", utm_source: "ig" } })));
    expect((await ordersOf(organic))[0]).toMatchObject({ adnet_id: null, clickid: null, utm_source: "ig" });

    for (const attribution of ["string", 42, null, ["a"], { adnet: "NOT A SLUG", clickid: "0812 3456 7890" }]) {
      const s = await createShop();
      await ok(await post(deps, s, await checkoutBody(s, { attribution })));
      expect((await ordersOf(s))[0], JSON.stringify(attribution)).toMatchObject({ adnet_id: null, clickid: null });
    }
  });

  it("keeps a visit_id of this landing page and ignores another page's, an unknown or a malformed one", async () => {
    const shop = await createShop();
    const other = await createShop();
    const deps = checkoutDeps();
    const visit = await one(root<{ id: string }[]>`INSERT INTO visits (landing_page_id) VALUES (${shop.landingPageId}) RETURNING id`);
    const foreign = await one(root<{ id: string }[]>`INSERT INTO visits (landing_page_id) VALUES (${other.landingPageId}) RETURNING id`);
    await ok(await post(deps, shop, await checkoutBody(shop, { visit_id: visit.id })));
    for (const visitId of [foreign.id, "00000000-0000-4000-8000-000000000000", visit.id.toUpperCase(), "x", 7]) await ok(await post(deps, shop, await checkoutBody(shop, { visit_id: visitId })));
    const orders = await ordersOf(shop);
    expect(orders.map((o) => o.visit_id)).toEqual([visit.id, null, null, null, null, null]);
  });
});

describe("failure policy and logs", () => {
  it("fails CLOSED with 503 while Valkey is unreachable (no rate limit, no single-use Cap check: no order)", async () => {
    const shop = await createShop();
    const deps = checkoutDeps({ valkey: await newValkey(1) });
    const response = await post(deps, shop, await checkoutBody(shop));
    expect(await failed(response)).toEqual({ status: 503, body: { v: 1, error: "unavailable" } });
    expect(response.headers.get("access-control-allow-origin")).toBe(shop.origin);
    expect(deps.stub.calls).toHaveLength(0);
    expect(await ordersOf(shop)).toHaveLength(0);
    expect(deps.logs.lines.some((l) => l.includes('"reason":"valkey_unavailable"'))).toBe(true);
  });

  it("never logs the buyer's name, phone or e-mail, nor the server key", async () => {
    const shop = await createShop();
    const deps = checkoutDeps();
    const phone = uniquePhone();
    deps.stub.failures.push("400");
    await post(deps, shop, await checkoutBody(shop, { phone, name: "Siti Rahmawati", email: "siti.r@example.test" }));
    await post(deps, shop, await checkoutBody(shop, { phone, name: "Siti Rahmawati", email: "siti.r@example.test" }));
    await post(deps, shop, await checkoutBody(shop, { phone, name: "Siti Rahmawati", email: "siti.r@example.test" }));
    const all = deps.logs.lines.join("\n");
    expect(deps.logs.lines.length).toBeGreaterThanOrEqual(3);
    for (const secret of [phone, phone.slice(3), "Siti", "siti.r@example.test", "SB-Mid-server-PUBLICINT0123456789"]) expect(all).not.toContain(secret);
  });
});
