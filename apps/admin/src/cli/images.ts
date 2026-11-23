// Content image maintenance, run on the VM by the operator after a release that changes where images live (the second CLI of the
// admin image; runbook docs/runbooks/staging-provision.md "Content images"). Both commands are re-runnable and print one line per
// upload (ids only, never a path or a name) and a summary.
//
//   node apps/admin/src/cli/images.ts backfill-display [--force] [--dry-run]
//       Makes the display copy (images/<id>.display.webp: thumbnails fit 480 x 600, prize images 256 x 256, program banners 1344 x 448) of
//       every set thumbnail, prize image and program banner that has none; --force makes them again.
//   node apps/admin/src/cli/images.ts move-question-images [--dry-run]
//       Moves every image players are not shown (question images, replaced thumbnails and banners, orphans) from images/ to question-images/ (not
//       mounted into the public app), each checked against the sha256 of its uploads row, and rewrites uploads.storage_path. Lists the
//       files under images/ that no uploads row names (never deleted).
//
// Environment (the admin app's /etc/ebooktrivia/admin.env): DATABASE_URL_ADMIN (the login must be in group admin_rw only) and
// ADMIN_DATA_DIR (/srv/data, writable). The container needs /srv/data mounted read-write and the admin's pinned address on the data
// network (pg_hba admits ebt_admin from there only), so the admin unit is stopped while it runs.
// Exit status: 0 done, 1 usage or configuration error, 2 done but something was reported (a missing, damaged, shared or refused upload,
// or a stray file): listed above the summary.
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { assertAdminLogin, createAdminDb } from "../lib/db.ts";
import { backfillDisplayCopies, moveQuestionImages } from "../lib/settings/image-maintenance.ts";

const USAGE = `usage:
  images.ts backfill-display [--force] [--dry-run]
  images.ts move-question-images [--dry-run]`;

class UsageError extends Error {}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { force: { type: "boolean" }, "dry-run": { type: "boolean" } }, strict: true });
  if (command !== "backfill-display" && command !== "move-question-images") throw new UsageError(USAGE);
  if (command === "move-question-images" && values.force === true) throw new UsageError(USAGE);
  const url = process.env["DATABASE_URL_ADMIN"];
  const dataDir = process.env["ADMIN_DATA_DIR"];
  if (url === undefined || url === "") throw new UsageError("DATABASE_URL_ADMIN is not set");
  if (dataDir === undefined || !isAbsolute(dataDir)) throw new UsageError("ADMIN_DATA_DIR must be an absolute path");
  const db = createAdminDb(url, 2);
  const options = { dryRun: values["dry-run"] === true, log: (line: string) => process.stdout.write(`${line}\n`) };
  try {
    await assertAdminLogin(db.sql);
    const dry = options.dryRun ? " (dry run: nothing changed)" : "";
    if (command === "backfill-display") {
      const report = await backfillDisplayCopies(db.sql, dataDir, { ...options, force: values.force === true });
      process.stdout.write(`display copies: ${String(report.made)} made, ${String(report.kept)} already there, ${String(report.missing.length)} without a file, ${String(report.refused.length)} refused${dry}\n`);
      return report.missing.length + report.refused.length === 0 ? 0 : 2;
    }
    const report = await moveQuestionImages(db.sql, dataDir, options);
    for (const name of report.strays) process.stdout.write(`stray ${name}\n`);
    process.stdout.write(
      `question images: ${String(report.moved)} moved, ${String(report.settled)} already in place, ${String(report.shared.length)} shared with a set, prize or banner (left), ${String(report.missing.length)} without a file, ${String(report.damaged.length)} damaged, ${String(report.refused.length)} refused, ${String(report.strays.length)} stray files under images/${dry}\n`,
    );
    return report.shared.length + report.missing.length + report.damaged.length + report.refused.length + report.strays.length === 0 ? 0 : 2;
  } finally {
    await db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Configuration and usage problems only: never print an error object (it may quote a path or a connection string).
    const message = error instanceof UsageError || (error instanceof Error && /Config|LoginRole/.test(error.name)) ? error.message : "failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  },
);
