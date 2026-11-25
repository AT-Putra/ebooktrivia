import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { type AdminEnv, freshTotp, runAdminCli, startAdminEnv } from "../support/admin.ts";

/**
 * A program's banner picture, as the Owner manages it on the Programs page (production build of apps/admin, own database and port):
 * upload (a re-encoded WebP with a display copy under the data directory), a preview embedded in the page, replace, remove; the
 * route refuses a foreign Origin; at 390 px nothing scrolls sideways. The leaderboard hint appears on the Programs and the Prize
 * tiers pages when the leaderboard is shorter than the last prize rank.
 */
test.describe.configure({ mode: "serial" });

const PORT = 3210;
const URL_ = `http://127.0.0.1:${String(PORT)}`;
const stamp = String(Date.now());
const OWNER = { email: `owner-ban-${stamp}@example.test`, password: "owner-banner-e2e-1", name: "Banner Owner" };

let admin: AdminEnv;
let started = false;
let dataDir = "";
let context: BrowserContext;
let owner: Page;
let slug = "";
let programId = "";

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};

/** A solid-colour RGB PNG of `width` x `height`. */
function solidPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x40)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  dataDir = await mkdtemp(join(tmpdir(), "ebt-e2e-banner-"));
  admin = await startAdminEnv({ port: PORT, extraEnv: { ADMIN_DATA_DIR: dataDir } });
  started = true;
  const boot = await runAdminCli(admin.env, ["bootstrap-owner", "--email", OWNER.email, "--name", OWNER.name], `${OWNER.password}\n`);
  expect(boot.code).toBe(0);
  context = await browser.newContext({ baseURL: URL_, extraHTTPHeaders: { "x-forwarded-for": "203.0.113.60" } });
  owner = await context.newPage();
  await owner.goto("/login");
  await owner.getByLabel("E-mail").fill(OWNER.email);
  await owner.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await owner.getByRole("button", { name: "Sign in" }).click();
  await expect(owner).toHaveURL(/\/enroll$/);
  const newPassword = `${OWNER.password}-new`;
  await owner.getByLabel("Current password").fill(OWNER.password);
  await owner.getByLabel("New password").fill(newPassword);
  await owner.getByRole("button", { name: "Start setup" }).click();
  const secret = ((await owner.getByTestId("totp-secret").textContent()) ?? "").replace(/\s/g, "");
  await owner.getByLabel("Authenticator code").fill(await freshTotp(secret, new Set()));
  await owner.getByRole("button", { name: "Turn on two-factor" }).click();
  await expect(owner.getByRole("heading", { name: "Overview" })).toBeVisible();
  slug = `banner-${stamp}`;
  const [product] = await admin.sql<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES ('Ebook Banner Uji', 49000) RETURNING id`;
  const [program] = await admin.sql<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days, leaderboard_top_n)
    VALUES (${product?.id ?? ""}, ${slug}, 'Musim Banner', 'published', now() - interval '1 day', now() + interval '30 days', 30, 5) RETURNING id`;
  programId = program?.id ?? "";
  await admin.sql`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr) VALUES (${programId}, 1, 1, 'Juara 1', 1000000), (${programId}, 2, 6, 'Juara 2-6', 500000)`;
});

test.afterAll(async () => {
  await context.close();
  if (started) await admin.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("the Owner uploads, previews, replaces and removes a program's banner picture; nothing scrolls sideways at 390 px", async () => {
  test.setTimeout(120_000);
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto("/settings/programs");
  const card = owner.getByTestId(`program-${slug}`);
  const banner = card.getByTestId("program-banner");
  await expect(banner).toContainText("Program banner (shown to players)");
  await expect(banner).toContainText("No banner yet");
  await expect(card.getByTestId("program-banner-preview")).toHaveCount(0);

  await banner.getByLabel(/Upload a banner/).setInputFiles({ name: "banner.png", mimeType: "image/png", buffer: solidPng(1500, 500) });
  await expect(banner.getByRole("status")).toContainText("Image saved.");
  // The page refreshes with the preview (the display copy, embedded as a data URI) in a 3:1 box, and the label offers a replacement.
  const preview = card.getByTestId("program-banner-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("src", /^data:image\/webp;base64,/);
  const box = await preview.boundingBox();
  expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(3, 1);
  await expect(banner.getByLabel(/Replace the banner/)).toBeVisible();
  const [row] = await admin.sql<{ id: string }[]>`SELECT banner_upload_id AS id FROM programs WHERE id = ${programId}`;
  const first = row?.id ?? "";
  expect(first).not.toBe("");

  await banner.getByLabel(/Replace the banner/).setInputFiles({ name: "banner2.png", mimeType: "image/png", buffer: solidPng(1800, 600) });
  await expect.poll(async () => (await admin.sql<{ id: string }[]>`SELECT banner_upload_id AS id FROM programs WHERE id = ${programId}`)[0]?.id).not.toBe(first);

  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await card.getByTestId("program-banner-remove").getByRole("button", { name: "Remove banner" }).click();
  await expect(card.getByTestId("program-banner-remove")).toHaveCount(0);
  await expect(banner).toContainText("No banner yet");
  expect((await admin.sql<{ id: string | null }[]>`SELECT banner_upload_id AS id FROM programs WHERE id = ${programId}`)[0]?.id).toBeNull();
  // Audited: one entry per change, with the upload ids and never the file name.
  const audits = await admin.sql<{ text: string }[]>`SELECT row_to_json(a)::text AS text FROM audit_log a WHERE action = 'program.banner' AND entity_id = ${programId}`;
  expect(audits).toHaveLength(3);
  expect(audits.some((a) => a.text.includes("banner.png") || a.text.includes("banner2.png"))).toBe(false);
});

test("the upload route refuses a foreign Origin, even with the Owner's session", async () => {
  const response = await owner.request.post(`/uploads/image/banner?program=${programId}`, {
    headers: { origin: "http://evil.example", "content-type": "image/png", "x-file-name": "x.png" },
    data: solidPng(300, 100),
  });
  expect(response.status()).toBe(403);
  expect((await admin.sql<{ id: string | null }[]>`SELECT banner_upload_id AS id FROM programs WHERE id = ${programId}`)[0]?.id).toBeNull();
});

test("a finalized program lists its banner as uploaded, without embedding the picture, and the Owner can still remove it", async () => {
  const [product] = await admin.sql<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES ('Ebook Selesai Uji', 49000) RETURNING id`;
  const doneSlug = `selesai-${stamp}`;
  const [done] = await admin.sql<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product?.id ?? ""}, ${doneSlug}, 'Musim Selesai', 'finalized', now() - interval '90 days', now() - interval '40 days', 30) RETURNING id`;
  // The picture exists on disk, so the missing preview is the page's choice and not a missing file.
  await owner.goto("/settings/programs");
  await owner.getByTestId(`program-${slug}`).getByLabel(/Upload a banner/).setInputFiles({ name: "b.png", mimeType: "image/png", buffer: solidPng(1500, 500) });
  await expect(owner.getByTestId(`program-${slug}`).getByRole("status")).toContainText("Image saved.");
  const [uploaded] = await admin.sql<{ id: string }[]>`SELECT banner_upload_id AS id FROM programs WHERE id = ${programId}`;
  await admin.sql`UPDATE programs SET banner_upload_id = ${uploaded?.id ?? ""} WHERE id = ${done?.id ?? ""}`;
  await owner.reload();
  const card = owner.getByTestId(`program-${doneSlug}`);
  await expect(card.getByTestId("program-banner-set")).toBeVisible();
  await expect(card.getByTestId("program-banner-preview")).toHaveCount(0);
  await expect(card.getByTestId("program-banner-remove")).toBeVisible();
  // A program still in play shows the picture.
  await expect(owner.getByTestId(`program-${slug}`).getByTestId("program-banner-preview")).toBeVisible();
  await card.getByTestId("program-banner-remove").getByRole("button", { name: "Remove banner" }).click();
  await expect(card.getByTestId("program-banner-remove")).toHaveCount(0);
  expect((await admin.sql<{ id: string | null }[]>`SELECT banner_upload_id AS id FROM programs WHERE id = ${done?.id ?? ""}`)[0]?.id).toBeNull();
});

test("a leaderboard shorter than the last prize rank is flagged on the Programs and the Prize tiers pages (read-only hint, Bahasa Indonesia)", async () => {
  await owner.goto("/settings/programs");
  const hint = owner.getByTestId(`program-${slug}`).getByTestId("program-leaderboard-hint");
  await expect(hint).toContainText("top 5 players");
  await expect(hint).toContainText("ranks 1 to 6");
  await expect(hint).toContainText("some prize winners would not appear on it");
  await owner.goto("/settings/prizes");
  await expect(owner.getByTestId(`prizes-${programId}`).getByTestId("leaderboard-hint")).toContainText("at least 6");
  // Long enough: no hint.
  await admin.sql`UPDATE programs SET leaderboard_top_n = 6 WHERE id = ${programId}`;
  await owner.goto("/settings/programs");
  await expect(owner.getByTestId(`program-${slug}`).getByTestId("program-leaderboard-hint")).toHaveCount(0);
});
