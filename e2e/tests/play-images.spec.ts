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
 *   - the prize list: ONE card for every tier (a square frame with its uploaded image, whole: object-fit contain, else the
 *     built-in placeholder; the medal on the rank line), one column on a phone, the same frame size and the same edges as the
 *     banner and the countdown, and each tier's picture appears exactly once; one column below xl, three from xl, cards of one
 *     row equally tall;
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
  // A third tier without a picture (the built-in placeholder stands in its frame): the prize ranks reach 6, so the leaderboard shows 6 rows first.
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

/** The left and right edge of an element on the page. */
async function edges(target: Locator): Promise<{ left: number; right: number }> {
  const b = await target.boundingBox();
  return { left: b?.x ?? -1, right: (b?.x ?? -1) + (b?.width ?? 0) };
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

  // The prize list. The "Hadiah" heading has an icon (no picture beside it) and names the list. EVERY tier is the same card: a square
  // picture frame (76 px on a phone), the picture whole (object-fit contain), shown once; a tier without a picture shows the
  // built-in placeholder in the same frame, never the medal.
  const prizesHeading = page.getByRole("heading", { level: 2, name: "Hadiah" });
  await expect(prizesHeading).toBeVisible();
  await expect(prizesHeading.locator("img")).toHaveCount(0);
  await expect(prizesHeading.locator("svg[aria-hidden='true']")).toHaveCount(1);
  const list = page.getByRole("list", { name: "Hadiah" });
  const cards = list.getByTestId("prize-card");
  await expect(cards).toHaveCount(3);
  const tierOneUrl = `/api/v1/play/img/prize/${content.tierOne}/${content.prizeOne}.webp`;
  const tierTwoUrl = `/api/v1/play/img/prize/${content.tierTwo}/${content.prizeTwo}.webp`;
  const one = cards.filter({ hasText: "Hadiah utama" });
  await expect(one).toHaveCount(1);
  // A one-place tier shows only its rank: the winner count would repeat it.
  await expect(one.locator(".flex-wrap.items-center")).toHaveText("Juara 1");
  await expect(one).not.toContainText("pemenang");
  const slot = one.getByTestId("prize-picture").locator("img");
  await expect(slot).toHaveAttribute("src", tierOneUrl);
  await expect(slot).toHaveAttribute("alt", "");
  await expectDecoded(slot);
  expect(await slot.evaluate((el) => getComputedStyle(el).objectFit)).toBe("contain");
  await expect(page.locator(`img[src="${tierOneUrl}"]`)).toHaveCount(1);
  const two = cards.filter({ hasText: "Juara 2–3 · 2 pemenang" });
  const twoImage = two.getByTestId("prize-picture").locator("img");
  await expect(twoImage).toHaveAttribute("src", tierTwoUrl);
  await expectDecoded(twoImage);
  expect(await twoImage.evaluate((el) => getComputedStyle(el).objectFit)).toBe("contain");
  await expect(page.locator(`img[src="${tierTwoUrl}"]`)).toHaveCount(1);
  // The tier without a picture: the built-in placeholder in the same frame (one on the page), and no medal in the frame; the medal
  // is on the rank line of every card.
  const three = cards.filter({ hasText: "Juara 4–6 · 3 pemenang" });
  const placeholder = three.getByTestId("prize-picture").locator("img");
  await expect(placeholder).toHaveAttribute("src", /^\/assets\/prize-placeholder\/prize-placeholder@1x\.webp$/);
  await expect(placeholder).toHaveAttribute("alt", "");
  // The built-in art is 3:2: it fills the square frame (cover); an upload stays whole (contain, above).
  expect(await placeholder.evaluate((el) => getComputedStyle(el).objectFit)).toBe("cover");
  await expect(page.locator("img[src*='prize-placeholder']")).toHaveCount(1);
  await expect(three.getByTestId("prize-picture").locator("svg")).toHaveCount(0);
  for (const card of [one, two, three]) await expect(card.locator("svg[aria-hidden='true']")).toHaveCount(1);
  // Every frame has the same size: 76 px on a phone.
  for (const card of [one, two, three]) {
    const frame = await card.getByTestId("prize-picture").boundingBox();
    expect({ width: frame?.width, height: frame?.height }).toEqual({ width: 76, height: 76 });
  }
  // Only the rank-1 card has the accent border and "Hadiah utama", then its value; the others show only their value. A pill never
  // wraps and sits in the text column under the rank line and the name, not under the picture.
  expect(await one.evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe(await two.evaluate((el) => getComputedStyle(el).borderTopColor));
  expect(await one.locator("[data-slot='badge']").allTextContents()).toEqual(["Hadiah utama", "Rp 1.000.000"]);
  expect(await two.locator("[data-slot='badge']").allTextContents()).toEqual(["Rp 500.000"]);
  expect(await three.locator("[data-slot='badge']").allTextContents()).toEqual(["Rp 100.000"]);
  for (const pill of await list.locator("[data-slot='badge']").all()) expect((await pill.boundingBox())?.height ?? 99).toBeLessThan(30);
  // The rank line is ONE line on a phone ("Juara 4–6 · 3 pemenang" at 375 px); where it ever has to break it does so only between
  // its two parts (each part is one line), and the medal is on the first.
  for (const card of [one, two, three]) {
    expect((await card.locator(".flex-wrap.items-center").boundingBox())?.height ?? 99).toBeLessThan(26);
    const [label, winners] = await card.locator(".flex-wrap.items-center > span").all();
    const labelBox = await label?.boundingBox();
    expect((await winners?.boundingBox())?.height ?? 0).toBeLessThan(26);
    expect(labelBox?.height ?? 99).toBeLessThan(26);
    const medal = await card.locator("svg[aria-hidden='true']").boundingBox();
    expect(medal?.y ?? -1).toBeGreaterThanOrEqual((labelBox?.y ?? 0) - 1);
    expect((medal?.y ?? 99) + (medal?.height ?? 0)).toBeLessThanOrEqual((labelBox?.y ?? 0) + (labelBox?.height ?? 0) + 1);
  }
  const badge = two.getByText("Rp 500.000");
  const badgeBox = await badge.boundingBox();
  expect(badgeBox?.height ?? 99).toBeLessThan(30);
  const rankLine = await two.getByText("Juara 2–3 · 2 pemenang").boundingBox();
  const nameLine = await two.getByText("Juara 2-3", { exact: true }).boundingBox();
  expect(badgeBox?.x ?? 0).toBeGreaterThanOrEqual((rankLine?.x ?? 0) - 1);
  expect(nameLine?.y ?? 0).toBeGreaterThan((rankLine?.y ?? 0) + (rankLine?.height ?? 0) - 2);
  expect(badgeBox?.y ?? 0).toBeGreaterThan((nameLine?.y ?? 0) + (nameLine?.height ?? 0) - 2);
  await expect(three.getByText("Rp 100.000")).toHaveCount(1);
  // One column on a phone, and the banner, the prize list and the countdown share the card's left and right edges.
  const bannerEdges = await edges(bannerBox);
  for (const target of [list, cards.first(), cards.last(), page.getByTestId("quiz-deadline")]) {
    const e = await edges(target);
    expect(e.left).toBeCloseTo(bannerEdges.left, 0);
    expect(e.right).toBeCloseTo(bannerEdges.right, 0);
  }

  // The countdown runs to the quiz deadline: no sales-end label, days then hh:mm:ss, the deadline in WIB under the label.
  const deadline = page.getByTestId("quiz-deadline");
  await expect(deadline).toContainText("Kuis ditutup dalam");
  // The day, month and year, and "pukul 23.59 WIB", are held together by no-break spaces; the line breaks only after "akhir:", the
  // weekday's comma and before "pukul".
  await expect(deadline).toContainText(/Batas\u00a0akhir: \w+, \d{1,2}\u00a0\w+\u00a0\d{4} pukul\u00a023\.59\u00a0WIB/);
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

const LONG_NAME = "Voucher belanja online senilai satu juta rupiah yang berlaku di semua toko mitra kami di seluruh Indonesia";

test("the prize grid is one column below xl and three from xl, the cards of a row are equally tall (even with a long name), the frames grow to 112 px from md, and everything shares the banner's edges", async ({ browser }) => {
  test.setTimeout(120_000);
  // One tier gets a long name, so the cards of a row can only share a height if the grid stretches them (the name is restored below).
  await play.sql`UPDATE prize_tiers SET name = ${LONG_NAME} WHERE id = ${content.tierTwo}`;
  let context: BrowserContext | undefined;
  try {
    const signed = await signedIn(browser);
    context = signed.context;
    const page = signed.page;
    const cards = page.getByRole("list", { name: "Hadiah" }).getByTestId("prize-card");
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(1)).toContainText(LONG_NAME);
    const columns = async (): Promise<number> => new Set(await cards.evaluateAll((all) => all.map((card) => Math.round(card.getBoundingClientRect().left)))).size;
    // A card with a short name is as tall as its picture frame, its padding and its border (112 + 2 x 12 + 2 x 2 px).
    const shortCard = 112 + 2 * 12 + 2 * 2;
    for (const [width, expected] of [[768, 1], [1024, 1], [1279, 1], [1280, 3], [1920, 3]] as const) {
      const at = `${String(width)} px`;
      await page.setViewportSize({ width, height: 900 });
      expect(await columns(), at).toBe(expected);
      const boxes = await cards.evaluateAll((all) => all.map((card) => card.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), height: Math.round(r.height) })));
      // The cards that share a row share its top and its height.
      for (const row of new Set(boxes.map((b) => b.top))) expect(new Set(boxes.filter((b) => b.top === row).map((b) => b.height)).size, at).toBe(1);
      // With three columns the row is as tall as the long card, which is taller than a short one would be alone.
      if (expected === 3) {
        expect(new Set(boxes.map((b) => b.top)).size, at).toBe(1);
        expect(boxes[0]?.height ?? 0, at).toBeGreaterThan(shortCard + 10);
      }
      for (let i = 0; i < 3; i++) {
        const frame = await cards.nth(i).getByTestId("prize-picture").boundingBox();
        expect({ width: frame?.width, height: frame?.height }, at).toEqual({ width: 112, height: 112 });
      }
      // The banner, the prize list and the countdown share the same left and right edges.
      const banner = await edges(page.getByTestId("banner-picture"));
      for (const target of [page.getByRole("list", { name: "Hadiah" }), page.getByTestId("quiz-deadline")]) {
        const e = await edges(target);
        expect(e.left, at).toBeCloseTo(banner.left, 0);
        expect(e.right, at).toBeCloseTo(banner.right, 0);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, at).toBeLessThanOrEqual(0);
    }
  } finally {
    await context?.close();
    await play.sql`UPDATE prize_tiers SET name = 'Juara 2-3' WHERE id = ${content.tierTwo}`;
  }
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
  // The top list is cached in-process for 5 s (lib/play/leaderboard-cache.ts): the board a previous test loaded must have expired
  // before this one's page asks for it, or the page shows the earlier, smaller board.
  await new Promise((resolve) => setTimeout(resolve, 5_200));
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
  const prizeMedal = (name: string) => page.getByTestId("prize-card").filter({ hasText: name }).locator("svg").first();
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
