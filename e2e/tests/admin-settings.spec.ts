import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type Page, request, test } from "@playwright/test";
import { makeZip } from "../../packages/uploads/test/zip-fixture.ts";
import { type AdminEnv, consoleNavLinks, freshTotp, openConsoleNav, runAdminCli, startAdminEnv } from "../support/admin.ts";

/**
 * US-017 (M5a-2) against the production build of apps/admin (`next start`, own database and port):
 *   - program field lock after the first PAID order + extend-only reschedule, enforced by the server;
 *   - a 21 MiB PDF shows the size warning, is accepted after confirmation and goes up in chunks;
 *   - a template test-send enqueues a worker job (outbox row) and the preview cannot run script;
 *   - Staff cannot register LP domains: the control is hidden and the action answers 403;
 *   - US-023: the Owner uploads a landing-page ZIP: a refused one lists its problems and publishes
 *     nothing, a valid one goes live on the domain's link, a second one replaces it, rollback.
 * DOMAIN is a reserved test name (RFC 6761); the sealing keys are generated per run (public halves
 * only reach the app).
 */
test.describe.configure({ mode: "serial" });

const PORT = 3203;
const URL_ = `http://127.0.0.1:${String(PORT)}`;
const DOMAIN = "example.test";
const stamp = String(Date.now());
const OWNER = { email: `owner-set-${stamp}@example.test`, password: "owner-settings-e2e-1", name: "Settings Owner" };
const STAFF = { email: `staff-set-${stamp}@example.test`, password: "staff-settings-e2e-1", name: "Settings Staff" };
const MiB = 1024 * 1024;

let admin: AdminEnv;
let started = false;
let dataDir = "";
let lpDir = "";
const secrets: Record<string, string> = {};
const usedCodes = new Map<string, Set<string>>();
const used = (who: string): Set<string> => {
  let set = usedCodes.get(who);
  if (set === undefined) usedCodes.set(who, (set = new Set()));
  return set;
};

const publicKey = (): string => {
  const jwk = generateKeyPairSync("x25519").publicKey.export({ format: "jwk" });
  return jwk.x ?? "";
};

async function contextFor(browser: Browser, ip: string): Promise<BrowserContext> {
  return browser.newContext({ baseURL: URL_, extraHTTPHeaders: { "x-forwarded-for": ip } });
}

async function passwordStep(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function enroll(page: Page, account: { password: string }, who: string): Promise<void> {
  await expect(page).toHaveURL(/\/enroll$/);
  const newPassword = `${account.password}-new`;
  await page.getByLabel("Current password").fill(account.password);
  await page.getByLabel("New password").fill(newPassword);
  await page.getByRole("button", { name: "Start setup" }).click();
  account.password = newPassword;
  const secret = ((await page.getByTestId("totp-secret").textContent()) ?? "").replace(/\s/g, "");
  secrets[who] = secret;
  await page.getByLabel("Authenticator code").fill(await freshTotp(secret, used(who)));
  await page.getByRole("button", { name: "Turn on two-factor" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

const one = async <T>(rows: Promise<readonly T[]>): Promise<T> => {
  const [row] = await rows;
  if (row === undefined) throw new Error("no row");
  return row;
};

let ownerContext: BrowserContext;
let owner: Page;
let productId = "";
let programId = "";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  dataDir = await mkdtemp(join(tmpdir(), "ebt-e2e-data-"));
  lpDir = await mkdtemp(join(tmpdir(), "ebt-e2e-lp-"));
  admin = await startAdminEnv({
    port: PORT,
    extraEnv: {
      DOMAIN,
      ADMIN_DATA_DIR: dataDir,
      ADMIN_LP_DIR: lpDir,
      SECRETS_PAYMENT_PUBLIC_KEY: publicKey(),
      SECRETS_MESSAGING_PUBLIC_KEY: publicKey(),
      SECRETS_CONVERSIONS_PUBLIC_KEY: publicKey(),
    },
  });
  started = true;
  const boot = await runAdminCli(admin.env, ["bootstrap-owner", "--email", OWNER.email, "--name", OWNER.name], `${OWNER.password}\n`);
  expect(boot.code).toBe(0);
  ownerContext = await contextFor(browser, "203.0.113.40");
  owner = await ownerContext.newPage();
  await passwordStep(owner, OWNER.email, OWNER.password);
  await enroll(owner, OWNER, "owner");
  // A Staff account (AC-A1 content only).
  await owner.goto("/team");
  await owner.getByLabel("E-mail", { exact: true }).fill(STAFF.email);
  await owner.getByLabel("Name", { exact: true }).fill(STAFF.name);
  await owner.getByLabel("Temporary password", { exact: true }).fill(STAFF.password);
  await owner.getByRole("button", { name: "Add Staff" }).click();
  await expect(owner.getByRole("status")).toContainText("Staff account created");
});

test.afterAll(async () => {
  await ownerContext.close();
  if (started) await admin.stop();
  await rm(dataDir, { recursive: true, force: true });
  await rm(lpDir, { recursive: true, force: true });
});

test("program lock: after the first PAID order the locked fields refuse changes on the server, and reschedule only extends", async () => {
  await owner.goto("/settings/products");
  await owner.getByLabel("Title", { exact: true }).first().fill("Ebook Uji Kunci");
  await owner.getByLabel("Price (IDR)", { exact: true }).first().fill("49.000");
  await owner.getByRole("button", { name: "Create product" }).click();
  await expect(owner.getByRole("status")).toContainText("Product created");
  productId = (await one(admin.sql<{ id: string }[]>`SELECT id FROM products WHERE title = 'Ebook Uji Kunci'`)).id;

  await owner.goto("/settings/programs");
  const create = owner.getByTestId("program-create");
  await create.getByLabel("Ebook (product)").selectOption(productId);
  await create.getByLabel("Name").fill("Musim Kunci");
  await create.getByLabel("Slug").fill(`kunci-${stamp}`);
  await create.getByLabel("First sales day (WIB)").fill("2027-04-01");
  await create.getByLabel("Last sales day (WIB)").fill("2027-06-30");
  await create.getByLabel("Grace days").fill("30");
  await create.getByRole("button", { name: "Create program" }).click();
  await expect(create.getByRole("status")).toContainText("Program created");
  programId = (await one(admin.sql<{ id: string }[]>`SELECT id FROM programs WHERE slug = ${`kunci-${stamp}`}`)).id;
  const card = owner.getByTestId(`program-kunci-${stamp}`);

  // Before any payment the dates are editable.
  await card.getByTestId("program-edit").getByLabel("Grace days").fill("20");
  await card.getByTestId("program-edit").getByRole("button", { name: "Save program" }).click();
  await expect(card.getByTestId("program-edit").getByRole("status")).toContainText("Program saved");

  // The first PAID order (as the worker would mark it).
  const lp = await one(admin.sql<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_lock${stamp}`}, 'LP', ${programId}) RETURNING id`);
  const order = await one(
    admin.sql<{ id: string }[]>`
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, expires_at)
      VALUES (${`lock${stamp}`}, 'K0C00000', ${lp.id}, ${programId}, ${productId}, 'Pembeli', '+6281234567890', 'buyer@example.invalid', sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 49000, now() + interval '1 day')
      RETURNING id`,
  );
  await admin.sql`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order.id}`;

  await owner.reload();
  await expect(card.getByTestId("program-locked")).toContainText("Locked: 1 paid order");
  const edit = card.getByTestId("program-edit");
  await expect(edit.getByLabel("Slug")).toHaveAttribute("readonly", "");
  await expect(edit.getByLabel("Last sales day (WIB)")).toHaveAttribute("readonly", "");
  // The server refuses a locked field even when the form is tampered with (readonly removed).
  await edit.getByLabel("Last sales day (WIB)").evaluate((el) => {
    el.removeAttribute("readonly");
  });
  await edit.getByLabel("Last sales day (WIB)").fill("2027-06-20");
  await edit.getByRole("button", { name: "Save program" }).click();
  await expect(edit.getByTestId("form-error")).toContainText("locked");
  await expect.poll(async () => (await one(admin.sql<{ slug: string; end: string }[]>`SELECT slug, to_char(sales_end_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS "end" FROM programs WHERE id = ${programId}`))).toEqual({
    slug: `kunci-${stamp}`,
    end: "2027-07-01",
  });

  // Reschedule: an earlier last day is refused; a later one with more grace is accepted.
  const reschedule = card.getByTestId("program-reschedule");
  await reschedule.getByLabel("New last sales day (WIB)").fill("2027-06-29");
  await reschedule.getByRole("button", { name: "Reschedule" }).click();
  await expect(reschedule.getByTestId("form-error")).toContainText("only move the last sales day and the end of grace later");
  await reschedule.getByLabel("New last sales day (WIB)").fill("2027-07-15");
  await reschedule.getByLabel("New grace days").fill("25");
  await reschedule.getByRole("button", { name: "Reschedule" }).click();
  await expect(reschedule.getByRole("status")).toContainText("Program rescheduled");
  const after = await one(admin.sql<{ end: Date; grace: number }[]>`SELECT sales_end_at AS "end", grace_days AS grace FROM programs WHERE id = ${programId}`);
  expect(after).toEqual({ end: new Date("2027-07-15T17:00:00.000Z"), grace: 25 });
  const audit = await one(admin.sql<{ changes: Record<string, unknown> }[]>`SELECT changes FROM audit_log WHERE action = 'program.reschedule' AND entity_id = ${programId} ORDER BY id DESC LIMIT 1`);
  expect(audit.changes).toMatchObject({ sales_end_at: { before: "2027-06-30T17:00:00.000Z", after: "2027-07-15T17:00:00.000Z" }, grace_days: { before: 20, after: 25 }, locked: true });
  // Even the database refuses shortening the locked program (any writer).
  await expect(admin.sql`UPDATE programs SET sales_end_at = sales_end_at - interval '1 day' WHERE id = ${programId}`).rejects.toMatchObject({ code: "ET048" });
});

test("a 21 MiB PDF shows the size warning, is accepted after confirming, and goes up in 1 MiB chunks", async () => {
  await owner.goto("/settings/products");
  const card = owner.getByTestId(`product-${productId}`);
  await expect(card.getByTestId("pdf-status")).toHaveText("No PDF yet");
  const size = 21 * MiB;
  const pdf = Buffer.alloc(size, 0x20);
  pdf.write("%PDF-1.7\n", 0, "latin1");
  pdf.write("\n%%EOF\n", size - 7, "latin1");
  const chunkSizes: number[] = [];
  owner.on("request", (r) => {
    if (r.url().includes("/uploads/pdf/chunk")) chunkSizes.push(r.postDataBuffer()?.length ?? -1);
  });
  await card.getByLabel("Upload ebook PDF").setInputFiles({ name: "ebook-besar.pdf", mimeType: "application/pdf", buffer: pdf });
  const dialog = owner.getByRole("dialog", { name: "Large PDF" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("21.0 MB");
  await dialog.getByRole("button", { name: "Upload anyway" }).click();
  await expect(card.getByRole("status")).toContainText("PDF uploaded (large file", { timeout: 60_000 });
  await expect(card.getByTestId("pdf-status")).toHaveText("PDF 21.0 MB");
  expect(chunkSizes).toHaveLength(21);
  expect(Math.max(...chunkSizes)).toBe(MiB);
  const row = await one(
    admin.sql<{ storage_path: string; size_bytes: string; large_confirmed: boolean }[]>`
      SELECT u.storage_path, u.size_bytes::text AS size_bytes, s.large_confirmed
        FROM products p JOIN uploads u ON u.id = p.pdf_upload_id JOIN upload_sessions s ON s.upload_id = u.id WHERE p.id = ${productId}`,
  );
  expect(row).toMatchObject({ size_bytes: String(size), large_confirmed: true });
  expect((await stat(join(dataDir, row.storage_path))).size).toBe(size);
  // The admin origin never serves the stored file (no GET handler; the upload routes are POST only).
  const raw = await request.newContext({ baseURL: URL_ });
  expect((await raw.get(`/${row.storage_path}`)).status()).not.toBe(200);
  expect((await raw.get("/uploads/pdf/complete")).status()).toBe(405);
  await raw.dispose();
});

test("a template test-send enqueues a worker job; the preview escapes user content", async () => {
  await owner.goto("/settings/templates");
  const card = owner.getByTestId("template-delivery-email");
  // Preview with a hostile sample name: escaped, inside an empty-sandbox iframe, no dialog fires.
  let dialogs = 0;
  owner.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });
  const editor = card.getByTestId("template-editor");
  await editor.getByLabel("Sample buyer name (preview only)").fill("<img src=x onerror=alert(1)><script>alert(2)</script>");
  await editor.getByRole("button", { name: "Preview" }).click();
  const frame = editor.getByTestId("preview-frame");
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("sandbox", "");
  const srcdoc = (await frame.getAttribute("srcdoc")) ?? "";
  expect(srcdoc).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(srcdoc).not.toContain("<img");
  expect(srcdoc).not.toContain("<script>alert");
  expect(dialogs).toBe(0);

  // An e-mail test goes to the requester's own login address only (security review S4).
  const send = card.getByTestId("template-test-send");
  await expect(send).toContainText("Sends to your login e-mail address.");
  await expect(send.getByRole("textbox")).toHaveCount(0);
  await send.getByRole("button", { name: "Send test" }).click();
  await expect(send.getByRole("status")).toContainText("Test message queued to your login e-mail");
  const job = await one(
    admin.sql<{ topic: string; payload: { test_send_id: string }; processed_at: Date | null; status: string; channel: string }[]>`
      SELECT o.topic, o.payload, o.processed_at, t.status, t.channel
        FROM template_test_sends t JOIN outbox o ON (o.payload ->> 'test_send_id')::uuid = t.id
       WHERE t.recipient = ${OWNER.email}`,
  );
  expect(job).toMatchObject({ topic: "template.test_send", processed_at: null, status: "pending", channel: "email" });
  // The audit row names the recipient by reference only.
  const audit = await one(admin.sql<{ text: string }[]>`SELECT row_to_json(a)::text AS text FROM audit_log a WHERE action = 'message_template.test_send' ORDER BY id DESC LIMIT 1`);
  expect(audit.text).not.toContain(OWNER.email);
  await owner.reload();
  await expect(card.getByTestId("template-tests")).toContainText("pending");
});

test("Staff cannot register LP domains: the control is hidden and the action is refused (403)", async ({ browser }) => {
  // The Owner creates a landing page and registers a domain (the app's own domain is refused).
  await owner.goto("/settings/landing-pages");
  const create = owner.getByTestId("lp-create");
  await create.getByLabel("Name").fill("LP Uji");
  await create.getByLabel("Program").selectOption(programId);
  await create.getByRole("button", { name: "Create landing page" }).click();
  await expect(create.getByRole("status")).toContainText("Landing page created");
  const lp = await one(admin.sql<{ id: string; lp_key: string }[]>`SELECT id, lp_key FROM landing_pages WHERE name = 'LP Uji'`);
  const card = owner.getByTestId(`lp-${lp.lp_key}`);
  await expect(card.getByTestId("lp-snippet")).toHaveText(`<script src="https://api.${DOMAIN}/sdk/v1.js" data-lp="${lp.lp_key}" async></script>`);
  const register = card.getByTestId("lp-domain-register");
  await register.getByLabel("Domain").fill(`PLAY.${DOMAIN.toUpperCase()}`);
  await register.getByRole("button", { name: "Register domain" }).click();
  await expect(register.getByTestId("form-error")).toContainText("app's own domain");
  await register.getByLabel("Domain").fill("promo.brand.example.");
  await register.getByRole("button", { name: "Register domain" }).click();
  await expect(register.getByTestId("form-error")).toContainText("no IP address, port, path or trailing dot");
  await register.getByLabel("Domain").fill("promo.brand.example");
  const captured = owner.waitForRequest((r) => r.method() === "POST" && r.headers()["next-action"] !== undefined);
  await register.getByRole("button", { name: "Register domain" }).click();
  const ownerRequest = await captured;
  await expect(register.getByRole("status")).toContainText("promo.brand.example registered.");
  const actionId = ownerRequest.headers()["next-action"] ?? "";
  const ownerBody = ownerRequest.postDataBuffer() ?? Buffer.alloc(0);
  const ownerType = ownerRequest.headers()["content-type"] ?? "";

  // Staff: enroll, then the landing pages page shows no domain control and no Owner-only entries.
  const staffContext = await contextFor(browser, "203.0.113.41");
  const staff = await staffContext.newPage();
  await passwordStep(staff, STAFF.email, STAFF.password);
  await enroll(staff, STAFF, "staff");
  await openConsoleNav(staff, "program");
  const nav = await openConsoleNav(staff, "messaging");
  await expect(nav.getByRole("link", { name: "Landing pages" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Products" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Templates" })).toBeVisible();
  for (const href of ["/settings/programs", "/settings/adnets", "/settings/midtrans", "/settings/waha", "/settings/smtp"]) await expect(consoleNavLinks(staff, href), href).toHaveCount(0);
  await staff.goto("/settings/landing-pages");
  const staffCard = staff.getByTestId(`lp-${lp.lp_key}`);
  await expect(staffCard.getByTestId("lp-domains")).toContainText("promo.brand.example");
  await expect(staff.getByTestId("lp-domain-register")).toHaveCount(0);
  await expect(staff.getByRole("button", { name: "Register domain" })).toHaveCount(0);
  await expect(staff.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(staff.getByRole("button", { name: "Save pixel ids" })).toHaveCount(0);
  for (const path of ["/settings/programs", "/settings/midtrans", "/settings/waha", "/settings/smtp", "/settings/adnets"]) {
    expect((await staff.goto(path))?.status(), path).toBe(403);
  }

  // The Owner's register-domain action replayed with the Staff session from the admin origin: 403.
  const cookie = (await staffContext.cookies(URL_)).map((c) => `${c.name}=${c.value}`).join("; ");
  const api = await request.newContext({ baseURL: URL_ });
  const forged = await api.post("/settings/landing-pages", {
    headers: { cookie, origin: URL_, "next-action": actionId, "content-type": ownerType, "x-forwarded-for": "203.0.113.41" },
    data: Buffer.from(ownerBody.toString("utf8").replace("promo.brand.example", "staff.brand.example")),
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(403);
  expect(await admin.sql`SELECT 1 FROM lp_domains WHERE host = 'staff.brand.example'`).toHaveLength(0);
  expect((await admin.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM lp_domains WHERE landing_page_id = ${lp.id}`)[0]?.n).toBe(1);
  await api.dispose();
  await staffContext.close();
});

test("US-023: the Owner publishes a landing-page ZIP, sees why a bad one is refused, and rolls back", async () => {
  const lp = await one(admin.sql<{ id: string; lp_key: string }[]>`SELECT id, lp_key FROM landing_pages WHERE name = 'LP Uji'`);
  await owner.goto("/settings/landing-pages");
  const card = owner.getByTestId(`lp-${lp.lp_key}`);
  const hosting = card.getByTestId("lp-hosting");
  await expect(hosting).toContainText("No version uploaded.");
  const input = hosting.getByLabel("Upload a new version (ZIP, up to 25 MB)");
  const page = (label: string): Buffer => Buffer.from(`<!doctype html><html><head><title>${label}</title></head><body>${label}</body></html>`);

  await input.setInputFiles({ name: "bad.zip", mimeType: "application/zip", buffer: makeZip([{ name: "index.html", data: page("x") }, { name: "shell.php", data: Buffer.from("<?php") }]) });
  const issues = hosting.getByTestId("lp-zip-issues");
  await expect(issues).toContainText("nothing was published");
  await expect(issues).toContainText("shell.php: the file type .php is not allowed");
  expect(await admin.sql`SELECT 1 FROM lp_versions WHERE landing_page_id = ${lp.id}`).toHaveLength(0);

  await input.setInputFiles({ name: "v1.zip", mimeType: "application/zip", buffer: makeZip([{ name: "index.html", data: page("v1") }]) });
  await expect(hosting.getByRole("status")).toHaveText("Version 1 is live.");
  await expect(hosting.getByTestId("lp-versions")).toContainText("Version 1");
  await expect(hosting.getByTestId("lp-versions").getByText("Live")).toHaveCount(1);
  const tag = `<script src="https://api.${DOMAIN}/sdk/v1.js" data-lp="${lp.lp_key}" async></script>`;
  const served = () => readFile(join(lpDir, "hosts", "promo.brand.example", "current", "index.html"), "utf8");
  expect(await served()).toBe(`<!doctype html><html><head><title>v1</title>${tag}</head><body>v1</body></html>`);

  await input.setInputFiles({ name: "v2.zip", mimeType: "application/zip", buffer: makeZip([{ name: "index.html", data: page("v2") }]) });
  await expect(hosting.getByRole("status")).toHaveText("Version 2 is live.");
  expect(await served()).toContain("<body>v2</body>");
  await hosting.getByRole("listitem").filter({ hasText: "Version 1" }).getByRole("button", { name: "Make live" }).click();
  // The live row shows the badge instead of its button (the form, and its status line, are replaced).
  await expect(hosting.getByRole("listitem").filter({ hasText: "Version 1" }).getByText("Live", { exact: true })).toBeVisible();
  await expect(hosting.getByRole("listitem").filter({ hasText: "Version 2" }).getByRole("button", { name: "Make live" })).toBeVisible();
  expect(await served()).toContain("<body>v1</body>");
  const actions = await admin.sql<{ action: string }[]>`SELECT action FROM audit_log WHERE entity_id = ${lp.id} AND action LIKE 'lp_version.%' ORDER BY id`;
  expect(actions.map((a) => a.action)).toEqual(["lp_version.reject", "lp_version.publish", "lp_version.publish", "lp_version.activate"]);
});

test("WAHA: the Owner deletes a never-used server and session after a two-step confirmation; used ones show a hint and no button; 390 px holds", async () => {
  const serverName = `Hapus ${stamp}`;
  const host = `waha-del-${stamp}.example.test`;
  const apiKey = `e2e-waha-key-${stamp}-0123456789`;
  const keyName = (id: string): string => `waha.${id.replaceAll("-", "")}.api_key`;
  await owner.goto("/settings/waha");
  const create = owner.getByTestId("waha-create");
  await create.getByLabel("Name").fill(serverName);
  await create.getByLabel("Base URL (https)").fill(`https://${host}/`);
  await create.getByRole("button", { name: "Add server" }).click();
  await expect(create.getByRole("status")).toContainText("Server added");
  const server = await one(admin.sql<{ id: string }[]>`SELECT id FROM waha_servers WHERE name = ${serverName}`);
  const card = owner.getByTestId(`waha-${server.id}`);

  // Its API key, then a session that is still active: nothing can be deleted yet, and the page says why.
  await card.getByLabel("API key (write-only)").fill(apiKey);
  await card.getByRole("button", { name: "Save API key" }).click();
  await expect(card.getByRole("status").filter({ hasText: "API key saved" })).toBeVisible();
  expect(await admin.sql`SELECT 1 FROM settings_secrets WHERE name = ${keyName(server.id)}`).toHaveLength(1);
  const addForm = card.locator("form").filter({ has: owner.getByRole("button", { name: "Add session" }) });
  await addForm.getByLabel("Session name").fill("tmp1");
  await addForm.getByRole("button", { name: "Add session" }).click();
  await expect.poll(async () => (await admin.sql`SELECT 1 FROM waha_sessions WHERE server_id = ${server.id} AND session_name = 'tmp1'`).length).toBe(1);
  const tmp1 = await one(admin.sql<{ id: string }[]>`SELECT id FROM waha_sessions WHERE server_id = ${server.id} AND session_name = 'tmp1'`);
  const tmp1Row = card.getByTestId(`waha-session-${tmp1.id}`);
  await expect(tmp1Row.getByTestId("waha-session-delete-hint")).toHaveText("Untick Active and save before deleting.");
  await expect(card.getByTestId("waha-server-delete-hint")).toHaveText("Untick Active on its sessions and save before deleting.");
  await expect(card.getByRole("button", { name: "Delete session" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Delete server" })).toHaveCount(0);

  // Untick Active and save: both buttons appear.
  await tmp1Row.getByLabel("Active").uncheck();
  await tmp1Row.getByRole("button", { name: "Save session" }).click();
  await expect(tmp1Row.getByRole("button", { name: "Delete session" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Delete server" })).toBeVisible();

  // A used server (one inactive and one active session, both with a send): the hints, no button.
  const usedServer = await one(
    admin.sql<{ id: string }[]>`INSERT INTO waha_servers (name, base_url, base_url_host, active) VALUES (${`Dipakai ${stamp}`}, ${`https://waha-used-${stamp}.example.test/`}, ${`waha-used-${stamp}.example.test`}, true) RETURNING id`,
  );
  const usedOff = await one(admin.sql<{ id: string }[]>`INSERT INTO waha_sessions (server_id, session_name, active) VALUES (${usedServer.id}, 'used-off', false) RETURNING id`);
  const usedOn = await one(admin.sql<{ id: string }[]>`INSERT INTO waha_sessions (server_id, session_name, active) VALUES (${usedServer.id}, 'used-on', true) RETURNING id`);
  await admin.sql`INSERT INTO waha_sends (session_id, kind) VALUES (${usedOff.id}, 'otp'), (${usedOn.id}, 'otp')`;
  await owner.reload();
  const usedCard = owner.getByTestId(`waha-${usedServer.id}`);
  await expect(usedCard.getByTestId(`waha-session-${usedOff.id}`).getByTestId("waha-session-delete-hint")).toHaveText("Has message history, so it cannot be deleted.");
  await expect(usedCard.getByTestId(`waha-session-${usedOn.id}`).getByTestId("waha-session-delete-hint")).toHaveText("Has message history: untick Active to stop using it.");
  await expect(usedCard.getByTestId("waha-server-delete-hint")).toHaveText("Has message history: untick Active to stop using it.");
  await expect(usedCard.getByRole("button", { name: /^Delete/ })).toHaveCount(0);

  // Two steps: the first click only asks (the warning replaces the button, focus goes to Cancel); Cancel, and Escape, put the button back and give it the focus; nothing is deleted.
  await tmp1Row.getByRole("button", { name: "Delete session" }).click();
  const sessionAsk = tmp1Row.getByRole("group", { name: `Delete session tmp1? This cannot be undone.` });
  await expect(sessionAsk).toBeVisible();
  await expect(sessionAsk.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(tmp1Row.getByRole("button", { name: "Delete session" })).toHaveCount(0);
  await sessionAsk.getByRole("button", { name: "Cancel" }).click();
  await expect(tmp1Row.getByRole("button", { name: "Delete session" })).toBeFocused();
  await tmp1Row.getByRole("button", { name: "Delete session" }).click();
  await owner.keyboard.press("Escape");
  await expect(tmp1Row.getByRole("button", { name: "Delete session" })).toBeFocused();
  expect(await admin.sql`SELECT 1 FROM waha_sessions WHERE id = ${tmp1.id}`).toHaveLength(1);

  // "Yes, delete" submits: the session goes, the server stays, and the page says so once (the card that held the form is gone).
  const sessionRequest = owner.waitForRequest((r) => r.method() === "POST" && r.headers()["next-action"] !== undefined);
  await tmp1Row.getByRole("button", { name: "Delete session" }).click();
  await tmp1Row.getByRole("button", { name: "Yes, delete" }).click();
  const deleteRequest = await sessionRequest;
  await expect(owner.getByTestId("deleted-notice")).toHaveText("Session deleted.");
  await expect(card.getByTestId(`waha-session-${tmp1.id}`)).toHaveCount(0);
  expect(await admin.sql`SELECT 1 FROM waha_sessions WHERE id = ${tmp1.id}`).toHaveLength(0);
  expect(await admin.sql`SELECT 1 FROM waha_servers WHERE id = ${server.id}`).toHaveLength(1);
  // The query is dropped from the address once the line is shown, so a reload does not show it again.
  await expect(owner).toHaveURL(/\/settings\/waha$/);
  await owner.reload();
  await expect(owner.getByTestId("deleted-notice")).toHaveCount(0);
  // Only the two fixed texts exist: any other value shows nothing, and nothing of the query is echoed.
  for (const asked of ["constructor", "__proto__", "%3Cb%3Ehi%3C%2Fb%3E", "Server"]) {
    await owner.goto(`/settings/waha?deleted=${asked}`);
    await expect(owner.getByRole("heading", { name: "WhatsApp (WAHA)" })).toBeVisible();
    await expect(owner.getByTestId("deleted-notice")).toHaveCount(0);
  }
  await owner.goto("/settings/waha");

  // The same action replayed by hand on the used session is refused by the server and deletes nothing.
  const cookie = (await ownerContext.cookies(URL_)).map((c) => `${c.name}=${c.value}`).join("; ");
  const api = await request.newContext({ baseURL: URL_ });
  const replay = await api.post("/settings/waha", {
    headers: { cookie, origin: URL_, "next-action": deleteRequest.headers()["next-action"] ?? "", "content-type": deleteRequest.headers()["content-type"] ?? "", "x-forwarded-for": "203.0.113.40" },
    data: Buffer.from((deleteRequest.postDataBuffer() ?? Buffer.alloc(0)).toString("utf8").replace(tmp1.id, usedOff.id)),
    maxRedirects: 0,
  });
  expect(await replay.text()).toContain("has message history");
  await api.dispose();
  expect(await admin.sql`SELECT 1 FROM waha_sessions WHERE id = ${usedOff.id}`).toHaveLength(1);

  // Two deletes of the same kind in a row, the second with no other page render in between: the address is clean after each, and a reload shows no line.
  for (const name of ["tmp2", "tmp3"]) {
    await addForm.getByLabel("Session name").fill(name);
    await addForm.getByLabel("Active").uncheck();
    await addForm.getByRole("button", { name: "Add session" }).click();
  }
  await expect(card.getByRole("button", { name: "Delete session" })).toHaveCount(2);
  for (const nth of [0, 1]) {
    await card.getByRole("button", { name: "Delete session" }).first().click();
    await card.getByRole("button", { name: "Yes, delete" }).click();
    await expect(card.getByRole("button", { name: "Delete session" })).toHaveCount(1 - nth);
    await expect(owner.getByTestId("deleted-notice")).toHaveText("Session deleted.");
    await expect(owner).toHaveURL(/\/settings\/waha$/);
  }
  await owner.reload();
  await expect(owner.getByTestId("deleted-notice")).toHaveCount(0);

  // The server goes with its remaining session and its key.
  await addForm.getByLabel("Session name").fill("tmp4");
  await addForm.getByLabel("Active").uncheck();
  await addForm.getByRole("button", { name: "Add session" }).click();
  await expect(card.getByRole("button", { name: "Delete session" })).toBeVisible();
  // Cancel keeps the server; "Yes, delete" removes it, and the page says so.
  await card.getByRole("button", { name: "Delete server" }).click();
  const serverAsk = card.getByRole("group", { name: `Delete server ${serverName}? Its unused sessions and saved API key are removed. This cannot be undone.` });
  await expect(serverAsk).toBeVisible();
  await expect(serverAsk.getByRole("button", { name: "Cancel" })).toBeFocused();
  await serverAsk.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByRole("button", { name: "Delete server" })).toBeFocused();
  expect(await admin.sql`SELECT 1 FROM waha_servers WHERE id = ${server.id}`).toHaveLength(1);
  expect(await admin.sql`SELECT 1 FROM settings_secrets WHERE name = ${keyName(server.id)}`).toHaveLength(1);
  await card.getByRole("button", { name: "Delete server" }).click();
  await card.getByRole("button", { name: "Yes, delete" }).click();
  await expect(owner.getByTestId("deleted-notice")).toHaveText("Server deleted.");
  await expect(owner.getByTestId(`waha-${server.id}`)).toHaveCount(0);
  expect(await admin.sql`SELECT 1 FROM waha_servers WHERE id = ${server.id}`).toHaveLength(0);
  expect(await admin.sql`SELECT 1 FROM waha_sessions WHERE server_id = ${server.id}`).toHaveLength(0);
  expect(await admin.sql`SELECT 1 FROM settings_secrets WHERE name = ${keyName(server.id)}`).toHaveLength(0);
  expect(await admin.sql`SELECT 1 FROM waha_servers WHERE id = ${usedServer.id}`).toHaveLength(1);

  // The audit log page shows both deletes by name, with no host, URL or key in those rows (the create row of the server does carry its address, as before).
  await owner.goto("/audit");
  const auditTable = owner.getByRole("table", { name: "Audit entries" });
  const serverDelete = auditTable.getByRole("row").filter({ hasText: "waha_server.delete" });
  const sessionDelete = auditTable.getByRole("row").filter({ hasText: "waha_session.delete" });
  await expect(serverDelete).toHaveCount(1);
  await expect(serverDelete).toContainText(serverName);
  // tmp1, tmp2 and tmp3 one by one, tmp4 with the server.
  await expect(sessionDelete).toHaveCount(4);
  await expect(sessionDelete.filter({ hasText: "tmp1" })).toHaveCount(1);
  for (const row of [...(await serverDelete.all()), ...(await sessionDelete.all())]) {
    await expect(row).not.toContainText(host);
    await expect(row).not.toContainText("https://");
    await expect(row).not.toContainText(apiKey);
  }

  // 390 px: no sideways scroll, with hints on the page and with a delete warning open.
  const spare = await one(
    admin.sql<{ id: string }[]>`INSERT INTO waha_servers (name, base_url, base_url_host, active) VALUES (${`Cadangan ${stamp}`}, ${`https://waha-spare-${stamp}.example.test/`}, ${`waha-spare-${stamp}.example.test`}, false) RETURNING id`,
  );
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto("/settings/waha");
  await expect(owner.getByTestId(`waha-${usedServer.id}`).getByTestId("waha-server-delete-hint")).toBeVisible();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const spareCard = owner.getByTestId(`waha-${spare.id}`);
  await spareCard.getByRole("button", { name: "Delete server" }).click();
  await expect(spareCard.getByRole("button", { name: "Yes, delete" })).toBeVisible();
  await expect(spareCard.getByRole("button", { name: "Cancel" })).toBeVisible();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // A refusal: the server gets a session with history behind the page's back, then "Yes, delete" is pressed. The refusal is shown as an alert, nothing is
  // deleted, and the keyboard is still on the (re-enabled) trigger instead of on the page's top.
  const lateSession = await one(admin.sql<{ id: string }[]>`INSERT INTO waha_sessions (server_id, session_name, active) VALUES (${spare.id}, 'late', false) RETURNING id`);
  await admin.sql`INSERT INTO waha_sends (session_id, kind) VALUES (${lateSession.id}, 'otp')`;
  await spareCard.getByRole("button", { name: "Yes, delete" }).click();
  await expect(spareCard.getByRole("alert")).toContainText("has message history");
  await expect(spareCard.getByRole("button", { name: "Delete server" })).toBeFocused();
  await expect(spareCard.getByRole("button", { name: "Delete server" })).not.toHaveAttribute("aria-disabled", "true");
  expect(await admin.sql`SELECT 1 FROM waha_servers WHERE id = ${spare.id}`).toHaveLength(1);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await owner.setViewportSize({ width: 1280, height: 720 });
});

test("Opener wordings: Add wording creates the next one, Remove asks twice, the limits hold (3 to 20); a choice previews one pick; 390 px holds", async () => {
  const wordings = () => admin.sql<{ id: string; key: string; body: string }[]>`
    SELECT id, key, body FROM message_templates WHERE key ~ '^delivery_opener_[0-9]+$' AND channel = 'whatsapp' ORDER BY substring(key from '[0-9]+$')::int`;
  const seeded = await wordings();
  expect(seeded.map((w) => w.key)).toEqual(Array.from({ length: 10 }, (_, i) => `delivery_opener_${String(i + 1)}`));
  await owner.goto("/settings/templates");
  const panel = owner.getByTestId("opener-wordings");
  await expect(panel).toContainText("10 of at most 20 (at least 3)");

  // An invalid wording is refused with what is wrong with it, and nothing is added.
  const add = owner.getByTestId("opener-add");
  await add.getByLabel("New wording").fill("[[Halo|Hai {nama}");
  await add.getByRole("button", { name: "Add wording" }).click();
  await expect(add.getByRole("alert")).toContainText("never closed");
  await add.getByLabel("New wording").fill("Halo {nama}, masuk: {link_trivia}");
  await add.getByRole("button", { name: "Add wording" }).click();
  await expect(add.getByRole("alert")).toContainText("cannot have");
  expect(await wordings()).toHaveLength(10);

  // A valid one becomes the next delivery_opener_N, with a card of its own, and is audited.
  const body = "{sapaan} {nama}, [[ebook|buku]] {judul_ebook} siap. Balas ya.";
  await add.getByLabel("New wording").fill(body);
  await add.getByRole("button", { name: "Add wording" }).click();
  await expect(add.getByRole("status")).toContainText("Wording added as delivery_opener_11.");
  // The form is empty again: a second press (a double click) cannot add the same text twice. The same text typed again is refused, naming the wording.
  await expect(add.getByLabel("New wording")).toHaveValue("");
  await add.getByLabel("New wording").fill(body);
  await add.getByRole("button", { name: "Add wording" }).click();
  await expect(add.getByRole("alert")).toContainText("already exists (delivery_opener_11)");
  expect(await wordings()).toHaveLength(11);
  await add.getByLabel("New wording").fill("");
  const card = owner.getByTestId("template-delivery_opener_11-whatsapp");
  await expect(card).toBeVisible();
  await expect(panel).toContainText("11 of at most 20");
  expect((await wordings()).find((w) => w.key === "delivery_opener_11")?.body).toBe(body);
  const created = await one(admin.sql<{ changes: { key: { after: string } } }[]>`SELECT changes FROM audit_log WHERE action = 'message_template.create' ORDER BY id DESC LIMIT 1`);
  expect(created.changes.key.after).toBe("delivery_opener_11");

  // The preview shows ONE pick of the choice and says the choice is random and what {sapaan} is.
  const editor = card.getByTestId("template-editor");
  await editor.getByLabel("Sample buyer name (preview only)").fill("Budi");
  await editor.getByRole("button", { name: "Preview" }).click();
  await expect(editor.getByTestId("preview-text")).toHaveText(/^Selamat pagi Budi, (ebook|buku) Contoh Ebook siap\. Balas ya\.$/);
  await expect(editor.getByTestId("preview-note")).toContainText("picked at random");
  await expect(editor.getByTestId("preview-note")).toContainText("Jakarta");

  // Remove asks twice: Cancel keeps it, "Yes, remove" deletes it, and the page says so once.
  const remove = card.getByTestId("opener-remove");
  // With up to 20 identical buttons, each one says which wording it is about.
  await expect(remove.getByRole("button", { name: "Remove wording" })).toHaveAccessibleDescription(/WhatsApp opener, wording 11/);
  await remove.getByRole("button", { name: "Remove wording" }).click();
  await expect(remove.getByRole("group", { name: /Remove this wording \(delivery_opener_11\)\?/ })).toBeVisible();
  await remove.getByRole("button", { name: "Cancel" }).click();
  await expect(remove.getByRole("button", { name: "Remove wording" })).toBeFocused();
  expect(await wordings()).toHaveLength(11);
  await remove.getByRole("button", { name: "Remove wording" }).click();
  await remove.getByRole("button", { name: "Yes, remove" }).click();
  await expect(owner.getByTestId("deleted-notice")).toHaveText("Wording removed.");
  await expect(owner.getByTestId("template-delivery_opener_11-whatsapp")).toHaveCount(0);
  expect(await wordings()).toHaveLength(10);
  const removed = await one(admin.sql<{ changes: { key: { before: string } } }[]>`SELECT changes FROM audit_log WHERE action = 'message_template.delete' ORDER BY id DESC LIMIT 1`);
  expect(removed.changes.key.before).toBe("delivery_opener_11");

  // 390 px with the wordings, a preview and a removal warning on the page: no sideways scroll.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto("/settings/templates");
  const fifth = owner.getByTestId("template-delivery_opener_5-whatsapp");
  await fifth.getByTestId("template-editor").getByRole("button", { name: "Preview" }).click();
  await expect(fifth.getByTestId("preview-note")).toContainText("picked at random");
  await fifth.getByTestId("opener-remove").getByRole("button", { name: "Remove wording" }).click();
  await expect(fifth.getByTestId("opener-remove").getByRole("button", { name: "Yes, remove" })).toBeVisible();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await owner.setViewportSize({ width: 1280, height: 720 });

  // The limits: at 20 there is no Add form, at 3 there is no Remove button, and both say why.
  await admin.sql`
    INSERT INTO message_templates (key, channel, locale, body)
    SELECT 'delivery_opener_' || n, 'whatsapp', 'id', 'Halo {nama}, balas ya ' || n FROM generate_series(11, 20) AS n`;
  await owner.goto("/settings/templates");
  await expect(panel).toContainText("20 of at most 20");
  await expect(owner.getByTestId("opener-add")).toHaveCount(0);
  await expect(panel).toContainText("That is the most there can be");
  await admin.sql`DELETE FROM message_templates WHERE key ~ '^delivery_opener_([4-9]|1[0-9]|20)$' AND channel = 'whatsapp'`;
  await owner.goto("/settings/templates");
  await expect(panel).toContainText("3 of at most 20");
  await expect(owner.getByTestId("opener-remove")).toHaveCount(0);
  await expect(owner.getByTestId("opener-remove-hint")).toHaveCount(3);
  await expect(owner.getByTestId("opener-remove-hint").first()).toHaveText("At least 3 wordings stay: add another before removing this one.");
  // Put the Owner's ten back for whatever runs next.
  for (const w of seeded.filter((s) => !["delivery_opener_1", "delivery_opener_2", "delivery_opener_3"].includes(s.key))) {
    await admin.sql`INSERT INTO message_templates (key, channel, locale, body) VALUES (${w.key}, 'whatsapp', 'id', ${w.body})`;
  }
  expect(await wordings()).toHaveLength(10);
});

test("WhatsApp numbers: the panel says where the warm-up is, a new session warms up unless it is established, and the box toggles it; 390 px holds", async () => {
  const serverName = `Pemanasan ${stamp}`;
  await owner.goto("/settings/waha");
  const create = owner.getByTestId("waha-create");
  await create.getByLabel("Name").fill(serverName);
  await create.getByLabel("Base URL (https)").fill(`https://waha-warm-${stamp}.example.test/`);
  await create.getByRole("button", { name: "Add server" }).click();
  await expect(create.getByRole("status")).toContainText("Server added");
  const server = await one(admin.sql<{ id: string }[]>`SELECT id FROM waha_servers WHERE name = ${serverName}`);
  const card = owner.getByTestId(`waha-${server.id}`);
  const addForm = card.locator("form").filter({ has: owner.getByRole("button", { name: "Add session" }) });
  const sessionOf = async (name: string) =>
    one(admin.sql<{ id: string; warmup: boolean }[]>`SELECT id, warmup_started_at IS NOT NULL AS warmup FROM waha_sessions WHERE server_id = ${server.id} AND session_name = ${name}`);

  // The add form: a new number warms up by default; the box is unticked.
  await expect(addForm.getByLabel("Established number (skip warm-up)")).not.toBeChecked();
  await addForm.getByLabel("Session name").fill("baru");
  await addForm.getByRole("button", { name: "Add session" }).click();
  await expect.poll(async () => (await admin.sql`SELECT 1 FROM waha_sessions WHERE server_id = ${server.id} AND session_name = 'baru'`).length).toBe(1);
  expect((await sessionOf("baru")).warmup).toBe(true);
  // Ticked: an established number from the start.
  await addForm.getByLabel("Session name").fill("lama");
  await addForm.getByLabel("Established number (skip warm-up)").check();
  await addForm.getByRole("button", { name: "Add session" }).click();
  await expect.poll(async () => (await admin.sql`SELECT 1 FROM waha_sessions WHERE server_id = ${server.id} AND session_name = 'lama'`).length).toBe(1);
  expect((await sessionOf("lama")).warmup).toBe(false);

  // The line of each panel: day X of 21 and today's limit of NEW people (5 / 10 / 20 by week, then the number's own cap, whichever is lower), or "Established number".
  const baru = await sessionOf("baru");
  const lama = await sessionOf("lama");
  const mid = await one(admin.sql<{ id: string }[]>`INSERT INTO waha_sessions (server_id, session_name, active, warmup_started_at) VALUES (${server.id}, 'minggu2', false, now() - interval '9 days') RETURNING id`);
  const late = await one(admin.sql<{ id: string }[]>`INSERT INTO waha_sessions (server_id, session_name, active, warmup_started_at, new_contact_cap) VALUES (${server.id}, 'minggu3', false, now() - interval '15 days', 12) RETURNING id`);
  const done = await one(admin.sql<{ id: string }[]>`INSERT INTO waha_sessions (server_id, session_name, active, warmup_started_at, new_contact_cap) VALUES (${server.id}, 'selesai', false, now() - interval '30 days', 25) RETURNING id`);
  const small = await one(admin.sql<{ id: string }[]>`INSERT INTO waha_sessions (server_id, session_name, active, warmup_started_at, new_contact_cap) VALUES (${server.id}, 'kecil', false, now(), 3) RETURNING id`);
  await owner.goto("/settings/waha");
  const line = (id: string) => card.getByTestId(`waha-session-${id}`).getByTestId("waha-warmup");
  await expect(line(baru.id)).toHaveText("Warm-up: day 1 of 21 · today's new-people limit 5");
  await expect(line(mid.id)).toHaveText("Warm-up: day 10 of 21 · today's new-people limit 10");
  await expect(line(late.id)).toHaveText("Warm-up: day 16 of 21 · today's new-people limit 12");
  await expect(line(done.id)).toHaveText("Warm-up finished · today's new-people limit 25");
  await expect(line(small.id)).toHaveText("Warm-up: day 1 of 21 · today's new-people limit 3");
  // The box says what it means to a screen reader, too.
  await expect(card.getByTestId(`waha-session-${baru.id}`).getByLabel("Established number (skip warm-up)")).toHaveAccessibleDescription(/Tick only for a number that has already been writing/);
  // With a WhatsApp warning on the number the line shows the smaller, effective limit (first warning: half of 5, rounded down) and says why.
  await admin.sql`UPDATE waha_sessions SET warning_level = 'first' WHERE id = ${baru.id}`;
  await owner.reload();
  await expect(line(baru.id)).toHaveText("Warm-up: day 1 of 21 · today's new-people limit 2 (after WhatsApp's first warning, at the usual share)");
  await admin.sql`UPDATE waha_sessions SET warning_level = 'none' WHERE id = ${baru.id}`;
  await owner.reload();
  await expect(line(baru.id)).toHaveText("Warm-up: day 1 of 21 · today's new-people limit 5");
  await expect(line(lama.id)).toHaveText("Established number");
  await expect(card.getByTestId(`waha-session-${lama.id}`).getByLabel("Established number (skip warm-up)")).toBeChecked();
  await expect(card.getByTestId(`waha-session-${baru.id}`).getByLabel("Established number (skip warm-up)")).not.toBeChecked();

  // Tick it on a warming number: the warm-up ends, audited. Untick it: the warm-up restarts from today.
  const row = card.getByTestId(`waha-session-${mid.id}`);
  await row.getByLabel("Established number (skip warm-up)").check();
  await row.getByRole("button", { name: "Save session" }).click();
  await expect(line(mid.id)).toHaveText("Established number");
  expect((await sessionOf("minggu2")).warmup).toBe(false);
  const ended = await one(admin.sql<{ changes: { warmup_started_at: { before: string; after: string | null } } }[]>`SELECT changes FROM audit_log WHERE action = 'waha_session.update' AND entity_id = ${mid.id} ORDER BY id DESC LIMIT 1`);
  expect(ended.changes.warmup_started_at.before).toEqual(expect.any(String));
  expect(ended.changes.warmup_started_at.after).toBeNull();
  await row.getByLabel("Established number (skip warm-up)").uncheck();
  await row.getByRole("button", { name: "Save session" }).click();
  await expect(line(mid.id)).toHaveText("Warm-up: day 1 of 21 · today's new-people limit 5");
  expect((await sessionOf("minggu2")).warmup).toBe(true);
  // Saving another field of a warming number leaves its day count alone.
  const before = await one(admin.sql<{ w: Date }[]>`SELECT warmup_started_at AS w FROM waha_sessions WHERE id = ${late.id}`);
  const lateRow = card.getByTestId(`waha-session-${late.id}`);
  await lateRow.getByLabel("Weight").fill("2");
  await lateRow.getByRole("button", { name: "Save session" }).click();
  await expect(lateRow.getByRole("status")).toContainText("Session saved");
  await expect(line(late.id)).toHaveText("Warm-up: day 16 of 21 · today's new-people limit 12");
  const after = await one(admin.sql<{ w: Date }[]>`SELECT warmup_started_at AS w FROM waha_sessions WHERE id = ${late.id}`);
  expect(after.w.getTime()).toBe(before.w.getTime());

  // 390 px: each session stays in its own bordered panel, the line and the box fit, nothing scrolls sideways.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto("/settings/waha");
  await expect(line(baru.id)).toBeVisible();
  await expect(card.getByTestId(`waha-session-${lama.id}`).getByLabel("Established number (skip warm-up)")).toBeVisible();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const id of [baru.id, lama.id, mid.id, late.id, done.id, small.id]) {
    const box = await card.getByTestId(`waha-session-${id}`).boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  }
  await owner.setViewportSize({ width: 1280, height: 720 });
});

test("Customer service: the Owner saves the contact, sees what buyers get, and the CS number can never be a sending number (both directions); 390 and 1280 px hold", async () => {
  const csNumber = "0812 3456 7890";
  await owner.goto("/settings/customer-service");
  await expect((await openConsoleNav(owner, "messaging")).getByRole("link", { name: "Customer service" })).toBeVisible();
  await expect(owner.getByRole("heading", { name: "Customer service", level: 1 })).toBeVisible();
  const form = owner.getByTestId("cs-contact-form");
  await expect(owner.getByTestId("cs-preview-line")).toHaveText("Nothing is set: the replies carry no customer service line.");

  // A bad number, a bad address and a long hours line are refused with a fixed message, and nothing is saved.
  await form.getByLabel("Customer service WhatsApp number").fill("12345");
  await form.getByRole("button", { name: "Save customer service" }).click();
  await expect(form.getByTestId("form-error")).toContainText("Enter an Indonesian mobile number");
  await form.getByLabel("Customer service WhatsApp number").fill(csNumber);
  await form.getByLabel("Customer service e-mail").fill("cs@contoh");
  await form.getByRole("button", { name: "Save customer service" }).click();
  await expect(form.getByTestId("form-error")).toContainText("Enter a valid e-mail address");
  expect((await admin.sql`SELECT 1 FROM cs_contact`).length).toBe(0);

  // A valid contact: saved, normalised, audited with the number and address as references only.
  await form.getByLabel("Customer service e-mail").fill("cs@contoh.id");
  await form.getByLabel("Hours (optional)").fill("Senin–Jumat 09.00–17.00 WIB");
  await form.getByRole("button", { name: "Save customer service" }).click();
  await expect(form.getByRole("status")).toContainText("Customer service contact saved");
  const row = await one(admin.sql<{ whatsapp: string; email: string; hours: string }[]>`SELECT whatsapp, email, hours FROM cs_contact`);
  expect(row).toEqual({ whatsapp: "+6281234567890", email: "cs@contoh.id", hours: "Senin–Jumat 09.00–17.00 WIB" });
  const audit = await one(admin.sql<{ text: string }[]>`SELECT row_to_json(a)::text AS text FROM audit_log a WHERE action = 'cs_contact.update' ORDER BY id DESC LIMIT 1`);
  expect(audit.text).not.toContain("+6281234567890");
  expect(audit.text).not.toContain("cs@contoh.id");
  await owner.reload();
  await expect(owner.getByLabel("Customer service WhatsApp number")).toHaveValue("0812-3456-7890");
  await expect(owner.getByTestId("cs-preview-line")).toHaveText("...hubungi CS kami di WhatsApp 0812-3456-7890 atau email cs@contoh.id (Senin–Jumat 09\u202400–17\u202400 WIB).");

  // The CS number is never a sending number, from either side.
  const serverName = `CS ${stamp}`;
  await owner.goto("/settings/waha");
  const create = owner.getByTestId("waha-create");
  await create.getByLabel("Name").fill(serverName);
  await create.getByLabel("Base URL (https)").fill(`https://waha-cs-${stamp}.example.test/`);
  await create.getByRole("button", { name: "Add server" }).click();
  await expect(create.getByRole("status")).toContainText("Server added");
  const server = await one(admin.sql<{ id: string }[]>`SELECT id FROM waha_servers WHERE name = ${serverName}`);
  const card = owner.getByTestId(`waha-${server.id}`);
  const addForm = card.locator("form").filter({ has: owner.getByRole("button", { name: "Add session" }) });
  await addForm.getByLabel("Session name").fill("cs-nomor");
  await addForm.getByLabel("Number", { exact: true }).fill(csNumber);
  await addForm.getByRole("button", { name: "Add session" }).click();
  await expect(addForm.getByTestId("form-error")).toContainText("This number is the customer-service number");
  expect((await admin.sql`SELECT 1 FROM waha_sessions WHERE server_id = ${server.id}`).length).toBe(0);
  // Another number is a sending number; the CS number can then not be moved onto it.
  await admin.sql`INSERT INTO waha_sessions (server_id, session_name, phone, active) VALUES (${server.id}, 'kirim', '+6281200000077', false)`;
  await owner.goto("/settings/customer-service");
  await form.getByLabel("Customer service WhatsApp number").fill("0812 0000 0077");
  await form.getByRole("button", { name: "Save customer service" }).click();
  await expect(form.getByTestId("form-error")).toContainText("This number is one of the WhatsApp sending numbers");
  expect((await one(admin.sql<{ whatsapp: string }[]>`SELECT whatsapp FROM cs_contact`)).whatsapp).toBe("+6281234567890");
  // Emptying every field is allowed: then buyers see nothing.
  await form.getByLabel("Customer service WhatsApp number").fill("");
  await form.getByLabel("Customer service e-mail").fill("");
  await form.getByLabel("Hours (optional)").fill("");
  await form.getByRole("button", { name: "Save customer service" }).click();
  await expect(form.getByRole("status")).toContainText("Customer service contact saved");
  await expect(owner.getByTestId("cs-preview-line")).toHaveText("Nothing is set: the replies carry no customer service line.");
  await form.getByLabel("Customer service WhatsApp number").fill(csNumber);
  await form.getByRole("button", { name: "Save customer service" }).click();
  await expect(form.getByRole("status")).toContainText("Customer service contact saved");

  // 390 px and 1280 px: the form and the preview fit, nothing scrolls sideways.
  for (const width of [390, 1280]) {
    await owner.setViewportSize({ width, height: 844 });
    await owner.goto("/settings/customer-service");
    await expect(form.getByRole("button", { name: "Save customer service" })).toBeVisible();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${String(width)} px`).toBeLessThanOrEqual(0);
    for (const label of ["Customer service WhatsApp number", "Customer service e-mail", "Hours (optional)"]) {
      const box = await form.getByLabel(label).boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0), `${label} at ${String(width)} px`).toBeLessThanOrEqual(width);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  }
  await owner.setViewportSize({ width: 1280, height: 720 });
});
