import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { type AdminEnv, freshTotp, runAdminCli, startAdminEnv } from "../support/admin.ts";

/**
 * US-030 (M10b) against the production build of apps/admin (`next start`, own database, port and data directory):
 *   - Staff get 403 on the prize fulfilment and data deletion pages, actions and routes, and see neither in the navigation;
 *   - the Owner moves a confirmed winner's fulfilment step by step, corrects one step back with a reason, writes notes, uploads a
 *     proof (stored privately) and downloads it as an attachment;
 *   - the Owner records a deletion request by phone, reviews the matched person with the consents of their orders, and erases them
 *     with the typed reference (the person's row is anonymized in the database);
 *   - the pages pass axe and fit a 390 px wide screen.
 */
test.describe.configure({ mode: "serial" });

const PORT = 3209;
const URL_ = `http://127.0.0.1:${String(PORT)}`;
const stamp = String(Date.now());
const OWNER = { email: `owner-ful-${stamp}@example.test`, password: "owner-fulfil-e2e-1", name: "Fulfil Owner" };
const STAFF = { email: `staff-ful-${stamp}@example.test`, password: "staff-fulfil-e2e-1", name: "Fulfil Staff" };
const DAY = 86_400_000;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let admin: AdminEnv;
let started = false;
let dataDir = "";
const usedCodes = new Map<string, Set<string>>();
const used = (who: string): Set<string> => {
  let set = usedCodes.get(who);
  if (set === undefined) usedCodes.set(who, (set = new Set()));
  return set;
};

async function contextFor(browser: Browser, ip: string): Promise<BrowserContext> {
  return browser.newContext({ baseURL: URL_, extraHTTPHeaders: { "x-forwarded-for": ip }, acceptDownloads: true });
}

async function signInAndEnroll(page: Page, account: { email: string; password: string }, who: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/enroll$/);
  const newPassword = `${account.password}-new`;
  await page.getByLabel("Current password").fill(account.password);
  await page.getByLabel("New password").fill(newPassword);
  await page.getByRole("button", { name: "Start setup" }).click();
  account.password = newPassword;
  const secret = ((await page.getByTestId("totp-secret").textContent()) ?? "").replace(/\s/g, "");
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
let staffContext: BrowserContext;
let staff: Page;
let programId = "";
const players: { id: string; phone: string; name: string }[] = [];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  dataDir = await mkdtemp(join(tmpdir(), "ebt-e2e-proof-"));
  admin = await startAdminEnv({ port: PORT, extraEnv: { ADMIN_DATA_DIR: dataDir } });
  started = true;
  const boot = await runAdminCli(admin.env, ["bootstrap-owner", "--email", OWNER.email, "--name", OWNER.name], `${OWNER.password}\n`);
  expect(boot.code).toBe(0);
  ownerContext = await contextFor(browser, "203.0.113.70");
  owner = await ownerContext.newPage();
  await signInAndEnroll(owner, OWNER, "owner");
  await owner.goto("/team");
  await owner.getByLabel("E-mail", { exact: true }).fill(STAFF.email);
  await owner.getByLabel("Name", { exact: true }).fill(STAFF.name);
  await owner.getByLabel("Temporary password", { exact: true }).fill(STAFF.password);
  await owner.getByRole("button", { name: "Add Staff" }).click();
  await expect(owner.getByRole("status")).toContainText("Staff account created");
  staffContext = await contextFor(browser, "203.0.113.71");
  staff = await staffContext.newPage();
  await signInAndEnroll(staff, STAFF, "staff");

  // An ended program: three paid players with their consents, prizes for ranks 1-2, the results snapshot (as the worker writes it)
  // and the Owner's confirmation (as the results page does it).
  const graceEnd = new Date(Math.floor(Date.now() / 1000) * 1000 - 5 * 60_000);
  const salesEnd = new Date(graceEnd.getTime() - 2 * DAY);
  const product = await one(admin.sql<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES ('Ebook Hadiah', 49000) RETURNING id`);
  programId = (
    await one(admin.sql<{ id: string }[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product.id}, ${`hadiah-${stamp}`}, 'Musim Hadiah', 'published', ${new Date(salesEnd.getTime() - 30 * DAY)}, ${salesEnd}, 2) RETURNING id`)
  ).id;
  const set = await one(admin.sql<{ id: string }[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${programId}, 1, 'Set') RETURNING id`);
  const q = await one(admin.sql<{ id: string }[]>`INSERT INTO questions (set_id, position, prompt, points, timer_seconds) VALUES (${set.id}, 1, 'Q', 10, 20) RETURNING id`);
  const right = await one(admin.sql<{ id: string }[]>`INSERT INTO question_options (question_id, position, label, is_correct) VALUES (${q.id}, 1, 'A', true) RETURNING id`);
  await admin.sql`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr) VALUES (${programId}, 1, 2, 'Voucher', 250000)`;
  const lp = await one(admin.sql<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_ful${stamp}`}, 'LP', ${programId}) RETURNING id`);
  const [terms, privacy] = await admin.sql<{ id: string }[]>`
    INSERT INTO legal_pages (program_id, kind, version, title, body) VALUES (${programId}, 'terms', 1, 'S&K', 'Isi'), (${programId}, 'privacy', 1, 'Privasi', 'Isi') RETURNING id`;
  await admin.sql`UPDATE legal_pages SET published_at = now() WHERE program_id = ${programId}`;
  for (const [i, name] of ["Rina Kilat", "Dodi Santai", "Sari Hapus"].entries()) {
    const phone = `+6281277${stamp.slice(-5)}${String(i)}`;
    const { id } = await one(admin.sql<{ id: string }[]>`INSERT INTO players (phone, name, email) VALUES (${phone}, ${name}, ${`p${String(i)}-${stamp}@example.test`}) RETURNING id`);
    await admin.sql`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${id}, ${programId}, now() - interval '20 days', true)`;
    const order = await one(admin.sql<{ id: string }[]>`
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, player_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at, paid_at, ip)
      VALUES (${`ful${stamp}x${String(i)}abcdef`}, ${`F${stamp.slice(-6)}${String(i)}A`}, ${lp.id}, ${programId}, ${product.id}, ${id}, ${name}, ${phone}, ${`p${String(i)}-${stamp}@example.test`},
              sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 49000, 'paid', now() + interval '1 hour', now() - interval '20 days', '2001:db8::9')
      RETURNING id`);
    await admin.sql`INSERT INTO consents (order_id, legal_page_id, ip, ua_hash) VALUES (${order.id}, ${terms?.id ?? ""}, '2001:db8::9', sha256('ua')), (${order.id}, ${privacy?.id ?? ""}, '2001:db8::9', sha256('ua'))`;
    const attempt = await one(admin.sql<{ id: string }[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${id}, ${set.id}) RETURNING id`);
    const served = new Date(graceEnd.getTime() - DAY);
    await admin.sql`
      INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at, option_id)
      VALUES (${attempt.id}, ${q.id}, 1, ${[right.id]}::uuid[], ${served}, ${new Date(served.getTime() + 20_000)}, ${new Date(served.getTime() + (i + 1) * 1000)}, ${right.id})`;
    players.push({ id, phone, name });
  }
  await admin.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE worker_rw");
    await tx`SELECT public.create_leaderboard_snapshot(${programId}::uuid)`;
  });
  const ownerId = (await one(admin.sql<{ id: string }[]>`SELECT id FROM admin_auth."user" WHERE email = ${OWNER.email}`)).id;
  await admin.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE admin_rw");
    await tx`SELECT public.confirm_program_winners(${programId}::uuid, ${ownerId}, NULL, NULL)`;
  });
});

test.afterAll(async () => {
  await ownerContext.close();
  await staffContext.close();
  if (started) await admin.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("Staff get 403 on the fulfilment and deletion pages and routes, and see neither in the navigation", async () => {
  for (const path of ["/fulfillment", `/fulfillment/${programId}`, "/privacy"]) {
    const response = await staff.goto(path);
    expect(response?.status(), path).toBe(403);
  }
  for (const path of [`/fulfillment/proof?fulfillment=${programId}`, `/uploads/proof?fulfillment=${programId}`]) {
    const response = await staff.request.post(path, { headers: { origin: URL_ } });
    expect(response.status(), path).toBe(403);
  }
  await staff.goto("/");
  const nav = staff.getByRole("navigation", { name: "Console" }).first();
  await expect(nav.getByRole("link", { name: "Prize fulfilment" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Data deletion" })).toHaveCount(0);
});

test("the Owner moves a fulfilment step by step, corrects it with a reason, keeps notes and a proof, and downloads the proof", async () => {
  await owner.goto("/fulfillment");
  await owner.getByRole("link", { name: "Musim Hadiah" }).click();
  await expect(owner).toHaveURL(new RegExp(`/fulfillment/${programId}$`));
  const card = owner.getByTestId("fulfillment-rank-1");
  await expect(card.getByTestId("winner-contact")).toContainText("Rina Kilat");
  await expect(card.getByTestId("fulfillment-status")).toHaveText("Pending");
  await card.getByRole("button", { name: "Mark contacted" }).click();
  await expect(card.getByTestId("fulfillment-status")).toHaveText("Contacted");
  const correct = card.getByTestId("fulfillment-correct");
  // Long enough for the browser's own check, but with a phone number: the server refuses it.
  await correct.getByLabel("Reason for the correction").fill("Telepon 081234567890 dulu");
  await correct.getByRole("button", { name: "Move back to pending" }).click();
  await expect(correct.getByTestId("form-error")).toContainText("without personal data");
  await correct.getByLabel("Reason for the correction").fill("Salah klik, belum dihubungi.");
  await correct.getByRole("button", { name: "Move back to pending" }).click();
  await expect(card.getByTestId("fulfillment-status")).toHaveText("Pending");
  await card.getByRole("button", { name: "Mark contacted" }).click();
  await expect(card.getByTestId("fulfillment-status")).toHaveText("Contacted");
  await card.getByRole("button", { name: "Mark sent" }).click();
  await expect(card.getByTestId("fulfillment-status")).toHaveText("Sent");

  const notes = card.getByTestId("fulfillment-notes");
  await notes.getByLabel("Notes").fill("Dikirim lewat JNE, resi <b>ABC123</b>.");
  await notes.getByRole("button", { name: "Save notes" }).click();
  await expect(notes.getByRole("status")).toContainText("Notes saved");

  await card.getByTestId("proof-upload").locator('input[type="file"]').setInputFiles({ name: "bukti.png", mimeType: "image/png", buffer: PNG });
  await expect(card.getByTestId("proof-upload").getByRole("status")).toContainText("Proof saved");
  await owner.reload();
  const reloaded = owner.getByTestId("fulfillment-rank-1");
  // Notes are text, never markup.
  await expect(reloaded.getByLabel("Notes")).toHaveValue("Dikirim lewat JNE, resi <b>ABC123</b>.");
  const [download] = await Promise.all([owner.waitForEvent("download"), reloaded.getByTestId("proof-download").click()]);
  expect(download.suggestedFilename()).toMatch(/^proof-1-[0-9a-f]{8}\.webp$/);
  await reloaded.getByRole("button", { name: "Mark done (prize delivered)" }).click();
  await expect(reloaded.getByTestId("fulfillment-status")).toHaveText("Done");
  await expect(reloaded.getByTestId("fulfillment-correct")).toHaveCount(0);
  const audit = await admin.sql<{ action: string }[]>`
    SELECT action FROM audit_log WHERE entity_type = 'fulfillment' ORDER BY id`;
  expect(audit.map((a) => a.action)).toEqual([
    "fulfillment.advance", "fulfillment.correct", "fulfillment.advance", "fulfillment.advance", "fulfillment.notes", "fulfillment.proof", "fulfillment.proof_download", "fulfillment.advance",
  ]);
});

test("the Owner records a deletion request, reviews the person with their consents, and erases them with the typed reference", async () => {
  const subject = players[2];
  await owner.goto("/privacy");
  const create = owner.getByTestId("deletion-new");
  await create.getByLabel("Identified by").selectOption("phone");
  await create.getByLabel("Number, e-mail or order id").fill(`0${subject?.phone.slice(3) ?? ""}`);
  await create.getByLabel("The request").fill("Diminta lewat WhatsApp tanggal 21 November.");
  await create.getByRole("button", { name: "Record request" }).click();
  await expect(owner).toHaveURL(/\/privacy\/[0-9a-f-]{36}$/);
  const ref = (owner.url().split("/").at(-1) ?? "").slice(0, 8);
  await expect(owner.getByTestId("deletion-subject")).toContainText("S*** H***");
  await expect(owner.getByTestId("deletion-orders").getByTestId("order-consents")).toContainText("Terms (S&K) v1");
  await expect(owner.getByTestId("deletion-orders").getByTestId("order-consents")).toContainText("Privacy policy v1");
  await expect(owner.getByTestId("deletion-blocked")).toHaveCount(0);
  const execute = owner.getByTestId("deletion-execute");
  await execute.getByLabel(/Type the reference/).fill("00000000");
  await execute.getByRole("button", { name: "Erase this person's data" }).click();
  await expect(execute.getByTestId("form-error")).toContainText("reference");
  await execute.getByLabel(/Type the reference/).fill(ref);
  await execute.getByRole("button", { name: "Erase this person's data" }).click();
  // The page re-renders as the completed request: the decision forms give way to the record of what was erased.
  await expect(owner.getByTestId("deletion-status")).toHaveText("Erased");
  await expect(owner.getByTestId("deletion-summary")).toContainText("orders");
  await owner.reload();
  await expect(owner.getByTestId("deletion-status")).toHaveText("Erased");
  await expect(owner.getByTestId("deletion-subject")).toHaveCount(0);
  const row = await one(admin.sql<{ phone: string | null; name: string; gone: boolean }[]>`SELECT phone, name, anonymized_at IS NOT NULL AS gone FROM players WHERE id = ${subject?.id ?? ""}`);
  expect(row).toEqual({ phone: null, name: "", gone: true });
  await owner.goto("/privacy");
  await expect(owner.getByTestId(`deletion-${ref}`)).toContainText("Erased");
});

test("the fulfilment and deletion pages pass axe and fit a 390 px wide screen", async () => {
  for (const path of ["/fulfillment", `/fulfillment/${programId}`, "/privacy"]) {
    await owner.setViewportSize({ width: 1280, height: 900 });
    await owner.goto(path);
    const scan = await new AxeBuilder({ page: owner }).analyze();
    const blocking = scan.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(blocking.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 5) })), path).toEqual([]);
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.goto(path);
    expect(await owner.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(390);
  }
});
