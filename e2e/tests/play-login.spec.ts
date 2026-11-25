import { createHash, randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { maskPhoneTail } from "@ebooktrivia/core";
import { type BrowserContext, expect, type Page, request, test } from "@playwright/test";
import { PLAY_URL, type PlayEnv, startPlayEnv } from "../support/play.ts";

/**
 * US-026 (M9a) against the production build of apps/public (`next start`, own database) at 375 px:
 * the WhatsApp OTP login (the real Cap widget solving in the browser, the code read from the sealed outbox
 * as the worker would), the same screen for an unknown number with nothing sent, the magic link's confirm
 * page (a GET consumes nothing; the click logs in once), the __Host-play_session cookie, logout, Origin
 * checks, and axe on every screen. Each test uses its own client address (X-Forwarded-For).
 */
test.describe.configure({ mode: "serial" });

let play: PlayEnv;
let started = false;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  play = await startPlayEnv();
  started = true;
});

test.afterAll(async () => {
  if (started) await play.stop();
});

const ip = (): string => `198.51.100.${String(1 + Math.floor(Math.random() * 250))}`;

async function phoneContext(browser: import("@playwright/test").Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: PLAY_URL, viewport: { width: 375, height: 812 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  return { context, page: await context.newPage() };
}

async function expectAccessible(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function askForCode(page: Page, phone: string): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Masuk ke Trivia" })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Nomor WhatsApp").fill(phone);
  await page.getByRole("button", { name: "Kirim kode" }).click();
  await expect(page.getByRole("heading", { name: "Masukkan kode" })).toBeVisible({ timeout: 60_000 });
}

test("an eligible player logs in with the WhatsApp code at 375 px; the session cookie is __Host-, Lax, 30 days", async ({ browser }) => {
  const { phone } = await play.eligiblePlayer();
  const { context, page } = await phoneContext(browser);
  await askForCode(page, `0${phone.slice(3)}`);
  const codeField = page.getByLabel("Kode OTP");
  await expect(codeField).toHaveAttribute("autocomplete", "one-time-code");
  await expect(codeField).toHaveAttribute("inputmode", "numeric");
  await expect(codeField).toBeFocused();
  await expectAccessible(page);

  await expect.poll(async () => play.sentCode(phone), { timeout: 15_000 }).toMatch(/^[0-9]{6}$/);
  const code = (await play.sentCode(phone)) ?? "";

  // A wrong code: the error sits next to the field.
  await codeField.fill(code === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.locator("#login-code-error")).toHaveText("Kode salah atau sudah tidak berlaku. Coba lagi atau kirim ulang kode.");
  await expect(codeField).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page);

  await codeField.fill(code);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  // Whose account it is, masked (login CSRF): the last 3 digits of the number just used.
  await expect(page.getByRole("heading", { name: "Berhasil masuk" })).toBeVisible();
  await expect(page.getByText(`Masuk sebagai ${maskPhoneTail(phone)}`)).toBeVisible();
  await expectAccessible(page);
  const cookie = (await context.cookies()).find((c) => c.name === "__Host-play_session");
  expect(cookie).toMatchObject({ path: "/", httpOnly: true, secure: true, sameSite: "Lax", domain: "127.0.0.1" });
  const days = ((cookie?.expires ?? 0) * 1000 - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(29.9);
  expect(days).toBeLessThanOrEqual(30);
  expect(await (await page.request.get("/api/v1/play/auth/session")).json()).toEqual({ v: 1, authenticated: true, phone_masked: maskPhoneTail(phone) });
  await page.getByRole("link", { name: "Buka trivia" }).click();
  // US-027: play.<DOMAIN>/ is the trivia home, which opens the player's (first) program.
  await page.waitForURL(`${PLAY_URL}/${play.programSlug}`);
  await context.close();
});

test("the signed-in panel's sign-out ends the session", async ({ browser }) => {
  const { id } = await play.eligiblePlayer();
  const token = randomBytes(32).toString("base64url");
  await play.sql`SELECT issue_magic_link(${id}, 'email', ${createHash("sha256").update(token).digest()})`;
  const { context, page } = await phoneContext(browser);
  await page.goto(`/masuk#c=email&t=${token}`);
  await page.getByRole("button", { name: "Masuk sekarang" }).click();
  await page.getByRole("button", { name: "Bukan kamu? Keluar" }).click();
  await page.waitForURL(`${PLAY_URL}/login`);
  expect(await (await page.request.get("/api/v1/play/auth/session")).json()).toEqual({ v: 1, authenticated: false });
  expect((await context.cookies()).find((c) => c.name === "__Host-play_session")).toBeUndefined();
  await context.close();
});

test("an unknown number sees the same screen and copy, and nothing is sent", async ({ browser }) => {
  const unknown = `+62813${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`;
  const known = await play.eligiblePlayer();
  const texts: string[] = [];
  for (const phone of [unknown, known.phone]) {
    const { context, page } = await phoneContext(browser);
    await askForCode(page, phone);
    texts.push((await page.locator("section").innerText()).replace(phone, "<phone>"));
    await context.close();
  }
  expect(texts[0]).toBe(texts[1]);
  await expect.poll(async () => play.sentCode(known.phone), { timeout: 15_000 }).toMatch(/^[0-9]{6}$/);
  expect(await play.sentCode(unknown)).toBeNull();
  expect(await play.sql`SELECT 1 FROM player_otps WHERE phone = ${unknown}`).toHaveLength(0);
});

test("a magic link: the GET shows a confirm page and consumes nothing; the click logs in once; a replay is refused", async ({ browser }) => {
  const { id } = await play.eligiblePlayer();
  const token = randomBytes(32).toString("base64url");
  await play.sql`SELECT issue_magic_link(${id}, 'whatsapp', ${createHash("sha256").update(token).digest()})`;
  const link = `${PLAY_URL}/masuk#c=whatsapp&t=${token}`;
  const consumed = async (): Promise<boolean> =>
    ((await play.sql<{ c: boolean }[]>`SELECT consumed_at IS NOT NULL AS c FROM magic_links WHERE player_id = ${id} AND channel = 'whatsapp'`)[0]?.c ?? false);

  const { context, page } = await phoneContext(browser);
  await page.goto(link);
  const confirm = page.getByRole("button", { name: "Masuk sekarang" });
  await expect(confirm).toBeVisible();
  // The token left the address bar; opening (and reopening) the page consumed nothing.
  expect(new URL(page.url()).hash).toBe("");
  await page.goto("about:blank");
  await page.goto(link);
  await expect(confirm).toBeVisible();
  expect(await consumed()).toBe(false);
  await expectAccessible(page);

  await confirm.click();
  const phone = (await play.sql<{ phone: string }[]>`SELECT phone FROM players WHERE id = ${id}`)[0]?.phone ?? "";
  await expect(page.getByText(`Masuk sebagai ${maskPhoneTail(phone)}`)).toBeVisible();
  await expectAccessible(page);
  expect(await consumed()).toBe(true);
  expect(await (await page.request.get("/api/v1/play/auth/session")).json()).toMatchObject({ v: 1, authenticated: true });

  // The same link again (a fresh document: from /masuk itself only the fragment would change): refused, with the
  // way to the OTP login.
  await page.goto("about:blank");
  await page.goto(link);
  await page.getByRole("button", { name: "Masuk sekarang" }).click();
  await expect(page.getByRole("heading", { name: "Tautan tidak berlaku" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Masuk dengan kode WhatsApp" })).toHaveAttribute("href", "/login");
  await expectAccessible(page);
  await context.close();
});

test("a link on the wrong channel and a broken link show the refusal; no Origin, no login", async ({ browser }) => {
  const { id } = await play.eligiblePlayer();
  const token = randomBytes(32).toString("base64url");
  await play.sql`SELECT issue_magic_link(${id}, 'email', ${createHash("sha256").update(token).digest()})`;
  const { context, page } = await phoneContext(browser);
  await page.goto(`/masuk#c=whatsapp&t=${token}`);
  await page.getByRole("button", { name: "Masuk sekarang" }).click();
  await expect(page.getByRole("heading", { name: "Tautan tidak berlaku" })).toBeVisible();
  await page.goto("/masuk#t=broken");
  await expect(page.getByRole("heading", { name: "Tautan tidak berlaku" })).toBeVisible();
  await context.close();

  // The login lives on the play origin only (host gating, security review L2), with the play nonce CSP.
  const page404 = await request.newContext({ baseURL: PLAY_URL.replace("127.0.0.1", "localhost") });
  for (const path of ["/login", "/masuk", "/api/v1/play/auth/session"]) expect((await page404.get(path)).status(), path).toBe(404);
  await page404.dispose();
  const login = await (await request.newContext({ baseURL: PLAY_URL })).get("/login");
  expect(login.headers()["content-security-policy"]).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic' 'wasm-unsafe-eval'; worker-src blob:/);

  // A cross-origin or Origin-less POST is refused before anything is read.
  const api = await request.newContext({ baseURL: PLAY_URL });
  for (const headers of [{ origin: "http://127.0.0.1:3199" }, {}]) {
    const response = await api.post("/api/v1/play/auth/magic-link", { headers: { ...headers, "content-type": "application/json" }, data: { channel: "email", token } });
    expect(response.status()).toBe(403);
  }
  expect((await play.sql<{ c: boolean }[]>`SELECT consumed_at IS NOT NULL AS c FROM magic_links WHERE player_id = ${id}`)[0]?.c).toBe(false);
  await api.dispose();
});
