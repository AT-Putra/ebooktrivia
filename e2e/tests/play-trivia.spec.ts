import { createHash, randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, expect, type Page, type Response, test } from "@playwright/test";
import { type PlayEnv, startPlayEnv } from "../support/play.ts";

/**
 * US-027 (M9b) against the production build of apps/public (`next start` on its own port and database) at 375 px:
 * the trivia page's four cards and program switcher, the next-unlock countdown in WIB and a locked set, then one
 * set played through: start, the server's timer surviving a reload, a right and a wrong answer (the correct option
 * and the explanation shown only after the pick, and in no response before it), the result with the fresh rank,
 * the completed tile and the leaderboard's "Perbarui". axe and no horizontal scroll on every screen.
 */
test.describe.configure({ mode: "serial" });

const PORT = 3104;
let play: PlayEnv;
let started = false;

/** Set 1's questions (each: the prompt, the right label, two wrong ones); set 2 stays locked on day 0. */
const QUESTIONS = [
  { prompt: "Apa ibu kota Indonesia?", right: "Jakarta", wrong: ["Bandung", "Surabaya"] },
  { prompt: "Berapa jumlah provinsi di Pulau Bali?", right: "Satu", wrong: ["Dua", "Tiga"] },
  { prompt: "Gunung tertinggi di Jawa?", right: "Semeru", wrong: ["Merapi", "Bromo"] },
] as const;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  play = await startPlayEnv(PORT);
  started = true;
  const { sql, programId } = play;
  await sql`UPDATE programs SET name = 'Trivia Sejarah Nusantara' WHERE id = ${programId}`;
  await sql`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr) VALUES (${programId}, 1, 1, 'Juara 1', 1000000), (${programId}, 2, 3, 'Juara 2-3', 500000)`;
  for (const [position, title] of [
    [1, "Sejarah"],
    [2, "Geografi"],
  ] as const) {
    const [set] = await sql<{ id: string }[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${programId}, ${position}, ${title}) RETURNING id`;
    const questions = position === 1 ? QUESTIONS : QUESTIONS.slice(0, 1);
    for (const [i, q] of questions.entries()) {
      const [question] = await sql<{ id: string }[]>`
        INSERT INTO questions (set_id, position, prompt, points, timer_seconds, explanation)
        VALUES (${set?.id ?? ""}, ${i + 1}, ${q.prompt}, 10, 60, ${`Jawabannya ${q.right}.`}) RETURNING id`;
      await sql`
        INSERT INTO question_options (question_id, position, label, is_correct)
        VALUES (${question?.id ?? ""}, 1, ${q.right}, true), (${question?.id ?? ""}, 2, ${q.wrong[0]}, false), (${question?.id ?? ""}, 3, ${q.wrong[1]}, false)`;
    }
  }
});

test.afterAll(async () => {
  if (started) await play.stop();
});

const ip = (): string => `198.51.100.${String(1 + Math.floor(Math.random() * 250))}`;

async function signedInPhone(browser: Browser): Promise<{ context: BrowserContext; page: Page; playerId: string }> {
  const { id } = await play.eligiblePlayer();
  // A second program the player bought: the switcher lists both.
  const [product] = await play.sql<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES ('Ebook Kedua', 49000) RETURNING id`;
  const [second] = await play.sql<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product?.id ?? ""}, ${`kedua-${randomBytes(3).toString("hex")}`}, 'Program Kedua', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`;
  await play.sql`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${id}, ${second?.id ?? ""}, now() + interval '1 second', true)`;
  const token = randomBytes(32).toString("base64url");
  await play.sql`SELECT issue_magic_link(${id}, 'whatsapp', ${createHash("sha256").update(token).digest()})`;
  const context = await browser.newContext({ baseURL: play.url, viewport: { width: 375, height: 812 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await context.newPage();
  await page.goto(`/masuk#c=whatsapp&t=${token}`);
  await page.getByRole("button", { name: "Masuk sekarang" }).click();
  await page.getByRole("link", { name: "Buka trivia" }).click();
  await page.waitForURL(`${play.url}/${play.programSlug}`);
  return { context, page, playerId: id };
}

async function expectAccessible(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

const isCurrent = (r: Response) => r.url().endsWith("/api/v1/play/attempts/current") && r.request().method() === "POST";

test("the trivia page at 375 px: four cards, the switcher, the WIB countdown; one set played with the server's timer", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page, playerId } = await signedInPhone(browser);
  // Every response before an answer is checked for correctness data (AC-Q9).
  const bodies: string[] = [];
  page.on("response", (response) => {
    if (isCurrent(response)) void response.text().then((text) => bodies.push(text));
  });

  // The four cards, in DOM order, and the program switcher.
  await expect(page.getByRole("heading", { level: 1, name: "Trivia Sejarah Nusantara" })).toBeVisible();
  for (const name of ["Papan Peringkat", "Profil Saya", "Daftar Set"]) await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByRole("button", { name: /Ganti program/ })).toBeVisible();
  await expect(page.getByText("Juara 2-3")).toBeVisible();
  await expect(page.getByRole("list", { name: "Hadiah" })).toContainText("Juara 2–3 · 2 pemenang");
  await expect(page.getByText(/Set berikutnya terbuka dalam/)).toBeVisible();
  await expect(page.getByText(/^Tepatnya .+, pukul 00\.00 WIB\.$/)).toBeVisible();
  await expect(page.getByRole("group", { name: /Set 2, terkunci, Terbuka .* 00\.00 WIB/ })).toBeVisible();
  // D8: a player who has not played yet is on the board too (score 0, every timer as the penalty), and the note says so.
  await expect(page.getByRole("cell", { name: /B\*\*\* S\*\*\*.*Kamu/ })).toBeVisible();
  await expect(page.getByText("Waktu termasuk penalti set yang belum dimainkan.")).toBeVisible();
  await expectAccessible(page);
  // The switcher lists both programs.
  await page.getByRole("button", { name: /Ganti program/ }).click();
  await expect(page.getByRole("link", { name: /Program Kedua/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // The set page's HTML carries no question at all.
  const html = await (await page.request.get(`/${play.programSlug}/set/1`)).text();
  for (const q of QUESTIONS) expect(html).not.toContain(q.prompt);

  await page.getByRole("link", { name: /Set 1/ }).click();
  await page.waitForURL(`${play.url}/${play.programSlug}/set/1`);
  await expect(page.getByRole("heading", { name: "Set 1: Sejarah" })).toBeVisible();
  await expectAccessible(page);
  const firstServe = page.waitForResponse(isCurrent);
  await page.getByRole("button", { name: "Mulai" }).click();
  const served = (await (await firstServe).json()) as { remaining_ms: number; prompt: string; answer_id: string };
  await expect(page.getByRole("heading", { name: served.prompt })).toBeFocused();
  await expect(page.getByRole("timer")).toHaveAttribute("aria-label", /Sisa waktu \d+ detik/);
  await expectAccessible(page);

  // A reload: the same question, its time still running (never reset).
  await page.waitForTimeout(1_500);
  const again = page.waitForResponse(isCurrent);
  await page.reload();
  const resumed = (await (await again).json()) as { remaining_ms: number; answer_id: string };
  expect(resumed.answer_id).toBe(served.answer_id);
  expect(resumed.remaining_ms).toBeLessThan(served.remaining_ms - 1_000);
  await expect(page.getByRole("heading", { name: served.prompt })).toBeVisible();

  const byPrompt = (prompt: string) => QUESTIONS.find((q) => q.prompt === prompt) ?? QUESTIONS[0];
  // Question 1 right, question 2 wrong.
  for (let n = 1; n <= 2; n++) {
    const prompt = (await page.locator("h1").last().innerText()).trim();
    const q = byPrompt(prompt);
    const pickRight = n === 1;
    const answered = page.waitForResponse((r) => r.url().endsWith("/api/v1/play/attempts/answer"));
    await page.getByRole("button", { name: pickRight ? q.right : q.wrong[0] }).click();
    const result = (await (await answered).json()) as { correct: boolean; correct_option_id: string };
    expect(result.correct).toBe(pickRight);
    if (pickRight) {
      await expect(page.getByText("Benar! +10 poin")).toBeVisible();
    } else {
      await expect(page.getByText("Jawabanmu salah. +0 poin")).toBeVisible();
      await expect(page.getByRole("button", { name: new RegExp(`${q.right}.*Jawaban benar`) })).toBeVisible();
      await expect(page.getByText(`Jawabannya ${q.right}.`)).toBeVisible();
      await expectAccessible(page);
    }
    await page.getByRole("button", { name: "Lanjut" }).click();
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-label", `Soal ${String(n + 1)} dari ${String(QUESTIONS.length)}`);
  }

  // Question 3 runs out: 2.5 s are left (its serve moved back by the server's own clock), then a reload.
  const [open] = await play.sql<{ id: string }[]>`
    SELECT aq.id FROM attempt_questions aq JOIN set_attempts a ON a.id = aq.attempt_id
     WHERE a.player_id = ${playerId} AND aq.served_at IS NOT NULL AND aq.answered_at IS NULL`;
  await play.sql`UPDATE attempt_questions SET served_at = served_at - interval '57500 milliseconds', deadline_at = deadline_at - interval '57500 milliseconds' WHERE id = ${open?.id ?? ""}`;
  await page.reload();
  // At the shown 0 the options stay enabled through the server's latency grace (security review MEDIUM-1)...
  await expect(page.getByRole("timer")).toHaveAttribute("aria-label", "Sisa waktu 0 detik", { timeout: 5_000 });
  const lastPrompt = (await page.locator("h1").last().innerText()).trim();
  await expect(page.getByRole("button", { name: byPrompt(lastPrompt).right })).not.toHaveAttribute("aria-disabled", "true");
  // ...then the time-up screen, which waits for the player (no next question by itself).
  await expect(page.getByText("Waktu habis. 0 poin.")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: byPrompt(lastPrompt).right })).toHaveAttribute("aria-disabled", "true");
  await page.waitForTimeout(2_500);
  await expect(page.getByText("Waktu habis. 0 poin.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Set selesai" })).toHaveCount(0);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Lihat hasil" }).click();

  await expect(page.getByRole("heading", { name: "Set selesai" })).toBeFocused();
  await expect(page.getByText("#1")).toBeVisible();
  await expectAccessible(page);
  // No response before an answer named the correct option or the explanation.
  expect(bodies.length).toBeGreaterThanOrEqual(4);
  for (const body of bodies) expect(body).not.toMatch(/correct|explanation|Jawabannya/);

  await page.getByRole("link", { name: "Kembali ke daftar set" }).click();
  await page.waitForURL(`${play.url}/${play.programSlug}`);
  await expect(page.getByRole("group", { name: /Set 1, selesai, skor 10 dari 30/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /B\*\*\* S\*\*\*.*Kamu/ })).toBeVisible();
  // D8: the board's time includes the sets not played yet, and says so.
  await expect(page.getByText("Waktu termasuk penalti set yang belum dimainkan.")).toBeVisible();
  await page.getByRole("button", { name: "Perbarui" }).click();
  await expect(page.getByText("Diperbarui baru saja")).toBeVisible();
  await expect(page.getByRole("button", { name: "Perbarui" })).toBeDisabled();
  await expectAccessible(page);
  await context.close();
});

test("logout everywhere from the account menu ends the session", async ({ browser }) => {
  const { context, page } = await signedInPhone(browser);
  await page.getByRole("button", { name: "Akun" }).click();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Keluar dari semua perangkat" }).click();
  await page.waitForURL(`${play.url}/login`);
  expect(await (await page.request.get("/api/v1/play/auth/session")).json()).toEqual({ v: 1, authenticated: false });
  // The trivia page now sends the visitor to the login page.
  await page.goto(`/${play.programSlug}`);
  await page.waitForURL(`${play.url}/login`);
  await context.close();
});

// US-027 addendum (Owner decision): the way in when the code checks are used up.
test("the login page sends a new login link on request: the same copy for every number, a job only for a buyer", async ({ browser }) => {
  test.setTimeout(120_000);
  const known = await play.eligiblePlayer();
  const unknown = `+62813${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`;
  const texts: string[] = [];
  for (const phone of [known.phone, unknown]) {
    const context = await browser.newContext({ baseURL: play.url, viewport: { width: 375, height: 812 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel("Nomor WhatsApp").fill(`0${phone.slice(3)}`);
    await page.getByRole("button", { name: "Kirim tautan masuk" }).click();
    const notice = page.getByRole("status").filter({ hasText: "tautan masuk baru sudah kami kirim lewat WhatsApp dan email" });
    await expect(notice).toBeVisible({ timeout: 60_000 });
    texts.push((await notice.innerText()).replace(phone, "<phone>"));
    await expectAccessible(page);
    await context.close();
  }
  expect(texts[0]).toBe(texts[1]);
  // Of both requests exactly one job exists (this spec's database has no other), and it is the buyer's.
  const jobs = () => play.sql<{ player_id: string }[]>`SELECT payload->>'player_id' AS player_id FROM outbox WHERE topic = 'magic_link.resend'`;
  await expect.poll(async () => (await jobs()).length, { timeout: 15_000 }).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(await jobs()).toEqual([{ player_id: known.id }]);
});

test("the internal trivia routes are a 404, and an unknown program is the 404 page", async ({ browser }) => {
  const { context, page } = await signedInPhone(browser);
  expect((await page.request.get(`/trivia/${play.programSlug}`)).status()).toBe(404);
  expect((await page.request.get(`/${play.programSlug}x`)).status()).toBe(404);
  await context.close();
});

// Owner decision 2026-11-24: one shared "Butuh bantuan?" block at the end of every buyer page (apps/public components/help). The app keeps what it read of
// the contact for 30 s (lib/cs/contact.ts), so the first page of this spec, loaded before the contact was set, is not the one that shows it.
test("the trivia pages end with the shared help block when a CS contact is set: the program page and a set, without anything personal in its links", async ({ browser }) => {
  test.setTimeout(150_000);
  await play.sql`DELETE FROM cs_contact`;
  await play.sql`INSERT INTO cs_contact (id, whatsapp, email, hours) VALUES (1, '+6281234567890', 'cs@contoh.id', 'Setiap hari 08.00-20.00 WIB')`;
  await new Promise((resolve) => setTimeout(resolve, 31_500));
  const { context, page } = await signedInPhone(browser);
  try {
    await page.goto(`/${play.programSlug}`);
    await expect(page.getByRole("heading", { level: 1, name: "Trivia Sejarah Nusantara" })).toBeVisible();
    const block = page.getByTestId("help-block");
    await expect(block).toHaveCount(1);
    // The last thing of the page's main column, after the four cards.
    expect(await page.locator("main").evaluate((main) => main.lastElementChild?.querySelector("[data-testid=help-block]") !== null)).toBe(true);
    await expect(page.getByTestId("help-hours")).toHaveText("Jam layanan: Setiap hari 08.00-20.00 WIB");
    expect(decodeURIComponent((await page.getByTestId("help-whatsapp").getAttribute("href")) ?? "")).toBe("https://wa.me/6281234567890?text=Halo CS, saya butuh bantuan.");
    expect(decodeURIComponent((await page.getByTestId("help-email").getAttribute("href")) ?? "")).toBe("mailto:cs@contoh.id?subject=Butuh bantuan");
    for (const id of ["help-whatsapp", "help-email"]) expect((await page.getByTestId(id).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expectAccessible(page);
    await page.goto(`/${play.programSlug}/set/1`);
    await expect(page.getByRole("heading", { name: "Set 1: Sejarah" })).toBeVisible();
    await expect(page.getByTestId("help-block")).toHaveCount(1);
    expect(await page.locator("main").evaluate((main) => main.lastElementChild?.getAttribute("data-testid") ?? null)).toBe("help-block");
    await expectAccessible(page);
  } finally {
    await context.close();
    await play.sql`DELETE FROM cs_contact`;
  }
});
