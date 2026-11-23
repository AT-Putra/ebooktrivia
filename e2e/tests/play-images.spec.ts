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
 *   - the banner's prize slot shows the rank-1 tier's uploaded image (else the placeholder), another tier with an image
 *     shows it in its own row, and the slot's image is not repeated in the first tier's row;
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
  await sql`UPDATE programs SET name = 'Trivia Bergambar' WHERE id = ${programId}`;
  const prizeOne = await upload();
  const prizeTwo = await upload();
  const [tierOne] = await sql<{ id: string }[]>`
    INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr, image_upload_id) VALUES (${programId}, 1, 1, 'Juara 1', 1000000, ${prizeOne}) RETURNING id`;
  const [tierTwo] = await sql<{ id: string }[]>`
    INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr, image_upload_id) VALUES (${programId}, 2, 3, 'Juara 2-3', 500000, ${prizeTwo}) RETURNING id`;
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

  // The banner: the rank-1 tier's image in the prize slot (not the placeholder); its row does not repeat it, the other tier's row shows its own.
  const slot = page.getByRole("img", { name: "Ilustrasi hadiah utama" });
  await expect(slot).toHaveAttribute("src", `/api/v1/play/img/prize/${content.tierOne}/${content.prizeOne}.webp`);
  await expectDecoded(slot);
  await expect(page.locator("img[src*='prize-placeholder']")).toHaveCount(0);
  await expect(page.getByRole("listitem").filter({ hasText: "Juara 1" }).locator("img")).toHaveCount(0);
  const rowImage = page.getByRole("listitem").filter({ hasText: "Juara 2-3" }).locator("img");
  await expect(rowImage).toHaveAttribute("src", `/api/v1/play/img/prize/${content.tierTwo}/${content.prizeTwo}.webp`);
  await expectDecoded(rowImage);
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
  // Another upload id, an unknown id, a question's picture (under a set's URL, or by any route of its own) are the same bare 404.
  for (const path of [
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
