// The one-off image maintenance (lib/settings/image-maintenance.ts, run by src/cli/images.ts on the VM), against the migrated
// database with the admin_rw login and real files: display copies for the images that predate them, and question images moved out of
// the directory the public app mounts. Both are re-runnable, leave what they cannot decide alone, and report it.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayCopy } from "@ebooktrivia/uploads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfillDisplayCopies, moveQuestionImages } from "../src/lib/settings/image-maintenance.ts";
import { NO_SETTINGS } from "../src/lib/settings/env.ts";
import { solidPng, webpSize } from "./image-fixtures.ts";
import { newRuntime, root, suffix, TEST_CONFIG } from "./support.ts";

const CLI = fileURLToPath(new URL("../src/cli/images.ts", import.meta.url));
let dataDir = "";
let rt: ReturnType<typeof newRuntime>;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ebt-admin-images-"));
  await mkdir(join(dataDir, "images"), { recursive: true });
  rt = newRuntime(undefined, { ...NO_SETTINGS, dataDir });
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

type Id = { id: string };
const one = async <T>(rows: Promise<readonly T[]>): Promise<T> => {
  const [row] = await rows;
  if (row === undefined) throw new Error("no row");
  return row;
};

/** An original as the upload policy leaves it: a WebP at its size (no larger than 2048), stored where `path` says, with its uploads row. */
async function upload(width: number, height: number, options: { readonly path?: (id: string) => string; readonly kind?: string; readonly onDisk?: boolean; readonly contentType?: string } = {}) {
  const id = randomUUID();
  const bytes = await displayCopy(solidPng(width, height), { width: 2048, height: 2048 });
  const path = (options.path ?? ((i) => `images/${i}.webp`))(id);
  await root`
    INSERT INTO uploads (id, kind, storage_path, content_type, size_bytes, sha256)
    VALUES (${id}, ${options.kind ?? "image"}, ${path}, ${options.contentType ?? "image/webp"}, ${bytes.length}, ${createHash("sha256").update(bytes).digest()})`;
  if (options.onDisk !== false) {
    await mkdir(join(dataDir, path, ".."), { recursive: true });
    await writeFile(join(dataDir, path), bytes);
  }
  return { id, bytes, path };
}

/** A published program with one set and (optionally) its question; returns the ids to hang images on. */
async function program(): Promise<{ programId: string; setId: string; questionId: string; tierId: string }> {
  const product = await one(root<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
  const p = await one(root<Id[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product.id}, ${`img-${suffix()}`}, 'Program', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`);
  const set = await one(root<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${p.id}, 1, 'Set 1') RETURNING id`);
  const question = await one(root<Id[]>`INSERT INTO questions (set_id, position, prompt, points, timer_seconds) VALUES (${set.id}, 1, 'Soal?', 10, 20) RETURNING id`);
  const tier = await one(root<Id[]>`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr) VALUES (${p.id}, 1, 1, 'Juara 1', 1000000) RETURNING id`);
  return { programId: p.id, setId: set.id, questionId: question.id, tierId: tier.id };
}

const exists = (path: string): Promise<boolean> =>
  stat(join(dataDir, path)).then(
    () => true,
    () => false,
  );
const dims = async (path: string) => webpSize(await readFile(join(dataDir, path)));

describe("backfillDisplayCopies", () => {
  it("makes the display copy of every set thumbnail (480 x 600) and prize image (256 x 256) that has none, from the original, which it leaves alone", async () => {
    const { setId, tierId } = await program();
    const thumbnail = await upload(1200, 800);
    const prize = await upload(1000, 600);
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${thumbnail.id} WHERE id = ${setId}`;
    await root`UPDATE prize_tiers SET image_upload_id = ${prize.id} WHERE id = ${tierId}`;
    const lines: string[] = [];
    const report = await backfillDisplayCopies(rt.sql, dataDir, { log: (line) => lines.push(line) });
    expect(report.made).toBeGreaterThanOrEqual(2);
    expect(report.missing).not.toContain(thumbnail.id);
    expect(await dims(`images/${thumbnail.id}.display.webp`)).toEqual({ width: 480, height: 320 });
    expect(await dims(`images/${prize.id}.display.webp`)).toEqual({ width: 256, height: 154 });
    expect((await readFile(join(dataDir, thumbnail.path))).equals(thumbnail.bytes)).toBe(true);
    expect(lines.join("\n")).toContain(thumbnail.id);
    // No temporary file is left behind, and the output names ids only (no path of the data directory).
    expect((await readdir(join(dataDir, "images"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(lines.join("\n")).not.toContain(dataDir);
  });

  it("makes the display copy of a program's banner too (1344 x 448, never enlarged), and the thumbnail box wins for an upload both a set and a banner show", async () => {
    const banner = await upload(1800, 600);
    const small = await upload(600, 200);
    const both = await upload(1800, 600);
    await root`UPDATE programs SET banner_upload_id = ${banner.id} WHERE id = ${(await program()).programId}`;
    await root`UPDATE programs SET banner_upload_id = ${small.id} WHERE id = ${(await program()).programId}`;
    const shown = await program();
    await root`UPDATE programs SET banner_upload_id = ${both.id} WHERE id = ${shown.programId}`;
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${both.id} WHERE id = ${shown.setId}`;
    const report = await backfillDisplayCopies(rt.sql, dataDir);
    expect(report.missing).not.toContain(banner.id);
    expect(await dims(`images/${banner.id}.display.webp`)).toEqual({ width: 1344, height: 448 });
    expect(await dims(`images/${small.id}.display.webp`)).toEqual({ width: 600, height: 200 });
    expect(await dims(`images/${both.id}.display.webp`)).toEqual({ width: 480, height: 160 });
    expect((await readFile(join(dataDir, banner.path))).equals(banner.bytes)).toBe(true);
  });

  it("is re-runnable: a second run makes nothing and keeps what it made; --force makes them again; a dry run writes nothing", async () => {
    const { setId } = await program();
    const thumbnail = await upload(900, 1500);
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${thumbnail.id} WHERE id = ${setId}`;
    const copy = `images/${thumbnail.id}.display.webp`;
    expect((await backfillDisplayCopies(rt.sql, dataDir, { dryRun: true })).made).toBeGreaterThanOrEqual(1);
    expect(await exists(copy)).toBe(false);
    await backfillDisplayCopies(rt.sql, dataDir);
    expect(await dims(copy)).toEqual({ width: 360, height: 600 });
    const first = await stat(join(dataDir, copy));
    const again = await backfillDisplayCopies(rt.sql, dataDir);
    expect(again.made).toBe(0);
    expect(again.kept).toBeGreaterThanOrEqual(1);
    expect((await stat(join(dataDir, copy))).mtimeMs).toBe(first.mtimeMs);
    // Corrupt it, and --force replaces it with a good one.
    await writeFile(join(dataDir, copy), "broken");
    expect((await backfillDisplayCopies(rt.sql, dataDir, { force: true })).made).toBeGreaterThanOrEqual(1);
    expect(await dims(copy)).toEqual({ width: 360, height: 600 });
  });

  it("reports an original that is not on the disk, and an upload that is not a stored image of the policy, and goes on with the rest", async () => {
    const { setId, tierId } = await program();
    const lost = await upload(800, 600, { onDisk: false });
    const pdf = await upload(800, 600, { kind: "pdf" });
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${lost.id} WHERE id = ${setId}`;
    await root`UPDATE prize_tiers SET image_upload_id = ${pdf.id} WHERE id = ${tierId}`;
    const report = await backfillDisplayCopies(rt.sql, dataDir);
    expect(report.missing).toContain(lost.id);
    expect(report.refused).toContain(pdf.id);
    expect(await exists(`images/${lost.id}.display.webp`)).toBe(false);
    expect(await exists(`images/${pdf.id}.display.webp`)).toBe(false);
  });

  it("leaves uploads that nothing shows alone (a replaced thumbnail, a question's image)", async () => {
    const { questionId } = await program();
    const orphan = await upload(800, 600);
    const question = await upload(800, 600, { path: (id) => `question-images/${id}.webp` });
    await root`UPDATE questions SET image_upload_id = ${question.id} WHERE id = ${questionId}`;
    await backfillDisplayCopies(rt.sql, dataDir);
    expect(await exists(`images/${orphan.id}.display.webp`)).toBe(false);
    expect(await exists(`question-images/${question.id}.display.webp`)).toBe(false);
    expect(await exists(`images/${question.id}.display.webp`)).toBe(false);
  });
});

describe("moveQuestionImages", () => {
  const rowPath = async (id: string) => (await one(root<{ storage_path: string }[]>`SELECT storage_path FROM uploads WHERE id = ${id}`)).storage_path;

  it("copies a question image to question-images/, rewrites its row, then removes the old file and any display copy", async () => {
    const { questionId } = await program();
    const image = await upload(800, 600);
    await writeFile(join(dataDir, `images/${image.id}.display.webp`), "stale display copy");
    await root`UPDATE questions SET image_upload_id = ${image.id} WHERE id = ${questionId}`;
    const lines: string[] = [];
    const report = await moveQuestionImages(rt.sql, dataDir, { log: (line) => lines.push(line) });
    expect(report.moved).toBeGreaterThanOrEqual(1);
    expect(await rowPath(image.id)).toBe(`question-images/${image.id}.webp`);
    expect((await readFile(join(dataDir, `question-images/${image.id}.webp`))).equals(image.bytes)).toBe(true);
    expect(await exists(`images/${image.id}.webp`)).toBe(false);
    expect(await exists(`images/${image.id}.display.webp`)).toBe(false);
    expect(lines.join("\n")).toContain(image.id);
    expect(lines.join("\n")).not.toContain(dataDir);
  });

  it("is re-runnable: a second run moves nothing, and an interrupted run (copied but not rewritten, or rewritten but not cleaned up) is finished by the next", async () => {
    const { questionId } = await program();
    const image = await upload(800, 600);
    await root`UPDATE questions SET image_upload_id = ${image.id} WHERE id = ${questionId}`;
    await moveQuestionImages(rt.sql, dataDir);
    const settled = await moveQuestionImages(rt.sql, dataDir);
    expect(settled.moved).toBe(0);
    expect(settled.settled).toBeGreaterThanOrEqual(1);

    // Crash after the copy, before the row: both files exist, the row still says images/.
    const copied = await upload(640, 480);
    await root`UPDATE questions SET image_upload_id = ${copied.id} WHERE id = ${(await program()).questionId}`;
    await mkdir(join(dataDir, "question-images"), { recursive: true });
    await writeFile(join(dataDir, `question-images/${copied.id}.webp`), copied.bytes);
    await moveQuestionImages(rt.sql, dataDir);
    expect(await rowPath(copied.id)).toBe(`question-images/${copied.id}.webp`);
    expect(await exists(`images/${copied.id}.webp`)).toBe(false);

    // Crash after the row, before the cleanup: the row says question-images/, the old file is still under images/.
    const rewritten = await upload(640, 480, { path: (id) => `question-images/${id}.webp` });
    await root`UPDATE questions SET image_upload_id = ${rewritten.id} WHERE id = ${(await program()).questionId}`;
    await writeFile(join(dataDir, `images/${rewritten.id}.webp`), rewritten.bytes);
    await moveQuestionImages(rt.sql, dataDir);
    expect(await exists(`images/${rewritten.id}.webp`)).toBe(false);
    expect(await exists(`question-images/${rewritten.id}.webp`)).toBe(true);
    expect(await rowPath(rewritten.id)).toBe(`question-images/${rewritten.id}.webp`);
  });

  it("leaves a program's banner in images/ (players are shown it), reports one a question also uses, and still moves an image nothing shows", async () => {
    const { programId } = await program();
    const banner = await upload(1800, 600);
    await root`UPDATE programs SET banner_upload_id = ${banner.id} WHERE id = ${programId}`;
    const { programId: sharedProgram, questionId } = await program();
    const shared = await upload(1800, 600);
    await root`UPDATE programs SET banner_upload_id = ${shared.id} WHERE id = ${sharedProgram}`;
    await root`UPDATE questions SET image_upload_id = ${shared.id} WHERE id = ${questionId}`;
    const orphan = await upload(800, 600);
    const report = await moveQuestionImages(rt.sql, dataDir);
    expect(report.shared).toContain(shared.id);
    for (const kept of [banner, shared]) {
      expect(await rowPath(kept.id)).toBe(`images/${kept.id}.webp`);
      expect(await exists(`images/${kept.id}.webp`)).toBe(true);
      expect(await exists(`question-images/${kept.id}.webp`)).toBe(false);
    }
    // Nothing shows the orphan, so it is taken out of the directory the public app mounts.
    expect(await rowPath(orphan.id)).toBe(`question-images/${orphan.id}.webp`);
    expect(await exists(`images/${orphan.id}.webp`)).toBe(false);
    // The banner's display copy (made by the backfill) is not touched by the move either.
    await backfillDisplayCopies(rt.sql, dataDir);
    await moveQuestionImages(rt.sql, dataDir);
    expect(await dims(`images/${banner.id}.display.webp`)).toEqual({ width: 1344, height: 448 });
  });

  it("leaves an upload that a set or a prize tier also shows where it is, and says so; a dry run changes nothing", async () => {
    const { questionId, setId } = await program();
    const shared = await upload(800, 600);
    await root`UPDATE questions SET image_upload_id = ${shared.id} WHERE id = ${questionId}`;
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${shared.id} WHERE id = ${setId}`;
    const report = await moveQuestionImages(rt.sql, dataDir);
    expect(report.shared).toContain(shared.id);
    expect(await rowPath(shared.id)).toBe(`images/${shared.id}.webp`);
    expect(await exists(`images/${shared.id}.webp`)).toBe(true);

    const { questionId: other } = await program();
    const image = await upload(800, 600);
    await root`UPDATE questions SET image_upload_id = ${image.id} WHERE id = ${other}`;
    expect((await moveQuestionImages(rt.sql, dataDir, { dryRun: true })).moved).toBeGreaterThanOrEqual(1);
    expect(await rowPath(image.id)).toBe(`images/${image.id}.webp`);
    expect(await exists(`images/${image.id}.webp`)).toBe(true);
    expect(await exists(`question-images/${image.id}.webp`)).toBe(false);
  });

  it("leaves the row alone when the file is at neither place, and refuses an upload that is not a stored image of the policy", async () => {
    const { questionId } = await program();
    const lost = await upload(800, 600, { onDisk: false });
    await root`UPDATE questions SET image_upload_id = ${lost.id} WHERE id = ${questionId}`;
    const { questionId: second } = await program();
    const odd = await upload(800, 600, { path: (id) => `deliverables/${id}.webp` });
    await root`UPDATE questions SET image_upload_id = ${odd.id} WHERE id = ${second}`;
    const report = await moveQuestionImages(rt.sql, dataDir);
    expect(report.missing).toContain(lost.id);
    expect(report.refused).toContain(odd.id);
    expect(await rowPath(lost.id)).toBe(`images/${lost.id}.webp`);
    expect(await rowPath(odd.id)).toBe(`deliverables/${odd.id}.webp`);
    expect(await exists(`deliverables/${odd.id}.webp`)).toBe(true);
  });
});

describe("moveQuestionImages never deletes the only good copy, and takes every image players are not shown out of images/", () => {
  const rowPath = async (id: string) => (await one(root<{ storage_path: string }[]>`SELECT storage_path FROM uploads WHERE id = ${id}`)).storage_path;
  const questionOf = async (uploadId: string) => {
    const { questionId } = await program();
    await root`UPDATE questions SET image_upload_id = ${uploadId} WHERE id = ${questionId}`;
  };

  it("replaces a truncated copy in question-images/ (the row still says images/) with a verified one from the old file, then removes the old file", async () => {
    const image = await upload(800, 600);
    await questionOf(image.id);
    await mkdir(join(dataDir, "question-images"), { recursive: true });
    await writeFile(join(dataDir, `question-images/${image.id}.webp`), image.bytes.subarray(0, 40));
    const report = await moveQuestionImages(rt.sql, dataDir);
    expect(report.moved).toBeGreaterThanOrEqual(1);
    expect(report.damaged).not.toContain(image.id);
    expect((await readFile(join(dataDir, `question-images/${image.id}.webp`))).equals(image.bytes)).toBe(true);
    expect(await rowPath(image.id)).toBe(`question-images/${image.id}.webp`);
    expect(await exists(`images/${image.id}.webp`)).toBe(false);
    // No temporary file is left behind.
    expect((await readdir(join(dataDir, "question-images"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("trusts nothing when the old file is corrupt too: reports it as damaged and changes and deletes nothing", async () => {
    const image = await upload(800, 600);
    await questionOf(image.id);
    const broken = Buffer.from(image.bytes);
    broken[broken.length - 1] = (broken[broken.length - 1] ?? 0) ^ 0xff;
    await writeFile(join(dataDir, `images/${image.id}.webp`), broken);
    const report = await moveQuestionImages(rt.sql, dataDir);
    expect(report.damaged).toContain(image.id);
    expect(await rowPath(image.id)).toBe(`images/${image.id}.webp`);
    expect((await readFile(join(dataDir, `images/${image.id}.webp`))).equals(broken)).toBe(true);
    expect(await exists(`question-images/${image.id}.webp`)).toBe(false);
    expect(await exists(`question-images/.${image.id}.tmp`)).toBe(false);
  });

  it("reports damaged, and changes nothing, when the copy in place is truncated and the old file is gone", async () => {
    const image = await upload(800, 600);
    await questionOf(image.id);
    await mkdir(join(dataDir, "question-images"), { recursive: true });
    const truncated = image.bytes.subarray(0, 40);
    await writeFile(join(dataDir, `question-images/${image.id}.webp`), truncated);
    await rm(join(dataDir, `images/${image.id}.webp`));
    const report = await moveQuestionImages(rt.sql, dataDir);
    expect(report.damaged).toContain(image.id);
    expect((await readFile(join(dataDir, `question-images/${image.id}.webp`))).equals(truncated)).toBe(true);
    expect(await rowPath(image.id)).toBe(`images/${image.id}.webp`);
  });

  it("removes nothing unless exactly one row was rewritten: the good copy is in place, the old file stays", async () => {
    const image = await upload(800, 600);
    await questionOf(image.id);
    // A connection that finds no row to update (the row changed under it).
    const noUpdate = new Proxy(rt.sql, {
      apply: (target, thisArg, args: unknown[]) => {
        const first = args[0];
        if (Array.isArray(first) && "raw" in first && (first as string[]).join(" ").includes("UPDATE public.uploads")) return Promise.resolve([]);
        return Reflect.apply(target, thisArg, args) as unknown;
      },
    });
    await expect(moveQuestionImages(noUpdate, dataDir)).rejects.toThrow(/was not updated/);
    expect(await exists(`images/${image.id}.webp`)).toBe(true);
    expect((await readFile(join(dataDir, `question-images/${image.id}.webp`))).equals(image.bytes)).toBe(true);
    expect(await rowPath(image.id)).toBe(`images/${image.id}.webp`);
    // The next normal run finishes it.
    await moveQuestionImages(rt.sql, dataDir);
    expect(await rowPath(image.id)).toBe(`question-images/${image.id}.webp`);
    expect(await exists(`images/${image.id}.webp`)).toBe(false);
  });

  it("finishes after a crash that left a temporary copy", async () => {
    const image = await upload(800, 600);
    await questionOf(image.id);
    await mkdir(join(dataDir, "question-images"), { recursive: true });
    await writeFile(join(dataDir, `question-images/.${image.id}.tmp`), "half a copy");
    await moveQuestionImages(rt.sql, dataDir);
    expect(await rowPath(image.id)).toBe(`question-images/${image.id}.webp`);
    expect(await exists(`question-images/.${image.id}.tmp`)).toBe(false);
  });

  it("moves an orphan too (an image under images/ that no set and no prize tier shows and no question uses), its display copy with it, and leaves a shown image alone without reporting it", async () => {
    const orphan = await upload(800, 600);
    await writeFile(join(dataDir, `images/${orphan.id}.display.webp`), "old display copy");
    const { setId } = await program();
    const shown = await upload(800, 600);
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${shown.id} WHERE id = ${setId}`;
    await backfillDisplayCopies(rt.sql, dataDir);
    const report = await moveQuestionImages(rt.sql, dataDir);
    expect(report.moved).toBeGreaterThanOrEqual(1);
    expect(await rowPath(orphan.id)).toBe(`question-images/${orphan.id}.webp`);
    expect((await readFile(join(dataDir, `question-images/${orphan.id}.webp`))).equals(orphan.bytes)).toBe(true);
    expect(await exists(`images/${orphan.id}.webp`)).toBe(false);
    expect(await exists(`images/${orphan.id}.display.webp`)).toBe(false);
    expect(await rowPath(shown.id)).toBe(`images/${shown.id}.webp`);
    expect(await exists(`images/${shown.id}.webp`)).toBe(true);
    expect(await exists(`images/${shown.id}.display.webp`)).toBe(true);
    expect(report.shared).not.toContain(shown.id);
    expect(report.strays).not.toContain(`${shown.id}.webp`);
    expect(report.strays).not.toContain(`${shown.id}.display.webp`);
  });

  it("reports files under images/ that no uploads row names (a temporary file, a stray copy), and never deletes them", async () => {
    const strayId = randomUUID();
    const names = [`${strayId}.webp`, `${strayId}.display.webp`, `.${strayId}.display.tmp`, "notes.txt"];
    for (const name of names) await writeFile(join(dataDir, "images", name), "x");
    const report = await moveQuestionImages(rt.sql, dataDir);
    for (const name of names) {
      expect(report.strays).toContain(name);
      expect(await exists(`images/${name}`)).toBe(true);
    }
    // A dry run reports them too, and still deletes nothing.
    expect((await moveQuestionImages(rt.sql, dataDir, { dryRun: true })).strays).toContain(`${strayId}.webp`);
    for (const name of names) await rm(join(dataDir, "images", name));
  });

  it("a dry run reports a damaged file and changes nothing", async () => {
    const image = await upload(800, 600);
    await questionOf(image.id);
    await writeFile(join(dataDir, `images/${image.id}.webp`), "not the image");
    const report = await moveQuestionImages(rt.sql, dataDir, { dryRun: true });
    expect(report.damaged).toContain(image.id);
    expect(await exists(`question-images/${image.id}.webp`)).toBe(false);
    expect(await rowPath(image.id)).toBe(`images/${image.id}.webp`);
  });
});

const rowPathOf = async (id: string) => (await one(root<{ storage_path: string }[]>`SELECT storage_path FROM uploads WHERE id = ${id}`)).storage_path;

describe("the CLI (a real process, as the operator runs it)", () => {
  const run = (args: readonly string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: { PATH: process.env["PATH"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "", NODE_ENV: "test", DATABASE_URL_ADMIN: TEST_CONFIG.databaseUrl, ADMIN_DATA_DIR: dataDir, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ code, stdout, stderr });
      });
    });

  it("backfills and moves, prints ids and counts only; exits 0, or 2 when it reported an upload it could not handle (earlier tests leave some in this database)", async () => {
    const { setId, questionId } = await program();
    const thumbnail = await upload(1200, 800);
    const question = await upload(800, 600);
    await root`UPDATE trivia_sets SET thumbnail_upload_id = ${thumbnail.id} WHERE id = ${setId}`;
    await root`UPDATE questions SET image_upload_id = ${question.id} WHERE id = ${questionId}`;
    const backfill = await run(["backfill-display"]);
    expect(backfill.stderr).toBe("");
    expect([0, 2]).toContain(backfill.code);
    expect(backfill.stdout).toContain(`made the display copy of ${thumbnail.id}`);
    expect(backfill.stdout).toMatch(/display copies: \d+ made, \d+ already there, \d+ without a file, \d+ refused/);
    expect(await dims(`images/${thumbnail.id}.display.webp`)).toEqual({ width: 480, height: 320 });
    const move = await run(["move-question-images"]);
    expect(move.stderr).toBe("");
    expect([0, 2]).toContain(move.code);
    expect(move.stdout).toContain(`moved ${question.id} to question-images/`);
    expect(await rowPathOf(question.id)).toBe(`question-images/${question.id}.webp`);
    expect(backfill.stdout + move.stdout).not.toContain(dataDir);
    expect(backfill.stdout + move.stdout).not.toContain(TEST_CONFIG.databaseUrl);
  });

  it("refuses a bad command, a missing data directory and a login that is not admin_rw's, as exit 1 with a short message", async () => {
    expect((await run([])).code).toBe(1);
    expect((await run(["unknown"])).code).toBe(1);
    expect((await run(["move-question-images", "--force"])).code).toBe(1);
    const noDir = await run(["backfill-display"], { ADMIN_DATA_DIR: "relative/dir" });
    expect(noDir.code).toBe(1);
    expect(noDir.stderr).toContain("ADMIN_DATA_DIR must be an absolute path");
    const superuser = await run(["backfill-display"], { DATABASE_URL_ADMIN: superuserUrl() });
    expect(superuser.code).toBe(1);
    expect(superuser.stderr).toContain("admin_rw only");
  });
});

/** The migrated database as its superuser (not a login of group admin_rw only): the CLI must refuse it. */
function superuserUrl(): string {
  const url = new URL(TEST_CONFIG.databaseUrl);
  const server = new URL(process.env["TEST_PG_URL"] ?? "postgres://postgres:devonly@127.0.0.1:55432/postgres"); // DEV ONLY default
  url.username = server.username;
  url.password = server.password;
  return url.toString();
}
