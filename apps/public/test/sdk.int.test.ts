// US-024 (the wire contract of the landing-page SDK, from US-019): GET /api/v1/lp/{lp_key}/config and
// POST /api/v1/visit/{lp_key} against PostgreSQL (as the public_rw login) and Valkey (ACL user `public`). The
// answers are also parsed by the SDK's OWN client (packages/sdk src/api.ts), so a drift from the contract fails here.
import { createHash } from "node:crypto";
import type { SdkLpConfig, SdkVisitResponse } from "@ebooktrivia/core/sdk-contract";
import { describe, expect, it } from "vitest";
import { createApi } from "../../../packages/sdk/src/api.ts";
import { visitBelongs } from "../src/lib/checkout/data.ts";
import { CONFIG_BUCKET, createConfigCache, createTokenBuckets, handleConfig, handleVisit, type SdkRouteDeps, VISIT_IP_LIMIT, VISIT_IP_WINDOW_MS } from "../src/lib/sdk-routes.ts";
import { hitRateLimits } from "../src/lib/valkey.ts";
import { throttleBucket } from "@ebooktrivia/edge";
import { apiRequest, captureLog, createShop, DOMAIN, freshIp, newValkey, one, publicSql, root, type Shop, valkey, withSettings } from "./support.ts";

function deps(overrides: Partial<SdkRouteDeps> = {}): SdkRouteDeps & { readonly logs: ReturnType<typeof captureLog> } {
  const logs = captureLog();
  // A cache of zero lifetime: every request reads the database, so each test sees its own fixture changes.
  return { sql: publicSql, valkey, domain: DOMAIN, configCache: createConfigCache(0), configLimit: createTokenBuckets(CONFIG_BUCKET), log: logs.log, logs, ...overrides };
}

/** `publicSql` that counts the statements run through it (a refusal before any database read runs none). */
function counted(): { sql: typeof publicSql; queries: () => number } {
  let n = 0;
  const sql = new Proxy(publicSql, {
    apply(target, thisArg, args: unknown[]) {
      n++;
      return Reflect.apply(target, thisArg, args) as unknown;
    },
  });
  return { sql, queries: () => n };
}

const getConfig = (d: SdkRouteDeps, shop: Shop, origin: string | null = shop.origin, lpKey = shop.lpKey): Promise<Response> =>
  handleConfig(d, apiRequest(`/api/v1/lp/${lpKey}/config`, undefined, { method: "GET", ...(origin === null ? {} : { origin }), headers: { accept: "application/json" } }), lpKey);

const postVisit = (d: SdkRouteDeps, shop: Shop, body: unknown, options: Parameters<typeof apiRequest>[2] = {}): Promise<Response> =>
  handleVisit(d, apiRequest(`/api/v1/visit/${shop.lpKey}`, body, { origin: shop.origin, ...options }), shop.lpKey);

const visitRow = (id: string) =>
  one(
    root<Record<string, string | null>[]>`
      SELECT landing_page_id, adnet_id, clickid, sub_id, pub, utm_source, utm_medium, fbclid, fbp, fbc, ttclid, gclid, host(ip) AS ip, encode(ua_hash, 'hex') AS ua_hash
        FROM visits WHERE id = ${id}`,
  );

describe("GET config", () => {
  it("answers the registered origin with the SDK's config and CORS for exactly that origin, cacheable for a minute, never credentials", async () => {
    const shop = await createShop();
    await root`UPDATE landing_pages SET pixels = ${JSON.stringify({ meta: "1234567890123", tiktok: "C3ABCDEFGH0123456", gtag: "AW-123456", gtag_label: "label" })}::text::jsonb WHERE id = ${shop.landingPageId}`;
    const response = await getConfig(deps(), shop);
    expect(response.status).toBe(200);
    expect(Object.fromEntries([...response.headers].filter(([k]) => k.startsWith("access-control") || k === "cache-control" || k === "vary"))).toEqual({
      "access-control-allow-origin": shop.origin,
      "cache-control": "public, max-age=60",
      vary: "Origin",
    });
    const slug = await one(root<{ slug: string }[]>`SELECT slug FROM programs WHERE id = ${shop.programId}`);
    expect(await response.json()).toEqual({
      v: 1,
      lp_key: shop.lpKey,
      checkout_open: true,
      // The ACTIVE adnets allowed on the page, with their click-id parameter; the foreign adnet is absent.
      adnets: [{ slug: shop.adnet.slug, clickid_param: "cid" }],
      // gtag_label is for the order page, not the SDK.
      pixels: { meta: "1234567890123", tiktok: "C3ABCDEFGH0123456", gtag: "AW-123456" },
      midtrans_env: "sandbox",
      // The newest PUBLISHED pair (a newer draft never counts).
      legal: { play_origin: `https://play.${DOMAIN}`, program: slug.slug, terms: 2, privacy: 1 },
    } satisfies SdkLpConfig);
  });

  it("is parsed by the SDK's own client (the contract holds from both sides)", async () => {
    const shop = await createShop();
    const d = deps();
    const api = createApi(`https://api.${DOMAIN}`, shop.lpKey, async (input, init) => {
      const url = new URL(input);
      const headers = { ...(init.headers as Record<string, string>), origin: shop.origin, "x-forwarded-for": freshIp() };
      return url.pathname.includes("/visit/")
        ? handleVisit(d, new Request(input, { ...init, headers }), shop.lpKey)
        : handleConfig(d, new Request(input, { ...init, headers }), shop.lpKey);
    });
    const config = await api.config();
    expect(config).toMatchObject({ lp_key: shop.lpKey, checkout_open: true, midtrans_env: "sandbox" });
    const visitId = await api.visit({ adnet: shop.adnet.slug, clickid: "AFF-123" });
    expect(visitId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("leaves out a pixel id that is not in its vendor's format (the SDK would refuse the whole config)", async () => {
    const shop = await createShop();
    await root`UPDATE landing_pages SET pixels = ${JSON.stringify({ meta: "not-a-pixel", tiktok: "C3ABCDEFGH0123456", gtag: "AW-1" })}::text::jsonb WHERE id = ${shop.landingPageId}`;
    const body = (await (await getConfig(deps(), shop)).json()) as SdkLpConfig;
    expect(body.pixels).toEqual({ tiktok: "C3ABCDEFGH0123456" });
  });

  it.each<[string, NonNullable<Parameters<typeof createShop>[0]>]>([
    ["the landing page is inactive", { lpActive: false }],
    ["sales are over", { salesEndAt: new Date(Date.now() - 3_600_000), salesStartAt: new Date(Date.now() - 86_400_000) }],
    ["sales close within the buffer before sales_end", { salesEndAt: new Date(Date.now() + 10 * 60_000) }],
    ["the program is not published", { programStatus: "draft" }],
    ["no terms + privacy pair is published", { published: false }],
  ])("checkout_open is false when %s, and legal is null without a published pair", async (_what, options) => {
    const shop = await createShop(options);
    const body = (await (await getConfig(deps(), shop)).json()) as SdkLpConfig;
    expect(body.checkout_open).toBe(false);
    if (options.published === false) expect(body.legal).toBeNull();
  });

  it("checkout_open is false while no payment method is enabled", async () => {
    const shop = await createShop();
    await withSettings({ "midtrans.enabled_methods": [] }, async () => {
      expect(((await (await getConfig(deps(), shop)).json()) as SdkLpConfig).checkout_open).toBe(false);
    });
  });

  it("an inactive adnet is not offered", async () => {
    const shop = await createShop();
    await root`UPDATE adnets SET active = false WHERE id = ${shop.adnet.id}`;
    expect(((await (await getConfig(deps(), shop)).json()) as SdkLpConfig).adnets).toEqual([]);
  });

  it("refuses an Origin that is not registered for the page, no Origin, another page's origin and an unknown page with 403 and no CORS headers", async () => {
    const shop = await createShop();
    const other = await createShop();
    const d = deps();
    for (const response of [
      await getConfig(d, shop, "https://evil.example.test"),
      await getConfig(d, shop, other.origin),
      await getConfig(d, shop, `http://${shop.host}`),
      await getConfig(d, shop, null),
      await getConfig(d, shop, shop.origin, "lp_doesnotexist0000"),
      await getConfig(d, shop, shop.origin, "not-a-key"),
    ]) {
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ v: 1, error: "origin" });
    }
  });

  it("is a 503 `unavailable` (never cached) while the settings are missing", async () => {
    const shop = await createShop();
    const d = deps();
    await root`UPDATE app_settings SET value = '"unknown"' WHERE key = 'midtrans.environment'`;
    try {
      const response = await getConfig(d, shop);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ v: 1, error: "unavailable" });
      expect(d.logs.lines.some((l) => l.includes("settings_unavailable"))).toBe(true);
    } finally {
      await root`UPDATE app_settings SET value = '"sandbox"' WHERE key = 'midtrans.environment'`;
    }
  });

  it("is rate limited per address in memory (security review US-024 L8): over the budget it answers what an unknown key gets, reads nothing, and another address is not affected", async () => {
    const shop = await createShop();
    const db = counted();
    const d = deps({ sql: db.sql, configLimit: createTokenBuckets({ capacity: 2, refillPerSecond: 0.001, maxKeys: 10 }) });
    const request = (ip: string) => handleConfig(d, apiRequest(`/api/v1/lp/${shop.lpKey}/config`, undefined, { method: "GET", origin: shop.origin, ip, headers: { accept: "application/json" } }), shop.lpKey);
    const ip = freshIp();
    expect([(await request(ip)).status, (await request(ip)).status]).toEqual([200, 200]);
    const queriesBefore = db.queries();
    const refused = await request(ip);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.json()).toEqual({ v: 1, error: "origin" });
    expect(db.queries()).toBe(queriesBefore);
    expect((await request(freshIp())).status).toBe(200);
  });

  it("serves a burst from one set of queries (the config cache), and sees a change once the cache has expired", async () => {
    const shop = await createShop();
    let clock = 1_000_000;
    const d = deps({ configCache: createConfigCache(5000, () => clock) });
    const first = (await (await getConfig(d, shop)).json()) as SdkLpConfig;
    expect(first.checkout_open).toBe(true);
    await root`UPDATE landing_pages SET active = false WHERE id = ${shop.landingPageId}`;
    expect(((await (await getConfig(d, shop)).json()) as SdkLpConfig).checkout_open).toBe(true);
    clock += 5001;
    expect(((await (await getConfig(d, shop)).json()) as SdkLpConfig).checkout_open).toBe(false);
  });
});

describe("POST visit", () => {
  const attribution = (adnet: string) => ({ adnet, clickid: "AFF-123", sub_id: "sub1", pub: "pub1", utm_source: "fb", utm_medium: "cpc", fbclid: "IwAR0abc", fbp: "fb.1.1700000000000.123456789", fbc: "fb.1.1700000000000.IwAR0abc", ttclid: "tt1", gclid: "g1" });

  it("stores the visit (sanitised attribution, client IP, a HASH of the user agent) and answers 200 {v, visit_id} with CORS", async () => {
    const shop = await createShop();
    const ip = freshIp();
    const response = await postVisit(deps(), shop, { v: 1, attribution: attribution(shop.adnet.slug) }, { ip });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(shop.origin);
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as SdkVisitResponse;
    expect(body.v).toBe(1);
    expect(await visitRow(body.visit_id)).toEqual({
      landing_page_id: shop.landingPageId,
      adnet_id: shop.adnet.id,
      clickid: "AFF-123",
      sub_id: "sub1",
      pub: "pub1",
      utm_source: "fb",
      utm_medium: "cpc",
      fbclid: "IwAR0abc",
      fbp: "fb.1.1700000000000.123456789",
      fbc: "fb.1.1700000000000.IwAR0abc",
      ttclid: "tt1",
      gclid: "g1",
      ip,
      ua_hash: createHash("sha256").update("public-int-test/1.0").digest("hex"),
    });
    // The id belongs to this landing page only (the checkout checks it).
    expect(await visitBelongs(publicSql, body.visit_id, shop.landingPageId)).toBe(true);
    expect(await visitBelongs(publicSql, body.visit_id, (await createShop()).landingPageId)).toBe(false);
  });

  it("drops what is not in shape and never rejects: an adnet the page does not allow makes the visit organic", async () => {
    const shop = await createShop();
    const d = deps();
    const organic = (await (await postVisit(d, shop, { v: 1, attribution: attribution(shop.foreignAdnet.slug) })).json()) as SdkVisitResponse;
    expect(await visitRow(organic.visit_id)).toMatchObject({ adnet_id: null, clickid: null, utm_source: "fb", gclid: "g1" });
    const dropped = (await (
      await postVisit(d, shop, {
        v: 1,
        attribution: { adnet: shop.adnet.slug, clickid: "x".repeat(300), sub_id: "has space", pub: "a@b.co", utm_source: "ok\u0000bad", fbp: "nope", unknown_key: "x", gclid: 5 },
      })
    ).json()) as SdkVisitResponse;
    expect(await visitRow(dropped.visit_id)).toMatchObject({ adnet_id: shop.adnet.id, clickid: null, sub_id: null, pub: null, utm_source: null, fbp: null, gclid: null });
    // A contact detail is never a click id.
    const contact = (await (await postVisit(d, shop, { v: 1, attribution: { adnet: shop.adnet.slug, clickid: "+6281234567890" } })).json()) as SdkVisitResponse;
    expect((await visitRow(contact.visit_id))["clickid"]).toBeNull();
  });

  it.each([
    ["a body that is not JSON", "not json{"],
    ["a body with the wrong version", { v: 2, attribution: {} }],
    ["a body that is an array", [1, 2]],
  ])("answers 204 with no body and stores nothing for %s", async (_what, body) => {
    const shop = await createShop();
    const response = await postVisit(deps(), shop, body);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBe(shop.origin);
    expect(await root`SELECT 1 FROM visits WHERE landing_page_id = ${shop.landingPageId}`).toEqual([]);
  });

  it("a visit with no attribution at all is still a visit", async () => {
    const shop = await createShop();
    const body = (await (await postVisit(deps(), shop, { v: 1, attribution: {} })).json()) as SdkVisitResponse;
    expect(await visitRow(body.visit_id)).toMatchObject({ adnet_id: null, clickid: null, landing_page_id: shop.landingPageId });
  });

  it("refuses an Origin that is not registered (403, no CORS), stores nothing, and answers the preflight per page", async () => {
    const shop = await createShop();
    for (const origin of ["https://evil.example.test", null]) {
      const response = await postVisit(deps(), shop, { v: 1, attribution: {} }, { origin });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(await root`SELECT 1 FROM visits WHERE landing_page_id = ${shop.landingPageId}`).toEqual([]);
  });

  it("is rate limited per client IP, and a refusal stores nothing (the checkout then simply has no visit_id)", async () => {
    const shop = await createShop();
    const ip = freshIp();
    // 300 beacons of this address are already counted in the window.
    for (let i = 0; i < VISIT_IP_LIMIT; i++) await hitRateLimits(valkey, [{ key: `visit:ip:${throttleBucket(ip)}`, limit: VISIT_IP_LIMIT + 1000, windowMs: VISIT_IP_WINDOW_MS }]);
    // Over the limit BEFORE the landing page is read: not one database statement, and (the origin unknown) no CORS headers.
    const db = counted();
    const refused = await postVisit(deps({ sql: db.sql }), shop, { v: 1, attribution: {} }, { ip });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    expect(db.queries()).toBe(0);
    expect(await root`SELECT 1 FROM visits WHERE landing_page_id = ${shop.landingPageId}`).toEqual([]);
    // Another address is not affected.
    expect((await postVisit(deps(), shop, { v: 1, attribution: {} })).status).toBe(200);
  });

  it("fails closed with a 503 the SDK ignores while Valkey is down, without a database read", async () => {
    const shop = await createShop();
    const down = await newValkey(1);
    const db = counted();
    const d = deps({ valkey: down, sql: db.sql });
    const response = await postVisit(d, shop, { v: 1, attribution: {} });
    expect(response.status).toBe(503);
    expect(db.queries()).toBe(0);
    expect(d.logs.lines.some((l) => l.includes("valkey_unavailable"))).toBe(true);
    expect(await root`SELECT 1 FROM visits WHERE landing_page_id = ${shop.landingPageId}`).toEqual([]);
  });
});
