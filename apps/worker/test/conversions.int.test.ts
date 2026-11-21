// US-024 criteria 1-3: the conversion sinks of the worker (src/conversions.ts) against PostgreSQL as the
// worker_rw login, through the REAL payments pipeline, the REAL claim / outcome processor and in-process HTTP
// stubs of an adnet, Meta and TikTok (no real credential exists yet; the vendor payloads are unverified).
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createSafeFetch, type HttpFetch } from "@ebooktrivia/adapters";
import { NEEDS_MANUAL_REFIRE, REVERSAL_SKIPPED } from "@ebooktrivia/core";
import { createSecretOpener, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inertFailpoint } from "../src/failpoint.ts";
import { createMoConsumer } from "../src/conversion-outbox.ts";
import { createConversionFire } from "../src/conversions.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { EFFECT_CANCELLED } from "../src/payments.ts";
import { first, sql, suffix } from "./support/db.ts";
import {
  ADNET_HOST,
  alertsRaised,
  API_KEY,
  attemptsOf,
  createAttributedOrder,
  createTrackingShop,
  dropCapiTokens,
  eventOf,
  eventsOf,
  fireDue,
  firing,
  hashOf,
  META_PIXEL,
  META_TOKEN,
  opener,
  payOrder,
  queryOf,
  refundOrder,
  startVendorStub,
  stubbedFetch,
  TIKTOK_PIXEL,
  TIKTOK_TOKEN,
  type TrackingShop,
  type VendorStub,
} from "./support/conversions.ts";
import { PRICE_IDR, retireEffects, silentLog, workerPool } from "./support/midtrans.ts";

const workerSql = workerPool(6);
let stub: VendorStub;
let shop: TrackingShop;
beforeAll(async () => {
  stub = await startVendorStub();
  shop = await createTrackingShop();
});
afterAll(async () => {
  await stub.close();
  await retireEffects(shop);
  await dropCapiTokens();
});

const orderRow = async (orderId: string) =>
  first(await sql<{ event_id: string; created_at: Date; paid_at: Date | null; buyer_email: string; buyer_phone: string; clickid: string | null; host: string }[]>`
    SELECT o.event_id, o.created_at, o.paid_at, o.buyer_email, o.buyer_phone, o.clickid, (SELECT host FROM lp_domains WHERE landing_page_id = o.landing_page_id LIMIT 1) AS host
      FROM orders o WHERE o.id = ${orderId}`);

/** Requests the stub got since `from`, by kind of path. */
const since = (from: number) => stub.requests.slice(from);
const s2sOf = (requests: VendorStub["requests"], path: string) => requests.filter((r) => r.url.startsWith(path));
const capi = (requests: VendorStub["requests"], platform: "meta" | "tiktok") => requests.filter((r) => (platform === "meta" ? r.url.includes("/events") : r.url.includes("/event/track")));

describe("S2S postbacks (criterion 1)", () => {
  it("expands every macro URL-encoded, resolves {secret:name}, and a 2xx is sent", async () => {
    stub.requests.length = 0;
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(shop, { clickid: "click-ABC_123", subId: "s u b", pub: "p&p" });
      await payOrder(order);
      const from = stub.requests.length;
      expect(await fireDue(f, order.id)).toEqual(["sent", "sent", "sent"]);
      const [request] = s2sOf(since(from), "/mt");
      expect(request?.method).toBe("GET");
      expect(queryOf(request as NonNullable<typeof request>)).toEqual({
        c: "click-ABC_123",
        // stable per order: orders.id, never the public id
        t: order.id,
        p: "15000",
        s: "approved",
        sub: "s u b",
        pub: "p&p",
        k: API_KEY,
      });
      // The raw URL is percent-encoded: no space, ampersand or slash of a value reaches the wire as such.
      expect(request?.url).toContain("sub=s%20u%20b&pub=p%26p&k=ADNET-secret-k3y%2Fwith%2Bodd%26chars%3D1");
      const event = await eventOf(order.id, "s2s", "mt");
      expect(event).toMatchObject({ status: "sent", attempts: 1, last_http_status: 200, txid: order.id });
      const [attempt] = await attemptsOf(event.id);
      expect(attempt).toMatchObject({ attempt: 1, http_status: 200, error: null });
      expect(attempt?.latency_ms).toBeGreaterThanOrEqual(0);
    } finally {
      await f.close();
    }
  });

  it("logs the URL with the secret masked and the answer with every secret replaced, bounded to 4 KB", async () => {
    const f = firing(stub);
    const echoing = stub.reply;
    try {
      const order = await createAttributedOrder(shop, { clickid: "click-echo" });
      await payOrder(order);
      // A sink that echoes the request URL (and so the secret) and then pads the answer far past 4 KB.
      stub.reply = (request) => ({ status: 200, body: `received ${request.url} ${"x".repeat(10_000)}` });
      await fireDue(f, order.id);
      const event = await eventOf(order.id, "s2s", "mt");
      const [attempt] = await attemptsOf(event.id);
      expect(attempt?.request_url_redacted).toBe(`https://${ADNET_HOST}/mt?c=click-echo&t=${order.id}&p=15000&s=approved&sub=sub1&pub=pub1&k=[secret:api_key]`);
      const excerpt = attempt?.response_excerpt ?? "";
      // The first 4 KB of the answer, minus what the redaction shortened.
      expect(excerpt.length).toBeGreaterThan(3900);
      expect(excerpt.length).toBeLessThanOrEqual(4096);
      expect(excerpt.startsWith("received /mt?c=click-echo")).toBe(true);
      expect(excerpt).toContain("k=***");
      for (const form of [API_KEY, encodeURIComponent(API_KEY), JSON.stringify(API_KEY).slice(1, -1)]) expect(excerpt).not.toContain(form);
      // Nothing about the secret anywhere in the log row, and no raw e-mail or phone.
      const row = JSON.stringify(attempt);
      expect(row).not.toContain(API_KEY);
      expect(row).not.toContain("api_key=");
    } finally {
      stub.reply = echoing;
      await f.close();
    }
  });

  it("no macro value can add a query parameter, a path segment or a fragment: the whole value stays one value", async () => {
    const f = firing(stub);
    try {
      const nasty = "a&evil=1#frag/../..?x=y%2F";
      const order = await createAttributedOrder(shop, { clickid: nasty, subId: "../..", pub: "\\\\evil" });
      await payOrder(order);
      const from = stub.requests.length;
      await fireDue(f, order.id);
      const [request] = s2sOf(since(from), "/mt");
      const query = queryOf(request as NonNullable<typeof request>);
      expect(query["c"]).toBe(nasty);
      expect(query["sub"]).toBe("../..");
      expect(Object.keys(query).sort()).toEqual(["c", "k", "p", "pub", "s", "sub", "t"]);
      expect(new URL(request?.url ?? "", "http://x").pathname).toBe("/mt");
    } finally {
      await f.close();
    }
  });

  it("refuses a value that would form a dot segment in the template's path, without any request", async () => {
    const dotShop = await createTrackingShop({ mtTemplate: `https://${ADNET_HOST}/p/{clickid}/mt?t={txid}&p={payout}&s={status}`, apiKey: false, pixels: {} });
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(dotShop, { clickid: ".." });
      await payOrder(order);
      const from = stub.requests.length;
      expect(await fireDue(f, order.id)).toEqual(["pending"]);
      expect(since(from)).toEqual([]);
      const event = await eventOf(order.id, "s2s", "mt");
      expect(event.last_error).toMatch(/postback template is refused/);
      expect(event.attempts).toBe(1);
    } finally {
      await f.close();
      await retireEffects(dotShop);
    }
  });

  it("a non-2xx answer is a failed attempt, retried at 1 minute, with the status and body logged", async () => {
    const f = firing(stub);
    const before = stub.reply;
    try {
      stub.reply = () => ({ status: 503, body: "busy" });
      const order = await createAttributedOrder(shop);
      await payOrder(order);
      expect(await fireDue(f, order.id)).toEqual(["pending", "pending", "pending"]);
      const event = await eventOf(order.id, "s2s", "mt");
      expect(event).toMatchObject({ status: "pending", attempts: 1, last_http_status: 503, last_error: "HTTP 503" });
      const [due] = await sql<{ delay: number }[]>`SELECT round(extract(epoch FROM next_attempt_at - now()))::int AS delay FROM conversion_events WHERE id = ${event.id}`;
      expect(due?.delay).toBeGreaterThan(50);
      expect(due?.delay).toBeLessThanOrEqual(60);
      expect(await attemptsOf(event.id)).toMatchObject([{ attempt: 1, http_status: 503, response_excerpt: "busy", error: "HTTP 503" }]);
    } finally {
      stub.reply = before;
      await f.close();
    }
  });

  it("{secret:name} reads the adnet's OWN secret only: another adnet's api_key of the same name is never used", async () => {
    const other = await createTrackingShop({ apiKey: true, pixels: {} });
    const lonely = await createTrackingShop({ apiKey: false, pixels: {} });
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(lonely);
      await payOrder(order);
      const from = stub.requests.length;
      expect(await fireDue(f, order.id)).toEqual(["pending"]);
      expect(since(from)).toEqual([]);
      expect((await eventOf(order.id, "s2s", "mt")).last_error).toMatch(/no bound secret/);
      expect(other.adnetId).not.toBe(lonely.adnetId);
    } finally {
      await f.close();
      await retireEffects(other);
      await retireEffects(lonely);
    }
  });

  it("a CAPI access token cannot be named by a postback template, whatever the adnet's host", async () => {
    const tokenShop = await createTrackingShop({
      mtTemplate: `https://${ADNET_HOST}/mt?c={clickid}&t={txid}&p={payout}&s={status}&k={secret:capi.meta.${META_PIXEL}}`,
      apiKey: false,
    });
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(tokenShop);
      await payOrder(order);
      const from = stub.requests.length;
      await fireDue(f, order.id);
      expect(s2sOf(since(from), "/mt")).toEqual([]);
      expect((await eventOf(order.id, "s2s", "mt")).last_error).toMatch(/no bound secret/);
    } finally {
      await f.close();
      await retireEffects(tokenShop);
    }
  });

  it("an admin-defined template whose host is not the adnet's endpoint host is refused, without any request", async () => {
    const wrong = await createTrackingShop({ mtTemplate: "https://evil.example.test/mt?c={clickid}&t={txid}&p={payout}&s={status}", apiKey: false, pixels: {} });
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(wrong);
      await payOrder(order);
      const from = stub.requests.length;
      await fireDue(f, order.id);
      expect(since(from)).toEqual([]);
      expect((await eventOf(order.id, "s2s", "mt")).last_error).toMatch(/refused/);
    } finally {
      await f.close();
      await retireEffects(wrong);
    }
  });

  it("without a template, a click id or a host nothing is sent and the attempt says why", async () => {
    const f = firing(stub);
    const noTemplate = await createTrackingShop({ mtTemplate: null, apiKey: false, pixels: {} });
    try {
      const order = await createAttributedOrder(noTemplate);
      await payOrder(order);
      const from = stub.requests.length;
      await fireDue(f, order.id);
      expect(since(from)).toEqual([]);
      expect((await eventOf(order.id, "s2s", "mt")).last_error).toBe("the adnet has no mt postback template");
    } finally {
      await f.close();
      await retireEffects(noTemplate);
    }
  });
});

describe("Meta CAPI and TikTok Events API (criterion 2)", () => {
  it("sends Purchase and CompletePayment with the browser's event_id, orders.id as the order id, hashed identifiers and IDR", async () => {
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(shop);
      await payOrder(order);
      const row = await orderRow(order.id);
      const from = stub.requests.length;
      await fireDue(f, order.id);
      const [meta] = capi(since(from), "meta");
      const [tiktok] = capi(since(from), "tiktok");
      expect(meta?.method).toBe("POST");
      expect(meta?.url).toBe(`/v24.0/${META_PIXEL}/events`);
      const metaBody = JSON.parse(meta?.body ?? "{}") as { data: Record<string, unknown>[]; access_token: string };
      expect(metaBody.access_token).toBe(META_TOKEN);
      expect(metaBody.data[0]).toMatchObject({
        event_name: "Purchase",
        // THE shared event id: the order page's browser Purchase uses orders.event_id too (US-022), so Meta dedupes the pair.
        event_id: row.event_id,
        action_source: "website",
        event_source_url: `https://${row.host}/`,
        user_data: {
          em: [hashOf(row.buyer_email.toLowerCase())],
          ph: [hashOf(row.buyer_phone.replace(/^\+/, ""))],
          client_ip_address: "203.0.113.9",
          fbp: "fb.1.1700000000000.123456789",
          fbc: "fb.1.1700000000000.AbCdEf",
        },
        custom_data: { currency: "IDR", value: PRICE_IDR, order_id: order.id },
      });
      expect(tiktok?.url).toBe("/open_api/v1.3/event/track/");
      expect(tiktok?.headers["access-token"]).toBe(TIKTOK_TOKEN);
      const tiktokBody = JSON.parse(tiktok?.body ?? "{}") as { event_source: string; event_source_id: string; data: Record<string, unknown>[] };
      expect(tiktokBody).toMatchObject({ event_source: "web", event_source_id: TIKTOK_PIXEL });
      expect(tiktokBody.data[0]).toMatchObject({
        event: "CompletePayment",
        event_id: row.event_id,
        user: { email: hashOf(row.buyer_email.toLowerCase()), phone: hashOf(row.buyer_phone), ttclid: "ttclid-abc", ip: "203.0.113.9" },
        properties: { currency: "IDR", value: PRICE_IDR, order_id: order.id },
      });
      // Only hashes of the e-mail and phone leave the system.
      for (const body of [meta?.body ?? "", tiktok?.body ?? ""]) {
        expect(body).not.toContain(row.buyer_email);
        expect(body).not.toContain(row.buyer_phone);
        expect(body).not.toContain(row.buyer_phone.replace(/^\+/, ""));
      }
      // The conversion rows carry the same event_id, and Google has none (browser only).
      const events = await eventsOf(order.id);
      expect(events.filter((e) => e.kind === "mt").map((e) => [e.sink, e.event_id, e.status])).toEqual([
        ["meta", row.event_id, "sent"],
        ["s2s", row.event_id, "sent"],
        ["tiktok", row.event_id, "sent"],
      ]);
      expect(events.some((e) => e.sink === "google")).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("logs the CAPI URL and answer but never the access token", async () => {
    const f = firing(stub);
    const before = stub.reply;
    try {
      stub.reply = (request) => ({ status: 200, body: JSON.stringify({ echo: request.body }) });
      const order = await createAttributedOrder(shop);
      await payOrder(order);
      await fireDue(f, order.id);
      for (const sink of ["meta", "tiktok"]) {
        const event = await eventOf(order.id, sink, "mt");
        const attempts = await attemptsOf(event.id);
        expect(attempts[0]?.request_url_redacted).toBe(sink === "meta" ? `https://graph.facebook.com/v24.0/${META_PIXEL}/events` : "https://business-api.tiktok.com/open_api/v1.3/event/track/");
        const logged = JSON.stringify(attempts);
        expect(logged).not.toContain(META_TOKEN);
        expect(logged).not.toContain(TIKTOK_TOKEN);
      }
      const metaAttempt = (await attemptsOf((await eventOf(order.id, "meta", "mt")).id))[0];
      expect(metaAttempt?.response_excerpt).toContain("***");
    } finally {
      stub.reply = before;
      await f.close();
    }
  });

  it("waits, failed and visible, while no access token is set for the pixel, and alerts the Owner once", async () => {
    // Its own pixel ids: a token is per pixel for the whole deployment, and the other shops' pixels have one.
    const bare = await createTrackingShop({ pixels: { meta: "5555555555555", tiktok: "NOTOKENPIXEL00000" }, metaToken: false, tiktokToken: false, apiKey: false, mtTemplate: null, moTemplate: null });
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(bare, { attributed: false });
      await payOrder(order);
      const from = stub.requests.length;
      await fireDue(f, order.id);
      expect(since(from)).toEqual([]);
      expect((await eventOf(order.id, "meta", "mt")).last_error).toBe("no meta CAPI access token is set for this pixel");
      expect((await eventOf(order.id, "tiktok", "mt")).last_error).toBe("no tiktok CAPI access token is set for this pixel");
      expect(await alertsRaised("capi_token_missing:meta:5555555555555")).toEqual([{ kind: "capi_token_missing", severity: "warning" }]);
    } finally {
      await f.close();
      await retireEffects(bare);
    }
  });

  it("the MO is InitiateCheckout with the same event_id, and its S2S postback says pending with nothing earned", async () => {
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(shop, { clickid: "click-mo" });
      await sql`UPDATE orders SET snap_redirect_url = 'https://app.sandbox.midtrans.com/snap/v4/redirection/abc-123' WHERE id = ${order.id}`;
      const mo = first(await sql<{ id: string }[]>`SELECT public.enqueue_mo(${order.id}) AS id`).id;
      expect(await createOutboxProcessor(createMoConsumer(), { sql: workerSql, failpoint: inertFailpoint, log: silentLog })({ id: mo })).toBe("processed");
      const row = await orderRow(order.id);
      const from = stub.requests.length;
      expect(await fireDue(f, order.id)).toEqual(["sent", "sent", "sent"]);
      const [meta] = capi(since(from), "meta");
      const [tiktok] = capi(since(from), "tiktok");
      expect((JSON.parse(meta?.body ?? "{}") as { data: { event_name: string; event_id: string }[] }).data[0]).toMatchObject({ event_name: "InitiateCheckout", event_id: row.event_id });
      expect((JSON.parse(tiktok?.body ?? "{}") as { data: { event: string; event_id: string }[] }).data[0]).toMatchObject({ event: "InitiateCheckout", event_id: row.event_id });
      const [request] = s2sOf(since(from), "/mo");
      expect(queryOf(request as NonNullable<typeof request>)).toEqual({ c: "click-mo", t: order.id, p: "0", s: "pending" });
      // An unpaid order has MO rows only: MT is created when it is PAID, once (AC-T4).
      expect((await eventsOf(order.id)).map((e) => `${e.kind}/${e.sink}`)).toEqual(["mo/meta", "mo/s2s", "mo/tiktok"]);
    } finally {
      await f.close();
      await retireEffects(shop);
    }
  });
});

describe("organic means no click id (AC-T8)", () => {
  it("an order that kept its adnet but lost its click id is organic: no S2S row at MO or MT, pixels and CAPI only, and no postback is sent", async () => {
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(shop);
      // The checkout keeps the adnet of an order whose click id was dropped (malformed, too long, a contact detail).
      await sql`UPDATE orders SET clickid = NULL WHERE id = ${order.id}`;
      await sql`UPDATE orders SET snap_redirect_url = 'https://app.sandbox.midtrans.com/snap/v4/redirection/abc-123' WHERE id = ${order.id}`;
      const mo = first(await sql<{ id: string }[]>`SELECT public.enqueue_mo(${order.id}) AS id`).id;
      expect(await createOutboxProcessor(createMoConsumer(), { sql: workerSql, failpoint: inertFailpoint, log: silentLog })({ id: mo })).toBe("processed");
      expect((await eventsOf(order.id)).map((e) => `${e.kind}/${e.sink}`)).toEqual(["mo/meta", "mo/tiktok"]);
      await payOrder(order);
      expect((await eventsOf(order.id)).map((e) => `${e.kind}/${e.sink}`)).toEqual(["mo/meta", "mo/tiktok", "mt/meta", "mt/tiktok"]);
      const from = stub.requests.length;
      expect(await fireDue(f, order.id)).toEqual(["sent", "sent", "sent", "sent"]);
      expect(since(from).filter((r) => r.url.startsWith("/mo") || r.url.startsWith("/mt") || r.url.startsWith("/rev"))).toEqual([]);
      // The reports' label agrees: Organic, though the order has an adnet.
      const [label] = await sql<{ source: string; adnet: boolean }[]>`SELECT public.order_source_label(adnet_id, clickid) AS source, adnet_id IS NOT NULL AS adnet FROM orders WHERE id = ${order.id}`;
      expect(label).toEqual({ source: "Organic", adnet: true });
    } finally {
      await f.close();
      await retireEffects(shop);
    }
  });
});

describe("the MO consumer (conversion.mo)", () => {
  const consumerOf = () => createOutboxProcessor(createMoConsumer(), { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
  const enqueue = async (orderId: string): Promise<string> => {
    await sql`UPDATE orders SET snap_redirect_url = 'https://app.sandbox.midtrans.com/snap/v4/redirection/abc-123' WHERE id = ${orderId}`;
    return first(await sql<{ id: string }[]>`SELECT public.enqueue_mo(${orderId}) AS id`).id;
  };

  it("writes one MO row per sink in one transaction with processed_at, and a repeat of the job adds nothing", async () => {
    const order = await createAttributedOrder(shop);
    const id = await enqueue(order.id);
    expect(await consumerOf()({ id })).toBe("processed");
    expect(await consumerOf()({ id })).toBe("skipped");
    const events = await eventsOf(order.id);
    expect(events.map((e) => [e.kind, e.sink, e.status, e.txid])).toEqual([
      ["mo", "meta", "pending", order.id],
      ["mo", "s2s", "pending", order.id],
      ["mo", "tiktok", "pending", order.id],
    ]);
    // enqueue_mo is once per order: a second call returns the same outbox row.
    expect(await enqueue(order.id)).toBe(id);
  });

  it("an organic order gets pixel / CAPI rows only; an adnet without an MO template gets no S2S row", async () => {
    const organic = await createAttributedOrder(shop, { attributed: false });
    expect(await consumerOf()({ id: await enqueue(organic.id) })).toBe("processed");
    expect((await eventsOf(organic.id)).map((e) => e.sink)).toEqual(["meta", "tiktok"]);
    const noMo = await createTrackingShop({ moTemplate: null, pixels: {}, apiKey: false });
    const order = await createAttributedOrder(noMo);
    expect(await consumerOf()({ id: await enqueue(order.id) })).toBe("processed");
    expect(await eventsOf(order.id)).toEqual([]);
    await retireEffects(noMo);
  });

  it("a page without pixels and an organic order have no MO rows at all", async () => {
    const plain = await createTrackingShop({ pixels: {}, apiKey: false });
    const order = await createAttributedOrder(plain, { attributed: false });
    expect(await consumerOf()({ id: await enqueue(order.id) })).toBe("processed");
    expect(await eventsOf(order.id)).toEqual([]);
    await retireEffects(plain);
  });

  it("an outbox row that names no order is retried, never processed, and writes nothing", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO outbox (topic, dedupe_key, payload) VALUES ('conversion.mo', ${`conversion.mo:${suffix()}`}, '{"order_id": "00000000-0000-4000-8000-000000000000"}') RETURNING id`;
    await expect(consumerOf()({ id: row?.id ?? "" })).rejects.toThrow(/no longer exists/);
    const [bad] = await sql<{ id: string }[]>`INSERT INTO outbox (topic, dedupe_key, payload) VALUES ('conversion.mo', ${`conversion.mo:${suffix()}`}, '{}') RETURNING id`;
    await expect(consumerOf()({ id: bad?.id ?? "" })).rejects.toThrow(/no order id/);
    expect(await sql`SELECT 1 FROM outbox WHERE id = ANY (${[row?.id ?? "", bad?.id ?? ""]}::uuid[]) AND processed_at IS NOT NULL`).toEqual([]);
    await sql`UPDATE outbox SET processed_at = now() WHERE id = ANY (${[row?.id ?? "", bad?.id ?? ""]}::uuid[])`;
  });
});

describe("organic orders and refunds (criterion 3)", () => {
  it("an organic order fires pixels / CAPI only (no S2S, no reversal), and Google never", async () => {
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(shop, { attributed: false });
      const midtrans = await payOrder(order);
      const from = stub.requests.length;
      expect(await fireDue(f, order.id)).toEqual(["sent", "sent"]);
      expect(since(from).map((r) => r.url)).toEqual([`/v24.0/${META_PIXEL}/events`, "/open_api/v1.3/event/track/"]);
      await refundOrder(order, midtrans);
      expect((await eventsOf(order.id)).map((e) => `${e.kind}/${e.sink}/${e.status}`)).toEqual(["mt/meta/sent", "mt/tiktok/sent"]);
      expect(await fireDue(f, order.id)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("a refund after an MT reached the adnet sends the reversal postback (reversed, the payout taken back), once", async () => {
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(shop, { clickid: "click-rev" });
      const midtrans = await payOrder(order);
      await fireDue(f, order.id);
      await refundOrder(order, midtrans);
      const from = stub.requests.length;
      expect(await fireDue(f, order.id)).toEqual(["sent"]);
      const [request] = s2sOf(since(from), "/rev");
      expect(queryOf(request as NonNullable<typeof request>)).toEqual({ c: "click-rev", t: order.id, p: "15000", s: "reversed", k: API_KEY });
      // Meta and TikTok have no standard refund event: only the adnet is told.
      expect(since(from)).toHaveLength(1);
      expect((await eventsOf(order.id)).filter((e) => e.kind === "reversal").map((e) => [e.sink, e.status])).toEqual([["s2s", "sent"]]);
      // A replayed refund adds nothing and sends nothing.
      await refundOrder(order, midtrans);
      expect(await fireDue(f, order.id)).toEqual([]);
      expect(s2sOf(since(from), "/rev")).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("an MT that never left is cancelled by the refund and nothing is reversed", async () => {
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(shop);
      const midtrans = await payOrder(order);
      await refundOrder(order, midtrans);
      const from = stub.requests.length;
      expect(await fireDue(f, order.id)).toEqual([]);
      expect(since(from)).toEqual([]);
      expect((await eventsOf(order.id)).map((e) => [e.kind, e.sink, e.status, e.last_error])).toEqual([
        ["mt", "meta", "failed", EFFECT_CANCELLED],
        ["mt", "s2s", "failed", EFFECT_CANCELLED],
        ["mt", "tiktok", "failed", EFFECT_CANCELLED],
      ]);
    } finally {
      await f.close();
    }
  });

  it("a reversal waits while its MT is in flight, goes out after an MT that may have counted, and is skipped after one that never reached the sink", async () => {
    const f = firing(stub);
    try {
      const cases = [
        { mt: "sending", expected: "wait" },
        { mt: "uncertain", expected: "send" },
        { mt: "refused", expected: "skip" },
      ] as const;
      for (const { mt, expected } of cases) {
        const order = await createAttributedOrder(shop);
        const midtrans = await payOrder(order);
        const s2s = await eventOf(order.id, "s2s", "mt");
        if (mt === "sending") await sql`UPDATE conversion_events SET status = 'sending', attempts = 1, lease_until = now() + interval '5 minutes' WHERE id = ${s2s.id}`;
        if (mt === "uncertain") await sql`UPDATE conversion_events SET status = 'failed', attempts = 1, maybe_counted = true, failed_at = now(), last_error = ${`${NEEDS_MANUAL_REFIRE} (the send may have counted): timeout`} WHERE id = ${s2s.id}`;
        if (mt === "refused") await sql`UPDATE conversion_events SET status = 'pending', attempts = 3, last_error = 'HTTP 500', last_http_status = 500, next_attempt_at = now() + interval '30 minutes' WHERE id = ${s2s.id}`;
        await refundOrder(order, midtrans);
        if (expected === "skip") {
          // Every attempt was answered with an error: the sink never counted it, so payments adds no reversal at all.
          expect((await eventsOf(order.id)).filter((e) => e.kind === "reversal")).toEqual([]);
          continue;
        }
        const reversal = await eventOf(order.id, "s2s", "reversal");
        const from = stub.requests.length;
        const result = await f.process({ id: reversal.id });
        const requests = s2sOf(since(from), "/rev");
        if (expected === "wait") {
          expect(result).toBe("skipped");
          expect(requests).toEqual([]);
          expect((await eventOf(order.id, "s2s", "reversal")).status).toBe("pending");
          // The MT finishes (the sink counted it): now the reversal goes out.
          await sql`UPDATE conversion_events SET status = 'sent', sent_at = now() WHERE id = ${s2s.id}`;
          expect(await f.process({ id: reversal.id })).toBe("sent");
        } else {
          expect(result).toBe("sent");
          expect(requests).toHaveLength(1);
        }
      }
    } finally {
      await f.close();
    }
  });
});

describe("claim time: the order must be paid (the US-021 follow-up)", () => {
  it("never claims the MT of an order that is not paid: the row is taken out of the send path with payments' mark", async () => {
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(shop);
      await payOrder(order);
      // The order leaves PAID behind payments' back (here by hand), while its MT rows are still pending.
      await sql`UPDATE orders SET status = 'review' WHERE id = ${order.id}`;
      const from = stub.requests.length;
      expect(await fireDue(f, order.id)).toEqual(["skipped", "skipped", "skipped"]);
      expect(since(from)).toEqual([]);
      expect((await eventsOf(order.id)).map((e) => [e.status, e.last_error, e.attempts])).toEqual([
        ["failed", EFFECT_CANCELLED, 0],
        ["failed", EFFECT_CANCELLED, 0],
        ["failed", EFFECT_CANCELLED, 0],
      ]);
      // Failed rows are never claimed again, so nothing here resurrects them.
      for (const e of await eventsOf(order.id)) expect(await f.process({ id: e.id })).toBe("skipped");
      expect(since(from)).toEqual([]);
    } finally {
      await f.close();
    }
  });
});

describe("SSRF: every outbound call goes through safe-fetch (criterion 1 design constraint)", () => {
  const strict = (options: Parameters<typeof createSafeFetch>[0] = {}): { fetch: HttpFetch; close: () => Promise<void> } => {
    const safe = createSafeFetch({ timeoutMs: 2000, ...options });
    return { fetch: safe, close: () => safe.close() };
  };
  const hostShop = (host: string, path = "/mt") =>
    createTrackingShop({ endpointHost: host, mtTemplate: `https://${host}${path}?c={clickid}&t={txid}&p={payout}&s={status}`, apiKey: false, pixels: {} });

  async function fireOne(target: TrackingShop, client: { fetch: HttpFetch }): Promise<{ result: string; error: string | null }> {
    const f = firing(stub, { fetch: client.fetch });
    try {
      const order = await createAttributedOrder(target);
      await payOrder(order);
      const [result] = await fireDue(f, order.id);
      return { result: result ?? "none", error: (await eventOf(order.id, "s2s", "mt")).last_error };
    } finally {
      await f.close();
    }
  }

  it.each([
    ["a loopback address", "127.0.0.1"],
    ["the cloud metadata address", "169.254.169.254"],
    ["a private address", "10.0.0.5"],
    ["a private IPv6 address", "[fd00::1]"],
    ["localhost", "localhost"],
  ])("refuses %s: no connection is made, the attempt fails and is retried on the schedule", async (_what, host) => {
    // A listening loopback server proves nothing reaches it: it counts every connection.
    let connections = 0;
    const listener = createServer(() => undefined);
    listener.on("connection", () => connections++);
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as AddressInfo).port;
    const target = host === "127.0.0.1" || host === "localhost" ? `${host}:${String(port)}` : host;
    const client = strict();
    const shopFor = await hostShop(target);
    try {
      const { result, error } = await fireOne(shopFor, client);
      expect(result).toBe("pending");
      expect(error).toMatch(/blocked|address/i);
      expect(connections).toBe(0);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => listener.close(() => { resolve(); }));
      await retireEffects(shopFor);
    }
  });

  it("refuses a host that RESOLVES to a private address (DNS rebinding): the check is at connect time", async () => {
    const client = strict({ resolver: () => Promise.resolve([{ address: "10.1.2.3", family: 4 }]) });
    const target = await hostShop(ADNET_HOST);
    try {
      const { result, error } = await fireOne(target, client);
      expect(result).toBe("pending");
      expect(error).toMatch(/blocked address/);
    } finally {
      await client.close();
      await retireEffects(target);
    }
  });

  it("refuses http: an adnet postback is https only", async () => {
    const client = strict();
    const target = await createTrackingShop({ mtTemplate: `http://${ADNET_HOST}/mt?c={clickid}&t={txid}&p={payout}&s={status}`, apiKey: false, pixels: {} });
    try {
      const { result, error } = await fireOne(target, client);
      expect(result).toBe("pending");
      expect(error).toMatch(/not allowed/);
    } finally {
      await client.close();
      await retireEffects(target);
    }
  });

  it("never follows a redirect, whatever it points at, and does not take it for a retryable no: the sink got the request (security review US-024 M2)", async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits++;
      res.end("internal");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const internal = `http://127.0.0.1:${String((target.address() as AddressInfo).port)}/internal-metadata`;
    const redirecting = await startVendorStub();
    redirecting.reply = () => ({ status: 302, headers: { location: internal } });
    const f = firing(redirecting);
    try {
      const order = await createAttributedOrder(shop, { clickid: "click-redirect" });
      await payOrder(order);
      await fireDue(f, order.id);
      // An adnet has no event id to dedupe on: an uncertain send waits for the Owner's re-fire, it is never sent twice.
      const event = await eventOf(order.id, "s2s", "mt");
      expect(event).toMatchObject({ status: "failed", attempts: 1 });
      expect(event.last_error).toBe(`${NEEDS_MANUAL_REFIRE} (the send may have counted): HTTP 302 (redirect not followed)`);
      expect(first(await sql<{ maybe_counted: boolean }[]>`SELECT maybe_counted FROM conversion_events WHERE id = ${event.id}`).maybe_counted).toBe(true);
      // Meta and TikTok dedupe by event_id, so theirs are retried on the schedule.
      expect((await eventOf(order.id, "meta", "mt")).status).toBe("pending");
      expect(redirecting.requests.filter((r) => r.url.startsWith("/mt"))).toHaveLength(1);
      expect(targetHits).toBe(0);
    } finally {
      await f.close();
      await redirecting.close();
      await new Promise<void>((resolve) => target.close(() => { resolve(); }));
    }
  });

  it("reads at most 4 KB of an enormous answer and times out a sink that never answers: the second is uncertain, never blindly retried", async () => {
    const slow = await startVendorStub();
    const f = firing(slow, { timeoutMs: 700 });
    try {
      slow.reply = () => ({ status: 200, body: "z".repeat(3_000_000) });
      const big = await createAttributedOrder(shop);
      await payOrder(big);
      await fireDue(f, big.id);
      const bigEvent = await eventOf(big.id, "s2s", "mt");
      expect(bigEvent.status).toBe("sent");
      expect((await attemptsOf(bigEvent.id))[0]?.response_excerpt).toHaveLength(4096);

      slow.reply = () => ({ status: 200, body: "late", delayMs: 3000 });
      const late = await createAttributedOrder(shop);
      await payOrder(late);
      await fireDue(f, late.id);
      // An adnet (no event id to dedupe on) is not retried blindly after an uncertain send: the Owner re-fires it.
      const lateEvent = await eventOf(late.id, "s2s", "mt");
      expect(lateEvent.status).toBe("failed");
      expect(lateEvent.last_error?.startsWith(NEEDS_MANUAL_REFIRE)).toBe(true);
      // Meta and TikTok dedupe by event_id, so their uncertain sends are retried on the schedule.
      expect((await eventOf(late.id, "meta", "mt")).status).toBe("pending");
    } finally {
      await f.close();
      await slow.close();
    }
  });
});

describe("secrets stay in the worker (design constraint)", () => {
  it("a secret that does not open (sealed to another key) is a failed attempt, not a crash, and nothing is sent", async () => {
    let requests = 0;
    const f = firing(stub, {
      fire: createConversionFire({
        sql: workerSql,
        opener: createSecretOpener({ conversions: generateScopeKeyPair().privateKey }),
        fetch: () => {
          requests++;
          return Promise.reject(new Error("no request expected"));
        },
        metaApiVersion: "v24.0",
        log: silentLog,
      }),
    });
    try {
      const order = await createAttributedOrder(shop);
      await payOrder(order);
      expect(await fireDue(f, order.id)).toEqual(["pending", "pending", "pending"]);
      expect((await eventOf(order.id, "s2s", "mt")).last_error).toBe("a secret could not be opened");
      expect((await eventOf(order.id, "meta", "mt")).last_error).toBe("a secret could not be opened");
      expect(requests).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("the worker's opener holds the conversions key and nothing else", () => {
    expect(opener.scopes).toEqual(["conversions"]);
  });
});

describe("review fixes (US-024 review round 1)", () => {
  const slowFor = async (delayMs: number, status = 200): Promise<VendorStub> => {
    const slow = await startVendorStub();
    slow.reply = () => ({ status, body: "late", delayMs });
    return slow;
  };

  it("M2 / L3: a refund that lands while the MT request is in flight and an answer that says retry: the attempt stays logged, the MT is out of the send path (order_not_paid), the reversal is skipped", async () => {
    const slow = await slowFor(900, 500);
    const f = firing(slow);
    const s2sShop = await createTrackingShop({ pixels: {} });
    try {
      const order = await createAttributedOrder(s2sShop);
      const midtrans = await payOrder(order);
      const mt = await eventOf(order.id, "s2s", "mt");
      const original = f.process({ id: mt.id });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await refundOrder(order, midtrans);
      // The refund found the MT in flight: it needs a reversal row (the request may count), judged when it is claimed.
      expect((await eventsOf(order.id)).filter((e) => e.kind === "reversal").map((e) => e.status)).toEqual(["pending"]);
      expect(await original).toBe("failed");
      expect(await eventOf(order.id, "s2s", "mt")).toMatchObject({ status: "failed", last_error: EFFECT_CANCELLED, last_http_status: 500, attempts: 1 });
      expect(await attemptsOf(mt.id)).toMatchObject([{ attempt: 1, http_status: 500, error: "HTTP 500" }]);
      expect(first(await sql<{ maybe_counted: boolean }[]>`SELECT maybe_counted FROM conversion_events WHERE id = ${mt.id}`).maybe_counted).toBe(false);
      // The adnet answered an error, so it never counted the MT: nothing to reverse.
      const reversal = await eventOf(order.id, "s2s", "reversal");
      const from = slow.requests.length;
      expect(await f.process({ id: reversal.id })).toBe("failed");
      expect(slow.requests.slice(from)).toEqual([]);
      expect(await eventOf(order.id, "s2s", "reversal")).toMatchObject({ status: "failed", last_error: REVERSAL_SKIPPED });
    } finally {
      await f.close();
      await slow.close();
      await retireEffects(s2sShop);
    }
  });

  it("L5: an uncertain MT stays 'may have counted' through an Owner re-fire, so a refund before the re-fire is claimed still sends the reversal", async () => {
    const slow = await slowFor(1500);
    const quick = firing(slow, { timeoutMs: 400 });
    const s2sShop = await createTrackingShop({ pixels: {} });
    try {
      const order = await createAttributedOrder(s2sShop, { clickid: "click-sticky" });
      const midtrans = await payOrder(order);
      const mt = await eventOf(order.id, "s2s", "mt");
      // The adnet takes too long: an uncertain send.
      expect(await quick.process({ id: mt.id })).toBe("failed");
      expect((await eventOf(order.id, "s2s", "mt")).last_error?.startsWith(NEEDS_MANUAL_REFIRE)).toBe(true);
      // The Owner re-fires it; before the worker claims it the order is refunded.
      await sql`SELECT public.refire_conversion(${mt.id})`;
      expect(first(await sql<{ status: string; maybe_counted: boolean }[]>`SELECT status::text AS status, maybe_counted FROM conversion_events WHERE id = ${mt.id}`)).toEqual({ status: "pending", maybe_counted: true });
      await refundOrder(order, midtrans);
      expect(await eventOf(order.id, "s2s", "mt")).toMatchObject({ status: "failed", last_error: EFFECT_CANCELLED });
      // The reversal IS sent: the sink may have counted the first attempt.
      const ok = firing(stub);
      try {
        const from = stub.requests.length;
        const reversal = await eventOf(order.id, "s2s", "reversal");
        expect(await ok.process({ id: reversal.id })).toBe("sent");
        expect(s2sOf(since(from), "/rev")).toHaveLength(1);
      } finally {
        await ok.close();
      }
    } finally {
      await quick.close();
      await slow.close();
      await retireEffects(s2sShop);
    }
  });

  it("I10: the reversal takes back the payout the MT reported, not the adnet's setting at refund time", async () => {
    const f = firing(stub);
    const priced = await createTrackingShop({ pixels: {}, payoutIdr: 15_000 });
    try {
      const order = await createAttributedOrder(priced, { clickid: "click-payout" });
      const midtrans = await payOrder(order);
      const from = stub.requests.length;
      await fireDue(f, order.id);
      const mt = await eventOf(order.id, "s2s", "mt");
      expect(first(await sql<{ p: string }[]>`SELECT reported_payout_idr::text AS p FROM conversion_events WHERE id = ${mt.id}`).p).toBe("15000");
      // The Owner edits the payout between the MT and the refund.
      await sql`UPDATE adnets SET payout_idr = 99000 WHERE id = ${priced.adnetId}`;
      await refundOrder(order, midtrans);
      await fireDue(f, order.id);
      const [mtRequest, reversalRequest] = [s2sOf(since(from), "/mt")[0], s2sOf(since(from), "/rev")[0]];
      expect(queryOf(mtRequest as NonNullable<typeof mtRequest>)["p"]).toBe("15000");
      expect(queryOf(reversalRequest as NonNullable<typeof reversalRequest>)["p"]).toBe("15000");
    } finally {
      await f.close();
      await retireEffects(priced);
    }
  });

  it("I10: an MT answered with an error reports the CURRENT payout when it is tried again (nothing counted yet)", async () => {
    const flaky = await startVendorStub();
    const f = firing(flaky);
    const priced = await createTrackingShop({ pixels: {}, payoutIdr: 15_000 });
    try {
      const order = await createAttributedOrder(priced);
      await payOrder(order);
      flaky.reply = () => ({ status: 503, body: "busy" });
      await fireDue(f, order.id);
      await sql`UPDATE adnets SET payout_idr = 20000 WHERE id = ${priced.adnetId}`;
      await sql`UPDATE conversion_events SET next_attempt_at = now() WHERE order_id = ${order.id}`;
      flaky.reply = () => ({ status: 200, body: "ok" });
      await fireDue(f, order.id);
      expect(queryOf(flaky.requests[1] as NonNullable<(typeof flaky.requests)[number]>)["p"]).toBe("20000");
      expect(first(await sql<{ p: string }[]>`SELECT reported_payout_idr::text AS p FROM conversion_events WHERE order_id = ${order.id} AND kind = 'mt'`).p).toBe("20000");
    } finally {
      await f.close();
      await flaky.close();
      await retireEffects(priced);
    }
  });

  it("L6 (processor): the claim's time budget cuts the request: an adnet that takes 3 s is an uncertain failure after about 1 s, never a late success", async () => {
    const slow = await slowFor(3000);
    const f = firing(slow, { requestTimeoutMs: 1000, timeoutMs: 8000 });
    const s2sShop = await createTrackingShop({ pixels: {} });
    try {
      const order = await createAttributedOrder(s2sShop);
      await payOrder(order);
      const mt = await eventOf(order.id, "s2s", "mt");
      const started = Date.now();
      expect(await f.process({ id: mt.id })).toBe("failed");
      expect(Date.now() - started).toBeLessThan(2500);
      const after = await eventOf(order.id, "s2s", "mt");
      expect(after.status).toBe("failed");
      expect(after.last_error?.startsWith(NEEDS_MANUAL_REFIRE)).toBe(true);
      expect(first(await sql<{ maybe_counted: boolean }[]>`SELECT maybe_counted FROM conversion_events WHERE id = ${mt.id}`).maybe_counted).toBe(true);
    } finally {
      await f.close();
      await slow.close();
      await retireEffects(s2sShop);
    }
  });

  it("L6: the fire's time budget reaches the request: an AbortSignal that is already spent sends nothing, one that runs out mid-request ends it", async () => {
    const slow = await slowFor(2500);
    const stubbed = stubbedFetch(slow, { timeoutMs: 8000 });
    const fire = createConversionFire({ sql: workerSql, opener, fetch: stubbed.fetch, metaApiVersion: "v24.0", log: silentLog });
    const order = await createAttributedOrder(shop, { clickid: "click-budget" });
    const e = { id: randomUUID(), orderId: order.id, sink: "s2s", kind: "mt", adnetId: shop.adnetId, txid: order.id, eventId: randomUUID(), valueIdr: 49_000, payoutIdr: 15_000, attempt: 1 };
    try {
      const spent = AbortSignal.abort();
      expect(await fire(e, spent)).toMatchObject({ outcome: { kind: "failed", httpStatus: null, error: "the time budget ran out before the request was sent" }, requestUrlRedacted: null });
      expect(slow.requests).toEqual([]);
      const started = Date.now();
      const cut = await fire(e, AbortSignal.timeout(400));
      expect(Date.now() - started).toBeLessThan(2000);
      // The request had left: an uncertain send, never a blind retry for an adnet.
      expect(cut.outcome.kind).toBe("maybe_sent");
      expect(slow.requests).toHaveLength(1);
    } finally {
      await stubbed.close();
      await slow.close();
    }
  });

  it("AC-T4: an attributed order whose adnet has no MT template gets its S2S row already failed, visibly; the Owner fixes the adnet and re-fires it", async () => {
    const bare = await createTrackingShop({ pixels: {}, mtTemplate: null, apiKey: false });
    const f = firing(stub);
    try {
      const order = await createAttributedOrder(bare);
      await payOrder(order);
      const row = await eventOf(order.id, "s2s", "mt");
      expect(row).toMatchObject({ status: "failed", attempts: 0, last_error: "the adnet has no mt postback template" });
      expect(await fireDue(f, order.id)).toEqual([]);
      await sql`UPDATE adnets SET mt_url_template = ${`https://${ADNET_HOST}/mt?c={clickid}&t={txid}&p={payout}&s={status}`} WHERE id = ${bare.adnetId}`;
      await sql`SELECT public.refire_conversion(${row.id})`;
      expect(await fireDue(f, order.id)).toEqual(["sent"]);
    } finally {
      await f.close();
      await retireEffects(bare);
    }
  });
});
