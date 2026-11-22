import { randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { type AdminEnv, freshTotp, runAdminCli, startAdminEnv } from "../support/admin.ts";

/**
 * US-033 (M10c) against the production build of apps/admin (`next start`, own database and port), at 375 px:
 *   - the Owner sees the review queue count on the dashboard and as the navigation badge;
 *   - the queue lists each order in review with its reason, its Midtrans attempt and the buyer masked; "Show buyer details" shows the
 *     full contact, and the view is audited;
 *   - "Re-query Midtrans now" queues the worker's job (audited);
 *   - "Mark paid" refuses a wrong typed confirmation, then pays the order with its effects; "Not paid" closes the other one as failed;
 *     the queue and the badge empty;
 *   - Staff get 403 on the page and no navigation entry;
 *   - the page passes axe and fits a 375 px wide screen.
 */
test.describe.configure({ mode: "serial" });

const PORT = 3207;
const URL_ = `http://127.0.0.1:${String(PORT)}`;
const stamp = String(Date.now());
const OWNER = { email: `owner-rev-${stamp}@example.test`, password: "owner-review-e2e-1", name: "Review Owner" };
const STAFF = { email: `staff-rev-${stamp}@example.test`, password: "staff-review-e2e-1", name: "Review Staff" };
const VIEWPORT = { width: 375, height: 812 };
const REASON = "Midtrans support confirmed the transfer arrived.";

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
const orders: { id: string; publicId: string }[] = [];

/** Two orders the payment code put in review: a fraud challenge on their settlement (never paid), as the worker would leave them. */
async function seed(): Promise<void> {
  const tag = stamp.slice(-6);
  const product = await one(admin.sql<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${tag}`}, 49000) RETURNING id`);
  const program = await one(admin.sql<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product.id}, ${`rev-${tag}`}, 'Musim Tinjau', 'published', now() - interval '3 days', now() + interval '30 days', 10) RETURNING id`);
  const lp = await one(admin.sql<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_r${tag}${tag}`}, 'LP Tinjau', ${program.id}) RETURNING id`);
  for (const i of [1, 2]) {
    const publicId = randomBytes(10).toString("hex");
    const o = await one(admin.sql<{ id: string }[]>`
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, snap_attempt_count, expires_at)
      VALUES (${publicId}, ${randomBytes(5).toString("hex").toUpperCase()}, ${lp.id}, ${program.id}, ${product.id}, 'Budi Santoso', ${`+62812345001${String(i)}0`}, 'budi@example.invalid',
              ${randomBytes(32)}, 49000, 'review', 1, now() + interval '1 hour') RETURNING id`);
    await admin.sql`INSERT INTO midtrans_attempts (order_id, n, midtrans_order_id, status, gateway_status, gateway_fraud_status, gateway_checked_at)
                    VALUES (${o.id}, 1, ${`${publicId}-1`}, 'created', 'settlement', 'challenge', now())`;
    await admin.sql`INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, changes)
                    VALUES ('system', 'order.status', 'order', ${o.id}, ${admin.sql.json({ status: { before: "pending", after: "review" }, event: "challenge", attempt: 1, source: "notification" })})`;
    await admin.sql`INSERT INTO alerts (source, kind, severity, dedupe_key, message, payload)
                    VALUES ('worker', 'payment_settlement_review', 'critical', ${`payment_settlement_review:${o.id}:1`}, 'e2e', ${admin.sql.json({ order_id: o.id })})`;
    orders.push({ id: o.id, publicId });
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  admin = await startAdminEnv({ port: PORT });
  started = true;
  const boot = await runAdminCli(admin.env, ["bootstrap-owner", "--email", OWNER.email, "--name", OWNER.name], `${OWNER.password}\n`);
  expect(boot.code).toBe(0);
  ownerContext = await contextFor(browser, "203.0.113.80");
  owner = await ownerContext.newPage();
  await signInAndEnroll(owner, OWNER, "owner");
  await owner.goto("/team");
  await owner.getByLabel("E-mail", { exact: true }).fill(STAFF.email);
  await owner.getByLabel("Name", { exact: true }).fill(STAFF.name);
  await owner.getByLabel("Temporary password", { exact: true }).fill(STAFF.password);
  await owner.getByRole("button", { name: "Add Staff" }).click();
  await expect(owner.getByRole("status")).toContainText("Staff account created");
  staffContext = await contextFor(browser, "203.0.113.81");
  staff = await staffContext.newPage();
  await signInAndEnroll(staff, STAFF, "staff");
  await seed();
});

test.afterAll(async () => {
  await ownerContext.close();
  await staffContext.close();
  if (started) await admin.stop();
});

const statusOf = async (id: string) => (await one(admin.sql<{ status: string }[]>`SELECT status::text AS status FROM orders WHERE id = ${id}`)).status;

test("the Owner sees the queue count on the dashboard and as the navigation badge", async () => {
  await owner.setViewportSize({ width: 1280, height: 900 });
  await owner.goto("/");
  await expect(owner.getByTestId("review-queue")).toContainText("2 orders wait for your decision");
  await expect(owner.getByTestId("nav-badge-review").first()).toContainText("2");
  await owner.getByTestId("review-queue").getByRole("link", { name: "Open the review queue" }).click();
  await expect(owner.getByRole("heading", { name: "Review queue" })).toBeVisible();
  await expect(owner.getByTestId("review-total")).toContainText("2 orders in review");
});

test("each order shows its reason, its Midtrans attempt and the buyer masked; the full contact is one audited click away", async () => {
  const [first] = orders;
  if (first === undefined) throw new Error("no order");
  await owner.goto("/orders/review");
  const card = owner.getByTestId(`review-${first.publicId}`);
  await expect(card.getByTestId("review-reason")).toContainText("Fraud challenge");
  await expect(card.getByTestId("attempt-row")).toContainText("settlement (fraud challenge)");
  await expect(card.getByTestId("buyer-name")).toHaveText("B*** S***");
  await expect(card.getByTestId("buyer-phone")).toHaveText("****110");
  await expect(card).not.toContainText("+6281234500110");
  await card.getByRole("button", { name: "Show buyer details" }).click();
  await expect(card.getByTestId("buyer-phone")).toHaveText("+6281234500110");
  await expect(card.getByTestId("buyer-email")).toHaveText("budi@example.invalid");
  const audit = await one(admin.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'order.buyer.view' AND entity_id = ${first.id}`);
  expect(audit.n).toBe(1);
});

test("re-query Midtrans now queues the worker's job, once", async () => {
  const [first] = orders;
  if (first === undefined) throw new Error("no order");
  await owner.goto("/orders/review");
  const card = owner.getByTestId(`review-${first.publicId}`);
  await card.getByTestId(`requery-${first.id}`).getByRole("button", { name: "Re-query Midtrans now" }).click();
  await expect(card.getByTestId(`requery-${first.id}`).getByRole("status")).toContainText("Re-query asked");
  const queued = await one(admin.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE topic = 'payment.requery' AND payload ->> 'order_id' = ${first.id}`);
  expect(queued.n).toBe(1);
});

test("mark paid refuses a wrong confirmation, then pays the order; not paid closes the other; the queue and the badge empty", async () => {
  const [first, second] = orders;
  if (first === undefined || second === undefined) throw new Error("no orders");
  await owner.goto("/orders/review");
  const paid = owner.getByTestId(`decide-paid-${first.id}`);
  await paid.getByLabel(/Type the order id/).fill("not-the-order-id");
  await paid.getByLabel(/Reason/).fill(REASON);
  await paid.getByRole("button", { name: "Mark paid" }).click();
  await expect(paid.getByTestId("form-error")).toContainText("confirmation does not match");
  expect(await statusOf(first.id)).toBe("review");
  await paid.getByLabel(/Type the order id/).fill(first.publicId);
  await paid.getByRole("button", { name: "Mark paid" }).click();
  // The decided order leaves the queue; the page confirms it under "Decided in the last 24 hours".
  await expect(owner.getByTestId(`decided-${first.publicId}`)).toContainText("Marked paid.");
  await expect(owner.getByTestId(`review-${first.publicId}`)).toHaveCount(0);
  expect(await statusOf(first.id)).toBe("paid");
  const effects = await one(admin.sql<{ deliveries: number; outbox: number; decisions: number }[]>`
    SELECT (SELECT count(*)::int FROM deliveries WHERE order_id = ${first.id}) AS deliveries,
           (SELECT count(*)::int FROM outbox WHERE dedupe_key = ${`order.paid:${first.id}`}) AS outbox,
           (SELECT count(*)::int FROM order_owner_decisions WHERE order_id = ${first.id}) AS decisions`);
  expect(effects).toEqual({ deliveries: 2, outbox: 1, decisions: 1 });

  await owner.goto("/orders/review");
  await expect(owner.getByTestId(`review-${first.publicId}`)).toHaveCount(0);
  const notPaid = owner.getByTestId(`decide-notpaid-${second.id}`);
  await notPaid.getByLabel(/Type the order id/).fill(second.publicId);
  await notPaid.getByLabel(/Reason/).fill("The buyer's bank reversed the transfer, no money arrived.");
  await notPaid.getByRole("button", { name: "Mark not paid" }).click();
  await expect(owner.getByTestId(`decided-${second.publicId}`)).toContainText("Marked not paid");
  expect(await statusOf(second.id)).toBe("gateway_failed");
  await owner.goto("/orders/review");
  await expect(owner.getByTestId("review-total")).toContainText("No order is waiting for you.");
  await expect(owner.getByTestId("nav-badge-review")).toHaveCount(0);
  const decided = await one(admin.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'order.review.decide'`);
  expect(decided.n).toBe(2);
});

test("Staff get 403 on the queue and no navigation entry", async () => {
  const response = await staff.goto("/orders/review");
  expect(response?.status()).toBe(403);
  await staff.goto("/");
  await expect(staff.getByRole("navigation", { name: "Console" }).first().getByRole("link", { name: /Review queue/ })).toHaveCount(0);
  await expect(staff.getByTestId("review-queue")).toHaveCount(0);
});

test("the review queue passes axe and fits a 375 px wide screen", async () => {
  // One order in review again, so the page shows a full card.
  await admin.sql`UPDATE orders SET status = 'review' WHERE id = ${orders[1]?.id ?? ""}`;
  for (const viewport of [{ width: 1280, height: 900 }, VIEWPORT]) {
    await owner.setViewportSize(viewport);
    await owner.goto("/orders/review");
    await expect(owner.getByTestId("review-total")).toContainText("1 order in review");
    if (viewport.width > VIEWPORT.width) {
      const scan = await new AxeBuilder({ page: owner }).analyze();
      const blocking = scan.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(blocking.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 5) }))).toEqual([]);
    } else {
      expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(VIEWPORT.width);
    }
  }
});
