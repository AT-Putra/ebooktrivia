import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type Page, request, test } from "@playwright/test";
import { type AdminEnv, freshTotp, runAdminCli, startAdminEnv } from "../support/admin.ts";

/**
 * US-017 (M5a-2) against the production build of apps/admin (`next start`, own database and port):
 *   - program field lock after the first PAID order + extend-only reschedule, enforced by the server;
 *   - a 21 MiB PDF shows the size warning, is accepted after confirmation and goes up in chunks;
 *   - a template test-send enqueues a worker job (outbox row) and the preview cannot run script;
 *   - Staff cannot register LP domains: the control is hidden and the action answers 403.
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
  admin = await startAdminEnv({
    port: PORT,
    extraEnv: {
      DOMAIN,
      ADMIN_DATA_DIR: dataDir,
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
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, amount_idr, expires_at)
      VALUES (${`lock${stamp}`}, 'K0C00000', ${lp.id}, ${programId}, ${productId}, 'Pembeli', '+6281234567890', 'buyer@example.invalid', 49000, now() + interval '1 day')
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
  const nav = staff.getByRole("navigation", { name: "Console" }).first();
  await expect(nav.getByRole("link", { name: "Landing pages" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Products" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Templates" })).toBeVisible();
  for (const name of ["Programs", "Adnets", "Midtrans", "WhatsApp", "SMTP"]) await expect(staff.getByRole("link", { name, exact: true })).toHaveCount(0);
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
