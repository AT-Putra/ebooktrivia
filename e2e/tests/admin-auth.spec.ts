import { type APIRequestContext, type Browser, type BrowserContext, expect, type Page, request, test } from "@playwright/test";
import { ADMIN_AUTH_URL, type AdminEnv, consoleNavLinks, freshTotp, openConsoleNav, OTHER_ORIGIN, runAdminCli, startAdminEnv, wrongTotp } from "../support/admin.ts";

/**
 * US-016 (M5a-1) against the production build of apps/admin (`next start`, own database):
 * forced TOTP enrollment, recovery-code sign-in, Staff 403 + hidden controls, cross-origin server
 * action / route POSTs refused, lockout after 5 failures, nonce CSP, audit rows without PII.
 * Each actor uses its own client address (X-Forwarded-For; `next start` has no edge listener in
 * front), so the per-address throttle of one test never affects another.
 */
test.describe.configure({ mode: "serial" });

let admin: AdminEnv;
let started = false;
// `password` is the current one: the temporary password until enrollment sets a new one.
const OWNER = { email: `owner-${String(Date.now())}@example.test`, password: "owner-password-e2e-1", name: "E2E Owner" };
const STAFF = { email: `staff-${String(Date.now())}@example.test`, password: "staff-password-e2e-1", name: "E2E Staff" };
const TARGET = { email: `target-${String(Date.now())}@example.test`, password: "target-password-e2e-1", name: "Lock Target" };
const usedCodes = new Map<string, Set<string>>();
let ownerSecret = "";
let ownerCodes: string[] = [];
let staffSecret = "";

const used = (who: string): Set<string> => {
  let set = usedCodes.get(who);
  if (set === undefined) usedCodes.set(who, (set = new Set()));
  return set;
};

async function contextFor(browser: Browser, ip: string): Promise<BrowserContext> {
  return browser.newContext({ baseURL: ADMIN_AUTH_URL, extraHTTPHeaders: { "x-forwarded-for": ip } });
}

async function passwordStep(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * Forced enrollment from the /enroll page: the temporary password and a new one, the QR code and
 * key, the first code. Updates `account.password`; returns the authenticator secret and codes.
 */
async function enroll(page: Page, account: { password: string }, who: string): Promise<{ secret: string; codes: string[] }> {
  await expect(page).toHaveURL(/\/enroll$/);
  const newPassword = `${account.password}-new`;
  await page.getByLabel("Current password").fill(account.password);
  await page.getByLabel("New password").fill(newPassword);
  const started = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/enroll"));
  await page.getByRole("button", { name: "Start setup" }).click();
  // The action result carries the TOTP secret and the recovery codes: never cached.
  expect((await started).headers()["cache-control"]).toContain("no-store");
  account.password = newPassword;
  const qr = page.getByTestId("totp-qr");
  await expect(qr).toBeVisible();
  expect(await qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
  const secret = ((await page.getByTestId("totp-secret").textContent()) ?? "").replace(/\s/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{32,}$/);
  const codes = await page.getByTestId("recovery-codes").locator("li").allTextContents();
  expect(codes).toHaveLength(10);
  await page.getByLabel("Authenticator code").fill(await freshTotp(secret, used(who)));
  await page.getByRole("button", { name: "Turn on two-factor" }).click();
  await expect(page).toHaveURL(`${ADMIN_AUTH_URL}/`);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  return { secret, codes };
}

async function signInWithTotp(page: Page, email: string, password: string, secret: string, who: string): Promise<void> {
  await passwordStep(page, email, password);
  await expect(page).toHaveURL(/\/login\/two-factor$/);
  await page.getByLabel("Authenticator code").fill(await freshTotp(secret, used(who)));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

/** A request client that sends exactly the headers given (no browser Origin, no cookie jar). */
async function rawClient(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: ADMIN_AUTH_URL });
}

const cookieHeader = async (context: BrowserContext): Promise<string> =>
  (await context.cookies(ADMIN_AUTH_URL)).map((c) => `${c.name}=${c.value}`).join("; ");

/** The id of the server action a server-rendered form posts to (progressive enhancement field). */
const actionIdOf = (html: string): string => {
  const id = /name="\$ACTION_ID_([0-9a-f]+)"/.exec(html)?.[1];
  if (id === undefined) throw new Error("no server action form on the page");
  return id;
};

const userIdByEmail = async (email: string): Promise<string> => {
  const [row] = await admin.sql<{ id: string }[]>`SELECT id FROM admin_auth."user" WHERE email = ${email}`;
  if (row === undefined) throw new Error(`no user ${email}`);
  return row.id;
};
const isDisabled = async (userId: string): Promise<boolean> =>
  (await admin.sql<{ d: boolean }[]>`SELECT disabled_at IS NOT NULL AS d FROM admin_profiles WHERE auth_user_id = ${userId}`)[0]?.d === true;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  admin = await startAdminEnv();
  started = true;
  const boot = await runAdminCli(admin.env, ["bootstrap-owner", "--email", OWNER.email, "--name", OWNER.name], `${OWNER.password}\n`);
  expect(boot.stderr).toBe("");
  expect(boot.code).toBe(0);
});

test.afterAll(async () => {
  if (started) await admin.stop();
});

test("forced 2FA: a new Owner can reach nothing but enrollment; afterwards sign-in asks for the code", async ({ browser }) => {
  const context = await contextFor(browser, "203.0.113.10");
  const page = await context.newPage();
  await passwordStep(page, OWNER.email, OWNER.password);
  await expect(page).toHaveURL(/\/enroll$/);
  for (const path of ["/", "/team", "/audit", "/account"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/enroll$/);
  }
  const enrollPage = await page.goto("/enroll");
  expect(enrollPage?.headers()["cache-control"]).toContain("no-store");
  const temporary = OWNER.password;
  const enrolled = await enroll(page, OWNER, "owner");
  ownerSecret = enrolled.secret;
  ownerCodes = enrolled.codes;

  // The session cookie: __Host- prefix, Secure, HttpOnly, SameSite=Strict, no Domain.
  const session = (await context.cookies()).find((c) => c.name === "__Host-admin_session");
  expect(session).toMatchObject({ secure: true, httpOnly: true, sameSite: "Strict", path: "/", domain: "127.0.0.1" });
  expect((await context.cookies()).some((c) => c.name.includes("trust_device"))).toBe(false);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/team");
  await expect(page).toHaveURL(/\/login$/);

  // The temporary password was replaced at enrollment.
  await passwordStep(page, OWNER.email, temporary);
  await expect(page.getByTestId("form-error")).toContainText("Wrong e-mail or password");
  await passwordStep(page, OWNER.email, OWNER.password);
  await expect(page).toHaveURL(/\/login\/two-factor$/);
  await page.getByLabel("Authenticator code").fill(wrongTotp(ownerSecret));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("form-error")).toContainText("not valid");
  await page.getByLabel("Authenticator code").fill(await freshTotp(ownerSecret, used("owner")));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await context.close();
});

test("recovery code sign-in: works once per code", async ({ browser }) => {
  const context = await contextFor(browser, "203.0.113.11");
  const page = await context.newPage();
  const code = ownerCodes[0] ?? "";
  await passwordStep(page, OWNER.email, OWNER.password);
  await page.getByRole("link", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.goto("/account");
  await expect(page.getByTestId("codes-left")).toHaveText("9");
  await page.getByRole("button", { name: "Sign out" }).click();

  await passwordStep(page, OWNER.email, OWNER.password);
  await expect(page).toHaveURL(/\/login\/two-factor$/);
  await page.goto("/login/recovery");
  await page.getByLabel("Recovery code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("form-error")).toContainText("not valid or was already used");
  await expect(page).toHaveURL(/\/login\/recovery$/);

  const [use] = await admin.sql<{ actor_kind: string; changes: { remaining: number } }[]>`
    SELECT actor_kind, changes FROM audit_log WHERE action = 'admin_auth.recovery_code_used' ORDER BY id DESC LIMIT 1`;
  expect(use).toEqual({ actor_kind: "admin", changes: { remaining: 9 } });
  await context.close();
});

test("Staff get 403 on Owner-only pages and actions, and those controls are hidden", async ({ browser }) => {
  // The Owner adds two Staff accounts from the Team page.
  const owner = await contextFor(browser, "203.0.113.12");
  const ownerPage = await owner.newPage();
  await signInWithTotp(ownerPage, OWNER.email, OWNER.password, ownerSecret, "owner");
  await ownerPage.goto("/team");
  for (const account of [STAFF, TARGET]) {
    await ownerPage.getByLabel("E-mail", { exact: true }).fill(account.email);
    await ownerPage.getByLabel("Name", { exact: true }).fill(account.name);
    await ownerPage.getByLabel("Temporary password", { exact: true }).fill(account.password);
    await ownerPage.getByRole("button", { name: "Add Staff" }).click();
    await expect(ownerPage.getByRole("status")).toContainText("Staff account created");
    await expect(ownerPage.getByRole("cell", { name: account.email })).toBeVisible();
  }

  // Audit: the e-mail and name are references only; non-PII fields carry their values.
  const staffId = await userIdByEmail(STAFF.email);
  const [created] = await admin.sql<{ text: string; changes: unknown; pii_refs: string[] }[]>`
    SELECT row_to_json(a)::text AS text, changes, pii_refs FROM audit_log a WHERE action = 'admin_user.create' AND entity_id = ${staffId}`;
  expect(created?.changes).toEqual({ role: { after: "staff" }, disabled: { after: false }, password: { set: true }, enroll_within_hours: 72 });
  expect(created?.pii_refs).toEqual([`admin_user:${staffId}.email set`, `admin_user:${staffId}.display_name set`]);
  for (const pii of [STAFF.email, STAFF.name, STAFF.password]) expect(created?.text).not.toContain(pii);

  const staff = await contextFor(browser, "203.0.113.20");
  const staffPage = await staff.newPage();
  await passwordStep(staffPage, STAFF.email, STAFF.password);
  staffSecret = (await enroll(staffPage, STAFF, "staff")).secret;

  // Hidden: the navigation has no Owner-only entries for Staff (the Owner sees them).
  // The menu is in collapsible groups (the page's group starts open): open Dashboard and System to read them.
  await openConsoleNav(staffPage, "dashboard");
  const nav = await openConsoleNav(staffPage, "system");
  await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Account" })).toBeVisible();
  await expect(consoleNavLinks(staffPage, "/team")).toHaveCount(0);
  await expect(consoleNavLinks(staffPage, "/audit")).toHaveCount(0);
  await expect((await openConsoleNav(ownerPage, "system")).getByRole("link", { name: "Audit log" })).toBeVisible();

  // 403 on the routes.
  for (const path of ["/team", "/audit"]) {
    const response = await staffPage.goto(path);
    expect(response?.status(), path).toBe(403);
    await expect(staffPage.getByRole("heading", { name: "403: not allowed" })).toBeVisible();
    await expect(staffPage.getByRole("button", { name: /Disable|Add Staff/ })).toHaveCount(0);
  }

  // 403 on the Owner's server action, replayed with the Staff session from the right origin. The
  // action id comes from the Owner's Team page. adminAction checks the role before the action body.
  await ownerPage.goto("/team");
  const disableAction = actionIdOf(await ownerPage.content());
  const ownerId = await userIdByEmail(OWNER.email);
  const api = await rawClient();
  const staffHeaders = { cookie: await cookieHeader(staff), origin: ADMIN_AUTH_URL, "x-forwarded-for": "203.0.113.20" };
  // As the console's client calls actions (fetch with Next-Action): 403.
  const forged = await api.post("/team", {
    headers: { ...staffHeaders, "next-action": disableAction, "content-type": "text/plain;charset=UTF-8" },
    data: "[]",
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(403);
  // As a no-JS form post: refused too (Next.js 16.4 renders its not-found page for an access
  // error raised in a form-post action, so the status is 404 there).
  const forgedForm = await api.post("/team", {
    headers: staffHeaders,
    multipart: { [`$ACTION_ID_${disableAction}`]: "", userId: ownerId, disabled: "true" },
    maxRedirects: 0,
  });
  expect([403, 404]).toContain(forgedForm.status());
  expect(await isDisabled(ownerId)).toBe(false);
  await api.dispose();
  await owner.close();
  await staff.close();
});

test("cross-origin POSTs to server actions and route handlers are refused (403), the same request from the admin origin works", async ({ browser }) => {
  const owner = await contextFor(browser, "203.0.113.13");
  const page = await owner.newPage();
  await signInWithTotp(page, OWNER.email, OWNER.password, ownerSecret, "owner");
  await page.goto("/team");
  const disableAction = actionIdOf(await page.content());
  const targetId = await userIdByEmail(TARGET.email);
  const cookie = await cookieHeader(owner);
  const api = await rawClient();
  const post = (origin: string | null) =>
    api.post("/team", {
      headers: { cookie, "x-forwarded-for": "203.0.113.13", ...(origin === null ? {} : { origin }) },
      multipart: { [`$ACTION_ID_${disableAction}`]: "", userId: targetId, disabled: "true" },
      maxRedirects: 0,
    });

  for (const origin of [OTHER_ORIGIN, null, "null", `${ADMIN_AUTH_URL}.evil.example.test`]) {
    const response = await post(origin);
    expect(response.status(), String(origin)).toBe(403);
    expect(await isDisabled(targetId), String(origin)).toBe(false);
  }
  // Fetch-style action call (Next-Action header) from another origin: refused too.
  const viaHeader = await api.post("/team", {
    headers: { cookie, origin: OTHER_ORIGIN, "next-action": disableAction, "content-type": "text/plain;charset=UTF-8", "x-forwarded-for": "203.0.113.13" },
    data: "[]",
    maxRedirects: 0,
  });
  expect(viaHeader.status()).toBe(403);
  // Route handler: a cross-origin sign-out does not end the session.
  const signOut = await api.post("/auth/sign-out", { headers: { cookie, origin: OTHER_ORIGIN }, maxRedirects: 0 });
  expect(signOut.status()).toBe(403);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  // GET never changes state: the route has no GET handler.
  const get = await api.get("/auth/sign-out", { headers: { cookie }, maxRedirects: 0 });
  expect(get.status()).toBe(405);

  // Control: the same action from the admin origin is accepted, so only the origin was refused.
  const accepted = await post(ADMIN_AUTH_URL);
  expect(accepted.status()).toBeLessThan(400);
  await expect.poll(() => isDisabled(targetId)).toBe(true);
  const [disabled] = await admin.sql<{ changes: unknown }[]>`SELECT changes FROM audit_log WHERE action = 'admin_user.disable' AND entity_id = ${targetId}`;
  expect(disabled?.changes).toEqual({ disabled: { before: false, after: true }, sessions_revoked: 0 });
  await admin.sql`UPDATE admin_profiles SET disabled_at = NULL WHERE auth_user_id = ${targetId}`;
  await api.dispose();
  await owner.close();
});

test("lockout: after 5 failed passwords the account is locked, even for the right password from another address", async ({ browser }) => {
  const attacker = await contextFor(browser, "203.0.113.30");
  const page = await attacker.newPage();
  for (let i = 1; i <= 5; i++) {
    await passwordStep(page, TARGET.email, `wrong-password-${String(i)}`);
    await expect(page.getByTestId("form-error")).toContainText(i < 5 ? "Wrong e-mail or password" : "Too many attempts");
  }
  await passwordStep(page, TARGET.email, TARGET.password);
  await expect(page.getByTestId("form-error")).toContainText("Too many attempts");

  const owner = await contextFor(browser, "203.0.113.31");
  const ownerTab = await owner.newPage();
  await passwordStep(ownerTab, TARGET.email, TARGET.password);
  await expect(ownerTab.getByTestId("form-error")).toContainText("Too many attempts");
  await expect(ownerTab).toHaveURL(/\/login$/);

  const [lock] = await admin.sql<{ actor_kind: string; changes: Record<string, unknown> }[]>`
    SELECT actor_kind, changes FROM audit_log WHERE action = 'admin_auth.locked_out' ORDER BY id DESC LIMIT 1`;
  expect(lock).toMatchObject({ actor_kind: "system", changes: { step: "password", account: true } });
  await attacker.close();
  await owner.close();
});

test("nonce CSP: every script carries the per-request nonce, no violations, no unsafe-inline scripts", async ({ browser }) => {
  const context = await contextFor(browser, "203.0.113.14");
  const page = await context.newPage();
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener("securitypolicyviolation", (event) => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  const nonces = new Set<string>();
  for (const path of ["/login", "/login", "/enroll"]) {
    const response = await page.goto(path);
    const csp = response?.headers()["content-security-policy"] ?? "";
    const nonce = /script-src 'self' 'nonce-([A-Za-z0-9+/=]+)' 'strict-dynamic'/.exec(csp)?.[1];
    expect(nonce, csp).toBeDefined();
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    nonces.add(nonce ?? "");
    const scriptNonces = await page.evaluate(() => [...document.scripts].map((s) => s.nonce));
    expect(scriptNonces.length).toBeGreaterThan(0);
    for (const n of scriptNonces) expect(n).toBe(nonce);
  }
  expect(nonces.size).toBe(3);
  // The page is hydrated (client components work) and nothing was blocked.
  await page.goto("/login");
  await page.getByLabel("E-mail").fill("nobody@example.test");
  await page.getByLabel("Password").fill("not-a-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("form-error")).toContainText("Wrong e-mail or password");
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  await context.close();
});

test("sign-out after the idle timeout still lands on /login and clears the cookie", async ({ browser }) => {
  const context = await contextFor(browser, "203.0.113.15");
  const page = await context.newPage();
  await signInWithTotp(page, OWNER.email, OWNER.password, ownerSecret, "owner");
  const ownerId = await userIdByEmail(OWNER.email);
  await admin.sql`UPDATE admin_auth.session_state SET last_seen_at = clock_timestamp() - interval '31 minutes'
                   WHERE session_id IN (SELECT id FROM admin_auth.session WHERE "userId" = ${ownerId})`;
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.cookies()).some((c) => c.name === "__Host-admin_session")).toBe(false);
  await context.close();
});

test("an expired second-factor challenge or a TOTP code used twice is refused", async ({ browser }) => {
  const context = await contextFor(browser, "203.0.113.21");
  const page = await context.newPage();
  const code = await freshTotp(staffSecret, used("staff"));
  await passwordStep(page, STAFF.email, STAFF.password);
  await page.getByLabel("Authenticator code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await passwordStep(page, STAFF.email, STAFF.password);
  await expect(page).toHaveURL(/\/login\/two-factor$/);
  await page.getByLabel("Authenticator code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("form-error")).toContainText("not valid");
  await context.clearCookies();
  await page.goto("/login/two-factor");
  await expect(page).toHaveURL(/\/login$/);
  await context.close();
});
