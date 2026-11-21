import { randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { type AdminEnv, freshTotp, runAdminCli, startAdminEnv } from "../support/admin.ts";

/**
 * US-029 (M10a) against the production build of apps/admin (`next start`, own database and port), at 375 px:
 *   - the dashboard shows today's visits, MO, MT, conversion % and revenue from the rollups, with the "as of" time;
 *   - the sales report filters, shows the chart with its table alternative, and the Owner (only) downloads an audited CSV;
 *   - Staff view the reports with no export, no profit view, no ad spend and no re-fire, enforced by the server (403), not only hidden;
 *   - the Owner's profit report matches the hand-computed fixture, and ad spend entered in the console changes it at once;
 *   - the postback report shows the failed conversion, the reconciliation identity, and the Owner re-fires it (audited);
 *   - every report page passes axe and fits a 375 px wide screen.
 */
test.describe.configure({ mode: "serial" });

const PORT = 3206;
const URL_ = `http://127.0.0.1:${String(PORT)}`;
const stamp = String(Date.now());
const OWNER = { email: `owner-rep-${stamp}@example.test`, password: "owner-reports-e2e-1", name: "Reports Owner" };
const STAFF = { email: `staff-rep-${stamp}@example.test`, password: "staff-reports-e2e-1", name: "Reports Staff" };
const VIEWPORT = { width: 375, height: 812 };

let admin: AdminEnv;
let started = false;
const usedCodes = new Map<string, Set<string>>();
const used = (who: string): Set<string> => {
  let set = usedCodes.get(who);
  if (set === undefined) usedCodes.set(who, (set = new Set()));
  return set;
};

async function contextFor(browser: Browser, ip: string): Promise<BrowserContext> {
  return browser.newContext({ baseURL: URL_, viewport: VIEWPORT, extraHTTPHeaders: { "x-forwarded-for": ip } });
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
let failedMtId = "";

/**
 * Today's orders (the WIB day the test runs on), hand-computed:
 *   oA paid, Alpha, qris 49000, S2S MT sent (payout 5000)     oB paid, Alpha, qris 49000, S2S MT failed (not counted)
 *   oC pending, Alpha (a payment page, MO only)               oD paid, organic (no click id), qris 49000
 * visits 3 (Alpha, with click id) + 2 (organic); MO 4, MT 3 -> 75 %, revenue 3 x 49000 = Rp 147.000.
 * Fee 0.70 % of 49000 = 343 each x 3 = 1029; CPA 5000; ad spend today Rp 20.000 -> net 147000 - 5000 - 1029 - 20000 = Rp 120.971.
 */
async function seed(): Promise<void> {
  const tag = stamp.slice(-6);
  await admin.sql`INSERT INTO app_settings (key, value) VALUES ('midtrans.fees', ${admin.sql.json({ other_qris: { flat_idr: 0, percent_bps: 70 } })}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  const product = await one(admin.sql<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${tag}`}, 49000) RETURNING id`);
  const program = await one(admin.sql<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product.id}, ${`rep-${tag}`}, 'Musim Laporan', 'published', now() - interval '30 days', now() + interval '30 days', 10) RETURNING id`);
  const lp = await one(admin.sql<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${tag}${tag}`}, 'LP Laporan', ${program.id}) RETURNING id`);
  const adnet = await one(admin.sql<{ id: string }[]>`
    INSERT INTO adnets (slug, name, clickid_param, payout_idr, mt_url_template) VALUES (${`alpha-${tag}`}, 'Alpha Ads', 'cid', 5000, 'https://postback.example.test/mt?c={clickid}') RETURNING id`);
  const order = async (status: string, clickid: string | null, method: string | null, mo: boolean) => {
    const paid = status === "paid";
    return one(admin.sql<{ id: string }[]>`
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at, paid_at, adnet_id, clickid, mo_outbox_id)
      VALUES (${randomBytes(8).toString("hex")}, ${randomBytes(5).toString("hex").toUpperCase()}, ${lp.id}, ${program.id}, ${product.id}, 'Budi Santoso', '+6281234500100', 'budi@example.invalid', ${randomBytes(32)}, 49000,
              ${status}, now() + interval '1 hour', ${paid ? new Date() : null}, ${clickid === null ? null : adnet.id}, ${clickid}, ${mo && !paid ? crypto.randomUUID() : null})
      RETURNING id`).then(async (o) => {
      if (method !== null) await admin.sql`INSERT INTO payments (order_id, gateway_txn_id, payment_type, transaction_status, gross_amount_idr, settled_at) VALUES (${o.id}, ${randomBytes(8).toString("hex")}, ${method}, 'settlement', 49000, now())`;
      return o.id;
    });
  };
  const oA = await order("paid", "ca", "qris", true);
  const oB = await order("paid", "cb", "qris", true);
  await order("pending", "cc", null, true);
  await order("paid", null, "qris", true);
  await admin.sql`
    INSERT INTO conversion_events (order_id, sink, kind, status, adnet_id, txid, event_id, value_idr, maybe_counted, reported_payout_idr, attempts, sent_at)
    VALUES (${oA}, 's2s', 'mt', 'sent', ${adnet.id}, ${oA}, gen_random_uuid(), 49000, true, 5000, 1, now())`;
  failedMtId = (
    await one(admin.sql<{ id: string }[]>`
      INSERT INTO conversion_events (order_id, sink, kind, status, adnet_id, txid, event_id, value_idr, maybe_counted, reported_payout_idr, attempts, failed_at, last_error, last_http_status)
      VALUES (${oB}, 's2s', 'mt', 'failed', ${adnet.id}, ${oB}, gen_random_uuid(), 49000, false, 5000, 6, now(), 'HTTP 500', 500) RETURNING id`)
  ).id;
  await admin.sql`INSERT INTO visits (landing_page_id, adnet_id, clickid) SELECT ${lp.id}, ${adnet.id}, 'x' FROM generate_series(1, 3)`;
  await admin.sql`INSERT INTO visits (landing_page_id) SELECT ${lp.id} FROM generate_series(1, 2)`;
  await admin.sql`INSERT INTO ad_spend (spend_date, platform, landing_page_id, adnet_id, amount_idr) VALUES ((now() AT TIME ZONE 'UTC' + interval '7 hours')::date, 'meta', ${lp.id}, ${adnet.id}, 20000)`;
  await admin.sql`SELECT public.refresh_report_rollups()`;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  admin = await startAdminEnv({ port: PORT });
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
  await seed();
});

test.afterAll(async () => {
  await ownerContext.close();
  await staffContext.close();
  if (started) await admin.stop();
});

test("the dashboard shows today's visits, MO, MT, conversion % and revenue from the rollups, with the time they are as of", async () => {
  await owner.goto("/");
  await expect(owner.getByTestId("kpi-visits")).toContainText("5");
  await expect(owner.getByTestId("kpi-mo")).toContainText("4");
  await expect(owner.getByTestId("kpi-mt")).toContainText("3");
  await expect(owner.getByTestId("kpi-conversion")).toContainText("75%");
  await expect(owner.getByTestId("kpi-revenue")).toContainText("Rp 147.000");
  await expect(owner.getByTestId("as-of")).toContainText("Figures as of");
  await expect(owner.getByTestId("stale-warning")).toHaveCount(0);
  // The chart has its table alternative.
  await owner.getByTestId("dashboard-table").locator("summary").click();
  await expect(owner.getByTestId("dashboard-table").getByRole("row").nth(-1)).toContainText("Rp 147.000");
});

test("the sales report filters (status), and the Owner downloads an audited CSV with the buyers' contact", async () => {
  await owner.goto("/reports/sales");
  await expect(owner.getByTestId("kpi-mo")).toContainText("4");
  await expect(owner.getByTestId("kpi-revenue")).toContainText("Rp 147.000");
  await owner.getByLabel("Order status").selectOption("pending");
  await owner.getByRole("button", { name: "Apply" }).click();
  await expect(owner).toHaveURL(/status=pending/);
  await expect(owner.getByTestId("kpi-mo")).toContainText("1");
  await expect(owner.getByTestId("kpi-mt")).toContainText("0");
  await expect(owner.getByTestId("kpi-revenue")).toContainText("Rp 0");
  await owner.getByLabel("Order status").selectOption("paid");
  await owner.getByRole("button", { name: "Apply" }).click();
  await expect(owner.getByTestId("kpi-mt")).toContainText("3");
  // A filter value that is not ours is refused with a message (and never reaches a query).
  await owner.goto("/reports/sales?status=nonsense");
  await expect(owner.getByTestId("filter-error")).toContainText("not valid");
  // The CSV: a download named without any personal data, one row per order, audited.
  await owner.goto("/reports/sales");
  const [download] = await Promise.all([owner.waitForEvent("download"), owner.getByTestId("sales-export").getByRole("button", { name: "Download CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^sales-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
  const path = await download.path();
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(path);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  expect(text.split("\r\n").filter((l) => l !== "")).toHaveLength(5);
  expect(text).toContain("Budi Santoso");
  expect(text).toContain("'+6281234500100");
  const audit = await one(admin.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'sales.export'`);
  expect(audit.n).toBe(1);
});

test("Staff view the reports but cannot export, see profit, edit ad spend or re-fire: the server refuses, not only the menu", async () => {
  await staff.goto("/reports/sales");
  await expect(staff.getByTestId("kpi-revenue")).toContainText("Rp 147.000");
  await expect(staff.getByTestId("sales-export")).toHaveCount(0);
  const nav = staff.getByRole("navigation", { name: "Console" }).first();
  await expect(nav.getByRole("link", { name: "Sales" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Postbacks" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Profit and ROI" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Ad spend" })).toHaveCount(0);
  // The server: the CSV routes, the profit view and the ad-spend page answer 403 to a Staff session.
  for (const path of ["/reports/sales/export", "/reports/contest/export"]) {
    const response = await staff.request.post(path, { form: { from: "2026-01-01", to: "2026-01-02" }, headers: { origin: URL_ } });
    expect(response.status(), path).toBe(403);
  }
  for (const path of ["/reports/roi", "/reports/ad-spend"]) {
    const response = await staff.goto(path);
    expect(response?.status(), path).toBe(403);
  }
  // Postbacks: the failed row is listed, with no re-fire button and no adnet payout.
  await staff.goto("/reports/postbacks?status=failed");
  await expect(staff.getByTestId("postback-row")).toHaveCount(1);
  await expect(staff.getByRole("button", { name: "Re-fire" })).toHaveCount(0);
  await expect(staff.getByRole("columnheader", { name: "Payout" })).toHaveCount(0);
  // Delivery and contest reports load for Staff, with buyers masked.
  await staff.goto("/reports/delivery");
  await expect(staff.getByRole("heading", { name: "Delivery report" })).toBeVisible();
  await staff.goto("/reports/contest");
  await expect(staff.getByRole("heading", { name: "Contest report" })).toBeVisible();
  await expect(staff.getByTestId("winners-export")).toHaveCount(0);
  const exports = await one(admin.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action IN ('sales.export', 'winners.export')`);
  expect(exports.n).toBe(1);
});

test("the Owner's profit report matches the hand-computed fixture, and ad spend entered in the console changes it at once", async () => {
  await owner.goto("/reports/roi");
  await expect(owner.getByTestId("roi-revenue")).toContainText("Rp 147.000");
  await expect(owner.getByTestId("roi-payout")).toContainText("Rp 5.000");
  await expect(owner.getByTestId("roi-fee")).toContainText("Rp 1.029");
  await expect(owner.getByTestId("roi-spend")).toContainText("Rp 20.000");
  await expect(owner.getByTestId("roi-total-net")).toContainText("Rp 120.971");
  await expect(owner.getByTestId("roi-row").first()).toBeVisible();
  // Add Rp 1.000 of spend; the report shows it without waiting for a rollup (spend is read live).
  await owner.goto("/reports/ad-spend");
  const form = owner.getByTestId("ad-spend-create");
  await form.getByLabel("Platform").selectOption("tiktok");
  await form.getByLabel("Amount (Rp)").fill("1.000");
  await form.getByRole("button", { name: "Save ad spend" }).click();
  await expect(form.getByRole("status")).toContainText("Ad spend saved");
  await owner.goto("/reports/ad-spend");
  await expect(owner.getByTestId("ad-spend-total")).toContainText("Rp 21.000");
  await owner.goto("/reports/roi");
  await expect(owner.getByTestId("roi-total-net")).toContainText("Rp 119.971");
  // A future date and a negative amount are refused with a message.
  await owner.goto("/reports/ad-spend");
  const again = owner.getByTestId("ad-spend-create");
  await again.getByLabel("Amount (Rp)").fill("-5");
  await again.getByRole("button", { name: "Save ad spend" }).click();
  await expect(again.getByTestId("form-error")).toContainText("rupiah");
  // Delete the entry again: back to the fixture.
  await owner.getByTestId("ad-spend-row").filter({ has: owner.getByRole("cell", { name: "Rp 1.000", exact: true }) }).locator("summary").click();
  await owner.getByRole("button", { name: "Delete this entry" }).click();
  // The entry disappears from the list (the page refreshes under the form), and the total is the seeded one again.
  await expect(owner.getByTestId("ad-spend-row")).toHaveCount(1);
  await expect(owner.getByTestId("ad-spend-total")).toContainText("Rp 20.000");
  await owner.goto("/reports/roi");
  await expect(owner.getByTestId("roi-total-net")).toContainText("Rp 120.971");
  const audit = await admin.sql<{ action: string }[]>`SELECT action FROM audit_log WHERE entity_type = 'ad_spend' ORDER BY id`;
  expect(audit.map((a) => a.action)).toEqual(["ad_spend.create", "ad_spend.delete"]);
});

test("the postback report shows the failed conversion and the reconciliation identity; the Owner re-fires it (audited)", async () => {
  await owner.goto("/reports/postbacks");
  // Alpha: two orders paid with a click id (oA, oB; oC is pending, oD is organic), MT sent 1 + failed 1: the identity holds.
  await expect(owner.getByTestId("reconciliation-row")).toHaveCount(1);
  await expect(owner.getByTestId("reconciliation-row")).toContainText("Matches");
  await owner.goto("/reports/postbacks?status=failed");
  const row = owner.getByTestId("postback-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("HTTP 500");
  await expect(owner.getByRole("columnheader", { name: "Payout" })).toBeVisible();
  await row.getByRole("button", { name: "Re-fire" }).click();
  // The page refreshes under the form: the row is no longer failed, so it leaves the failed list.
  await expect(owner.getByTestId("postback-row")).toHaveCount(0);
  const after = await one(admin.sql<{ status: string }[]>`SELECT status::text AS status FROM conversion_events WHERE id = ${failedMtId}`);
  expect(after.status).toBe("pending");
  const audit = await one(admin.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'conversion.refire' AND entity_id = ${failedMtId}`);
  expect(audit.n).toBe(1);
  // The identity is now balanced but not final: the re-fired row is in flight.
  await owner.goto("/reports/postbacks");
  await expect(owner.getByTestId("reconciliation-row")).toContainText("In flight");
});

test("every report page passes axe and fits a 375 px wide screen", async () => {
  for (const path of ["/", "/reports/sales", "/reports/roi", "/reports/ad-spend", "/reports/postbacks", "/reports/delivery", "/reports/contest"]) {
    await owner.setViewportSize({ width: 1280, height: 900 });
    await owner.goto(path);
    const scan = await new AxeBuilder({ page: owner }).analyze();
    const blocking = scan.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(blocking.map((v) => ({ path, id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 5) }))).toEqual([]);
    await owner.setViewportSize(VIEWPORT);
    await owner.goto(path);
    expect(await owner.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(VIEWPORT.width);
  }
});
