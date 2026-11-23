import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type Page, request, test } from "@playwright/test";
import { type AdminEnv, freshTotp, runAdminCli, startAdminEnv } from "../support/admin.ts";

/**
 * US-018 (M5b) against the production build of apps/admin (`next start`, own database and port):
 *   - trivia editor: defaults from the program, CSV import with row-level errors (nothing written);
 *   - content lock: Staff see a set with attempts read-only; the Owner's action replayed with a Staff
 *     session is refused with the lock message and writes nothing, the image upload route answers 403;
 *   - the Owner's scoring override re-scores at once; it is blocked once the results snapshot exists;
 *   - prize tiers (no overlap), legal pages (escaped preview, publish), OTP / rate limits (bounded);
 *   - the new pages fit a 390 px wide screen.
 */
test.describe.configure({ mode: "serial" });

const PORT = 3204;
const URL_ = `http://127.0.0.1:${String(PORT)}`;
const stamp = String(Date.now());
const OWNER = { email: `owner-tri-${stamp}@example.test`, password: "owner-trivia-e2e-1", name: "Trivia Owner" };
const STAFF = { email: `staff-tri-${stamp}@example.test`, password: "staff-trivia-e2e-1", name: "Trivia Staff" };
const PLAYER_PHONE = `+62812${stamp.slice(-8)}`;
const HEADER = "prompt,option_1,option_2,option_3,option_4,correct,points,timer_seconds,explanation";

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

const csv = (name: string, body: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(body, "utf8") });

let ownerContext: BrowserContext;
let owner: Page;
let staffContext: BrowserContext;
let staff: Page;
let programId = "";
let setId = "";
let setPath = "";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  dataDir = await mkdtemp(join(tmpdir(), "ebt-e2e-trivia-"));
  admin = await startAdminEnv({ port: PORT, extraEnv: { ADMIN_DATA_DIR: dataDir } });
  started = true;
  const boot = await runAdminCli(admin.env, ["bootstrap-owner", "--email", OWNER.email, "--name", OWNER.name], `${OWNER.password}\n`);
  expect(boot.code).toBe(0);
  ownerContext = await contextFor(browser, "203.0.113.50");
  owner = await ownerContext.newPage();
  await signInAndEnroll(owner, OWNER, "owner");
  await owner.goto("/team");
  await owner.getByLabel("E-mail", { exact: true }).fill(STAFF.email);
  await owner.getByLabel("Name", { exact: true }).fill(STAFF.name);
  await owner.getByLabel("Temporary password", { exact: true }).fill(STAFF.password);
  await owner.getByRole("button", { name: "Add Staff" }).click();
  await expect(owner.getByRole("status")).toContainText("Staff account created");
  staffContext = await contextFor(browser, "203.0.113.51");
  staff = await staffContext.newPage();
  await signInAndEnroll(staff, STAFF, "staff");
  // A published program on sale (defaults 10 points / 20 s), as the programs page creates it.
  const product = await one(admin.sql<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES ('Ebook Trivia Uji', 49000) RETURNING id`);
  programId = (
    await one(
      admin.sql<{ id: string }[]>`
        INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
        VALUES (${product.id}, ${`trivia-${stamp}`}, 'Musim Trivia', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`,
    )
  ).id;
});

test.afterAll(async () => {
  await ownerContext.close();
  await staffContext.close();
  if (started) await admin.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("editor: a set and a question with the program's defaults; a CSV with bad rows imports nothing and lists every bad row", async () => {
  await owner.goto("/settings/trivia");
  await owner.getByRole("link", { name: "Musim Trivia" }).click();
  const create = owner.getByTestId("set-create");
  await create.getByLabel("Title").fill("Set Uji");
  await create.getByRole("button", { name: "Add set" }).click();
  await expect(create.getByRole("status")).toContainText("Trivia set added");
  setId = (await one(admin.sql<{ id: string }[]>`SELECT id FROM trivia_sets WHERE program_id = ${programId}`)).id;
  setPath = `/settings/trivia/${programId}/${setId}`;
  await owner.getByRole("link", { name: "Set Uji" }).click();
  await expect(owner).toHaveURL(new RegExp(`${setPath}$`));

  const form = owner.getByTestId("question-create");
  await expect(form.getByLabel("Points")).toHaveValue("10");
  await expect(form.getByLabel("Timer (seconds)")).toHaveValue("20");
  await form.getByLabel("Question").fill("Ibu kota Indonesia?");
  await form.getByLabel("Option 1").fill("Bandung");
  await form.getByLabel("Option 2").fill("Jakarta");
  await form.getByLabel("Correct option").selectOption("2");
  await form.getByRole("button", { name: "Add question" }).click();
  await expect(form.getByRole("status")).toContainText("Question added");
  await expect(owner.getByTestId("question-1")).toBeVisible();

  const importCard = owner.getByTestId("question-import");
  await expect(importCard.getByTestId("import-template")).toHaveAttribute("download", "question-template.csv");
  await expect(importCard.getByTestId("import-template")).toHaveAttribute("href", /^data:text\/csv;charset=utf-8,/);
  await importCard.getByLabel("Questions file").setInputFiles(csv("soal.csv", `${HEADER}\nSatu?,A,B,,,1,,,\nDua?,A,,,,1,,,\nTiga?,A,B,,,7,,,\n=1+1,A,B,,,1,abc,,\n`));
  const errors = importCard.getByTestId("import-errors");
  await expect(errors).toContainText("Nothing was imported");
  await expect(errors).toContainText("Row 3: Enter 2 to 4 options, in order without gaps.");
  await expect(errors).toContainText("Row 4: The correct answer is the number of a filled option (1 to 2).");
  await expect(errors).toContainText("Row 5: Points are a whole number from 0 to 1000.");
  expect((await one(admin.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM questions WHERE set_id = ${setId}`)).n).toBe(1);

  await importCard.getByLabel("Questions file").setInputFiles(csv("soal.csv", `${HEADER}\nSatu?,A,B,,,1,,,\nDua?,A,B,C,D,4,5,10,Karena D.\n`));
  await expect(importCard.getByRole("status")).toContainText("2 questions imported");
  await expect(owner.getByTestId("question-3")).toBeVisible();
  const imported = await admin.sql<{ points: number; timer: number }[]>`SELECT points, timer_seconds AS timer FROM questions WHERE set_id = ${setId} ORDER BY position`;
  expect(imported).toEqual([
    { points: 10, timer: 20 },
    { points: 10, timer: 20 },
    { points: 5, timer: 10 },
  ]);
});

test("content lock: Staff see a set with attempts read-only; the Owner's edit replayed with a Staff session is refused with the lock message, the image route with 403", async () => {
  // A player answered question 1 with option 2 (correct) in 4 s: the set is locked.
  const question = await one(admin.sql<{ id: string }[]>`SELECT id FROM questions WHERE set_id = ${setId} AND position = 1`);
  const options = await admin.sql<{ id: string }[]>`SELECT id FROM question_options WHERE question_id = ${question.id} ORDER BY position`;
  const player = await one(admin.sql<{ id: string }[]>`INSERT INTO players (phone, name) VALUES (${PLAYER_PHONE}, 'Pemain Rahasia') RETURNING id`);
  await admin.sql`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${player.id}, ${programId}, now(), true)`;
  const attempt = await one(admin.sql<{ id: string }[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${player.id}, ${setId}) RETURNING id`);
  // Answer timestamps are whole milliseconds (CHECK), as the answer path writes them.
  const served = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  await admin.sql`
    INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at, option_id, correct, points, elapsed_ms)
    VALUES (${attempt.id}, ${question.id}, 1, ${options.map((o) => o.id)}::uuid[], ${served}, ${new Date(served.getTime() + 20_000)},
            ${new Date(served.getTime() + 4_000)}, ${options[1]?.id ?? ""}, true, 10, 4000)`;
  await admin.sql`UPDATE set_attempts SET score = 10, total_ms = 4000 WHERE id = ${attempt.id}`;
  await admin.sql`INSERT INTO player_program_stats (player_id, program_id, score, total_ms) VALUES (${player.id}, ${programId}, 10, 4000)`;

  // The Owner: a text fix is allowed (scoring fields are not in the form any more).
  await owner.goto(setPath);
  await expect(owner.getByTestId("set-locked")).toContainText("locked");
  await expect(owner.getByTestId("question-create")).toHaveCount(0);
  await expect(owner.getByTestId("question-import")).toHaveCount(0);
  const edit = owner.getByTestId("question-1").getByTestId("question-edit");
  await expect(edit.getByLabel("Points")).toHaveCount(0);
  await edit.getByLabel("Question").fill("Ibu kota Republik Indonesia?");
  const captured = owner.waitForRequest((r) => r.method() === "POST" && r.headers()["next-action"] !== undefined);
  await edit.getByRole("button", { name: "Save text" }).click();
  const ownerRequest = await captured;
  await expect(edit.getByRole("status")).toContainText("Question saved");

  // Staff: read-only, no controls.
  await staff.goto(setPath);
  await expect(staff.getByTestId("set-locked")).toContainText("only the Owner can change it");
  for (const id of ["question-edit", "question-create", "question-import", "question-override"]) await expect(staff.getByTestId(id)).toHaveCount(0);
  for (const name of ["Save text", "Save question", "Add question", "Delete question", "Remove image", "Override and re-score"]) await expect(staff.getByRole("button", { name })).toHaveCount(0);
  await staff.goto(`/settings/trivia/${programId}`);
  await expect(staff.getByTestId("set-readonly")).toBeVisible();

  // The Owner's action replayed with the Staff session, from the admin origin: refused inside the
  // change with the lock message (a Staff form racing the first attempt shows the same), nothing changed.
  const cookie = (await staffContext.cookies(URL_)).map((c) => `${c.name}=${c.value}`).join("; ");
  const api = await request.newContext({ baseURL: URL_ });
  const forged = await api.post(setPath, {
    headers: { cookie, origin: URL_, "next-action": ownerRequest.headers()["next-action"] ?? "", "content-type": ownerRequest.headers()["content-type"] ?? "", "x-forwarded-for": "203.0.113.51" },
    data: Buffer.from((ownerRequest.postDataBuffer() ?? Buffer.alloc(0)).toString("utf8").replace("Ibu kota Republik Indonesia?", "Diubah Staff?")),
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(200);
  expect(await forged.text()).toContain("Only the Owner can change it now.");
  const image = await api.post(`/uploads/image/trivia?program=${programId}&set=${setId}&question=${question.id}`, {
    headers: { cookie, origin: URL_, "content-type": "image/png", "x-file-name": "x.png", "x-forwarded-for": "203.0.113.51" },
    data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
  });
  expect(image.status()).toBe(403);
  expect(((await image.json()) as { error?: string }).error).toContain("Only the Owner can change it now.");
  await api.dispose();
  expect((await one(admin.sql<{ prompt: string; image: string | null }[]>`SELECT prompt, image_upload_id AS image FROM questions WHERE id = ${question.id}`))).toEqual({ prompt: "Ibu kota Republik Indonesia?", image: null });
});

test("Owner override: changing the correct option re-scores the player at once, audited without personal data", async () => {
  await owner.goto(setPath);
  const override = owner.getByTestId("question-1").getByTestId("question-override");
  await override.locator("summary").click();
  await override.getByLabel("Correct option").selectOption("1");
  await override.getByLabel(/^Reason/).fill("Kunci jawaban salah: yang benar opsi 1.");
  await override.getByLabel(/I understand/).check();
  await override.getByRole("button", { name: "Override and re-score" }).click();
  await expect(override.getByRole("status")).toContainText("Re-scored 1 player: 1 answer changed, total score 10 to 0.");
  const answer = await one(admin.sql<{ correct: boolean; points: number }[]>`SELECT aq.correct, aq.points FROM attempt_questions aq JOIN set_attempts a ON a.id = aq.attempt_id WHERE a.set_id = ${setId}`);
  expect(answer).toEqual({ correct: false, points: 0 });
  expect((await one(admin.sql<{ score: number }[]>`SELECT score FROM player_program_stats WHERE program_id = ${programId}`)).score).toBe(0);
  const audit = await one(admin.sql<{ changes: Record<string, unknown>; text: string }[]>`
    SELECT changes, row_to_json(a)::text AS text FROM audit_log a WHERE action = 'question.rescore_override' ORDER BY id DESC LIMIT 1`);
  expect(audit.changes).toMatchObject({ correct_option: { before: 2, after: 1 }, reason: "Kunci jawaban salah: yang benar opsi 1.", score_before: 10, score_after: 0, players: 1 });
  expect(audit.text).not.toContain(PLAYER_PHONE);
  expect(audit.text).not.toContain("Pemain Rahasia");
});

test("the override is blocked once the results snapshot exists (refused on submit, then hidden)", async () => {
  await owner.goto(setPath);
  const override = owner.getByTestId("question-1").getByTestId("question-override");
  await override.locator("summary").click();
  // The grace-end sweeper writes the snapshot while the Owner has the form open.
  await admin.sql`INSERT INTO leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${programId}, now(), '[]')`;
  await override.getByLabel("Correct option").selectOption("2");
  await override.getByLabel(/^Reason/).fill("Seharusnya ditolak setelah snapshot.");
  await override.getByLabel(/I understand/).check();
  await override.getByRole("button", { name: "Override and re-score" }).click();
  await expect(override.getByTestId("form-error")).toContainText("results snapshot exists");
  expect((await one(admin.sql<{ points: number }[]>`SELECT aq.points FROM attempt_questions aq JOIN set_attempts a ON a.id = aq.attempt_id WHERE a.set_id = ${setId}`)).points).toBe(0);
  const correct = await admin.sql<{ position: number }[]>`
    SELECT o.position FROM question_options o JOIN questions q ON q.id = o.question_id WHERE q.set_id = ${setId} AND q.position = 1 AND o.is_correct`;
  expect(correct).toEqual([{ position: 1 }]);
  await owner.reload();
  await expect(owner.getByTestId("override-blocked")).toContainText("results snapshot exists");
  await expect(owner.getByTestId("question-override")).toHaveCount(0);
});

test("prize tiers refuse overlaps; a legal page preview shows markup as text; limits are bounded", async () => {
  const other = await one(
    admin.sql<{ id: string }[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      SELECT product_id, ${`hadiah-${stamp}`}, 'Musim Hadiah', 'draft', sales_start_at, sales_end_at, 30 FROM programs WHERE id = ${programId} RETURNING id`,
  );
  await owner.goto("/settings/prizes");
  const card = owner.getByTestId(`prizes-${other.id}`);
  const create = card.getByTestId("tier-create");
  await create.getByLabel("First rank").fill("1");
  await create.getByLabel("Last rank").fill("1");
  await create.getByLabel("Prize").fill("Juara 1");
  await create.getByLabel("Value (IDR)").fill("1.000.000");
  await create.getByRole("button", { name: "Add prize tier" }).click();
  await expect(create.getByRole("status")).toContainText("Prize tier added");
  await create.getByLabel("First rank").fill("1");
  await create.getByLabel("Last rank").fill("3");
  await create.getByLabel("Prize").fill("Bentrok");
  await create.getByLabel("Value (IDR)").fill("0");
  await create.getByRole("button", { name: "Add prize tier" }).click();
  await expect(create.getByTestId("form-error")).toContainText("overlap");
  expect((await one(admin.sql<{ n: number; value: string }[]>`SELECT count(*)::int AS n, max(value_idr)::text AS value FROM prize_tiers WHERE program_id = ${other.id}`))).toEqual({ n: 1, value: "1000000" });
  // The first program has its results snapshot: its tiers are final.
  await expect(owner.getByTestId(`prizes-${programId}`).getByTestId("tier-create")).toHaveCount(0);

  let dialogs = 0;
  owner.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });
  await owner.goto(`/settings/legal/${other.id}`);
  const terms = owner.getByTestId("legal-terms");
  const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  await terms.getByLabel("Title").fill("Syarat & Ketentuan");
  await terms.getByLabel("Text").fill(`# Hadiah\n${payload}\n\nJuara 1 mendapat voucher.`);
  await terms.getByRole("button", { name: "Save as new version" }).click();
  await expect(terms.getByRole("status")).toContainText("draft version 1 saved");
  const preview = terms.getByTestId("legal-preview").first();
  await expect(preview).toContainText(payload);
  await expect(preview.locator("img, script")).toHaveCount(0);
  expect(dialogs).toBe(0);
  await terms.getByRole("button", { name: "Publish version 1" }).click();
  await expect(terms.getByTestId("legal-terms-versions")).toContainText("Published");
  const page = await one(admin.sql<{ published: boolean }[]>`SELECT published_at IS NOT NULL AS published FROM legal_pages WHERE program_id = ${other.id} AND kind = 'terms' AND version = 1`);
  expect(page.published).toBe(true);

  await owner.goto("/settings/limits");
  const limits = owner.getByTestId("limits-form");
  await limits.getByLabel("OTP code validity").fill("30");
  await limits.getByRole("button", { name: "Save limits" }).click();
  // otp.code_ttl_seconds is 60..600 (10 minutes at most, ASVS V6.5.5; apps/admin/src/lib/settings/limits.ts).
  await expect(limits.getByTestId("form-error")).toContainText("60 to 600");
  await limits.getByLabel("OTP code validity").fill("240");
  await limits.getByRole("button", { name: "Save limits" }).click();
  await expect(limits.getByRole("status")).toContainText("1 limit saved");
  expect((await one(admin.sql<{ value: unknown }[]>`SELECT value FROM app_settings WHERE key = 'otp.code_ttl_seconds'`)).value).toBe(240);

  // Staff reach the trivia pages, not the Owner's settings.
  for (const path of ["/settings/prizes", "/settings/legal", `/settings/legal/${other.id}`, "/settings/limits"]) expect((await staff.goto(path))?.status(), path).toBe(403);
  await expect(staff.getByRole("navigation", { name: "Console" }).first().getByRole("link", { name: "Trivia" })).toBeVisible();
});

test("the new pages fit a 390 px wide screen (no horizontal scrolling)", async () => {
  await owner.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/settings/trivia", `/settings/trivia/${programId}`, setPath, "/settings/prizes", "/settings/legal", `/settings/legal/${programId}`, "/settings/limits"]) {
    await owner.goto(path);
    const width = await owner.evaluate(() => document.documentElement.scrollWidth);
    expect(width, path).toBeLessThanOrEqual(390);
  }
});
