// US-022 acceptance criteria 1-3 against PostgreSQL (as the public_rw login) and Valkey (ACL user `public`):
// the order status and claim routes, the exactly-once browser MT claim (two tabs at once give one fire),
// the masked page data, the pool number and the published-only legal pages.
import { randomBytes } from "node:crypto";
import { newOrderCode, newPublicId } from "@ebooktrivia/core";
import { clientIp, throttleBucket } from "@ebooktrivia/edge";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrderCard } from "../src/components/order/order-card.tsx";
import { parseLegalRequest, publishedLegalPage } from "../src/lib/legal.ts";
import type { OrderClaimBody, OrderErrorBody, OrderStatusBody } from "../src/lib/order/contract.ts";
import { getOrderStatus, poolNumber } from "../src/lib/order/data.ts";
import { handleOrderApi, ORDER_IP_LIMIT, ORDER_IP_WINDOW_MS, type OrderDeps, type OrderRoute } from "../src/lib/order/handler.ts";
import { toView } from "../src/lib/order/view.ts";
import { apiRequest, captureLog, createShop, DOMAIN, freshIp, newValkey, one, PRICE_IDR, publicSql, root, type Shop, uniquePhone, valkey } from "./support.ts";

const ORIGIN = `https://order.${DOMAIN}`;
const PIXELS = { meta: "1234567890123", tiktok: "ABCDEFGH12345678", gtag: "AW-123456789", gtag_label: "AbC_12-xyz" };
const NAME = "Budi Santoso";
const EMAIL = "budi.santoso@example.test";

interface Order {
  readonly id: string;
  readonly publicId: string;
  readonly eventId: string;
  readonly code: string;
  readonly phone: string;
}

/** An order of the shop, set to `status` the way the worker would (the status guard allows nobody else). */
async function newOrder(shop: Shop, status = "pending", paidAgoMinutes = 0): Promise<Order> {
  const publicId = newPublicId();
  const code = newOrderCode();
  const phone = uniquePhone();
  const row = await one(root<{ id: string; event_id: string }[]>`
    INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at)
    VALUES (${publicId}, ${code}, ${shop.landingPageId}, ${shop.programId}, ${shop.productId}, ${NAME}, ${phone}, ${EMAIL}, ${randomBytes(32)}, ${PRICE_IDR}, 'pending', now() + interval '1 hour')
    RETURNING id, event_id`);
  if (status !== "pending") {
    await root.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE worker_rw");
      // paid_at is set once (US-021), so a payment in the past is set here with the status.
      await tx`UPDATE orders SET status = ${status}, paid_at = CASE WHEN ${status} = 'paid' THEN now() - make_interval(mins => ${paidAgoMinutes}) END WHERE id = ${row.id}`;
    });
  }
  return { id: row.id, publicId, eventId: row.event_id, code, phone };
}

const withPixels = async (shop: Shop, pixels: unknown): Promise<void> => {
  await root`UPDATE landing_pages SET pixels = ${root.json(pixels as never)} WHERE id = ${shop.landingPageId}`;
};

function deps(overrides: Partial<OrderDeps> = {}) {
  const logs = captureLog();
  const value: OrderDeps = { sql: publicSql, valkey, domain: DOMAIN, log: logs.log, ...overrides };
  return { value, logs };
}

const call = (d: OrderDeps, route: OrderRoute, body: unknown, options: { origin?: string | null; ip?: string; contentType?: string } = {}): Promise<Response> =>
  handleOrderApi(d, route, apiRequest(`/api/v1/order/${route}`, body, { origin: options.origin === undefined ? ORIGIN : options.origin, ...(options.ip === undefined ? {} : { ip: options.ip }), ...(options.contentType === undefined ? {} : { contentType: options.contentType }) }));

const idOf = (publicId: string) => ({ v: 1, id: publicId });
const statusOf = async (d: OrderDeps, publicId: string): Promise<OrderStatusBody> => (await (await call(d, "status", idOf(publicId))).json()) as OrderStatusBody;
const claimOf = async (d: OrderDeps, publicId: string): Promise<OrderClaimBody> => (await (await call(d, "claim", idOf(publicId))).json()) as OrderClaimBody;

describe("criterion 1: the status route", () => {
  it.each([
    ["pending", "pending"],
    ["paid", "paid"],
    ["expired", "expired"],
    ["gateway_failed", "failed"],
    ["snap_create_failed", "failed"],
    ["review", "review"],
    ["refunded", "refunded"],
  ])("answers a %s order with the page state %s and nothing else", async (status, state) => {
    const shop = await createShop();
    const order = await newOrder(shop, status);
    const { value } = deps();
    const response = await call(value, "status", idOf(order.publicId));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({ v: 1, status: state });
  });

  it("follows the order through the worker's transitions (the page polls orders.status)", async () => {
    const shop = await createShop();
    const order = await newOrder(shop);
    const { value } = deps();
    expect((await statusOf(value, order.publicId)).status).toBe("pending");
    await root.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE worker_rw");
      await tx`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order.id}`;
    });
    expect((await statusOf(value, order.publicId)).status).toBe("paid");
  });

  it("gives an unknown id, a malformed id, a missing id and a body that is not JSON the very same 404", async () => {
    const { value } = deps();
    const answers = [];
    for (const body of [idOf(newPublicId()), idOf("short"), idOf("x".repeat(500)), idOf(`${newPublicId()}-1`), { v: 1 }, { v: 1, id: 5 }, { v: 1, id: ["a"] }, null, "not json", [], 42]) {
      const response = await call(value, "status", body, typeof body === "string" ? { contentType: "text/plain" } : {});
      answers.push({ status: response.status, body: await response.text(), headers: [...response.headers].filter(([k]) => k !== "content-length") });
    }
    expect(answers.map((a) => a.status)).toEqual(Array(answers.length).fill(404));
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]?.body).toBe(JSON.stringify({ v: 1, error: "not_found" } satisfies OrderErrorBody));
    const noBody = await handleOrderApi(value, "status", new Request(`https://order.${DOMAIN}/api/v1/order/status`, { method: "POST", headers: { origin: ORIGIN, "x-forwarded-for": freshIp() } }));
    expect(noBody.status).toBe(404);
    expect(await noBody.text()).toBe(answers[0]?.body);
  });

  it("refuses a body over 1 KiB as unknown, without reading it", async () => {
    const { value } = deps();
    const response = await call(value, "status", { v: 1, id: newPublicId(), pad: "x".repeat(2000) });
    expect(response.status).toBe(404);
  });

  it("refuses any Origin but the order origin with 403 and no CORS headers, before looking at the id", async () => {
    const shop = await createShop();
    const order = await newOrder(shop);
    const { value } = deps();
    for (const origin of [null, "null", "https://evil.example.test", `https://play.${DOMAIN}`, `https://api.${DOMAIN}`, shop.origin, `https://order.${DOMAIN}.evil.test`, `https://xorder.${DOMAIN}`, "not a url"]) {
      const response = await call(value, "status", idOf(order.publicId), { origin });
      expect({ origin, status: response.status, body: (await response.json()) as unknown, cors: response.headers.get("access-control-allow-origin") }).toEqual({ origin, status: 403, body: { v: 1, error: "origin" }, cors: null });
    }
    // The scheme and port do not matter (dev and e2e serve plain http on a port): the host does.
    expect((await call(value, "status", idOf(order.publicId), { origin: `http://order.${DOMAIN}:3205` })).status).toBe(200);
  });

  it("does not log a public id, a name, a phone number or an e-mail address", async () => {
    const shop = await createShop();
    const order = await newOrder(shop, "paid");
    const { value, logs } = deps();
    await call(value, "status", idOf(order.publicId));
    await call(value, "claim", idOf(order.publicId));
    await call(value, "status", idOf(newPublicId()));
    await call(value, "status", idOf(order.publicId), { origin: "https://evil.example.test" });
    const text = logs.lines.join("\n");
    for (const secret of [order.publicId, NAME, order.phone, EMAIL, order.code]) expect(text, secret).not.toContain(secret);
  });
});

describe("criterion 1: the per-IP rate limit (fail closed)", () => {
  it("answers 429 with Retry-After once the IP is over its limit, before it reads anything, and counts every route together", async () => {
    const shop = await createShop();
    const order = await newOrder(shop);
    const { value } = deps();
    const ip = freshIp();
    await valkey.set(`rl:order:ip:${throttleBucket(clientIp(new Headers({ "x-forwarded-for": ip })))}`, String(ORDER_IP_LIMIT - 1), "PX", ORDER_IP_WINDOW_MS);
    expect((await call(value, "status", idOf(order.publicId), { ip })).status).toBe(200);
    for (const route of ["status", "claim"] as const) {
      const limited = await call(value, route, idOf(order.publicId), { ip });
      expect(limited.status, route).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(await limited.json()).toEqual({ v: 1, error: "rate_limited" });
    }
    // Another client is not affected.
    expect((await call(value, "status", idOf(order.publicId), { ip: freshIp() })).status).toBe(200);
  });

  it("answers 503 when Valkey is down: never allowed without a limit", async () => {
    const shop = await createShop();
    const order = await newOrder(shop);
    const { value, logs } = deps({ valkey: await newValkey(1) });
    for (const route of ["status", "claim"] as const) {
      const response = await call(value, route, idOf(order.publicId));
      expect(response.status, route).toBe(503);
      expect(await response.json()).toEqual({ v: 1, error: "unavailable" });
    }
    expect(logs.lines.join("\n")).toContain("valkey_unavailable");
  });
});

describe("criterion 2: the exactly-once browser MT claim", () => {
  it("gives the pixel contract's values and the page's pixel ids to the first claim of a PAID order, and fire:false to every later one", async () => {
    const shop = await createShop();
    await withPixels(shop, PIXELS);
    const order = await newOrder(shop, "paid");
    const { value } = deps();
    const claim = await claimOf(value, order.publicId);
    expect(claim).toEqual({ v: 1, fire: true, event_id: order.eventId, transaction_id: order.id, value_idr: PRICE_IDR, pixels: PIXELS });
    for (let i = 0; i < 3; i++) expect(await claimOf(value, order.publicId)).toEqual({ v: 1, fire: false });
    expect((await root<{ at: Date | null }[]>`SELECT browser_mt_fired_at AS at FROM orders WHERE id = ${order.id}`)[0]?.at).toBeInstanceOf(Date);
  });

  it("fires for two tabs at once exactly once, whatever the interleaving", async () => {
    const shop = await createShop();
    await withPixels(shop, PIXELS);
    for (let round = 0; round < 3; round++) {
      const order = await newOrder(shop, "paid");
      const { value } = deps();
      const results = await Promise.all(Array.from({ length: 8 }, () => claimOf(value, order.publicId)));
      expect(results.filter((r) => r.fire), `round ${String(round)}`).toHaveLength(1);
      expect(results.filter((r) => !r.fire)).toHaveLength(7);
    }
  });

  it("never fires for an order that is not paid, and does not use the claim up: it fires once the order is paid", async () => {
    const shop = await createShop();
    await withPixels(shop, PIXELS);
    const { value } = deps();
    for (const status of ["pending", "review", "expired", "gateway_failed", "refunded"]) {
      const order = await newOrder(shop, status);
      expect(await claimOf(value, order.publicId), status).toEqual({ v: 1, fire: false });
      expect((await root<{ at: Date | null }[]>`SELECT browser_mt_fired_at AS at FROM orders WHERE id = ${order.id}`)[0]?.at, status).toBeNull();
    }
    const order = await newOrder(shop);
    expect(await claimOf(value, order.publicId)).toEqual({ v: 1, fire: false });
    await root.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE worker_rw");
      await tx`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order.id}`;
    });
    expect((await claimOf(value, order.publicId)).fire).toBe(true);
  });

  it("answers the claim of an unknown or malformed id with the same 404 as the status route", async () => {
    const { value } = deps();
    for (const id of [newPublicId(), "short"]) {
      const response = await call(value, "claim", idOf(id));
      expect({ status: response.status, body: (await response.json()) as unknown }).toEqual({ status: 404, body: { v: 1, error: "not_found" } });
    }
  });

  it("hands out only valid pixel ids: a bad value in the database is dropped, not passed to a browser", async () => {
    const shop = await createShop();
    await withPixels(shop, { meta: "1234567890123; script-src *", tiktok: PIXELS.tiktok, gtag: PIXELS.gtag, gtag_label: "x", extra: "<script>" });
    const order = await newOrder(shop, "paid");
    const claim = await claimOf(deps().value, order.publicId);
    expect(claim).toMatchObject({ fire: true, pixels: { tiktok: PIXELS.tiktok } });
    expect(JSON.stringify(claim)).not.toMatch(/script|AW-|gtag/);
  });

  it("gives nothing for an order paid more than an hour ago: the claim is a bearer action, the server-side conversion covers a late visitor", async () => {
    const shop = await createShop();
    await withPixels(shop, PIXELS);
    const order = await newOrder(shop, "paid", 120);
    expect(await claimOf(deps().value, order.publicId)).toEqual({ v: 1, fire: false });
    expect((await root<{ at: Date | null }[]>`SELECT browser_mt_fired_at AS at FROM orders WHERE id = ${order.id}`)[0]?.at).toBeNull();
  });

  it("does not hand the pixel ids to anything but the claim: the status answer never carries them", async () => {
    const shop = await createShop();
    await withPixels(shop, PIXELS);
    const order = await newOrder(shop, "paid");
    const text = await (await call(deps().value, "status", idOf(order.publicId))).text();
    for (const id of Object.values(PIXELS)) expect(text).not.toContain(id);
  });
});

describe("criterion 1: what the page can show (data, masking, the WhatsApp button)", () => {
  it("reads the order through get_order_status and renders only masked personal data", async () => {
    const shop = await createShop();
    await withPixels(shop, PIXELS);
    const order = await newOrder(shop, "paid");
    const record = await getOrderStatus(publicSql, order.publicId);
    expect(record).toMatchObject({ status: "paid", orderCode: order.code, productTitle: expect.stringContaining("Ebook Trivia") as unknown, amountIdr: PRICE_IDR, lpHost: shop.host });
    if (record === undefined) throw new Error("order");
    const view = toView(record, "6281199900011", DOMAIN);
    expect(view).toMatchObject({ state: "paid", code: order.code, name: "B*** S***", phone: `****${order.phone.slice(-3)}`, vendors: ["meta", "tiktok", "gtag"], loginHref: `https://play.${DOMAIN}/login` });
    const html = renderToStaticMarkup(
      createElement(OrderCard, {
        state: view.state,
        order: { ref: view.code, product: view.product, amount: view.amountIdr, name: view.name, whatsapp: view.phone },
        links: { trivia: view.loginHref, again: view.orderAgainHref, whatsapp: view.whatsappHref, help: view.whatsappHref },
      }),
    );
    const page = JSON.stringify(view) + html;
    for (const secret of ["Budi", "Santoso", EMAIL, "budi.santoso", order.phone, order.phone.slice(1), order.id, order.eventId, ...Object.values(PIXELS)]) expect(page, secret).not.toContain(secret);
    expect(html).toContain(order.code);
    expect(html).toContain(`****${order.phone.slice(-3)}`);
    expect(html).toContain("Kirim via WhatsApp");
    expect(decodeURIComponent(/href="(https:\/\/wa\.me\/[^"]+)"/.exec(html)?.[1] ?? "")).toContain(order.code);
    expect(html).not.toMatch(/token|midtrans|snap/i);
  });

  it("finds nothing for an unknown or malformed id and never raises", async () => {
    for (const id of [newPublicId(), "x", "' OR 1=1 --", "a".repeat(5000)]) expect(await getOrderStatus(publicSql, id)).toBeUndefined();
  });

  it("picks the WhatsApp number from the paired, active, WORKING sessions only", async () => {
    await root`DELETE FROM waha_sessions`;
    expect(await poolNumber(publicSql)).toBeUndefined();
    const server = await one(root<{ id: string }[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES ('W', 'https://waha-us022.invalid/', 'waha-us022.invalid') RETURNING id`);
    const add = (name: string, phone: string | null, status: string, active: boolean) =>
      root`INSERT INTO waha_sessions (server_id, session_name, phone, status, active) VALUES (${server.id}, ${name}, ${phone}, ${status}, ${active})`;
    await add("stopped", "+6281100000001", "STOPPED", true);
    await add("inactive", "+6281100000002", "WORKING", false);
    await add("unpaired", null, "WORKING", true);
    expect(await poolNumber(publicSql)).toBeUndefined();
    await add("good", "+6281199900011", "WORKING", true);
    expect(await poolNumber(publicSql)).toBe("6281199900011");
    await root`DELETE FROM waha_sessions`;
  });
});

describe("criterion 3: the legal pages (published versions only)", () => {
  it("shows a published version, an older published one too, and nothing for a draft or a version that does not exist", async () => {
    const shop = await createShop();
    const [program] = await root<{ slug: string }[]>`SELECT slug FROM programs WHERE id = ${shop.programId}`;
    const slug = program?.slug ?? "";
    const read = (kind: string, version: string) => {
      const request = parseLegalRequest(slug, kind, version);
      return request === undefined ? Promise.resolve(undefined) : publishedLegalPage(publicSql, request);
    };
    // createShop: terms 1 and 2 and privacy 1 published, terms 3 a draft.
    expect(await read("terms", "2")).toMatchObject({ title: "terms", body: "Isi", version: 2 });
    expect(await read("terms", "1")).toMatchObject({ version: 1 });
    expect(await read("privacy", "1")).toMatchObject({ version: 1 });
    expect(await read("terms", "3")).toBeUndefined();
    expect(await read("terms", "4")).toBeUndefined();
    expect(await read("privacy", "2")).toBeUndefined();
    expect(await read("terms", "0")).toBeUndefined();
    const other = await createShop();
    const [otherProgram] = await root<{ slug: string }[]>`SELECT slug FROM programs WHERE id = ${other.programId}`;
    expect(await publishedLegalPage(publicSql, { program: "no-such-program", kind: "terms", version: 1 })).toBeUndefined();
    // A version published later becomes visible; the program's other slug does not leak it.
    await root`UPDATE legal_pages SET published_at = now() WHERE program_id = ${shop.programId} AND kind = 'terms' AND version = 3`;
    expect(await read("terms", "3")).toMatchObject({ version: 3 });
    expect(await publishedLegalPage(publicSql, { program: otherProgram?.slug ?? "", kind: "terms", version: 3 })).toBeUndefined();
  });
});
