import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { type PlayEnv, startPlayEnv } from "../support/play.ts";

/**
 * The pictures the Owner uploads, on the play pages (production build of apps/public on its own port and database, a
 * temporary data directory holding the WebP files) at 375 px:
 *   - the grid shows a set's uploaded thumbnail when it has one and the generic art when it has none;
 *   - the banner card shows the program's uploaded banner in a fixed 3:1 box (object-fit cover), else the built-in art;
 *   - the prize list: the rank-1 tier is the featured tile (its uploaded image, whole: object-fit contain, in a square box, NOT
 *     beside the "Hadiah" heading), every other tier a compact row with ONE leading visual (its image, else the medal), and
 *     each tier's picture appears exactly once;
 *   - the countdown runs to the quiz deadline ("Kuis ditutup dalam", days and hh:mm:ss, the deadline in WIB under it);
 *   - the leaderboard follows the prize tiers: a phone shows every winner (6 prize ranks: 6 rows) before "Lihat semua", and a
 *     medal sits exactly on the ranks a tier covers, in that tier's colour;
 *   - the pictures are served through their owning row (display copy, immutable cache), and a question's picture is not
 *     served at all (question images are stored where the public app does not mount them).
 */
test.describe.configure({ mode: "serial" });

const PORT = 3105;
/** The smallest lossless WebP (1 x 1): a real image the browser decodes. */
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

let play: PlayEnv;
let started = false;
let dataDir: string;

interface Content {
  readonly setWithThumbnail: string;
  readonly thumbnail: string;
  readonly setWithout: string;
  readonly tierOne: string;
  readonly prizeOne: string;
  readonly tierTwo: string;
  readonly prizeTwo: string;
  /** The program's banner picture (upload id). */
  readonly banner: string;
  /** A question's picture (upload id), stored where the admin app puts it (question-images/). */
  readonly questionImage: string;
}
let content: Content;

/** An image upload: the original and its display copy under images/ (or the original alone under `dir`), and the uploads row. */
async function upload(dir = "images"): Promise<string> {
  const id = randomUUID();
  const storagePath = `${dir}/${id}.webp`;
  await writeFile(join(dataDir, storagePath), WEBP);
  if (dir === "images") await writeFile(join(dataDir, `images/${id}.display.webp`), WEBP);
  await play.sql`
    INSERT INTO uploads (id, kind, storage_path, content_type, size_bytes, sha256)
    VALUES (${id}, 'image', ${storagePath}, 'image/webp', ${WEBP.length}, ${createHash("sha256").update(WEBP).digest()})`;
  return id;
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  dataDir = await mkdtemp(join(tmpdir(), "ebt-e2e-images-"));
  await mkdir(join(dataDir, "images"), { recursive: true });
  await mkdir(join(dataDir, "question-images"), { recursive: true });
  play = await startPlayEnv(PORT, { dataDir });
  started = true;
  const { sql, programId } = play;
  // The sales end on a WIB midnight 30 days from now (the program's grace is 30 days): the quiz deadline is then a midnight too, which the
  // page shows as the end of the day before, at 23.59.
  await sql`UPDATE programs SET name = 'Trivia Bergambar', sales_end_at = (date_trunc('day', now() AT TIME ZONE 'Asia/Jakarta') + interval '30 days') AT TIME ZONE 'Asia/Jakarta' WHERE id = ${programId}`;
  const prizeOne = await upload();
  const prizeTwo = await upload();
  const [tierOne] = await sql<{ id: string }[]>`
    INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr, image_upload_id) VALUES (${programId}, 1, 1, 'Juara 1', 1000000, ${prizeOne}) RETURNING id`;
  const [tierTwo] = await sql<{ id: string }[]>`
    INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr, image_upload_id) VALUES (${programId}, 2, 3, 'Juara 2-3', 500000, ${prizeTwo}) RETURNING id`;
  // A third tier without a picture (the medal stands in its box): the prize ranks reach 6, so the leaderboard shows 6 rows first.
  await sql`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr) VALUES (${programId}, 4, 6, 'Juara 4-6', 100000)`;
  const banner = await upload();
  await sql`UPDATE programs SET banner_upload_id = ${banner} WHERE id = ${programId}`;
  const thumbnail = await upload();
  const [first] = await sql<{ id: string }[]>`INSERT INTO trivia_sets (program_id, position, title, thumbnail_upload_id) VALUES (${programId}, 1, 'Bergambar', ${thumbnail}) RETURNING id`;
  const [second] = await sql<{ id: string }[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${programId}, 2, 'Tanpa Gambar') RETURNING id`;
  const questionImage = await upload("question-images");
  const [question] = await sql<{ id: string }[]>`
    INSERT INTO questions (set_id, position, prompt, points, timer_seconds, image_upload_id) VALUES (${first?.id ?? ""}, 1, 'Hewan apa pada gambar ini?', 10, 60, ${questionImage}) RETURNING id`;
  await sql`INSERT INTO question_options (question_id, position, label, is_correct) VALUES (${question?.id ?? ""}, 1, 'Benar', true), (${question?.id ?? ""}, 2, 'Salah', false)`;
  content = {
    setWithThumbnail: first?.id ?? "",
    thumbnail,
    setWithout: second?.id ?? "",
    tierOne: tierOne?.id ?? "",
    prizeOne,
    tierTwo: tierTwo?.id ?? "",
    prizeTwo,
    banner,
    questionImage,
  };
});

test.afterAll(async () => {
  if (started) await play.stop();
  await rm(dataDir, { recursive: true, force: true });
});

const ip = (): string => `198.51.100.${String(1 + Math.floor(Math.random() * 250))}`;

async function signedIn(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const { id } = await play.eligiblePlayer();
  const token = randomBytes(32).toString("base64url");
  await play.sql`SELECT issue_magic_link(${id}, 'whatsapp', ${createHash("sha256").update(token).digest()})`;
  const context = await browser.newContext({ baseURL: play.url, viewport: { width: 375, height: 812 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await context.newPage();
  await page.goto(`/masuk#c=whatsapp&t=${token}`);
  await page.getByRole("button", { name: "Masuk sekarang" }).click();
  await page.getByRole("link", { name: "Buka trivia" }).click();
  await page.waitForURL(`${play.url}/${play.programSlug}`);
  return { context, page };
}

async function expectAccessible(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

/** The image is on screen, decoded and not the browser's broken-image box. */
async function expectDecoded(image: Locator): Promise<void> {
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBe(1);
}

test("the grid shows a set's uploaded thumbnail and the generic art for a set without one; the banner shows the rank-1 tier's image once", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await signedIn(browser);
  await expect(page.getByRole("heading", { level: 1, name: "Trivia Bergambar" })).toBeVisible();

  // Set 1 has a thumbnail: the tile shows it (through the owning row, the upload id in the URL), decoded.
  const tile1 = page.getByRole("listitem").filter({ hasText: "Set 1" }).filter({ hasText: "Bergambar" });
  const thumbnail = tile1.locator("img").first();
  await expect(thumbnail).toHaveAttribute("src", `/api/v1/play/img/set/${content.setWithThumbnail}/${content.thumbnail}.webp`);
  await expectDecoded(thumbnail);
  // Set 2 has none: the generic art of the asset pipeline (and no uploaded picture).
  const tile2 = page.getByRole("listitem").filter({ hasText: "Set 2" }).filter({ hasText: "Tanpa Gambar" });
  await expect(tile2.locator("img[src^='/api/v1/play/img/']")).toHaveCount(0);
  await expect(tile2.locator("img").first()).toHaveAttribute("src", /^\/assets\/set-[a-z]+\/set-[a-z]+@1x\.webp$/);

  // The banner card's big picture: the program's uploaded banner in a fixed 3:1 box, cropped from its middle (object-fit cover).
  const bannerBox = page.getByTestId("banner-picture");
  const bannerImage = bannerBox.locator("img");
  await expect(bannerImage).toHaveAttribute("src", `/api/v1/play/img/banner/${play.programId}/${content.banner}.webp`);
  await expectDecoded(bannerImage);
  expect(await bannerImage.evaluate((el) => getComputedStyle(el).objectFit)).toBe("cover");
  const bannerSize = await bannerBox.boundingBox();
  expect((bannerSize?.width ?? 0) / (bannerSize?.height ?? 1)).toBeCloseTo(3, 1);
  await expect(page.locator("img[src*='/assets/banner-program/']")).toHaveCount(0);

  // The prize list. The "Hadiah" heading has an icon (no picture beside it); the rank-1 tier is the featured tile, its image in a
  // square box, whole (object-fit contain), not repeated anywhere else; the placeholder is not used.
  const prizesHeading = page.getByRole("heading", { level: 2, name: "Hadiah" });
  await expect(prizesHeading).toBeVisible();
  await expect(prizesHeading.locator("img")).toHaveCount(0);
  await expect(prizesHeading.locator("svg[aria-hidden='true']")).toHaveCount(1);
  const featured = page.getByTestId("prize-featured");
  await expect(featured).toContainText("Juara 1");
  await expect(featured).toContainText("Peringkat 1");
  const tierOneUrl = `/api/v1/play/img/prize/${content.tierOne}/${content.prizeOne}.webp`;
  const slot = page.getByTestId("prize-featured-box").locator("img");
  await expect(slot).toHaveAttribute("src", tierOneUrl);
  await expect(slot).toHaveAttribute("alt", "");
  await expectDecoded(slot);
  expect(await slot.evaluate((el) => getComputedStyle(el).objectFit)).toBe("contain");
  const box = await page.getByTestId("prize-featured-box").boundingBox();
  expect(box?.width).toBe(96);
  expect(box?.height).toBe(96);
  await expect(page.locator(`img[src="${tierOneUrl}"]`)).toHaveCount(1);
  await expect(page.locator("img[src*='prize-placeholder']")).toHaveCount(0);
  // The other tiers: one leading visual in a 48 px box. A tier with an image shows it (once), one without shows the medal.
  const rows = page.getByTestId("prize-row");
  await expect(rows).toHaveCount(2);
  const withImage = rows.filter({ hasText: "Juara 2-3" });
  const rowImage = withImage.locator("img");
  await expect(rowImage).toHaveAttribute("src", `/api/v1/play/img/prize/${content.tierTwo}/${content.prizeTwo}.webp`);
  await expectDecoded(rowImage);
  expect(await rowImage.evaluate((el) => getComputedStyle(el).objectFit)).toBe("contain");
  await expect(withImage.getByTestId("prize-row-box")).toHaveCount(1);
  const rowBox = await withImage.getByTestId("prize-row-box").boundingBox();
  expect({ width: rowBox?.width, height: rowBox?.height }).toEqual({ width: 48, height: 48 });
  const medalRow = rows.filter({ hasText: "Juara 4-6" });
  await expect(medalRow.locator("img")).toHaveCount(0);
  await expect(medalRow.getByTestId("prize-row-box").locator("svg[aria-hidden='true']")).toHaveCount(1);
  // The value badge never wraps, and on a phone it sits in the text column under the rank line, not under the picture.
  const badge = withImage.getByText("Rp 500.000");
  const badgeBox = await badge.boundingBox();
  expect(badgeBox?.height ?? 99).toBeLessThan(30);
  const rankLine = await withImage.getByText("Peringkat 2-3").boundingBox();
  expect(badgeBox?.x ?? 0).toBeGreaterThanOrEqual((rankLine?.x ?? 0) - 1);
  expect(badgeBox?.y ?? 0).toBeGreaterThan((rankLine?.y ?? 0) + (rankLine?.height ?? 0) - 2);

  // The countdown runs to the quiz deadline: no sales-end label, days then hh:mm:ss, the deadline in WIB under the label.
  const deadline = page.getByTestId("quiz-deadline");
  await expect(deadline).toContainText("Kuis ditutup dalam");
  await expect(deadline).toContainText(/Batas akhir: \w+, \d{1,2} \w+ \d{4} pukul 23\.59 WIB/);
  await expect(deadline.getByRole("timer")).toHaveText(/^\d+ hari \d{2}:\d{2}:\d{2}$/);
  await expect(page.getByText("Penjualan berakhir dalam")).toHaveCount(0);
  await expectAccessible(page);

  // The pictures are public (a thumbnail needs no session), fixed image/webp with nosniff, and cached for good.
  const anonymous = await browser.newContext({ baseURL: play.url, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const url = `/api/v1/play/img/set/${content.setWithThumbnail}/${content.thumbnail}.webp`;
  const response = await anonymous.request.get(url);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/webp");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect((await response.body()).equals(WEBP)).toBe(true);
  // A HEAD request answers the headers and no body.
  const head = await anonymous.request.head(url);
  expect(head.status()).toBe(200);
  expect(head.headers()["content-type"]).toBe("image/webp");
  expect(head.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect((await head.body()).length).toBe(0);
  // The banner is public too (no session), the same fixed image/webp with nosniff, immutable.
  const bannerUrl = `/api/v1/play/img/banner/${play.programId}/${content.banner}.webp`;
  const bannerResponse = await anonymous.request.get(bannerUrl);
  expect(bannerResponse.status()).toBe(200);
  expect(bannerResponse.headers()["content-type"]).toBe("image/webp");
  expect(bannerResponse.headers()["x-content-type-options"]).toBe("nosniff");
  expect(bannerResponse.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect((await bannerResponse.body()).equals(WEBP)).toBe(true);
  // Another upload id, an unknown id, a question's picture (under a set's URL, or by any route of its own) are the same bare 404.
  for (const path of [
    `/api/v1/play/img/banner/${play.programId}/${content.thumbnail}.webp`,
    `/api/v1/play/img/banner/${play.programId}/${content.prizeOne}.webp`,
    `/api/v1/play/img/banner/${play.programId}/${content.questionImage}.webp`,
    `/api/v1/play/img/banner/${randomUUID()}/${content.banner}.webp`,
    `/api/v1/play/img/banner/${content.setWithThumbnail}/${content.banner}.webp`,
    `/api/v1/play/img/set/${content.setWithThumbnail}/${content.prizeOne}.webp`,
    `/api/v1/play/img/set/${content.setWithThumbnail}/${content.questionImage}.webp`,
    `/api/v1/play/img/set/${randomUUID()}/${content.thumbnail}.webp`,
    `/api/v1/play/img/set/${content.setWithout}/${content.thumbnail}.webp`,
    `/api/v1/play/img/q/${randomUUID()}.webp`,
  ]) {
    const refused = await anonymous.request.get(path);
    expect(refused.status(), path).toBe(404);
  }
  await anonymous.close();
  await context.close();
});

test("the question screen shows no picture, even for a question that has one in the database", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await signedIn(browser);
  await page.getByRole("link", { name: /Set 1/ }).click();
  await page.waitForURL(`${play.url}/${play.programSlug}/set/1`);
  const served = page.waitForResponse((r) => r.url().endsWith("/api/v1/play/attempts/current") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Mulai" }).click();
  const body = (await (await served).json()) as Record<string, unknown>;
  expect(body["prompt"]).toBe("Hewan apa pada gambar ini?");
  // No hint of the picture in the question's JSON, none on the screen, nothing under the question's upload id.
  expect(JSON.stringify(body)).not.toContain(content.questionImage);
  expect(Object.keys(body)).not.toContain("has_image");
  await expect(page.getByRole("heading", { name: "Hewan apa pada gambar ini?" })).toBeVisible();
  await expect(page.locator("main img")).toHaveCount(0);
  await expectAccessible(page);
  await context.close();
});

test("the leaderboard follows the prize tiers: 6 prize ranks show 6 rows on a phone, and medals sit exactly on ranks 1-6 in their tier's colour", async ({ browser }) => {
  test.setTimeout(120_000);
  // Exactly nine players on the board (the signed-in one and eight more; the earlier tests' players are set aside): more than the six
  // winners, so "Lihat semua" is needed, and fewer than the board's size, so everyone is in it.
  await play.sql`UPDATE player_programs SET eligible = false WHERE program_id = ${play.programId}`;
  for (let i = 0; i < 8; i++) await play.eligiblePlayer();
  const { context, page } = await signedIn(browser);
  const rows = page.locator("section", { has: page.locator("#leaderboard-title") }).locator("tbody tr");
  await expect(rows).toHaveCount(9);
  // The phone shows the six winners (max(5, 6)), the other three wait behind the button; a medal marks ranks 1-6 and nothing else.
  const visibleRows = (): Promise<number> => rows.evaluateAll((all) => all.filter((row) => (row as HTMLElement).offsetParent !== null).length);
  // The player's own row (the "Kamu" badge) is never folded away: when they rank below the sixth, that row is shown as well.
  const mine = await rows.evaluateAll((all) => all.findIndex((row) => row.textContent.includes("Kamu")));
  expect(mine).toBeGreaterThanOrEqual(0);
  await expect(rows.nth(mine)).toBeVisible();
  expect(await visibleRows()).toBe(mine >= 6 ? 7 : 6);
  const showAll = page.getByRole("button", { name: "Lihat semua" });
  await expect(showAll).toBeVisible();
  await expect(rows.locator("[data-testid='rank-medal']")).toHaveCount(6);
  const tone = async (n: number): Promise<string> => (await rows.nth(n).locator("[data-testid='rank-medal'] svg").getAttribute("class")) ?? "";
  // Tier 1 (rank 1) gold, tier 2 (ranks 2-3) silver, tier 3 (ranks 4-6) bronze: the colours of the prize list's medals.
  expect(await tone(0)).toContain("text-accent");
  for (const n of [1, 2]) expect(await tone(n)).toContain("text-muted-foreground");
  for (const n of [3, 4, 5]) expect(await tone(n)).toContain("text-warning");
  for (const n of [6, 7, 8]) await expect(rows.nth(n).locator("[data-testid='rank-medal']")).toHaveCount(0);
  const prizeMedal = (name: string) => page.getByTestId("prize-row").filter({ hasText: name }).locator("svg").first();
  expect(await prizeMedal("Juara 2-3").getAttribute("class")).toContain("text-muted-foreground");
  expect(await prizeMedal("Juara 4-6").getAttribute("class")).toContain("text-warning");
  // A screen reader hears the rank and the prize; the visible number stays.
  await expect(rows.nth(1)).toContainText("Peringkat 2, hadiah Juara 2-3 Rp 500.000");
  await expect(rows.nth(1).locator("td").first()).toContainText("2");
  await showAll.click();
  expect(await visibleRows()).toBe(9);
  await expectAccessible(page);
  await context.close();
});

test("a program without a banner picture shows the built-in art in the same 3:1 box", async ({ browser }) => {
  test.setTimeout(120_000);
  await play.sql`UPDATE programs SET banner_upload_id = NULL WHERE id = ${play.programId}`;
  const { context, page } = await signedIn(browser);
  const box = page.getByTestId("banner-picture");
  const art = box.locator("img");
  await expect(art).toHaveAttribute("src", /^\/assets\/banner-program\/banner-program@1x\.webp$/);
  // The built-in art is decoded at its own size (the 1 x 1 test WebP of expectDecoded is for the uploaded pictures).
  await art.scrollIntoViewIfNeeded();
  await expect.poll(() => art.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(1);
  expect(await art.evaluate((el) => getComputedStyle(el).objectFit)).toBe("cover");
  const size = await box.boundingBox();
  expect((size?.width ?? 0) / (size?.height ?? 1)).toBeCloseTo(3, 1);
  await expect(page.locator("img[src*='/api/v1/play/img/banner/']")).toHaveCount(0);
  await expectAccessible(page);
  await context.close();
});
