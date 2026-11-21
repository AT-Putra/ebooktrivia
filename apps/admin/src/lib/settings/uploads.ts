// Chunked, resumable ebook PDF upload (AC-D7, plan M2.5 / §10 item 9; US-017). Landing-page ZIPs
// (US-023, kind lp_zip) go up through the same sessions, chunks, quota and sweeper; their completion
// is lib/settings/lp-hosting.ts (completeLpZipUpload), which claims the session here.
//
// Why chunks: Caddy's read_body timeout (30 s) is global (Caddy 2.11.9 has no per-route body
// timeout), so no single request may carry a large body. The browser sends 1 MiB chunks (8.4 s
// at 1 Mbit/s), each with its SHA-256; the server checks the hash and writes the chunk at its
// offset into a staging file. A chunk can be re-sent (idempotent), and `init` with the same
// product, size and hash resumes an open session.
//
// Completion (security review US-017 M1/M2, code review M1):
//   1. claim  UPDATE ... SET completing_at WHERE completing_at IS NULL: exactly one `complete` wins.
//             A chunk write holds the session row (FOR NO KEY UPDATE) while it writes and refuses a
//             claimed session, so the claim waits for writes in flight and none starts after it;
//   2. copy   the staging file is STREAMED once: hashed, copied into the final file (opened "wx", a
//             new inode no earlier fd can reach) and its first PDF_HEAD_BYTES kept. Nothing large is
//             held in memory, and what was checked is exactly what is stored;
//   3. check  the size, the whole-file SHA-256 declared at init, and the PDF policy on the head
//             (@ebooktrivia/uploads/pdf, the same rules as checkUpload);
//   4. link   one audited transaction: uploads row, the product's PDF, the session completed and
//             the replaced PDF marked superseded. Only then is the staging file removed.
// One completion runs at a time per process (they are disk-bound).
//
// Size rules: over 20 MiB the uploader must confirm the warning before `init` accepts the upload;
// over the hard cap (ADMIN_PDF_MAX_BYTES) it is refused. Quota (security review US-017 M1, F2), under
// one advisory lock: at most ADMIN_UPLOAD_MAX_OPEN_SESSIONS unfinished uploads per admin, and at most
// ADMIN_UPLOAD_MAX_STAGED_BYTES for the whole server, counting the declared bytes of every unfinished
// upload plus replaced PDFs not purged yet (both are on disk).
//
// Housekeeping (sweepUploads): the admin app is the only process that may write /srv/data (the
// worker mounts deliverables read-only, US-014 S7), so it also sweeps: on every `init` (all
// admins) and every 15 minutes (src/instrumentation.ts). It removes expired sessions and their
// staging files, staging files without a session, PDFs replaced more than an hour ago (in-flight
// deliveries keep reading them for a while) and deliverables without an uploads row. One sweep at a
// time across instances (pg_try_advisory_xact_lock; a held lock skips the run). It never removes an
// entry that is not a regular file with one of our own names, a failed removal is logged and the
// sweep goes on, and `init` never fails because of the sweep (security review US-017 F1/F3).
//
// The stored file is never served by the admin app (no route reads it); buyers get it from the
// api origin's /files with nosniff, Content-Disposition and CSP sandbox (M6 / M8). The original
// file name must pass the same rule as an e-mail attachment name (core isSafeFileName).
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isSafeFileName, isUuid } from "@ebooktrivia/core";
import { checkPdf, DEFAULT_UPLOAD_LIMITS, PDF_HEAD_BYTES, UploadRejected } from "@ebooktrivia/uploads/pdf";
import { runMutation, withAudit } from "../audit.ts";
import type { Sql } from "../db.ts";
import { logEvent } from "../log.ts";
import { PDF_WARN_BYTES, type SettingsConfig } from "./env.ts";
import { InvalidInput, singleLine } from "./fields.ts";
import { PROOF_DIR, PROOF_FILE } from "./proof-files.ts";

export const CHUNK_BYTES = 1024 * 1024;
export type UploadSessionKind = "pdf" | "lp_zip";
const SESSION_TTL_HOURS = 24;
/** A claim older than this belongs to a crashed completion: the sweeper may remove the session. */
const STALE_COMPLETION_MINUTES = 60;
/** Files younger than this may belong to a request still running: the sweeper leaves them. */
const ORPHAN_MIN_AGE_MS = 10 * 60_000;
/** A replaced PDF stays this long (signed links already handed out keep working). */
const SUPERSEDED_GRACE_MINUTES = 60;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PART_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.part$/;
const PDF_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf$/;

export type InitResult =
  | { readonly kind: "ready"; readonly sessionId: string; readonly chunkBytes: number; readonly chunkCount: number; readonly received: readonly number[] }
  | { readonly kind: "needs_confirmation"; readonly warnBytes: number }
  | { readonly kind: "too_large"; readonly maxBytes: number };

export interface InitRequest {
  readonly productId: string;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
  readonly confirmLarge: boolean;
}

/** Test seams (integration tests only): run code while a chunk write holds its lock, or after a claim. */
export interface UploadTestHooks {
  readonly whileWritingChunk?: () => Promise<void>;
  readonly afterClaim?: () => Promise<void>;
}

const chunkCount = (size: number, chunk: number): number => Math.ceil(size / chunk);

function dataDir(settings: SettingsConfig): string {
  if (settings.dataDir === null) throw new InvalidInput("Uploads are not configured on the server (ADMIN_DATA_DIR).");
  return settings.dataDir;
}

const stagingDir = (dir: string): string => join(dir, "upload-staging");
const stagingPath = (dir: string, sessionId: string): string => {
  if (!isUuid(sessionId)) throw new InvalidInput("Unknown upload.");
  return join(stagingDir(dir), `${sessionId}.part`);
};

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Checks the request shape (no I/O). */
export function parseInit(body: unknown): InitRequest {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const productId = typeof b["productId"] === "string" ? b["productId"].toLowerCase() : "";
  if (!isUuid(productId)) throw new InvalidInput("Unknown product.");
  const filename = singleLine(typeof b["filename"] === "string" ? b["filename"] : "", "The file name is up to 128 characters.", { max: 128 });
  if (!isSafeFileName(filename)) throw new InvalidInput('The file name may not contain / \\ : * ? " < > | or quotes, nor start with a dot. Rename the file and try again.');
  if (!filename.toLowerCase().endsWith(".pdf")) throw new InvalidInput("Choose a .pdf file.");
  const size = b["size"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) throw new InvalidInput("The file is empty.");
  const sha256 = typeof b["sha256"] === "string" ? b["sha256"].toLowerCase() : "";
  if (!SHA256_HEX.test(sha256)) throw new InvalidInput("The file hash is missing.");
  return { productId, filename, size, sha256, confirmLarge: b["confirmLarge"] === true };
}

/** Starts (or resumes) an upload for `adminUserId`. */
export async function initPdfUpload(sql: Sql, settings: SettingsConfig, adminUserId: string, req: InitRequest): Promise<InitResult> {
  if (req.size > settings.pdfMaxBytes) return { kind: "too_large", maxBytes: settings.pdfMaxBytes };
  if (req.size > PDF_WARN_BYTES && !req.confirmLarge) return { kind: "needs_confirmation", warnBytes: PDF_WARN_BYTES };
  return openSession(sql, settings, adminUserId, { kind: "pdf", target: req.productId, filename: req.filename, size: req.size, sha256: req.sha256, largeConfirmed: req.size > PDF_WARN_BYTES && req.confirmLarge });
}

interface OpenRequest {
  readonly kind: UploadSessionKind;
  /** The product (pdf) or landing page (lp_zip). */
  readonly target: string;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
  readonly largeConfirmed: boolean;
}

/** Resumes an open session of the same target, size and hash, or opens a new one within the quota. */
export async function openSession(sql: Sql, settings: SettingsConfig, adminUserId: string, req: OpenRequest): Promise<InitResult> {
  const dir = dataDir(settings);
  await sweepUploads(sql, settings).catch((error: unknown) => {
    logEvent("warn", "admin.upload_sweep_failed", {}, error);
  });
  const productId = req.kind === "pdf" ? req.target : null;
  const landingPageId = req.kind === "lp_zip" ? req.target : null;
  const [resumable] = await sql<{ id: string; chunk_bytes: number; received_chunks: number[] }[]>`
    SELECT id, chunk_bytes, received_chunks FROM public.upload_sessions
     WHERE kind = ${req.kind} AND product_id IS NOT DISTINCT FROM ${productId}::uuid AND landing_page_id IS NOT DISTINCT FROM ${landingPageId}::uuid
       AND created_by_admin_user_id = ${adminUserId} AND size_bytes = ${req.size}
       AND sha256 = ${Buffer.from(req.sha256, "hex")} AND completed_at IS NULL AND completing_at IS NULL
       AND expires_at > clock_timestamp()
     ORDER BY created_at DESC LIMIT 1`;
  if (resumable !== undefined) {
    return { kind: "ready", sessionId: resumable.id, chunkBytes: resumable.chunk_bytes, chunkCount: chunkCount(req.size, resumable.chunk_bytes), received: resumable.received_chunks };
  }
  const id = randomUUID();
  const staging = stagingPath(dir, id);
  await mkdir(stagingDir(dir), { recursive: true });
  try {
    await withAudit(sql, async (tx, audit) => {
      // Serialises every init, so neither quota can be raced.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('upload_quota', 0))`;
      const [usage] = await tx<{ mine: number; staged: number; superseded: number }[]>`
        SELECT (SELECT count(*)::int FROM public.upload_sessions
                 WHERE created_by_admin_user_id = ${adminUserId} AND completed_at IS NULL AND expires_at > clock_timestamp()) AS mine,
               (SELECT coalesce(sum(size_bytes), 0)::float8 FROM public.upload_sessions
                 WHERE completed_at IS NULL AND expires_at > clock_timestamp()) AS staged,
               (SELECT coalesce(sum(size_bytes), 0)::float8 FROM public.uploads WHERE superseded_at IS NOT NULL) AS superseded`;
      if ((usage?.mine ?? 0) >= settings.uploadMaxOpenSessions) {
        throw new InvalidInput(`You already have ${String(settings.uploadMaxOpenSessions)} unfinished uploads. Finish one, or wait until they expire (24 hours).`);
      }
      if ((usage?.staged ?? 0) + (usage?.superseded ?? 0) + req.size > settings.uploadMaxStagedBytes) {
        throw new InvalidInput("The server's upload space is full: wait for unfinished uploads to finish or expire (24 hours), and replaced PDFs to be removed (about an hour).");
      }
      const [target] = req.kind === "pdf" ? await tx`SELECT 1 FROM public.products WHERE id = ${req.target}` : await tx`SELECT 1 FROM public.landing_pages WHERE id = ${req.target}`;
      if (target === undefined) throw new InvalidInput(req.kind === "pdf" ? "This product no longer exists." : "This landing page no longer exists.");
      await tx`
        INSERT INTO public.upload_sessions (id, kind, product_id, landing_page_id, filename, size_bytes, sha256, chunk_bytes, large_confirmed, created_by_admin_user_id, expires_at)
        VALUES (${id}, ${req.kind}, ${productId}, ${landingPageId}, ${req.filename}, ${req.size}, ${Buffer.from(req.sha256, "hex")}, ${CHUNK_BYTES},
                ${req.largeConfirmed}, ${adminUserId}, clock_timestamp() + make_interval(hours => ${SESSION_TTL_HOURS}))`;
      const file = await open(staging, "wx", 0o600);
      try {
        await file.truncate(req.size);
      } finally {
        await file.close();
      }
      audit({
        action: "upload.start",
        entityType: "upload_session",
        entityId: id,
        facts:
          req.kind === "pdf"
            ? { kind: "pdf", product_id: req.target, size_bytes: req.size, large: req.size > PDF_WARN_BYTES, large_confirmed: req.largeConfirmed }
            : { kind: "lp_zip", landing_page_id: req.target, size_bytes: req.size },
      });
    });
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
  return { kind: "ready", sessionId: id, chunkBytes: CHUNK_BYTES, chunkCount: chunkCount(req.size, CHUNK_BYTES), received: [] };
}

/** A claimed lp_zip session (completeLpZipUpload in lp-hosting.ts). */
export interface ClaimedLpZip {
  readonly landingPageId: string;
  readonly filename: string;
  readonly size: number;
  readonly sha256: Buffer;
  readonly staging: string;
  /** Gives the session back (e.g. a publish failed for a reason the uploader can retry). */
  release(): Promise<void>;
  /** Deletes the session and its staging file (a refused or corrupt ZIP). */
  discard(): Promise<void>;
  /** Marks the session completed with the uploads row it became, and removes the staging file. */
  finish(uploadId: string): Promise<void>;
}

/** Claims a fully received lp_zip session of `adminUserId` (one claim wins; chunk writes stop). */
export async function claimLpZipSession(sql: Sql, settings: SettingsConfig, adminUserId: string, sessionId: string): Promise<ClaimedLpZip> {
  const staging = stagingPath(dataDir(settings), sessionId);
  const [session] = await sql<{ id: string; landing_page_id: string; filename: string; size_bytes: number; sha256: Uint8Array; chunk_bytes: number; received_chunks: number[] }[]>`
    UPDATE public.upload_sessions SET completing_at = clock_timestamp()
     WHERE id = ${sessionId} AND kind = 'lp_zip' AND created_by_admin_user_id = ${adminUserId} AND completed_at IS NULL
       AND completing_at IS NULL AND expires_at > clock_timestamp()
    RETURNING id, landing_page_id, filename, size_bytes::float8 AS size_bytes, sha256, chunk_bytes, received_chunks`;
  if (session === undefined) throw new InvalidInput(REFUSED);
  const release = async (): Promise<void> => {
    await sql`UPDATE public.upload_sessions SET completing_at = NULL WHERE id = ${session.id} AND completed_at IS NULL`;
  };
  if (session.received_chunks.length !== chunkCount(session.size_bytes, session.chunk_bytes)) {
    await release();
    throw new InvalidInput("Some chunks are missing: resume the upload.");
  }
  return {
    landingPageId: session.landing_page_id,
    filename: session.filename,
    size: session.size_bytes,
    sha256: Buffer.from(session.sha256),
    staging,
    release,
    discard: async () => {
      await sql`DELETE FROM public.upload_sessions WHERE id = ${session.id} AND completed_at IS NULL`;
      await rm(staging, { force: true });
    },
    finish: async (uploadId) => {
      await sql`UPDATE public.upload_sessions SET completed_at = clock_timestamp(), upload_id = ${uploadId} WHERE id = ${session.id}`;
      await rm(staging, { force: true });
    },
  };
}

interface SessionRow {
  readonly id: string;
  readonly product_id: string;
  readonly filename: string;
  readonly size_bytes: number;
  readonly sha256: Uint8Array;
  readonly chunk_bytes: number;
  readonly received_chunks: number[];
  readonly large_confirmed: boolean;
}

const REFUSED = "This upload is finished, being completed or expired: start it again.";

/** Writes chunk `index` (its bytes and declared SHA-256) and returns how many chunks are in. */
export async function writeChunk(
  sql: Sql,
  settings: SettingsConfig,
  adminUserId: string,
  chunk: { readonly sessionId: string; readonly index: number; readonly sha256: string; readonly bytes: Uint8Array; readonly kind?: UploadSessionKind },
  hooks: UploadTestHooks = {},
): Promise<{ readonly received: number; readonly chunkCount: number }> {
  const dir = dataDir(settings);
  const staging = stagingPath(dir, chunk.sessionId);
  if (sha256Hex(chunk.bytes) !== chunk.sha256.toLowerCase()) throw new InvalidInput("Chunk is corrupt (hash mismatch): send it again.");
  return sql.begin(async (tx) => {
    // Held until commit: a `complete` claim waits for this write, and none starts after the claim.
    const [session] = await tx<{ size_bytes: number; chunk_bytes: number }[]>`
      SELECT size_bytes::float8 AS size_bytes, chunk_bytes FROM public.upload_sessions
       WHERE id = ${chunk.sessionId} AND kind = ${chunk.kind ?? "pdf"} AND created_by_admin_user_id = ${adminUserId} AND completed_at IS NULL
         AND completing_at IS NULL AND expires_at > clock_timestamp()
         FOR NO KEY UPDATE`;
    if (session === undefined) throw new InvalidInput(REFUSED);
    const count = chunkCount(session.size_bytes, session.chunk_bytes);
    if (!Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index >= count) throw new InvalidInput("Chunk out of range.");
    const expected = chunk.index === count - 1 ? session.size_bytes - chunk.index * session.chunk_bytes : session.chunk_bytes;
    if (chunk.bytes.length !== expected) throw new InvalidInput("Chunk has the wrong size.");
    await hooks.whileWritingChunk?.();
    const file = await open(staging, "r+");
    try {
      await file.write(chunk.bytes, 0, chunk.bytes.length, chunk.index * session.chunk_bytes);
    } finally {
      await file.close();
    }
    const [row] = await tx<{ n: number }[]>`
      UPDATE public.upload_sessions
         SET received_chunks = (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(received_chunks || ${chunk.index}::int) AS x)
       WHERE id = ${chunk.sessionId}
      RETURNING cardinality(received_chunks) AS n`;
    return { received: row?.n ?? 0, chunkCount: count };
  });
}

const REJECTIONS: Readonly<Partial<Record<UploadRejected["code"], string>>> = {
  too_large: "The PDF is larger than the limit.",
  unknown_type: "This file is not a PDF.",
  type_not_allowed: "This file is not a PDF.",
  svg_not_allowed: "This file is not a PDF.",
  extension_mismatch: "The file name must end in .pdf.",
  mime_mismatch: "This file is not a PDF.",
};

/** One completion at a time per process (disk-bound work). */
let completions: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = completions.then(fn, fn);
  completions = run.catch(() => undefined);
  return run;
}

/** Streams `from` into a new file `to` (exclusive create), returning its SHA-256, size and head. */
async function copyHashed(from: string, to: string): Promise<{ readonly sha256: string; readonly size: number; readonly head: Buffer }> {
  const hash = createHash("sha256");
  const out = await open(to, "wx", 0o640);
  const head: Buffer[] = [];
  let headBytes = 0;
  let size = 0;
  try {
    for await (const piece of createReadStream(from, { highWaterMark: 256 * 1024 })) {
      const bytes = piece as Buffer;
      hash.update(bytes);
      if (headBytes < PDF_HEAD_BYTES) {
        const take = bytes.subarray(0, PDF_HEAD_BYTES - headBytes);
        head.push(take);
        headBytes += take.length;
      }
      await out.write(bytes, 0, bytes.length, size);
      size += bytes.length;
    }
    await out.sync();
  } finally {
    await out.close();
  }
  return { sha256: hash.digest("hex"), size, head: Buffer.concat(head) };
}

/** Checks the assembled file and makes it the product's PDF. */
export function completeUpload(sql: Sql, settings: SettingsConfig, adminUserId: string, sessionId: string, hooks: UploadTestHooks = {}): Promise<{ readonly uploadId: string; readonly large: boolean }> {
  const dir = dataDir(settings);
  const staging = stagingPath(dir, sessionId);
  return oneAtATime(async () => {
    const [session] = await sql<SessionRow[]>`
      UPDATE public.upload_sessions SET completing_at = clock_timestamp()
       WHERE id = ${sessionId} AND kind = 'pdf' AND created_by_admin_user_id = ${adminUserId} AND completed_at IS NULL
         AND completing_at IS NULL AND expires_at > clock_timestamp()
      RETURNING id, product_id, filename, size_bytes::float8 AS size_bytes, sha256, chunk_bytes, received_chunks, large_confirmed`;
    if (session === undefined) throw new InvalidInput(REFUSED);
    const release = () => sql`UPDATE public.upload_sessions SET completing_at = NULL WHERE id = ${session.id} AND completed_at IS NULL`;
    const discard = async (final: string | null) => {
      await sql`DELETE FROM public.upload_sessions WHERE id = ${session.id} AND completed_at IS NULL`;
      await rm(staging, { force: true });
      if (final !== null) await rm(final, { force: true });
    };
    await hooks.afterClaim?.();
    if (session.received_chunks.length !== chunkCount(session.size_bytes, session.chunk_bytes)) {
      await release();
      throw new InvalidInput("Some chunks are missing: resume the upload.");
    }
    const uploadId = randomUUID();
    const storagePath = `deliverables/${uploadId}.pdf`;
    const final = join(dir, storagePath);
    await mkdir(join(dir, "deliverables"), { recursive: true });
    let copied;
    try {
      copied = await copyHashed(staging, final);
    } catch (error) {
      await rm(final, { force: true });
      await release();
      throw error;
    }
    if (copied.size !== session.size_bytes || copied.sha256 !== Buffer.from(session.sha256).toString("hex")) {
      await discard(final);
      throw new InvalidInput("The assembled file does not match its hash: start the upload again.");
    }
    let accepted;
    try {
      accepted = checkPdf({ head: copied.head, size: copied.size, filename: session.filename, mimeType: "application/pdf" }, { ...DEFAULT_UPLOAD_LIMITS, pdfWarnBytes: PDF_WARN_BYTES, pdfMaxBytes: settings.pdfMaxBytes });
    } catch (error) {
      if (!(error instanceof UploadRejected)) throw error;
      await discard(final);
      throw new InvalidInput(REJECTIONS[error.code] ?? "This file is not accepted.");
    }
    const large = accepted.warnings.includes("pdf_large");
    if (large && !session.large_confirmed) {
      await discard(final);
      throw new InvalidInput("Confirm the large-file warning before uploading this PDF.");
    }
    try {
      await withAudit(sql, async (tx, audit) => {
        const [current] = await tx`SELECT 1 FROM public.upload_sessions WHERE id = ${session.id} AND completed_at IS NULL FOR UPDATE`;
        if (current === undefined) throw new InvalidInput("This upload was already completed.");
        const [product] = await tx<{ pdf_upload_id: string | null }[]>`SELECT pdf_upload_id FROM public.products WHERE id = ${session.product_id} FOR UPDATE`;
        if (product === undefined) throw new InvalidInput("This product no longer exists.");
        await tx`
          INSERT INTO public.uploads (id, kind, storage_path, original_filename, content_type, size_bytes, sha256, created_by_admin_user_id)
          VALUES (${uploadId}, 'pdf', ${storagePath}, ${session.filename}, ${accepted.contentType}, ${session.size_bytes}, ${Buffer.from(session.sha256)}, ${adminUserId})`;
        await tx`UPDATE public.products SET pdf_upload_id = ${uploadId}, updated_at = clock_timestamp() WHERE id = ${session.product_id}`;
        if (product.pdf_upload_id !== null) await tx`UPDATE public.uploads SET superseded_at = clock_timestamp() WHERE id = ${product.pdf_upload_id}`;
        await tx`UPDATE public.upload_sessions SET completed_at = clock_timestamp(), upload_id = ${uploadId} WHERE id = ${session.id}`;
        audit({
          action: "product.pdf_set",
          entityType: "product",
          entityId: session.product_id,
          fields: { pdf_upload_id: "value" },
          before: { pdf_upload_id: product.pdf_upload_id },
          after: { pdf_upload_id: uploadId },
          facts: { size_bytes: session.size_bytes, sha256: copied.sha256, large, large_confirmed: session.large_confirmed, upload_session_id: session.id },
        });
      });
    } catch (error) {
      await rm(final, { force: true });
      await release();
      throw error;
    }
    await rm(staging, { force: true });
    return { uploadId, large };
  });
}

let sweeping: Promise<SweepResult> | null = null;

export interface SweepResult {
  /** Another instance held the sweep lock: nothing was done. */
  readonly skipped: boolean;
  readonly expiredSessions: number;
  readonly orphanStagingFiles: number;
  readonly supersededPdfs: number;
  readonly orphanPdfs: number;
  /** US-030: fulfilment proof files without an uploads row (a replace or an erasure whose file removal did not happen). */
  readonly orphanProofs: number;
  /** Entries left alone: not a regular file, a foreign name, or a failed removal (each logged). */
  readonly leftAlone: number;
}

const NOTHING: SweepResult = Object.freeze({ skipped: false, expiredSessions: 0, orphanStagingFiles: 0, supersededPdfs: 0, orphanPdfs: 0, orphanProofs: 0, leftAlone: 0 });

const listDir = async (path: string): Promise<string[]> => {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
};

type Removal = "removed" | "young" | "absent" | "left_alone";

/**
 * Removes `name` in `dir` only if the name is ours (`pattern`) and it is a regular file (lstat, so
 * a symlink or directory is never followed or removed) older than `minAgeMs`. Never throws: anything
 * unexpected is logged (reason only, no path) and left alone.
 */
async function removeOwnFile(dir: string, name: string, pattern: RegExp, minAgeMs: number): Promise<Removal> {
  if (!pattern.test(name)) {
    logEvent("warn", "admin.upload_sweep_left_alone", { reason: "foreign_name" });
    return "left_alone";
  }
  const path = join(dir, name);
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) {
      logEvent("warn", "admin.upload_sweep_left_alone", { reason: "not_a_file" });
      return "left_alone";
    }
    if (Date.now() - entry.mtimeMs < minAgeMs) return "young";
    await rm(path);
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    logEvent("warn", "admin.upload_sweep_left_alone", { reason: "remove_failed" }, error);
    return "left_alone";
  }
}

/**
 * Removes, for ALL admins: expired sessions (and sessions whose completion crashed more than
 * STALE_COMPLETION_MINUTES ago) with their staging files, staging files without a session, PDFs
 * replaced more than SUPERSEDED_GRACE_MINUTES ago (audited, as the system), and deliverables without
 * an uploads row. Concurrent calls in this process share one run; across instances the advisory lock
 * lets one run and the others skip.
 */
export function sweepUploads(sql: Sql, settings: SettingsConfig): Promise<SweepResult> {
  if (settings.dataDir === null) return Promise.resolve(NOTHING);
  const dir = settings.dataDir;
  sweeping ??= sql
    .begin(async (lock) => {
      const [held] = await lock<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended('upload_sweep', 0)) AS ok`;
      if (held?.ok !== true) return { ...NOTHING, skipped: true };
      return sweepOnce(sql, dir);
    })
    .finally(() => {
      sweeping = null;
    });
  return sweeping;
}

async function sweepOnce(sql: Sql, dir: string): Promise<SweepResult> {
  let leftAlone = 0;
  const count = (result: Removal): boolean => {
    if (result === "left_alone") leftAlone++;
    return result === "removed";
  };

  // A session claimed by a completion recently is never expired under it (code review US-017 F6).
  const expired = await sql<{ id: string }[]>`
    DELETE FROM public.upload_sessions
     WHERE completed_at IS NULL
       AND (completing_at IS NULL OR completing_at < clock_timestamp() - make_interval(mins => ${STALE_COMPLETION_MINUTES}))
       AND (expires_at <= clock_timestamp() OR completing_at IS NOT NULL)
    RETURNING id`;
  for (const { id } of expired) count(await removeOwnFile(stagingDir(dir), `${id}.part`, PART_FILE, 0));

  let orphanStagingFiles = 0;
  const live = new Set((await sql<{ id: string }[]>`SELECT id FROM public.upload_sessions WHERE completed_at IS NULL`).map((r) => r.id));
  for (const name of await listDir(stagingDir(dir))) {
    const id = PART_FILE.exec(name)?.[1];
    if (id !== undefined && live.has(id)) continue;
    if (count(await removeOwnFile(stagingDir(dir), name, PART_FILE, ORPHAN_MIN_AGE_MS))) orphanStagingFiles++;
  }

  const superseded = await sql<{ id: string; storage_path: string }[]>`
    SELECT u.id, u.storage_path FROM public.uploads u
     WHERE u.kind = 'pdf' AND u.superseded_at < clock_timestamp() - make_interval(mins => ${SUPERSEDED_GRACE_MINUTES})
       AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.pdf_upload_id = u.id)`;
  let supersededPdfs = 0;
  for (const upload of superseded) {
    const name = /^deliverables\/(.+)$/.exec(upload.storage_path)?.[1] ?? "";
    if (!PDF_FILE.test(name)) {
      logEvent("warn", "admin.upload_sweep_left_alone", { reason: "foreign_storage_path" });
      leftAlone++;
      continue;
    }
    try {
      await runMutation({ actor: { kind: "system" }, requestId: null, ip: null }, () =>
        withAudit(sql, async (tx, audit) => {
          const deleted = await tx`DELETE FROM public.uploads WHERE id = ${upload.id}`;
          audit({ action: "upload.purge", entityType: "upload", entityId: upload.id, facts: { reason: "superseded", storage_path: upload.storage_path, deleted: deleted.count } });
        }),
      );
    } catch (error) {
      logEvent("warn", "admin.upload_sweep_left_alone", { reason: "purge_failed" }, error);
      leftAlone++;
      continue;
    }
    count(await removeOwnFile(join(dir, "deliverables"), name, PDF_FILE, 0));
    supersededPdfs++;
  }

  // Every uploads row counts, whatever its kind (security review US-017 F4).
  let orphanPdfs = 0;
  const known = new Set((await sql<{ storage_path: string }[]>`SELECT storage_path FROM public.uploads`).map((r) => r.storage_path));
  for (const name of await listDir(join(dir, "deliverables"))) {
    if (known.has(`deliverables/${name}`)) continue;
    if (count(await removeOwnFile(join(dir, "deliverables"), name, PDF_FILE, ORPHAN_MIN_AGE_MS))) orphanPdfs++;
  }
  // US-030: the same for fulfilment proofs (lib/settings/fulfillment-proof.ts), once older than ORPHAN_MIN_AGE_MS (a proof being
  // stored is written before its row).
  let orphanProofs = 0;
  for (const name of await listDir(join(dir, PROOF_DIR))) {
    if (known.has(`${PROOF_DIR}/${name}`)) continue;
    if (count(await removeOwnFile(join(dir, PROOF_DIR), name, PROOF_FILE, ORPHAN_MIN_AGE_MS))) orphanProofs++;
  }
  return { skipped: false, expiredSessions: expired.length, orphanStagingFiles, supersededPdfs, orphanPdfs, orphanProofs, leftAlone };
}
