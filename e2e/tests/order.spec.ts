import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { newPublicId } from "@ebooktrivia/core";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { BUYER, ORDER_BROWSER_ARGS, ORDER_ORIGIN, ORDER_PORT, type Order, type OrderEnv, PLAY_ORIGIN, PRICE_IDR, startOrderEnv } from "../support/order.ts";

/**
 * US-022 against the production build of apps/public (`next start`, own database, Valkey and port) with the
 * order and play hosts mapped to it, so they are two origins:
 *   - the order page: id stripped from the address before any vendor script, polled, exactly one Purchase
 *     per vendor (also for two tabs at once and after a reload), per-vendor CSP, Referrer-Policy
 *     strict-origin, no cookies, no login token, only masked personal data, a plain page without JavaScript;
 *   - the legal pages on the play origin: published versions only, content shown as text;
 *   - the same 404 for an unknown and a malformed order id, and no order or legal route on the wrong host.
 */
test.describe.configure({ mode: "serial" });
test.use({ launchOptions: { args: ORDER_BROWSER_ARGS } });

const ALL_PIXELS = { meta: "1234567890123", tiktok: "ABCDEFGH12345678", gtag: "AW-123456789", gtag_label: "AbC_12-xyz" };
const META_ONLY = { meta: ALL_PIXELS.meta };
const TIKTOK_ONLY = { tiktok: ALL_PIXELS.tiktok };

let env: OrderEnv;
test.beforeAll(async () => {
  test.setTimeout(600_000);
  env = await startOrderEnv();
  await env.poolNumber();
});
test.afterAll(async () => {
  await env.stop();
});

interface VendorRequest {
  readonly url: string;
  readonly referer: string | undefined;
}

/**
 * Every request to a host that is not ours is a vendor's: answered with a script stub or 204, and recorded.
 * A script stub notes the page's address (location.href) in window.__vendorHrefs when it EXECUTES, which is
 * the address a vendor library would read: it must be the stripped one (see hrefsOfVendorScripts).
 */
async function stubVendors(context: BrowserContext): Promise<VendorRequest[]> {
  const seen: VendorRequest[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const { hostname } = new URL(request.url());
    if (hostname.endsWith(".example.test") || hostname === "127.0.0.1") {
      await route.continue();
      return;
    }
    seen.push({ url: request.url(), referer: request.headers()["referer"] });
    if (request.resourceType() === "script") {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: "(window.__vendorHrefs = window.__vendorHrefs || []).push(location.href);" });
    }
    else await route.fulfill({ status: 204 });
  });
  return seen;
}

/** CSP violations and page errors of a page. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy|Refused to/i.test(message.text())) problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  return problems;
}

interface Purchases {
  readonly meta: unknown[][];
  readonly tiktok: unknown[][];
  readonly gtag: unknown[][];
}

/** The Purchase calls the page made, read from the vendor stubs the page installed. */
const purchases = (page: Page, tiktokId: string): Promise<Purchases> =>
  page.evaluate((id) => {
    const w = window as unknown as { fbq?: { queue?: unknown[][] }; ttq?: { _i?: Record<string, unknown[][]> }; dataLayer?: ArrayLike<unknown>[] };
    return {
      meta: (w.fbq?.queue ?? []).filter((call) => call[0] === "trackSingle").map((call) => [...call]),
      tiktok: (w.ttq?._i?.[id] ?? []).filter((call) => call[0] === "track").map((call) => [...call]),
      gtag: (w.dataLayer ?? []).map((entry) => Array.from(entry)).filter((entry) => entry[0] === "event"),
    };
  }, tiktokId);

const total = (p: Purchases): number => p.meta.length + p.tiktok.length + p.gtag.length;

/** location.href as each vendor script saw it when it ran: the address must be the stripped one by then. */
const hrefsOfVendorScripts = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __vendorHrefs?: string[] }).__vendorHrefs ?? []);
const orderUrl = (order: Order): string => `${ORDER_ORIGIN}/${order.publicId}`;
const firedAt = async (order: Order): Promise<Date | null> => (await env.sql<{ at: Date | null }[]>`SELECT browser_mt_fired_at AS at FROM orders WHERE id = ${order.id}`)[0]?.at ?? null;

test("a paid order: the id is stripped before any vendor script, Purchase fires once per vendor, nothing unmasked or secret is on the page", async ({ browser }) => {
  const shop = await env.shop(ALL_PIXELS);
  const order = await env.order(shop, "paid");
  const context = await browser.newContext();
  const vendors = await stubVendors(context);
  const page = await context.newPage();
  const problems = watch(page);

  const response = await page.goto(orderUrl(order));
  expect(response?.status()).toBe(200);
  const headers = response?.headers() ?? {};
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' /);
  expect(csp).toContain("https://connect.facebook.net");
  expect(csp).toContain("https://analytics.tiktok.com");
  expect(csp).toContain("https://www.googletagmanager.com");
  expect(csp).not.toMatch(/unsafe-eval|strict-dynamic/);
  expect(csp.match(/script-src[^;]*/)?.[0]).not.toContain("unsafe-inline");
  expect(headers["referrer-policy"]).toBe("strict-origin");
  expect(headers["set-cookie"]).toBeUndefined();
  expect(headers["cache-control"]).toContain("no-store");

  // All three vendors got their one Purchase.
  await expect.poll(async () => total(await purchases(page, ALL_PIXELS.tiktok)), { timeout: 15_000 }).toBe(3);
  const fired = await purchases(page, ALL_PIXELS.tiktok);
  expect(fired.meta).toEqual([["trackSingle", ALL_PIXELS.meta, "Purchase", { value: PRICE_IDR, currency: "IDR" }, { eventID: order.eventId }]]);
  expect(fired.tiktok).toEqual([["track", "CompletePayment", { value: PRICE_IDR, currency: "IDR" }, { event_id: order.eventId }]]);
  expect(fired.gtag).toEqual([["event", "conversion", { send_to: `${ALL_PIXELS.gtag}/${ALL_PIXELS.gtag_label}`, value: PRICE_IDR, currency: "IDR", transaction_id: order.id }]]);
  expect(await firedAt(order)).not.toBeNull();

  // The address no longer holds the id, the tab still does (sessionStorage), and no vendor request carried it.
  expect(page.url()).toBe(`${ORDER_ORIGIN}/`);
  expect(await page.evaluate(() => window.sessionStorage.getItem("ebt:order:1"))).toBe(order.publicId);
  expect(vendors.length).toBeGreaterThanOrEqual(3);
  // When each vendor script RAN, the page's address was already the stripped one: no id, no order_id.
  const hrefs = await hrefsOfVendorScripts(page);
  expect(hrefs).toHaveLength(3);
  for (const href of hrefs) expect(href).toBe(`${ORDER_ORIGIN}/`);
  for (const vendor of vendors) {
    expect(vendor.referer, vendor.url).toBe(`${ORDER_ORIGIN}/`);
    expect(JSON.stringify(vendor)).not.toContain(order.publicId);
    expect(vendor.url).not.toContain("order_id");
  }

  // What the buyer sees: the code, the status, masked data, the WhatsApp button and the login call to action.
  await expect(page.getByTestId("order-code")).toHaveText(order.code);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pembayaran berhasil");
  const html = await page.content();
  for (const secret of [BUYER.name, "Budi", "Santoso", BUYER.email, order.phone, order.phone.slice(3), order.id, order.eventId, "snap", "midtrans"]) expect(html, secret).not.toContain(secret);
  expect(html).not.toMatch(/magic|otp=|[?&]token=|login_token/i);
  await expect(page.getByText("B*** S***")).toBeVisible();
  await expect(page.getByText(`****${order.phone.slice(-3)}`)).toBeVisible();
  const wa = await page.getByTestId("order-whatsapp").getAttribute("href");
  expect(wa).toMatch(/^https:\/\/wa\.me\/6281199900011\?text=/);
  expect(decodeURIComponent(wa ?? "")).toContain(order.code);
  // WhatsApp first (2026-11-25): the big button asks our number for the ebook and the trivia access; the login is a small link under it.
  expect(decodeURIComponent(wa ?? "")).toContain("saya mau ambil ebook");
  await expect(page.getByTestId("order-whatsapp")).toHaveText("Ambil Ebook & Akses Trivia via WhatsApp");
  await expect(page.getByTestId("order-body")).toHaveText(/^Langkah terakhir: chat kami di WhatsApp\./);
  await expect(page.getByTestId("order-whatsapp-note")).toBeVisible();
  await expect(page.getByRole("link", { name: "Masuk ke Trivia" })).toHaveAttribute("href", "https://play.example.test/login");
  const [waBox, loginBox] = await Promise.all([page.getByTestId("order-whatsapp").boundingBox(), page.getByTestId("order-trivia-link").boundingBox()]);
  expect((waBox?.y ?? 0) < (loginBox?.y ?? 0)).toBe(true);
  expect((waBox?.height ?? 0) > (loginBox?.height ?? 0)).toBe(true);

  // No cookie anywhere, no CSP violation, no script error.
  expect(await context.cookies()).toEqual([]);
  expect(problems).toEqual([]);

  // A reload (the address is now "/") finds the order again from sessionStorage and fires nothing.
  await page.reload();
  await expect(page.getByTestId("order-code")).toHaveText(order.code);
  await page.waitForTimeout(1500);
  expect(page.url()).toBe(`${ORDER_ORIGIN}/`);
  expect(total(await purchases(page, ALL_PIXELS.tiktok))).toBe(0);
  await context.close();
});

test("two tabs at once fire Purchase exactly once", async ({ browser }) => {
  const shop = await env.shop(META_ONLY);
  const order = await env.order(shop, "paid");
  const context = await browser.newContext();
  await stubVendors(context);
  const [a, b] = await Promise.all([context.newPage(), context.newPage()]);
  await Promise.all([a.goto(orderUrl(order)), b.goto(orderUrl(order))]);
  await expect(a.getByTestId("order-code")).toHaveText(order.code);
  await expect(b.getByTestId("order-code")).toHaveText(order.code);
  await expect.poll(async () => (await purchases(a, "")).meta.length + (await purchases(b, "")).meta.length, { timeout: 15_000 }).toBe(1);
  await a.waitForTimeout(2000);
  expect((await purchases(a, "")).meta.length + (await purchases(b, "")).meta.length).toBe(1);
  await context.close();
});

test("a pending order is polled, loads no vendor script and claims nothing; once paid it fires once and the poll stops", async ({ browser }) => {
  const shop = await env.shop(META_ONLY);
  const order = await env.order(shop);
  const context = await browser.newContext();
  const vendors = await stubVendors(context);
  const page = await context.newPage();
  const problems = watch(page);
  const calls: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/order/")) calls.push(path);
  });

  await page.goto(orderUrl(order));
  const live = page.getByTestId("order-live");
  await expect(live).toHaveAttribute("data-state", "pending");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Menunggu pembayaran");
  await expect(page.getByRole("button", { name: "Masuk ke Trivia" })).toBeDisabled();
  await expect.poll(() => calls.filter((c) => c.endsWith("/status")).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  expect(calls.filter((c) => c.endsWith("/claim"))).toEqual([]);
  expect(vendors).toEqual([]);
  expect(await firedAt(order)).toBeNull();

  await env.setStatus(order, "paid");
  await expect(live).toHaveAttribute("data-state", "paid", { timeout: 20_000 });
  await expect(page.getByTestId("order-announce")).toHaveText(/Pembayaran berhasil/);
  await expect.poll(async () => (await purchases(page, "")).meta.length, { timeout: 15_000 }).toBe(1);

  // A terminal state ends the poll: no further status request, no second claim, no second Purchase.
  const statusCalls = calls.filter((c) => c.endsWith("/status")).length;
  await page.waitForTimeout(8000);
  expect(calls.filter((c) => c.endsWith("/status")).length).toBe(statusCalls);
  expect(calls.filter((c) => c.endsWith("/claim"))).toHaveLength(1);
  expect((await purchases(page, "")).meta).toHaveLength(1);
  expect(problems).toEqual([]);
  await context.close();
});

test("the Midtrans dashboard's /?order_id={publicId}-{n} shows that order and strips the query", async ({ browser }) => {
  const shop = await env.shop({});
  const order = await env.order(shop, "expired");
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${ORDER_ORIGIN}/?order_id=${order.publicId}-2&status_code=407&transaction_status=expire`);
  await expect(page.getByTestId("order-code")).toHaveText(order.code);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pembayaran kedaluwarsa");
  // The page is server-rendered; the address is stripped as soon as its script has hydrated.
  await expect(page).toHaveURL(`${ORDER_ORIGIN}/`);
  await expect(page.getByRole("link", { name: "Pesan lagi" })).toHaveAttribute("href", `https://${shop.host}/`);
  await context.close();
});

test("the finish redirect's own query is stripped too, and a root without an order says so", async ({ browser }) => {
  const shop = await env.shop({});
  const order = await env.order(shop, "pending");
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${orderUrl(order)}?order_id=${order.publicId}-1&status_code=201&transaction_status=pending`);
  await expect(page.getByTestId("order-code")).toHaveText(order.code);
  await expect(page).toHaveURL(`${ORDER_ORIGIN}/`);
  await context.close();

  const fresh = await browser.newContext();
  const root = await fresh.newPage();
  const response = await root.goto(`${ORDER_ORIGIN}/`);
  expect(response?.status()).toBe(200);
  await expect(root.getByRole("heading", { level: 1 })).toHaveText("Pesanan tidak ditemukan");
  await fresh.close();
});

test("the dashboard's /?order_id= form also strips the address before any vendor script runs, and fires once", async ({ browser }) => {
  const shop = await env.shop(META_ONLY);
  const order = await env.order(shop, "paid");
  const context = await browser.newContext();
  const vendors = await stubVendors(context);
  const page = await context.newPage();
  await page.goto(`${ORDER_ORIGIN}/?order_id=${order.publicId}-3&status_code=200&transaction_status=settlement`);
  await expect.poll(async () => (await purchases(page, "")).meta.length, { timeout: 15_000 }).toBe(1);
  const hrefs = await hrefsOfVendorScripts(page);
  expect(hrefs).toEqual([`${ORDER_ORIGIN}/`]);
  for (const vendor of vendors) {
    expect(vendor.referer).toBe(`${ORDER_ORIGIN}/`);
    expect(JSON.stringify(vendor)).not.toContain(order.publicId);
  }
  await context.close();
});

test("an expired order that is paid late: the page keeps asking at the slow interval, then shows paid and claims once", async ({ browser }) => {
  const shop = await env.shop(META_ONLY);
  const order = await env.order(shop, "expired");
  const context = await browser.newContext();
  const vendors = await stubVendors(context);
  const page = await context.newPage();
  const problems = watch(page);
  const calls: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/order/")) calls.push(path);
  });
  await page.goto(orderUrl(order));
  const live = page.getByTestId("order-live");
  await expect(live).toHaveAttribute("data-state", "expired");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pembayaran kedaluwarsa");
  expect(vendors).toEqual([]);

  // A late settlement: the worker moves the order to paid; the next slow poll (30 s) shows it.
  await env.setStatus(order, "paid");
  await expect(live).toHaveAttribute("data-state", "paid", { timeout: 45_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pembayaran berhasil");
  await expect(page.getByTestId("order-announce")).toHaveText(/Pembayaran berhasil/);
  await expect.poll(async () => (await purchases(page, "")).meta.length, { timeout: 15_000 }).toBe(1);
  expect(calls.filter((c) => c.endsWith("/claim"))).toHaveLength(1);
  expect(await firedAt(order)).not.toBeNull();
  expect(problems).toEqual([]);
  await context.close();
});

test("the root resumes a tab's order from sessionStorage without flashing 'not found'", async ({ browser }) => {
  const shop = await env.shop({});
  const order = await env.order(shop, "pending");
  const context = await browser.newContext();
  const page = await context.newPage();
  // The tab already has its order; the root is reloaded. Record every moment the "not found" text is on screen.
  await page.addInitScript((id) => {
    window.sessionStorage.setItem("ebt:order:1", id);
    const note = () => {
      // At document start there is no body yet (the type says there always is one).
      const body = document.body as HTMLElement | null;
      if ((body?.innerText ?? "").includes("Pesanan tidak ditemukan")) window.sessionStorage.setItem("saw-not-found", "1");
    };
    new MutationObserver(note).observe(document, { subtree: true, childList: true, characterData: true });
  }, order.publicId);
  await page.goto(`${ORDER_ORIGIN}/`);
  await expect(page.getByTestId("order-code")).toHaveText(order.code);
  await expect(page).toHaveURL(`${ORDER_ORIGIN}/`);
  expect(await page.evaluate(() => window.sessionStorage.getItem("saw-not-found"))).toBeNull();
  await context.close();
});

test("an unknown id, a malformed id and any other path are the same 404 page", async ({ browser }) => {
  const shop = await env.shop(ALL_PIXELS);
  const order = await env.order(shop, "paid");
  const context = await browser.newContext();
  const page = await context.newPage();
  const seen: { status: number | undefined; text: string; csp: string }[] = [];
  for (const path of [`/${newPublicId()}`, "/short", `/${order.publicId}/extra`, "/favicon.ico", "/legal/x/terms/1", `/order/${order.publicId}`]) {
    const response = await page.goto(`${ORDER_ORIGIN}${path}`);
    seen.push({ status: response?.status(), text: await page.locator("main").innerText(), csp: response?.headers()["content-security-policy"] ?? "" });
  }
  expect(seen.map((s) => s.status)).toEqual(Array(seen.length).fill(404));
  expect(new Set(seen.map((s) => s.text)).size).toBe(1);
  expect(seen[0]?.text).toContain("Halaman tidak ditemukan");
  // The 404 of an order that does not exist never gets a vendor in its CSP.
  for (const s of seen) expect(s.csp).not.toMatch(/facebook|tiktok|google/);
  expect(await firedAt(order)).toBeNull();
  await context.close();
});

test("the CSP lists only the vendors the landing page has a pixel id for", async ({ browser }) => {
  const context = await browser.newContext();
  const vendors = await stubVendors(context);
  const page = await context.newPage();
  const cspOf = async (pixels: Record<string, string>): Promise<string> => {
    const order = await env.order(await env.shop(pixels), "pending");
    return (await page.goto(orderUrl(order)))?.headers()["content-security-policy"] ?? "";
  };
  const tiktok = await cspOf(TIKTOK_ONLY);
  expect(tiktok).toContain("https://analytics.tiktok.com");
  expect(tiktok).not.toMatch(/facebook|google/);
  const meta = await cspOf(META_ONLY);
  expect(meta).toContain("https://connect.facebook.net");
  expect(meta).not.toMatch(/tiktok|google/);
  const none = await cspOf({});
  expect(none).not.toMatch(/facebook|tiktok|google|doubleclick/);
  // Google needs both its id and its label.
  const half = await cspOf({ gtag: ALL_PIXELS.gtag });
  expect(half).not.toMatch(/facebook|tiktok|google/);
  expect(vendors).toEqual([]);

  // A paid order of a page with no pixel has nothing to claim: no vendor request, the claim stays unused.
  const noPixels = await env.order(await env.shop({}), "paid");
  const calls: string[] = [];
  page.on("request", (request) => calls.push(new URL(request.url()).pathname));
  await page.goto(orderUrl(noPixels));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pembayaran berhasil");
  await page.waitForTimeout(1500);
  expect(vendors).toEqual([]);
  expect(calls.filter((c) => c.endsWith("/claim"))).toEqual([]);
  expect(await firedAt(noPixels)).toBeNull();
  await context.close();
});

test("a plain page without JavaScript still shows the code, the status and the WhatsApp link", async ({ browser }) => {
  const shop = await env.shop(ALL_PIXELS);
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  for (const [status, title] of [
    ["pending", "Menunggu pembayaran"],
    ["paid", "Pembayaran berhasil"],
  ] as const) {
    const order = await env.order(shop, status);
    const response = await page.goto(orderUrl(order));
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByTestId("order-code")).toHaveText(order.code);
    expect(decodeURIComponent((await page.getByTestId("order-whatsapp").getAttribute("href")) ?? "")).toContain(order.code);
    expect(await firedAt(order)).toBeNull();
    // Nothing is checking without a script, so the page does not say it is: it says how to check.
    await expect(page.getByText(/Dicek terakhir|Memeriksa pembayaran/)).toHaveCount(0);
    // (getByText skips <noscript>, so the note is found by its element.)
    const note = page.locator("noscript p");
    if (status === "pending") {
      await expect(note).toHaveText("Muat ulang halaman untuk memeriksa status pembayaran.");
      await expect(note).toBeVisible();
    } else {
      await expect(note).toHaveCount(0);
    }
  }
  await context.close();
});

test("the order and the play origins serve only their own routes, and the order API refuses another origin", async ({ browser }) => {
  const shop = await env.shop(META_ONLY);
  const order = await env.order(shop, "paid");
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const url of [`${PLAY_ORIGIN}/order/${order.publicId}`, `${PLAY_ORIGIN}/order`, `${PLAY_ORIGIN}/api/v1/order/status`, `${ORDER_ORIGIN}/legal/${shop.programSlug}/terms/2`]) {
    expect((await page.goto(url))?.status(), url).toBe(404);
  }
  const body = { v: 1, id: order.publicId };
  // The API client runs in Node, which does not know the host mapping of the browser: it reaches the server by
  // its address and says which host it means.
  const orderHost = new URL(ORDER_ORIGIN).host;
  const direct = new URL(ORDER_ORIGIN);
  direct.hostname = "127.0.0.1";
  const status = (origin: string | undefined) =>
    context.request.post(`${direct.origin}/api/v1/order/status`, { data: body, headers: { host: orderHost, ...(origin === undefined ? {} : { origin }) } });
  expect((await status(PLAY_ORIGIN)).status()).toBe(403);
  expect((await status("https://evil.example.test")).status()).toBe(403);
  expect((await status(undefined)).status()).toBe(403);
  const ok = await status(ORDER_ORIGIN);
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toEqual({ v: 1, status: "paid" });
  expect(ok.headers()["set-cookie"]).toBeUndefined();
  expect(ok.headers()["access-control-allow-origin"]).toBeUndefined();
  expect((await context.request.get(`${direct.origin}/api/v1/order/status`, { headers: { host: orderHost } })).status()).toBe(405);
  expect(await firedAt(order)).toBeNull();
  await context.close();
});

/** A request to the app's own address by RAW path (no URL normalisation on this side) with the given Host header. */
function rawRequest(host: string, method: string, path: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host };
    if (body !== undefined) Object.assign(headers, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), origin: ORDER_ORIGIN });
    const req = httpRequest({ host: "127.0.0.1", port: ORDER_PORT, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("Next's pages-router data route, which the public build id opens, reaches nothing: no order page, no order API, no legal page, on any host (security N1)", async () => {
  // The build id is public (it is in every page's HTML) and Next resolves /_next/data/{buildId}/{page}.json to the
  // page path BEFORE the proxy runs, so the proxy refuses the route itself (lib/order/routing.ts).
  const buildId = readFileSync(fileURLToPath(new URL("../../apps/public/.next/BUILD_ID", import.meta.url)), "utf8").trim();
  expect(buildId).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  const shop = await env.shop(META_ONLY);
  const order = await env.order(shop, "paid");
  const data = `/_next/data/${buildId}`;
  const hosts = [new URL(ORDER_ORIGIN).host, new URL(PLAY_ORIGIN).host, `${shop.host}:${String(ORDER_PORT)}`, `order.example.test.:${String(ORDER_PORT)}`, `127.0.0.1:${String(ORDER_PORT)}`];
  const paths = [
    `${data}/order/${order.publicId}.json`,
    `${data}/${order.publicId}.json`,
    `${data}/legal/${shop.programSlug}/terms/2.json`,
    `${data}/api/v1/order/status.json`,
    `${data}/api/v1/order/claim.json`,
    `/_next/%64ata/${buildId}/order/${order.publicId}.json`,
    `/%5Fnext/data/${buildId}/order/${order.publicId}.json`,
    `/_NEXT/DATA/${buildId}/order/${order.publicId}.json`,
    `/_next/static/../data/${buildId}/order/${order.publicId}.json`,
    `/assets/../_next/data/${buildId}/order/${order.publicId}.json`,
  ];
  const body = JSON.stringify({ v: 1, id: order.publicId });
  const seen: string[] = [];
  for (const host of hosts) {
    for (const path of paths) {
      for (const method of ["GET", "POST"]) {
        const answer = await rawRequest(host, method, path, method === "POST" ? body : undefined);
        seen.push(`${host} ${method} ${path} -> ${String(answer.status)}`);
        expect(answer.status, `${host} ${method} ${path}`).toBe(404);
        // Nothing of the order, its API or the legal page is in what comes back.
        for (const leak of [order.code, "Pembayaran berhasil", "Menunggu pembayaran", "not_found", '"status"', "Syarat dan Ketentuan", "legal-document"]) {
          expect(answer.text, `${host} ${method} ${path}`).not.toContain(leak);
        }
      }
    }
  }
  expect(seen.length).toBe(hosts.length * paths.length * 2);

  // The other route the proxy's matcher leaves to Next, the image optimizer, fetches the path it is given
  // internally: it must not hand back the order page or the legal page (it answers an error: not an image).
  for (const host of hosts) {
    for (const url of [`/${order.publicId}`, `/order/${order.publicId}`, `/legal/${shop.programSlug}/terms/2`, `/api/v1/order/status`]) {
      const answer = await rawRequest(host, "GET", `/_next/image?url=${encodeURIComponent(url)}&w=64&q=75`);
      expect(answer.status, `${host} image ${url}`).not.toBe(200);
      for (const leak of [order.code, "Pembayaran berhasil", "Syarat dan Ketentuan", '"status"']) expect(answer.text, `${host} image ${url}`).not.toContain(leak);
    }
  }
  // The order was never claimed by any of it.
  expect(await firedAt(order)).toBeNull();

  // The routes themselves still work where they belong.
  const page = await rawRequest(new URL(ORDER_ORIGIN).host, "GET", `/${order.publicId}`);
  expect(page.status).toBe(200);
  expect(page.text).toContain(order.code);
  const legal = await rawRequest(new URL(PLAY_ORIGIN).host, "GET", `/legal/${shop.programSlug}/terms/2`);
  expect(legal.status).toBe(200);
  expect(legal.text).toContain("Syarat dan Ketentuan Musim 1");
  const status = await rawRequest(new URL(ORDER_ORIGIN).host, "POST", "/api/v1/order/status", body);
  expect(status.status).toBe(200);
  expect(JSON.parse(status.text)).toEqual({ v: 1, status: "paid" });
});

test("legal pages show published versions only, as text, on the play origin", async ({ browser }) => {
  const shop = await env.shop({});
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems = watch(page);
  const base = `${PLAY_ORIGIN}/legal/${shop.programSlug}`;

  const response = await page.goto(`${base}/terms/2`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toMatch(/script-src 'self' 'nonce-/);
  expect(response?.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Syarat dan Ketentuan Musim 1");
  await expect(page.getByRole("heading", { level: 2, name: "Hadiah" })).toBeVisible();
  await expect(page.getByText("Juara 1 mendapat voucher.")).toBeVisible();
  await expect(page.getByText(/Versi 2/)).toBeVisible();
  // The body's markup is text: it shows, and nothing ran.
  await expect(page.getByTestId("legal-document")).toContainText("<script>window.__xss = 1</script>");
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator("article script, article img").count()).toBe(0);

  // An older published version and the other kind are readable; a draft, a missing version and a missing program are 404.
  for (const path of ["/terms/1", "/privacy/1"]) expect((await page.goto(`${base}${path}`))?.status(), path).toBe(200);
  const refused: string[] = [];
  for (const path of ["/terms/3", "/terms/4", "/privacy/2", "/terms/0", "/terms/latest", "/cookies/1"]) {
    const answer = await page.goto(`${base}${path}`);
    expect(answer?.status(), path).toBe(404);
    refused.push(await page.locator("main").innerText());
  }
  expect((await page.goto(`${PLAY_ORIGIN}/legal/no-such-program/terms/1`))?.status()).toBe(404);
  refused.push(await page.locator("main").innerText());
  expect(new Set(refused).size).toBe(1);
  expect(problems).toEqual([]);

  // Publishing the draft makes it appear.
  await env.sql`UPDATE legal_pages SET published_at = now() WHERE program_id = ${shop.programId} AND kind = 'terms' AND version = 3`;
  expect((await page.goto(`${base}/terms/3`))?.status()).toBe(200);
  await context.close();
});

test.describe("at 375 px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  for (const status of ["pending", "paid", "expired", "gateway_failed", "review", "refunded"] as const) {
    test(`the ${status} order page has no horizontal scroll and no serious accessibility violation`, async ({ browser }) => {
      const order = await env.order(await env.shop(META_ONLY), status);
      const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
      await stubVendors(context);
      const page = await context.newPage();
      await page.goto(orderUrl(order));
      await expect(page.getByTestId("order-code")).toHaveText(order.code);
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const results = await new AxeBuilder({ page }).analyze();
      const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(blocking.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 5) }))).toEqual([]);
      // The actions are reachable by keyboard and show where the focus is.
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        return el === null || el === document.body ? null : { tag: el.tagName, outline: getComputedStyle(el).outlineStyle };
      });
      expect(focused).not.toBeNull();
      expect(focused?.outline, "the focused element shows an outline").not.toBe("none");
      await context.close();
    });
  }

  test("the legal page has no horizontal scroll and no serious accessibility violation", async ({ browser }) => {
    const shop = await env.shop({});
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    await page.goto(`${PLAY_ORIGIN}/legal/${shop.programSlug}/terms/2`);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    await context.close();
  });
});

/**
 * The shared "Butuh bantuan?" block (Owner decision 2026-11-24: a buyer with a problem reaches a person). One component, the same place at the end
 * of the main column on every buyer page; nothing at all when no CS contact is set; the order code (only) in its prefilled text and mail subject;
 * the buyer's name, e-mail and phone in no URL. The app keeps what it read of the contact for 30 s and refreshes it behind a request (lib/cs/contact.ts,
 * stale-while-revalidate): a change is waited out, one request starts the refresh, and the next request sees it.
 */
test.describe("the shared help block", () => {
  const CS = { whatsapp: "+6281234567890", email: "cs@contoh.id", hours: "Senin–Jumat 09.00–17.00 WIB" };
  const CACHE_WAIT_MS = 31_500;
  /** The first request after the 30 s gets the old answer and starts the refresh behind it; once it is done, every request sees the change. */
  const refreshCsCache = async (browser: Browser): Promise<void> => {
    const context = await browser.newContext();
    await (await context.newPage()).goto(`${PLAY_ORIGIN}/login`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await context.close();
  };
  const csUrls = async (page: Page): Promise<{ whatsapp: string | null; email: string | null }> => ({
    whatsapp: await page.getByTestId("help-whatsapp").getAttribute("href"),
    email: await page.getByTestId("help-email").getAttribute("href"),
  });
  /** What the page's main column ends with. */
  const lastInMain = (page: Page): Promise<string | null> => page.locator("main").evaluate((main) => main.lastElementChild?.getAttribute("data-testid") ?? null);
  const sideways = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  test("with no contact set there is no block and no pointer to one, on any state", async ({ browser }) => {
    const shop = await env.shop(META_ONLY);
    const context = await browser.newContext();
    await stubVendors(context);
    const page = await context.newPage();
    for (const status of ["paid", "gateway_failed"] as const) {
      await page.goto(orderUrl(await env.order(shop, status)));
      await expect(page.getByTestId("order-code")).toBeVisible();
      await expect(page.getByTestId("help-block")).toHaveCount(0);
      await expect(page.getByTestId("order-help-pointer")).toHaveCount(0);
      expect(await page.locator("body").innerText()).not.toContain("Butuh bantuan");
    }
    await page.goto(`${ORDER_ORIGIN}/${newPublicId()}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Halaman tidak ditemukan");
    await expect(page.getByTestId("help-block")).toHaveCount(0);
    // An invalid login link says what is wrong, and does not point to a block that is not there.
    await page.goto(`${PLAY_ORIGIN}/masuk`);
    await expect(page.getByRole("heading", { name: "Tautan tidak berlaku" })).toBeVisible();
    await expect(page.getByTestId("help-block")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain("Hubungi CS");
    await context.close();
  });

  test("the Owner sets the contact: buyers see it once the app's 30 s of memory is over and one request has refreshed it", async ({ browser }) => {
    test.setTimeout(120_000);
    await env.sql`DELETE FROM cs_contact`;
    await env.sql`INSERT INTO cs_contact (id, whatsapp, email, hours) VALUES (1, ${CS.whatsapp}, ${CS.email}, ${CS.hours})`;
    await new Promise((resolve) => setTimeout(resolve, CACHE_WAIT_MS));
    await refreshCsCache(browser);
  });

  test("a paid order at 390 px: the block closes the page, with its hours and the two links, the order code in the prefilled text only", async ({ browser }) => {
    const shop = await env.shop(META_ONLY);
    const order = await env.order(shop, "paid");
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await stubVendors(context);
    const page = await context.newPage();
    const problems = watch(page);
    await page.goto(orderUrl(order));
    await expect(page.getByTestId("order-code")).toHaveText(order.code);
    const block = page.getByTestId("help-block");
    await expect(block).toHaveCount(1);
    await expect(block.getByRole("heading", { name: "Butuh bantuan?" })).toBeVisible();
    await expect(page.getByTestId("help-hours")).toHaveText("Jam layanan: Senin–Jumat 09.00–17.00 WIB");
    expect(await lastInMain(page)).toBe("help-block");
    // The order card has no help area of its own: one "Butuh bantuan?" on the page.
    expect(await page.getByText("Butuh bantuan?").count()).toBe(1);
    const urls = await csUrls(page);
    expect(urls.whatsapp).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/);
    expect(decodeURIComponent(urls.whatsapp ?? "")).toBe(`https://wa.me/6281234567890?text=Halo CS, saya butuh bantuan untuk pesanan ${order.code}.`);
    expect(decodeURIComponent(urls.email ?? "")).toBe(`mailto:cs@contoh.id?subject=Butuh bantuan untuk pesanan ${order.code}`);
    await expect(page.getByTestId("help-whatsapp")).toHaveAttribute("target", "_blank");
    await expect(page.getByTestId("help-whatsapp")).toHaveAttribute("rel", "noopener noreferrer");
    // No personal data and not the order's public id in either URL; the paid page points to the block for an ebook that did not arrive.
    for (const secret of [BUYER.name, "Budi", "Santoso", BUYER.email, order.phone, order.phone.slice(3), order.publicId]) expect(JSON.stringify(urls), secret).not.toContain(secret);
    await expect(page.getByTestId("order-help-pointer")).toHaveText("Ebook belum sampai? Hubungi CS di bawah.");
    // Touch targets of at least 44 px, and nothing scrolls sideways.
    for (const id of ["help-whatsapp", "help-email"]) expect((await page.getByTestId(id).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    expect(problems).toEqual([]);
    await context.close();
  });

  test("a failed order points to the block in its message, and the block stays in its place", async ({ browser }) => {
    const order = await env.order(await env.shop({}), "gateway_failed");
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(orderUrl(order));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pembayaran gagal");
    await expect(page.getByTestId("order-help-pointer")).toHaveText("Tetap gagal setelah dicoba lagi? Hubungi CS di bawah.");
    expect(await lastInMain(page)).toBe("help-block");
    await context.close();
  });

  test("the not-found page, the order lookup and the login pages have it too, in the same place and without an order code", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    for (const url of [`${ORDER_ORIGIN}/${newPublicId()}`, `${ORDER_ORIGIN}/`, `${PLAY_ORIGIN}/login`, `${PLAY_ORIGIN}/masuk`]) {
      await page.goto(url);
      await expect(page.getByTestId("help-block"), url).toHaveCount(1);
      expect(await lastInMain(page), url).toBe("help-block");
      const urls = await csUrls(page);
      expect(decodeURIComponent(urls.whatsapp ?? ""), url).toBe("https://wa.me/6281234567890?text=Halo CS, saya butuh bantuan.");
      expect(decodeURIComponent(urls.email ?? ""), url).toBe("mailto:cs@contoh.id?subject=Butuh bantuan");
      expect(await sideways(page), url).toBeLessThanOrEqual(0);
    }
    await context.close();
  });

  test("an invalid login link says to contact CS below, above the block", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${PLAY_ORIGIN}/masuk`);
    await expect(page.getByRole("heading", { name: "Tautan tidak berlaku" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Hubungi CS di bawah." })).toBeVisible();
    expect(await lastInMain(page)).toBe("help-block");
    await context.close();
  });

  test("clearing the contact takes the block away again (nothing empty is left behind)", async ({ browser }) => {
    test.setTimeout(120_000);
    await env.sql`DELETE FROM cs_contact`;
    await new Promise((resolve) => setTimeout(resolve, CACHE_WAIT_MS));
    await refreshCsCache(browser);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${PLAY_ORIGIN}/login`);
    await expect(page.getByRole("heading", { name: "Masuk ke Trivia" })).toBeVisible();
    await expect(page.getByTestId("help-block")).toHaveCount(0);
    await context.close();
  });
});
