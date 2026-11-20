import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSdk } from "@ebooktrivia/sdk/build";
import { expect, type Page, test } from "@playwright/test";
import { LEGAL, LP_KEY, type LpFixture, SNAP_SANDBOX_URL, type SdkStub, startLpFixture, startSdkStub, VALUE_IDR } from "../support/sdk-stub.ts";

/**
 * US-019 (M6a): the landing-page SDK in a real browser, on a landing page served from ANOTHER origin
 * than the API (another port of 127.0.0.1, so CORS, Origin and localStorage behave as in production)
 * under a strict CSP (no inline script or style, no eval; only the API origin and the Meta pixel host
 * for scripts and the API origin for connections).
 *   - the stub API implements the wire contract (support/sdk-stub.ts) and answers Cap with the real
 *     Cap server library, so the real widget solves real challenges;
 *   - the Meta pixel library and the Midtrans Snap page are intercepted: the test never leaves the
 *     machine.
 */
test.describe.configure({ mode: "serial" });

const DAY = 24 * 60 * 60 * 1000;
const ATTR_KEY = `ebt:attr:1:${LP_KEY}`;
const META_ID = "1234567890123";
const PHONE_TYPED = "0812-3456-7890";
const PHONE_E164 = "+6281234567890";
const LP_URL = "/lp.html";

let sdkDir = "";
let stub: SdkStub;
let lp: LpFixture;

test.beforeAll(async () => {
  sdkDir = mkdtempSync(join(tmpdir(), "ebt-sdk-e2e-"));
  await buildSdk(sdkDir);
  stub = await startSdkStub({ sdkDir });
  lp = await startLpFixture(stub.origin);
  stub.allowOrigin = lp.origin;
});

test.afterAll(async () => {
  await lp.close();
  await stub.close();
  rmSync(sdkDir, { recursive: true, force: true });
});

interface Probe {
  /** What the intercepted Meta library recorded: one entry per fbq call, in order. */
  readonly pixel: unknown[][];
  /** Every request the page made, as host names. */
  readonly hosts: Set<string>;
  readonly pageErrors: string[];
  /** Requests the intercepted Midtrans pages received. */
  readonly midtrans: string[];
  /** Requests that reached a host the test treats as hostile. */
  readonly evil: string[];
  /** How often the (intercepted) Meta library was requested. */
  metaScriptRequests: number;
  /** The values of every input on the page at the moment the vendor script ran, by id (what automatic advanced matching could read). */
  readonly formWhenVendorRan: Record<string, string>[];
  /** Console errors and warnings of the page. */
  readonly console: { readonly type: string; readonly text: string }[];
}

/** The vendor / payment hosts are intercepted, so nothing leaves the machine. */
async function probe(page: Page): Promise<Probe> {
  const state: Probe = { pixel: [], hosts: new Set(), pageErrors: [], midtrans: [], evil: [], metaScriptRequests: 0, formWhenVendorRan: [], console: [] };
  await page.exposeFunction("__ebtPixel", (json: string) => {
    const entry = JSON.parse(json) as unknown[];
    if (entry[0] === "__form") state.formWhenVendorRan.push(entry[1] as Record<string, string>);
    else state.pixel.push(entry);
  });
  // A stand-in for fbevents.js: first records what the page's inputs hold (the vendor's automatic
  // advanced matching reads them when it runs), then replays the SDK's queued calls and records every call.
  await page.route("https://connect.facebook.net/en_US/fbevents.js", (route) => {
    state.metaScriptRequests += 1;
    return route.fulfill({
      contentType: "application/javascript",
      body: `(function(){var v={};document.querySelectorAll("input").forEach(function(i){if(i.id)v[i.id]=i.value});window.__ebtPixel(JSON.stringify(["__form",v]));var q=(window.fbq&&window.fbq.queue)||[];var log=function(a){window.__ebtPixel(JSON.stringify(Array.prototype.slice.call(a)))};window.fbq=function(){log(arguments)};for(var i=0;i<q.length;i++)log(q[i])})();`,
    });
  });
  await page.route(/^https:\/\/app(\.sandbox)?\.midtrans\.com\//, (route) => {
    state.midtrans.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Midtrans Snap (test double)</title><h1>Pembayaran</h1>" });
  });
  await page.route(/^https?:\/\/evil\.example\.test\//, (route) => {
    state.evil.push(route.request().url());
    return route.abort();
  });
  page.on("request", (request) => state.hosts.add(new URL(request.url()).host));
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") state.console.push({ type: message.type(), text: message.text() });
  });
  return state;
}

async function fillForm(page: Page, values: { name?: string; phone?: string; email?: string; consent?: boolean } = {}): Promise<void> {
  await page.getByLabel("Nama lengkap").fill(values.name ?? "Budi Santoso");
  await page.getByLabel("Nomor WhatsApp").fill(values.phone ?? PHONE_TYPED);
  await page.getByLabel("E-mail").fill(values.email ?? "budi@example.co");
  if (values.consent !== false) await page.locator("#consent").check();
}

/** Opens the landing page and waits until the SDK has the config (the consent label is filled in). */
async function open(page: Page, query = "", path = LP_URL): Promise<void> {
  await page.goto(`${lp.origin}${path}${query}`);
  await expect(page.locator("[data-ebt-consent-label] a").first()).toBeVisible();
  // The page ships its submit button disabled; the SDK enables it once it has bound (security review S4).
  await expect(page.locator("#buy")).toBeEnabled();
}

/** The console messages that are not the known, harmless noise of the hidden Cap widget (see "console noise"). */
const unexpectedConsole = (state: Probe): string[] =>
  state.console.filter((m) => !/Applying inline style violates the following Content Security Policy directive 'style-src 'self''/.test(m.text)).map((m) => `${m.type}: ${m.text}`);

const visits = (): { attribution: Record<string, string> }[] => stub.seen("/api/v1/visit/").map((r) => (r.body as { attribution: Record<string, string> }));
const checkouts = (): Record<string, unknown>[] => stub.seen("/api/v1/checkout/").map((r) => r.body as Record<string, unknown>);

test.beforeEach(() => {
  stub.reset();
  stub.allowOrigin = lp.origin;
});

test.describe("attribution (AC-T1)", () => {
  test("stores the click, keeps it across a reload without parameters, replaces it with a new click and honours the 30-day expiry", async ({ page }) => {
    await probe(page);
    const click = "?cid=click-1&sub_id=sub-1&pub=pub-1&utm_source=meta&utm_campaign=Promo%20Besar&fbclid=fb-1&gclid=g-1&ttclid=tt-1&email=leak%40example.co&phone=0812";
    await open(page, click);
    await expect.poll(() => visits().length).toBe(1);
    const first = visits()[0]?.attribution;
    const clickedAt = Number(String(first?.["fbc"]).split(".")[2]);
    expect(first).toEqual({
      adnet: "adnet-a",
      clickid: "click-1",
      sub_id: "sub-1",
      pub: "pub-1",
      utm_source: "meta",
      utm_campaign: "Promo Besar",
      fbclid: "fb-1",
      gclid: "g-1",
      ttclid: "tt-1",
      fbc: `fb.1.${String(clickedAt)}.fb-1`,
    });
    expect(clickedAt).toBeGreaterThan(Date.now() - 60_000);

    // Stored for 30 days under the landing page's key; no personal data from the URL went in.
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), ATTR_KEY);
    expect(JSON.parse(stored ?? "{}")).toMatchObject({ v: 1, a: { clickid: "click-1", adnet: "adnet-a", sub_id: "sub-1" } });
    expect(stored).not.toContain("leak@example.co");
    expect(stored).not.toContain("0812");

    // A reload without parameters keeps it.
    await open(page);
    await expect.poll(() => visits().length).toBe(2);
    expect(visits()[1]?.attribution).toMatchObject({ clickid: "click-1", adnet: "adnet-a", sub_id: "sub-1", gclid: "g-1" });

    // A visit from a link with UTM only (a newsletter) leaves the ad click alone: it keeps its click id and its own UTM.
    await open(page, "?utm_source=newsletter&sub_id=other");
    await expect.poll(() => visits().length).toBe(3);
    expect(visits()[2]?.attribution).toMatchObject({ clickid: "click-1", adnet: "adnet-a", sub_id: "sub-1", utm_source: "meta" });

    // A new click replaces it whole: nothing of the old one rides along.
    await open(page, "?aff_click_id=click-2");
    await expect.poll(() => visits().length).toBe(4);
    expect(visits()[3]?.attribution).toEqual({ adnet: "adnet-b", clickid: "click-2" });

    // Still there 29 days later, gone after 31.
    await page.clock.setFixedTime(new Date(Date.now() + 29 * DAY));
    await open(page);
    await expect.poll(() => visits().length).toBe(5);
    expect(visits()[4]?.attribution).toMatchObject({ adnet: "adnet-b", clickid: "click-2" });
    await page.clock.setFixedTime(new Date(Date.now() + 31 * DAY));
    await open(page);
    await expect.poll(() => visits().length).toBe(6);
    expect(visits()[5]?.attribution).toEqual({});
    expect(await page.evaluate((key) => window.localStorage.getItem(key), ATTR_KEY)).toBeNull();
  });

  test("ignores a corrupted localStorage entry, and the checkout still works", async ({ page }) => {
    const state = await probe(page);
    await page.addInitScript((key) => { window.localStorage.setItem(key, '{"v":1,"t":"yesterday","a":'); }, ATTR_KEY);
    await open(page, "?cid=fresh");
    await expect.poll(() => visits().length).toBe(1);
    expect(visits()[0]?.attribution).toEqual({ adnet: "adnet-a", clickid: "fresh" });
    expect(state.pageErrors).toEqual([]);
  });

  test("keeps the click when the visitor leaves before the config arrives, and resolves the adnet's click id on the next load of the tab", async ({ page }) => {
    await probe(page);
    // The config is unreachable on this load (the API does not know the page's origin yet).
    stub.allowOrigin = "http://127.0.0.1:1";
    await page.goto(`${lp.origin}${LP_URL}?gclid=g-boot&utm_source=google&cid=zz9&no_hp=081234567890&nama_lengkap=Budi&email=budi%40example.co&ref=0812-3456-7890`);
    await page.waitForTimeout(300);
    // Captured at boot, without the config: the fixed keys are stored, the adnet's click id waits in sessionStorage.
    expect(JSON.parse((await page.evaluate((key) => window.localStorage.getItem(key), ATTR_KEY)) ?? "null")).toMatchObject({ a: { gclid: "g-boot", utm_source: "google" } });
    expect(await page.evaluate(() => window.sessionStorage.length)).toBe(1);
    // Only the click id waits in sessionStorage: nothing that looks like personal data, whatever the parameter is called.
    const parked = (await page.evaluate(() => Object.values(window.sessionStorage).join("|"))) || "";
    expect(parked).toContain("zz9");
    for (const personal of ["081234567890", "Budi", "example.co", "0812-3456-7890", "no_hp", "nama_lengkap", "email"]) expect(parked).not.toContain(personal);
    expect(visits()).toEqual([]);
    // The next load in the same tab, now with a config, resolves it.
    stub.allowOrigin = lp.origin;
    await open(page);
    await expect.poll(() => visits().length).toBe(1);
    expect(visits()[0]?.attribution).toEqual({ adnet: "adnet-a", clickid: "zz9", gclid: "g-boot", utm_source: "google" });
    expect(await page.evaluate(() => window.sessionStorage.length)).toBe(0);
    // The adnets' parameter names are cached now (not personal), so the next first-load parking is by those names only.
    expect(JSON.parse((await page.evaluate((key) => window.localStorage.getItem(key), `ebt:names:1:${LP_KEY}`)) ?? "null")).toMatchObject({ v: 1, n: ["cid", "aff_click_id"] });
  });

  test("reloading a landing URL with both click ids does not restart the 30 days or lose the adnet's click id (E1)", async ({ page }) => {
    await probe(page);
    await open(page, "?cid=AFF1&gclid=G1");
    await expect.poll(() => visits().length).toBe(1);
    const first = await page.evaluate((key) => window.localStorage.getItem(key), ATTR_KEY);
    expect(JSON.parse(first ?? "{}")).toMatchObject({ a: { gclid: "G1", clickid: "AFF1", adnet: "adnet-a" } });
    await page.waitForTimeout(50);
    // Reload on a later day, and this time the config never arrives: the stored click is untouched.
    await page.clock.setFixedTime(new Date(Date.now() + 20 * DAY));
    stub.allowOrigin = "http://127.0.0.1:1";
    await page.goto(`${lp.origin}${LP_URL}?cid=AFF1&gclid=G1`);
    await page.waitForTimeout(300);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), ATTR_KEY)).toBe(first);
  });
});

test.describe("checkout", () => {
  test("loads Cap only on the first interaction with the form, never a third party", async ({ page }) => {
    const state = await probe(page);
    await open(page);
    await expect.poll(() => visits().length).toBe(1);
    await page.waitForTimeout(500);
    expect(stub.seen("/api/v1/cap/")).toEqual([]);
    expect(await page.evaluate(() => "Cap" in window)).toBe(false);
    await page.getByLabel("Nama lengkap").focus();
    await expect.poll(() => stub.seen("/api/v1/cap/").length).toBeGreaterThan(0);
    expect(await page.evaluate(() => "Cap" in window)).toBe(true);
    expect([...state.hosts].sort()).toEqual([new URL(lp.origin).host, new URL(stub.origin).host].sort());
  });

  test("solves with the self-hosted WebAssembly solver, and the console stays quiet (owner decision O1)", async ({ page }) => {
    const state = await probe(page);
    await open(page);
    await page.getByLabel("Nama lengkap").focus();
    await expect.poll(() => stub.seen("/api/v1/cap/").map((r) => r.path.split("/").pop())).toContain("challenge");
    await expect.poll(() => stub.files).toContain("cap-wasm-v0.0.8.wasm");
    // Wait for the proof of work to be redeemed: the solver ran in the workers.
    await expect.poll(() => stub.seen("/api/v1/cap/").map((r) => r.path.split("/").pop())).toContain("redeem");
    expect(stub.files.filter((f) => f === "cap-wasm-v0.0.8.wasm")).toHaveLength(1);
    expect(stub.files).toEqual(expect.arrayContaining(["v1.js", "cap-v0.1.62.js", "cap-wasm-v0.0.8.wasm"]));
    // Nothing from a CDN, no blocked data: URL, no "no wasm module" warning from the workers.
    expect([...state.hosts].sort()).toEqual([new URL(lp.origin).host, new URL(stub.origin).host].sort());
    expect(unexpectedConsole(state)).toEqual([]);
  });

  test("falls back to the JavaScript solver, and the checkout still works, when the page's CSP lacks 'wasm-unsafe-eval'", async ({ page }) => {
    const state = await probe(page);
    await open(page, "", "/lp-nowasm.html");
    await fillForm(page);
    await page.locator("#buy").click();
    await page.waitForURL(SNAP_SANDBOX_URL);
    expect(checkouts()).toHaveLength(1);
    expect((checkouts()[0] ?? {})["cap_token"]).toMatch(/^[0-9a-f]{146}$/);
    // The module was fetched but the browser refused to compile it: the widget said so and solved in JavaScript.
    expect(stub.files).toContain("cap-wasm-v0.0.8.wasm");
    expect(state.console.some((m) => /WebAssembly|wasm/i.test(m.text))).toBe(true);
    expect(state.pageErrors).toEqual([]);
  });

  test("runs no server-supplied code: no iframe, the isolation flags on", async ({ page }) => {
    await probe(page);
    await open(page);
    await page.getByLabel("Nama lengkap").focus();
    await expect.poll(() => stub.seen("/api/v1/cap/").map((r) => r.path.split("/").pop())).toContain("redeem");
    expect(await page.evaluate(() => document.querySelectorAll("iframe").length)).toBe(0);
    expect(page.frames()).toHaveLength(1);
    expect(await page.evaluate(() => [(window as unknown as Record<string, unknown>)["CAP_ISOLATE"], (window as unknown as Record<string, unknown>)["CAP_PAKO_URL"]])).toEqual([true, "data:,"]);
  });

  test("a page whose script never loaded keeps its submit button disabled: nothing is submitted natively (security review S4)", async ({ page }) => {
    await probe(page);
    await page.goto(`${lp.origin}/lp-nosdk.html`);
    await expect(page.locator("#buy")).toBeDisabled();
    expect(await page.evaluate(() => document.querySelector("form")?.method)).toBe("post");
    await fillForm(page, { consent: false });
    await page.locator("#email").press("Enter");
    await page.waitForTimeout(300);
    expect(page.url()).toBe(`${lp.origin}/lp-nosdk.html`);
  });

  test("submits the payload with its attribution, fires the MO pixel once with the server's event id, and follows the Midtrans redirect", async ({ page, context }) => {
    const state = await probe(page);
    // Cookies of the API's host must never be sent (127.0.0.1 cookies are shared between ports).
    await context.addCookies([{ name: "api_session", value: "secret-session", url: stub.origin }]);
    await context.addCookies([{ name: "_fbp", value: "fb.1.1700000000000.1234567890", url: lp.origin }]);
    await open(page, "?cid=abc123&sub_id=s1&utm_source=meta");
    await fillForm(page);
    await page.locator("#buy").click();
    await page.waitForURL(SNAP_SANDBOX_URL);
    await expect(page.getByRole("heading", { name: "Pembayaran" })).toBeVisible();

    expect(checkouts()).toHaveLength(1);
    const body = checkouts()[0] ?? {};
    expect(body).toMatchObject({
      v: 1,
      name: "Budi Santoso",
      phone: PHONE_E164,
      email: "budi@example.co",
      consent: { terms: LEGAL.terms, privacy: LEGAL.privacy },
      attribution: { adnet: "adnet-a", clickid: "abc123", sub_id: "s1", utm_source: "meta", fbp: "fb.1.1700000000000.1234567890" },
    });
    expect(body["cap_token"]).toMatch(/^[0-9a-f]{146}$/);
    expect(body["visit_id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(body).sort()).toEqual(["attribution", "cap_token", "consent", "email", "name", "phone", "v", "visit_id"]);

    // Every request to the API came from the landing page's origin and carried no cookie.
    expect(stub.requests.length).toBeGreaterThan(4);
    for (const request of stub.requests) {
      expect(request.origin, request.path).toBe(lp.origin);
      expect(request.cookie, request.path).toBeUndefined();
    }
    // Cap: one challenge, one redeem, from the self-hosted widget.
    expect(stub.seen("/api/v1/cap/").map((r) => r.path.split("/").pop())).toEqual(["challenge", "redeem"]);

    // The MO pixel: automatic advanced matching switched off BEFORE init (owner decision O3), the id
    // initialised once, InitiateCheckout addressed to the registered id once, with the event id the server returned.
    const eventId = stub.checkouts[0]?.event_id;
    expect(state.pixel).toEqual([
      ["set", "autoConfig", false, META_ID],
      ["init", META_ID],
      ["trackSingle", META_ID, "InitiateCheckout", { value: VALUE_IDR, currency: "IDR" }, { eventID: eventId }],
    ]);
    // The visitor's values were gone from the page when the vendor script ran: nothing for it to scrape.
    expect(state.formWhenVendorRan).toEqual([{ name: "", phone: "", email: "", consent: "on" }]);
    expect(state.midtrans).toEqual([SNAP_SANDBOX_URL]);
    expect(state.pageErrors).toEqual([]);
    // Only the landing page, the API, the (intercepted) Meta host and the Snap page: no CDN, no widget host.
    expect([...state.hosts].sort()).toEqual([new URL(lp.origin).host, new URL(stub.origin).host, "connect.facebook.net", "app.sandbox.midtrans.com"].sort());
  });

  test.describe("refuses a redirect that is not the configured Midtrans Snap page", () => {
    for (const url of ["https://evil.example.test/snap/v4/redirection/abc", "http://app.sandbox.midtrans.com/snap/v4/redirection/abc", "https://app.midtrans.com/snap/v4/redirection/abc", "https://app.sandbox.midtrans.com.evil.example.test/x", "javascript:alert(1)"]) {
      test(url, async ({ page }) => {
        const state = await probe(page);
        stub.snapRedirectUrl = url;
        await open(page);
        await fillForm(page);
        await page.locator("#buy").click();
        await expect(page.getByRole("alert")).toHaveText("Alamat pembayaran tidak dikenali, jadi kamu tidak dialihkan. Hubungi penyelenggara.");
        // Still on the landing page, the form usable again, the pixel not fired, nothing requested from the bad host.
        expect(page.url()).toBe(`${lp.origin}${LP_URL}`);
        await expect(page.locator("#buy")).toBeEnabled();
        expect(state.pixel).toEqual([]);
        expect(state.evil).toEqual([]);
        expect(state.midtrans).toEqual([]);
      });
    }
  });

  test("loads no vendor script while the checkout is in flight, only after the response, with the page's personal data already cleared (owner decision O3)", async ({ page }) => {
    const state = await probe(page);
    stub.checkoutDelayMs = 1200;
    await open(page);
    await fillForm(page);
    await page.locator("#buy").click();
    await page.waitForTimeout(600);
    expect(checkouts()).toHaveLength(1);
    expect(state.metaScriptRequests).toBe(0);
    // The values are still there while the buyer waits (they may need to fix them if the order fails).
    await expect(page.locator("#phone")).toHaveValue(PHONE_TYPED);
    await page.waitForURL(SNAP_SANDBOX_URL);
    expect(state.metaScriptRequests).toBe(1);
    expect(state.formWhenVendorRan.map((f) => [f["name"], f["phone"], f["email"]])).toEqual([["", "", ""]]);
  });

  test("a failed order keeps what the buyer typed and loads no vendor script", async ({ page }) => {
    const state = await probe(page);
    stub.snapRedirectUrl = "https://evil.example.test/pay";
    await open(page);
    await fillForm(page);
    await page.locator("#buy").click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator("#phone")).toHaveValue(PHONE_TYPED);
    await expect(page.locator("#email")).toHaveValue("budi@example.co");
    expect(state.metaScriptRequests).toBe(0);
  });

  test("back from the payment page, a page where the vendor pixels were loaded is reloaded; otherwise the form is just usable (E5)", async ({ page }) => {
    const state = await probe(page);
    // The payment page never answers: the page stays here, with the vendor scripts loaded and fired, as it would just before leaving.
    await page.route(/^https:\/\/app\.sandbox\.midtrans\.com\//, () => new Promise<void>(() => undefined));
    await open(page);
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>)["__marker"] = 1;
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    // No vendor library yet: nothing to reload.
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__marker"])).toBe(1);
    await fillForm(page);
    await page.locator("#buy").click();
    await expect.poll(() => state.pixel.filter((call) => call[0] === "trackSingle").length).toBe(1);
    // The buyer comes back (bfcache restore): the page is reloaded from scratch, so nothing is retyped under the live vendor scripts.
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await page.waitForFunction(() => !("__marker" in window));
    await expect(page.locator("[data-ebt-consent-label] a").first()).toBeVisible();
    await expect(page.locator("#buy")).toBeEnabled();
    await expect(page.locator("#phone")).toHaveValue("");
    expect(await page.evaluate(() => "fbq" in window)).toBe(false);
  });

  test("shows errors next to their fields in Bahasa Indonesia, linked with aria-describedby, and sends nothing", async ({ page }) => {
    await probe(page);
    await open(page);
    await page.locator("#phone").fill("12345");
    await page.locator("#email").fill("bukan-email");
    await page.locator("#buy").click();
    const expectations = [
      ["#name", "Isi nama lengkapmu."],
      ["#phone", "Gunakan nomor Indonesia yang diawali 08 atau +62."],
      ["#email", "Alamat e-mail tidak valid. Contoh: nama@contoh.com"],
      ["#consent", "Centang persetujuan untuk melanjutkan."],
    ] as const;
    for (const [selector, message] of expectations) {
      const field = page.locator(selector);
      await expect(field).toHaveAttribute("aria-invalid", "true");
      const describedBy = (await field.getAttribute("aria-describedby")) ?? "";
      await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(message);
    }
    await expect(page.locator("#name")).toBeFocused();
    // No error text inside a <label>, where it would become part of the field's name.
    await expect(page.locator("label p")).toHaveCount(0);
    // The SDK's default styles apply under the strict CSP (a constructable stylesheet, not a <style> element): 6.5:1 on white.
    await expect(page.locator("[id='ebt0-phone-error']")).toHaveCSS("color", "rgb(185, 28, 28)");
    expect(stub.seen("/api/v1/checkout/")).toEqual([]);
    // Fixing a field clears its error on the next try.
    await fillForm(page);
    await page.locator("#buy").click();
    await page.waitForURL(SNAP_SANDBOX_URL);
    expect(checkouts()).toHaveLength(1);
  });

  test("a form without the consent checkbox says it cannot take orders instead of failing silently", async ({ page }) => {
    await probe(page);
    await open(page);
    await page.evaluate(() => {
      document.querySelector("#consent")?.closest("p")?.remove();
    });
    await fillForm(page, { consent: false });
    await page.locator("#buy").click();
    await expect(page.getByRole("alert")).toHaveText("Halaman ini belum bisa menerima pesanan.");
    expect(stub.seen("/api/v1/checkout/")).toEqual([]);
    await expect(page.locator("#buy")).toBeEnabled();
  });

  test("locks the form while a submit is in flight, so a double click sends one checkout", async ({ page }) => {
    await probe(page);
    stub.checkoutDelayMs = 1500;
    await open(page);
    await fillForm(page);
    const button = page.locator("#buy");
    await button.dblclick();
    await expect(button).toBeDisabled();
    await expect(page.locator("#checkout")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("status")).toHaveText("Memproses pesanan…");
    await page.waitForURL(SNAP_SANDBOX_URL);
    expect(checkouts()).toHaveLength(1);
  });

  test("ignores a second submit event while one is in flight (Enter pressed twice, a script calling requestSubmit)", async ({ page }) => {
    await probe(page);
    stub.checkoutDelayMs = 1000;
    await open(page);
    await fillForm(page);
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>("#checkout");
      form?.requestSubmit();
      form?.requestSubmit();
    });
    await page.waitForURL(SNAP_SANDBOX_URL);
    expect(checkouts()).toHaveLength(1);
  });

  test("fires the MO pixel once per order, even when the page is opened and submitted again", async ({ page, browser }) => {
    const state = await probe(page);
    await open(page);
    await fillForm(page);
    await page.locator("#buy").click();
    await page.waitForURL(SNAP_SANDBOX_URL);
    const eventId = stub.checkouts[0]?.event_id;
    expect(state.pixel.filter((call) => call[0] === "trackSingle")).toHaveLength(1);

    // Same browser, same order again, and the server (wrongly) not saying "deduped": the SDK's own record stops a second fire.
    stub.neverDeduped = true;
    await open(page);
    await fillForm(page);
    await page.locator("#buy").click();
    await page.waitForURL(SNAP_SANDBOX_URL);
    expect(checkouts()).toHaveLength(2);
    expect(state.pixel.filter((call) => call[0] === "trackSingle")).toHaveLength(1);

    // A different browser: the server reuses the open order (deduped) and the pixel stays silent.
    stub.neverDeduped = false;
    const other = await browser.newContext({ locale: "id-ID" });
    const otherPage = await other.newPage();
    const otherState = await probe(otherPage);
    await open(otherPage);
    await fillForm(otherPage);
    await otherPage.locator("#buy").click();
    await otherPage.waitForURL(SNAP_SANDBOX_URL);
    expect(checkouts()).toHaveLength(3);
    expect(otherState.pixel).toEqual([]);
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/);
    await other.close();
  });

  test("links the consent to the program's legal pages and sends the accepted versions", async ({ page }) => {
    await probe(page);
    await open(page);
    const links = page.locator("[data-ebt-consent-label] a");
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAttribute("href", `http://127.0.0.1:4999/legal/${LEGAL.program}/terms/${String(LEGAL.terms)}`);
    await expect(links.nth(1)).toHaveAttribute("href", `http://127.0.0.1:4999/legal/${LEGAL.program}/privacy/${String(LEGAL.privacy)}`);
    await expect(links.nth(0)).toHaveAttribute("target", "_blank");
    await expect(links.nth(0)).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.locator("#consent")).toBeEnabled();
    await expect(page.locator("[data-ebt-consent-label]")).toHaveText("Saya menyetujui Syarat & Ketentuan dan Kebijakan Privasi.");
  });

  test("shows the server's field errors and an outdated-consent message, and recovers", async ({ page }) => {
    await probe(page);
    await open(page);
    // The policy is republished after the page loaded: the SDK still sends the old version, the API says so.
    stub.config = { ...stub.config, legal: stub.config.legal === null ? null : { ...stub.config.legal, terms: LEGAL.terms + 1 } };
    await fillForm(page);
    await page.locator("#buy").click();
    await expect(page.locator("#consent")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("[id='ebt0-consent-error']")).toHaveText("Syarat dan kebijakan baru saja diperbarui. Muat ulang halaman, lalu setujui versi terbaru.");
    await expect(page.locator("#buy")).toBeEnabled();
    expect(page.url()).toBe(`${lp.origin}${LP_URL}`);
    // After a reload the new version is read from the config and the order goes through.
    await open(page);
    await fillForm(page);
    await page.locator("#buy").click();
    await page.waitForURL(SNAP_SANDBOX_URL);
    expect(checkouts().at(-1)).toMatchObject({ consent: { terms: LEGAL.terms + 1, privacy: LEGAL.privacy } });
  });
});

test.describe("a registered origin only", () => {
  test("does nothing useful when the API does not know the page's origin", async ({ page }) => {
    const state = await probe(page);
    stub.allowOrigin = "http://127.0.0.1:1";
    await page.goto(`${lp.origin}${LP_URL}`);
    await fillForm(page, { consent: true });
    await page.locator("#buy").click();
    // The config is unreachable (the browser blocks the response): the form says so and nothing is paid.
    await expect(page.getByRole("alert")).toHaveText("Halaman ini belum bisa menerima pesanan.");
    expect(stub.seen("/api/v1/checkout/")).toEqual([]);
    expect(state.midtrans).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
});

