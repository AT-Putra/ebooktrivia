import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { type AdminEnv, freshTotp, runAdminCli, startAdminEnv } from "../support/admin.ts";

/**
 * US-028 (M9c) against the production build of apps/admin (`next start`, own database and port):
 *   - the contest results page shows the frozen winners in full (the Owner's decision of 2026-11-25), with their anti-cheat flags, to
 *     Staff and the Owner; only the Owner gets the confirmation and the deadline-extension forms;
 *   - the Owner extends the open questions of a running program (validated, audited);
 *   - the Owner confirms the winners (a confirmation box first); the banner read path then returns
 *     them masked;
 *   - the page passes axe and fits a 390 px wide screen.
 */
test.describe.configure({ mode: "serial" });

const PORT = 3205;
const URL_ = `http://127.0.0.1:${String(PORT)}`;
const stamp = String(Date.now());
const OWNER = { email: `owner-res-${stamp}@example.test`, password: "owner-results-e2e-1", name: "Results Owner" };
const STAFF = { email: `staff-res-${stamp}@example.test`, password: "staff-results-e2e-1", name: "Results Staff" };
const DAY = 86_400_000;

let admin: AdminEnv;
let started = false;
const usedCodes = new Map<string, Set<string>>();
const used = (who: string): Set<string> => {
  let set = usedCodes.get(who);
  if (set === undefined) usedCodes.set(who, (set = new Set()));
  return set;
};

async function contextFor(browser: Browser, ip: string): Promise<BrowserContext> {
  return browser.newContext({ baseURL: URL_, extraHTTPHeaders: { "x-forwarded-for": ip } });
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

/** A published program whose grace ends at `graceEnd`, one set of three 20 s questions. */
async function program(name: string, graceEnd: Date) {
  const product = await one(admin.sql<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${name}`}, 49000) RETURNING id`);
  const salesEnd = new Date(graceEnd.getTime() - 2 * DAY);
  const { id } = await one(admin.sql<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product.id}, ${`${name.toLowerCase().replace(/\s+/g, "-")}-${stamp}`}, ${name}, 'published', ${new Date(salesEnd.getTime() - 30 * DAY)}, ${salesEnd}, 2) RETURNING id`);
  const set = await one(admin.sql<{ id: string }[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${id}, 1, 'Set') RETURNING id`);
  const questions: { id: string; right: string; wrong: string }[] = [];
  for (const position of [1, 2, 3]) {
    const q = await one(admin.sql<{ id: string }[]>`INSERT INTO questions (set_id, position, prompt, points, timer_seconds) VALUES (${set.id}, ${position}, 'Q', 10, 20) RETURNING id`);
    const [right, wrong] = await admin.sql<{ id: string }[]>`INSERT INTO question_options (question_id, position, label, is_correct) VALUES (${q.id}, 1, 'A', true), (${q.id}, 2, 'B', false) RETURNING id`;
    questions.push({ id: q.id, right: right?.id ?? "", wrong: wrong?.id ?? "" });
  }
  return { id, setId: set.id, questions };
}

async function player(programId: string, name: string, phone: string): Promise<string> {
  const { id } = await one(admin.sql<{ id: string }[]>`INSERT INTO players (phone, name) VALUES (${phone}, ${name}) RETURNING id`);
  await admin.sql`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${id}, ${programId}, now() - interval '20 days', true)`;
  return id;
}

let ownerContext: BrowserContext;
let owner: Page;
let staffContext: BrowserContext;
let staff: Page;
let ended: Awaited<ReturnType<typeof program>>;
let running: Awaited<ReturnType<typeof program>>;
let openRowId = "";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  admin = await startAdminEnv({ port: PORT });
  started = true;
  const boot = await runAdminCli(admin.env, ["bootstrap-owner", "--email", OWNER.email, "--name", OWNER.name], `${OWNER.password}\n`);
  expect(boot.code).toBe(0);
  ownerContext = await contextFor(browser, "203.0.113.60");
  owner = await ownerContext.newPage();
  await signInAndEnroll(owner, OWNER, "owner");
  await owner.goto("/team");
  await owner.getByLabel("E-mail", { exact: true }).fill(STAFF.email);
  await owner.getByLabel("Name", { exact: true }).fill(STAFF.name);
  await owner.getByLabel("Temporary password", { exact: true }).fill(STAFF.password);
  await owner.getByRole("button", { name: "Add Staff" }).click();
  await expect(owner.getByRole("status")).toContainText("Staff account created");
  staffContext = await contextFor(browser, "203.0.113.61");
  staff = await staffContext.newPage();
  await signInAndEnroll(staff, STAFF, "staff");

  // An ended program with two players (one answering in 300 ms: a flag; the median needs 3 answers), prizes for ranks 1-2, and
  // its results snapshot written as the worker's grace-end sweeper writes it.
  ended = await program("Musim Selesai", new Date(Math.floor(Date.now() / 1000) * 1000 - 5 * 60_000));
  await admin.sql`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name) VALUES (${ended.id}, 1, 2, 'Juara')`;
  const base = Date.now() - 3 * DAY;
  for (const [name, phone, elapsed] of [["Rina Kilat", "+6281234500111", [300, 300, 300]], ["Dodi Santai", "+6281234500222", [9000, 9000, 9000]]] as const) {
    const playerId = await player(ended.id, name, phone);
    const attempt = await one(admin.sql<{ id: string }[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${playerId}, ${ended.setId}) RETURNING id`);
    for (const [i, q] of ended.questions.entries()) {
      const served = new Date(Math.floor(base / 1000) * 1000 + i * 60_000);
      await admin.sql`
        INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at, option_id)
        VALUES (${attempt.id}, ${q.id}, ${i + 1}, ${[q.right, q.wrong]}::uuid[], ${served}, ${new Date(served.getTime() + 20_000)}, ${new Date(served.getTime() + (elapsed[i] ?? 0))}, ${q.right})`;
    }
  }
  await admin.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE worker_rw");
    await tx`SELECT public.create_leaderboard_snapshot(${ended.id}::uuid)`;
  });

  // A running program with one question served 200 s ago and still open (caught by an outage).
  running = await program("Musim Berjalan", new Date(Date.now() + 3 * DAY));
  const runner = await player(running.id, "Budi", "+6281234500333");
  const attempt = await one(admin.sql<{ id: string }[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${runner}, ${running.setId}) RETURNING id`);
  const q = running.questions[0];
  const served = new Date(Math.floor(Date.now() / 1000) * 1000 - 200_000);
  openRowId = (
    await one(admin.sql<{ id: string }[]>`
      INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at)
      VALUES (${attempt.id}, ${q?.id ?? ""}, 1, ${[q?.right ?? "", q?.wrong ?? ""]}::uuid[], ${served}, ${new Date(served.getTime() + 20_000)}) RETURNING id`)
  ).id;
});

test.afterAll(async () => {
  await ownerContext.close();
  await staffContext.close();
  if (started) await admin.stop();
});

test("Staff see the frozen winners in full with their flags, and no Owner form", async () => {
  await staff.goto(`/settings/trivia/${ended.id}`);
  await staff.getByTestId("contest-results-link").click();
  await expect(staff).toHaveURL(new RegExp(`/settings/trivia/${ended.id}/results$`));
  await expect(staff.getByTestId("snapshot-summary")).toContainText("2 eligible players ranked");
  const first = staff.getByTestId("winner-1");
  await expect(first).toContainText("Rina Kilat");
  await expect(first).toContainText("+6281234500111");
  await expect(first).toContainText("Awaiting confirmation");
  await expect(first).toContainText("Median answer time under 800 ms");
  await expect(staff.getByTestId("winner-2")).toContainText("Dodi Santai");
  await expect(staff.getByTestId("confirm-winners")).toHaveCount(0);
  await staff.goto(`/settings/trivia/${running.id}/results`);
  await expect(staff.getByTestId("contest-extension")).toHaveCount(0);
});

test("the Owner extends a running program's open question after an outage (validated, audited)", async () => {
  await owner.goto(`/settings/trivia/${running.id}/results`);
  const form = owner.getByTestId("extend-deadlines");
  const wib = (msAgo: number) => new Date(Date.now() + 7 * 3_600_000 - msAgo).toISOString().slice(0, 16);
  await form.getByLabel("Reason").fill("Server mati dua puluh menit.");
  await form.getByRole("button", { name: "Extend deadlines" }).click();
  await expect(form.getByTestId("form-error")).toContainText("Tick the box");
  await form.getByLabel(/I understand this changes/).check();
  await form.getByLabel("Outage started (WIB)").fill(wib(61 * 60_000));
  await form.getByRole("button", { name: "Extend deadlines" }).click();
  await expect(form.getByTestId("form-error")).toContainText("within the last 60 minutes");
  await form.getByLabel("Outage started (WIB)").fill(wib(5 * 60_000));
  await form.getByLabel("Outage ended (WIB)").fill(wib(10 * 60_000));
  await form.getByRole("button", { name: "Extend deadlines" }).click();
  await expect(form.getByTestId("form-error")).toContainText("end after it started");
  // The outage ended a minute ago (minute precision): the question, due about 3 minutes ago, lies inside it.
  await form.getByLabel("Outage ended (WIB)").fill(wib(60_000));
  await form.getByRole("button", { name: "Extend deadlines" }).click();
  await expect(form.getByRole("status")).toContainText("Extended 1 open question of 1 player");
  // It lost its whole 20 s to the outage: 20 s from now, recorded once in the ledger.
  const row = await one(admin.sql<{ ext: number; left: number }[]>`
    SELECT deadline_extension_ms AS ext, extract(epoch FROM deadline_at - now())::float8 AS left FROM attempt_questions WHERE id = ${openRowId}`);
  expect(row.ext).toBeGreaterThan(20_000);
  expect(row.left).toBeLessThanOrEqual(20);
  expect((await one(admin.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM deadline_extensions WHERE attempt_question_id = ${openRowId}`)).n).toBe(1);
  const audit = await one(admin.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'contest.deadline_extension' AND entity_id = ${running.id}`);
  expect(audit.n).toBe(1);
  // No extension form on an ended program.
  await owner.goto(`/settings/trivia/${ended.id}/results`);
  await expect(owner.getByTestId("contest-extension")).toHaveCount(0);
});

test("the Owner confirms the winners; the banner read path then returns them masked", async () => {
  await owner.goto(`/settings/trivia/${ended.id}/results`);
  const form = owner.getByTestId("confirm-winners");
  await form.getByRole("button", { name: "Confirm winners" }).click();
  await expect(form.getByTestId("form-error")).toContainText("Tick the box");
  await form.getByLabel(/I checked the winners/).check();
  await form.getByRole("button", { name: "Confirm winners" }).click();
  await expect(owner.getByTestId("winner-1")).toContainText("Confirmed");
  await expect(owner.getByTestId("confirm-winners")).toHaveCount(0);
  const banner = await admin.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE public_rw");
    return tx<{ rank: number; masked_name: string; masked_phone: string }[]>`SELECT rank, masked_name, masked_phone FROM public.program_winners_banner(${ended.id}::uuid)`;
  });
  expect(banner).toEqual([
    { rank: 1, masked_name: "R*** K***", masked_phone: "****111" },
    { rank: 2, masked_name: "D*** S***", masked_phone: "****222" },
  ]);
});

test("the results page passes axe and fits a 390 px wide screen", async () => {
  for (const id of [ended.id, running.id]) {
    await owner.setViewportSize({ width: 1280, height: 900 });
    await owner.goto(`/settings/trivia/${id}/results`);
    const scan = await new AxeBuilder({ page: owner }).analyze();
    const blocking = scan.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(blocking.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 5) }))).toEqual([]);
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.goto(`/settings/trivia/${id}/results`);
    expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});
