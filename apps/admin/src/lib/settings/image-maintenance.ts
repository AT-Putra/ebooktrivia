// One-off, re-runnable maintenance of the content images on disk (run by src/cli/images.ts on the VM; runbook
// docs/runbooks/staging-provision.md "Content images"). Two jobs, both safe to run again and again:
//
//   backfillDisplayCopies  every set thumbnail and prize image gets its DISPLAY COPY images/<id>.display.webp (what the play pages
//                          load; storeImage makes one for every new upload), made from the stored original with the same box
//                          (thumbnail 480 x 600, prize 256 x 256) and written atomically (a temporary file, then a rename). An
//                          existing copy is left alone unless `force`.
//   moveQuestionImages     every image upload that players are NOT shown lives in question-images/, which the public app does not mount
//                          (storeImage puts every new question image there): a question's image, and any other image under images/
//                          that no set thumbnail and no prize tier shows (a replaced thumbnail, an orphan). It is copied to a
//                          temporary file, flushed, checked against the sha256 of its uploads row and renamed into place; the row is
//                          rewritten (exactly one row or an error); only then is the old file (and any display copy) removed, so the
//                          only good copy is never deleted and an interrupted run leaves a state the next run finishes. A file that
//                          does not match its row's digest is reported (`damaged`) and left alone. An upload a question uses AND a set
//                          or a prize tier shows stays where it is and is reported: it is the Owner's decision which use to give up.
//                          A missing file leaves its row alone and is reported. Files under images/ that no uploads row names are
//                          reported, never deleted.
//
// Nothing here reads outside the data directory: every path is built from an upload id (@ebooktrivia/core content-images.ts).
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONTENT_IMAGE_DIR, contentImagePath, DISPLAY_BOXES, displayImagePath, QUESTION_IMAGE_DIR } from "@ebooktrivia/core";
import { displayCopy, UploadRejected } from "@ebooktrivia/uploads";
import type { Sql } from "../db.ts";

export interface MaintenanceOptions {
  /** Report what would be done, change nothing. */
  readonly dryRun?: boolean;
  /** One line per upload (ids only). */
  readonly log?: (line: string) => void;
}

const regularFile = async (path: string): Promise<boolean> => {
  try {
    const info = await lstat(path);
    return info.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

export interface BackfillReport {
  /** Display copies written (or that would be). */
  readonly made: number;
  /** Already had one. */
  readonly kept: number;
  /** Upload ids whose original is not on the disk. */
  readonly missing: readonly string[];
  /** Upload ids that are not a stored image of the upload policy (another kind, type or path) or could not be resized. */
  readonly refused: readonly string[];
}

export async function backfillDisplayCopies(sql: Sql, dataDir: string, options: MaintenanceOptions & { readonly force?: boolean } = {}): Promise<BackfillReport> {
  const log = options.log ?? (() => undefined);
  // Every upload a set shows as its thumbnail or a prize tier shows (a thumbnail box wins when both).
  const rows = await sql<{ id: string; kind: string; content_type: string; storage_path: string; thumbnail: boolean }[]>`
    SELECT u.id, u.kind, u.content_type, u.storage_path, bool_or(shown.purpose = 'thumbnail') AS thumbnail
      FROM (SELECT thumbnail_upload_id AS id, 'thumbnail' AS purpose FROM public.trivia_sets WHERE thumbnail_upload_id IS NOT NULL
            UNION ALL
            SELECT image_upload_id, 'prize' FROM public.prize_tiers WHERE image_upload_id IS NOT NULL) shown
      JOIN public.uploads u ON u.id = shown.id
     GROUP BY u.id, u.kind, u.content_type, u.storage_path
     ORDER BY u.id`;
  let made = 0;
  let kept = 0;
  const missing: string[] = [];
  const refused: string[] = [];
  for (const row of rows) {
    if (row.kind !== "image" || row.content_type !== "image/webp" || row.storage_path !== contentImagePath("thumbnail", row.id)) {
      refused.push(row.id);
      log(`refused ${row.id}: not a stored image of the upload policy`);
      continue;
    }
    const target = join(dataDir, displayImagePath(row.id));
    if (!options.force && (await regularFile(target))) {
      kept++;
      continue;
    }
    const original = join(dataDir, row.storage_path);
    if (!(await regularFile(original))) {
      missing.push(row.id);
      log(`missing ${row.id}: no file`);
      continue;
    }
    if (options.dryRun !== true) {
      let copy: Buffer;
      try {
        copy = await displayCopy(await readFile(original), DISPLAY_BOXES[row.thumbnail ? "thumbnail" : "prize"]);
      } catch (error) {
        if (!(error instanceof UploadRejected)) throw error;
        refused.push(row.id);
        log(`refused ${row.id}: cannot be resized`);
        continue;
      }
      // Written beside the target and renamed over it: a reader never sees half a file, a crash leaves only a temporary one.
      const temporary = join(dataDir, CONTENT_IMAGE_DIR, `.${row.id}.display.tmp`);
      try {
        await writeFile(temporary, copy, { flag: "w", mode: 0o640 });
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    }
    made++;
    log(`${options.dryRun === true ? "would make" : "made"} the display copy of ${row.id}`);
  }
  return { made, kept, missing, refused };
}

export interface MoveReport {
  /** Moved to question-images/ (or would be). */
  readonly moved: number;
  /** Already in question-images/ with a verified file and a row that says so. */
  readonly settled: number;
  /** Upload ids a question uses and a set or a prize tier ALSO shows: left where they are. */
  readonly shared: readonly string[];
  /** Upload ids with no file at either place: their rows are not touched. */
  readonly missing: readonly string[];
  /** Upload ids whose bytes do not match the digest in their row (a truncated or corrupt file) and that have no good copy to move: nothing is deleted or changed. */
  readonly damaged: readonly string[];
  /** Upload ids a question uses that are not a stored image of the upload policy (another kind, type or path). */
  readonly refused: readonly string[];
  /** Files under images/ that no uploads row names (an interrupted backfill's temporary file, a stranger): reported, never deleted. */
  readonly strays: readonly string[];
}

const sha256Of = async (path: string): Promise<string | null> => {
  if (!(await regularFile(path))) return null;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

/** Flushes a directory's entries to disk after a rename (not possible on Windows, where it is skipped). */
async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not supported here: the rename itself is still atomic.
  }
}

/** Copies `source` to `temporary`, flushes it to disk and says whether its sha256 is `expected` (the temporary file is removed when it is not). */
async function copyVerified(source: string, temporary: string, expected: string): Promise<boolean> {
  await rm(temporary, { force: true });
  await copyFile(source, temporary, constants.COPYFILE_EXCL);
  const handle = await open(temporary, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  if ((await sha256Of(temporary)) === expected) return true;
  await rm(temporary, { force: true });
  return false;
}

/** Files under images/ that no uploads row names (report only). */
async function strayFiles(sql: Sql, dataDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(dataDir, CONTENT_IMAGE_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const idOf = (name: string): string | undefined => /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.display)?\.webp$/.exec(name)?.[1];
  const ids = [...new Set(names.map(idOf).filter((id): id is string => id !== undefined))];
  const known = new Set(ids.length === 0 ? [] : (await sql<{ id: string }[]>`SELECT id FROM public.uploads WHERE id IN ${sql(ids)}`).map((row) => row.id));
  return names.filter((name) => {
    const id = idOf(name);
    return id === undefined || !known.has(id);
  });
}

/**
 * Takes every image the public app could read but players are not shown out of images/ into question-images/: a question's image, and
 * any other image upload no set thumbnail and no prize tier shows (a replaced thumbnail, an orphan). The old file is removed only
 * after a copy whose sha256 equals the row's is in place AND the row is rewritten (exactly one row): the only good copy is never
 * deleted. A file whose bytes do not match the row is reported (`damaged`) and left as it is.
 */
export async function moveQuestionImages(sql: Sql, dataDir: string, options: MaintenanceOptions = {}): Promise<MoveReport> {
  const log = options.log ?? (() => undefined);
  const rows = await sql<{ id: string; kind: string; content_type: string; storage_path: string; sha256: string; shown: boolean; questioned: boolean }[]>`
    SELECT u.id, u.kind, u.content_type, u.storage_path, encode(u.sha256, 'hex') AS sha256,
           (EXISTS (SELECT 1 FROM public.trivia_sets s WHERE s.thumbnail_upload_id = u.id)
            OR EXISTS (SELECT 1 FROM public.prize_tiers t WHERE t.image_upload_id = u.id)) AS shown,
           EXISTS (SELECT 1 FROM public.questions q WHERE q.image_upload_id = u.id) AS questioned
      FROM public.uploads u
     WHERE (u.kind = 'image' AND u.storage_path = 'images/' || u.id || '.webp')
        OR EXISTS (SELECT 1 FROM public.questions q WHERE q.image_upload_id = u.id)
     ORDER BY u.id`;
  let moved = 0;
  let settled = 0;
  const shared: string[] = [];
  const missing: string[] = [];
  const damaged: string[] = [];
  const refused: string[] = [];
  for (const row of rows) {
    if (row.shown && !row.questioned) continue; // a set's or a prize's image: players are shown it, it stays in images/
    if (row.shown) {
      shared.push(row.id);
      log(`shared ${row.id}: a question uses it and a set or a prize shows it, left where it is`);
      continue;
    }
    const before = contentImagePath("thumbnail", row.id); // images/<id>.webp
    const after = contentImagePath("question", row.id); // question-images/<id>.webp
    if (row.kind !== "image" || row.content_type !== "image/webp" || (row.storage_path !== before && row.storage_path !== after)) {
      refused.push(row.id);
      log(`refused ${row.id}: not a stored image of the upload policy`);
      continue;
    }
    const source = join(dataDir, before);
    const target = join(dataDir, after);
    const leftovers = [source, join(dataDir, displayImagePath(row.id))];
    const targetSha = await sha256Of(target);
    const targetGood = targetSha === row.sha256;
    const stale = (await Promise.all(leftovers.map(regularFile))).some(Boolean);
    if (row.storage_path === after && targetGood && !stale) {
      settled++;
      continue;
    }
    if (!targetGood) {
      // No trustworthy copy in place (none, or one that does not match the row): it has to come from the old file, which must match too.
      if (!(await regularFile(source))) {
        (targetSha === null ? missing : damaged).push(row.id);
        log(targetSha === null ? `missing ${row.id}: no file at either place` : `damaged ${row.id}: the file does not match its digest and there is no other copy`);
        continue;
      }
      if (options.dryRun === true) {
        const good = (await sha256Of(source)) === row.sha256;
        if (good) moved++;
        else damaged.push(row.id);
        log(`${good ? "would move" : "damaged"} ${row.id}`);
        continue;
      }
      await mkdir(join(dataDir, QUESTION_IMAGE_DIR), { recursive: true });
      const temporary = join(dataDir, QUESTION_IMAGE_DIR, `.${row.id}.tmp`);
      if (!(await copyVerified(source, temporary, row.sha256))) {
        damaged.push(row.id);
        log(`damaged ${row.id}: the file does not match its digest, nothing changed`);
        continue;
      }
      await rename(temporary, target);
      await syncDirectory(join(dataDir, QUESTION_IMAGE_DIR));
    }
    if (options.dryRun !== true) {
      // The row is rewritten only against the path it was read with, and must be found: only then may an old file go.
      const updated = await sql<{ id: string }[]>`
        UPDATE public.uploads SET storage_path = ${after} WHERE id = ${row.id} AND storage_path IN (${before}, ${after}) RETURNING id`;
      if (updated.length !== 1) throw new Error(`the uploads row of ${row.id} was not updated (${String(updated.length)} rows): nothing was deleted`);
      await Promise.all(leftovers.map((path) => rm(path, { force: true })));
    }
    moved++;
    log(`${options.dryRun === true ? "would move" : "moved"} ${row.id} to ${QUESTION_IMAGE_DIR}/`);
  }
  return { moved, settled, shared, missing, damaged, refused, strays: await strayFiles(sql, dataDir) };
}
