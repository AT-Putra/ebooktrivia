// Landing-page ZIP hosting (US-023, plan M6.7): the Owner uploads a static site as a ZIP; it is served
// on the page's registered domains by Caddy from ADMIN_LP_DIR (/srv/lp), with on-demand TLS approved
// by the internal process for exactly the hosts of public.lp_served_hosts().
//
//   <lpDir>/.staging/<uuid>/              a fresh extraction, same filesystem as versions/
//   <lpDir>/versions/<lpId>/<version>/    one immutable directory per version (plain files and folders)
//   <lpDir>/hosts/<host>/current          symlink -> ../../versions/<lpId>/<version> (Caddy's root)
//   <dataDir>/lp-zips/<uploadId>.zip      the uploaded archive as received (never served)
//
// Upload: the ZIP goes up in 1 MiB chunks through the upload sessions of lib/settings/uploads.ts (kind
// lp_zip), so no request carries more than a chunk inside Caddy's 30 s body timeout. `complete` takes
// the process's one publish slot BEFORE it reads anything (a second publish meanwhile is answered
// "busy"), checks the assembled file against its declared SHA-256 and publishes it.
//
// Publish: @ebooktrivia/uploads/lp-zip checks the archive (limits measured while inflating, names,
// types, SVG, the SDK tag) and hands over each accepted file as soon as it is checked; it is written
// into a new staging directory at once (folders created one by one, files opened O_CREAT|O_EXCL, so
// nothing existing is ever followed or reused) and dropped from memory. A refused ZIP throws the staging
// directory away, is audited and its problems are shown. The finished tree is checked (only the files
// planned, no link, every resolved path inside), then, in one audited transaction under the hosting
// lock, renamed into versions/<lpId>/<n> and made the page's current version (hosting 'zip'). Only
// after the hosts are re-linked are versions beyond the last LP_VERSION_RETENTION deleted, and never
// one that a host link still points at.
//
// Host links (syncLpHosts): after every publish, rollback, domain, active or hosting change, and every
// few minutes, under the same lock: each served host's `current` link is pointed at its live version
// by an atomic rename of a new symlink over the old one (Linux), and every other host directory loses
// its link and is removed, so a removed domain or a deactivated page stops being served even where
// Caddy still holds a certificate. Only entries of our own shape are touched; anything else is logged
// and left alone. RELINK_ALERT_AFTER failed runs in a row raise an alert. The NOTIFY that refreshes
// the ask cache comes from the database (sql/triggers.sql).
//
// On Windows (development and tests only) symlinks need a privilege, so the link is a junction, and a
// junction cannot be renamed over another: there the swap is unlink + rename, not atomic.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, rmdir, symlink, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isUuid, normalizeHost } from "@ebooktrivia/core";
import { checkLpZip, LP_ZIP_LIMITS, type LpFile, type LpSite, type LpZipIssue, LpZipRejected } from "@ebooktrivia/uploads/lp-zip";
import { type Tx, withAudit } from "../audit.ts";
import type { Sql } from "../db.ts";
import { logEvent } from "../log.ts";
import type { SettingsConfig } from "./env.ts";
import { InvalidInput, singleLine } from "./fields.ts";
import { snippet } from "./landing-pages.ts";
import { claimLpZipSession, type InitResult, openSession } from "./uploads.ts";

export const LP_VERSION_RETENTION = 5;
/** Consecutive failed relink runs after which an alert is raised (security review US-023 L5). */
export const RELINK_ALERT_AFTER = 3;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TMP_LINK = /^current\.[0-9a-f-]{36}\.tmp$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Entries younger than this may belong to a publish still running: the cleanup leaves them. */
const ORPHAN_MIN_AGE_MS = 10 * 60_000;

const lockHosting = (tx: Tx) => tx`SELECT pg_advisory_xact_lock(hashtextextended('lp_hosting', 0))`;
const versionDir = (root: string, lpId: string, version: number): string => join(root, "versions", lpId, String(version));
const linkTarget = (lpId: string, version: number): string => `../../versions/${lpId}/${String(version)}`;
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** A ZIP refused by the checks; `issues` is what the console shows. */
export class LpZipRefused extends Error {
  readonly issues: readonly LpZipIssue[];
  constructor(issues: readonly LpZipIssue[]) {
    super("the landing-page ZIP was refused");
    this.name = "LpZipRefused";
    this.issues = issues;
  }
}

/** Another publish holds this process's slot (answered 409; security review US-023 L1). */
export class PublishBusy extends Error {
  constructor() {
    super("A landing-page publish is running. Try again in a minute.");
    this.name = "PublishBusy";
  }
}

// One publish at a time per process: a check holds the ZIP (25 MiB) and one inflated file (25 MiB).
let publishBusy = false;
async function withPublishSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (publishBusy) throw new PublishBusy();
  publishBusy = true;
  try {
    return await fn();
  } finally {
    publishBusy = false;
  }
}

function hostingConfig(settings: SettingsConfig): { root: string; dataDir: string; domain: string } {
  if (settings.lpDir === null || settings.dataDir === null) throw new InvalidInput("Landing-page hosting is not configured on the server (ADMIN_LP_DIR, ADMIN_DATA_DIR).");
  if (settings.domain === null) throw new InvalidInput("The SDK tag needs DOMAIN, which is not configured on the server.");
  return { root: settings.lpDir, dataDir: settings.dataDir, domain: settings.domain };
}

export interface LpZipInitRequest {
  readonly landingPageId: string;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
}

/** Checks the `init` request of a chunked LP ZIP upload (no I/O). */
export function parseLpZipInit(body: unknown): LpZipInitRequest {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const landingPageId = typeof b["landingPageId"] === "string" ? b["landingPageId"].toLowerCase() : "";
  if (!isUuid(landingPageId)) throw new InvalidInput("Unknown landing page.");
  const filename = singleLine(typeof b["filename"] === "string" ? b["filename"] : "", "The file name is up to 128 characters.", { max: 128 });
  if (!filename.toLowerCase().endsWith(".zip") || /[\\/:*?"<>|\p{Cc}]/u.test(filename)) throw new InvalidInput("Choose a .zip file (its name without / \\ : * ? \" < > |).");
  const size = b["size"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) throw new InvalidInput("The file is empty.");
  const sha256 = typeof b["sha256"] === "string" ? b["sha256"].toLowerCase() : "";
  if (!SHA256_HEX.test(sha256)) throw new InvalidInput("The file hash is missing.");
  return { landingPageId, filename, size, sha256 };
}

/** Starts (or resumes) the chunked upload of an LP ZIP. */
export async function initLpZipUpload(sql: Sql, settings: SettingsConfig, adminUserId: string, req: LpZipInitRequest): Promise<InitResult> {
  hostingConfig(settings);
  if (req.size > LP_ZIP_LIMITS.maxZipBytes) return { kind: "too_large", maxBytes: LP_ZIP_LIMITS.maxZipBytes };
  return openSession(sql, settings, adminUserId, { kind: "lp_zip", target: req.landingPageId, filename: req.filename, size: req.size, sha256: req.sha256, largeConfirmed: false });
}

export interface PublishResult {
  readonly version: number;
  readonly fileCount: number;
  readonly uncompressedBytes: number;
  /** macOS metadata entries skipped. */
  readonly skipped: number;
  readonly hostsSynced: boolean;
}

/** Test seam (integration tests only): runs after the publish committed, before the session is marked completed. */
export interface CompleteTestHooks {
  readonly beforeFinish?: () => Promise<void>;
}

/** Completes a chunked LP ZIP upload: takes the publish slot, then checks and publishes the staged file. */
export function completeLpZipUpload(sql: Sql, settings: SettingsConfig, adminUserId: string, sessionId: string, hooks: CompleteTestHooks = {}): Promise<PublishResult> {
  hostingConfig(settings);
  return withPublishSlot(async () => {
    const claimed = await claimLpZipSession(sql, settings, adminUserId, sessionId);
    let zip: Buffer;
    try {
      zip = await readFile(claimed.staging);
    } catch (error) {
      await claimed.release();
      throw error;
    }
    if (zip.length !== claimed.size || !createHash("sha256").update(zip).digest().equals(claimed.sha256)) {
      await claimed.discard();
      throw new InvalidInput("The assembled file does not match its hash: start the upload again.");
    }
    let published: { result: PublishResult; uploadId: string };
    try {
      published = await publishOnce(sql, settings, adminUserId, claimed.landingPageId, { bytes: zip, filename: claimed.filename });
    } catch (error) {
      if (error instanceof LpZipRefused || error instanceof InvalidInput) await claimed.discard();
      else await claimed.release();
      throw error;
    }
    // The version is committed: from here on the session must stay claimed whatever happens (a released
    // one could be completed again into a duplicate version). A failed finish is only logged; the
    // sweeper removes the stale claim and its staging file later.
    try {
      await hooks.beforeFinish?.();
      await claimed.finish(published.uploadId);
    } catch (error) {
      logEvent("warn", "admin.lp_zip_finish_failed", {}, error);
    }
    return published.result;
  });
}

/** Checks the ZIP bytes and publishes them (tests and the chunked completion; one at a time). */
export async function publishLpZip(sql: Sql, settings: SettingsConfig, adminUserId: string, landingPageId: string, upload: { readonly bytes: Uint8Array; readonly filename: string }): Promise<PublishResult> {
  return withPublishSlot(async () => (await publishOnce(sql, settings, adminUserId, landingPageId, upload)).result);
}

/** `path` must resolve (symlinks followed) to somewhere inside `dir`. */
async function assertInside(dir: string, path: string): Promise<void> {
  const real = await realpath(path);
  if (!real.startsWith(dir + sep)) throw new Error("an extracted path resolves outside its version directory");
}

/** A writer into a new staging directory: folders made one by one, files created exclusively. */
async function stagingWriter(root: string): Promise<{ dir: string; write: (file: LpFile) => Promise<void> }> {
  await mkdir(join(root, ".staging"), { recursive: true, mode: 0o750 });
  const dir = join(root, ".staging", randomUUID());
  await mkdir(dir, { mode: 0o750 });
  const made = new Set<string>();
  return {
    dir,
    write: async (file) => {
      const segments = file.path.split("/");
      for (let i = 1; i < segments.length; i++) {
        const folder = segments.slice(0, i).join("/");
        if (made.has(folder)) continue;
        await mkdir(join(dir, ...segments.slice(0, i)), { mode: 0o750 });
        made.add(folder);
      }
      const handle = await open(join(dir, ...segments), "wx", 0o640);
      try {
        await handle.writeFile(file.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
}

/** Defence in depth: the tree holds exactly the checked files and their folders, none a link, all inside. */
async function verifyTree(dir: string, site: LpSite): Promise<void> {
  const real = await realpath(dir);
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  if (entries.some((e) => !e.isFile() && !e.isDirectory()) || entries.filter((e) => e.isFile()).length !== site.files.length) {
    throw new Error("the extracted tree is not the checked one");
  }
  for (const file of site.files) await assertInside(real, join(dir, ...file.path.split("/")));
}

const cut = (s: string | null): string | null => (s === null ? null : s.slice(0, 200));

async function publishOnce(sql: Sql, settings: SettingsConfig, adminUserId: string, landingPageId: string, upload: { readonly bytes: Uint8Array; readonly filename: string }): Promise<{ result: PublishResult; uploadId: string }> {
  const { root, dataDir, domain } = hostingConfig(settings);
  const [page] = await sql<{ lp_key: string }[]>`SELECT lp_key FROM public.landing_pages WHERE id = ${landingPageId}`;
  if (page === undefined) throw new InvalidInput("This landing page no longer exists.");
  const zip = Buffer.from(upload.bytes.buffer, upload.bytes.byteOffset, upload.bytes.byteLength);
  const sha256 = createHash("sha256").update(zip).digest();
  const staging = await stagingWriter(root);
  let site: LpSite;
  try {
    site = await checkLpZip(zip, { sdkTag: snippet(domain, page.lp_key), onFile: staging.write });
    await verifyTree(staging.dir, site);
  } catch (error) {
    await rm(staging.dir, { recursive: true, force: true });
    if (!(error instanceof LpZipRejected)) throw error;
    const firstIssue = error.issues[0];
    await withAudit(sql, (_tx, audit) => {
      audit({
        action: "lp_version.reject",
        entityType: "landing_page",
        entityId: landingPageId,
        facts: { zip_bytes: zip.length, sha256: sha256.toString("hex"), issues: error.issues.length, code: firstIssue?.code ?? null, entry: cut(firstIssue?.entry ?? null) },
      });
      return Promise.resolve();
    });
    throw new LpZipRefused(error.issues);
  }

  const uploadId = randomUUID();
  const storagePath = `lp-zips/${uploadId}.zip`;
  const zipFile = join(dataDir, storagePath);
  // Set inside the transaction callback once the staging directory became the version directory.
  const state: { moved: string | null } = { moved: null };
  let version: number;
  try {
    await mkdir(join(dataDir, "lp-zips"), { recursive: true, mode: 0o750 });
    const handle = await open(zipFile, "wx", 0o640);
    try {
      await handle.writeFile(zip);
      await handle.sync();
    } finally {
      await handle.close();
    }
    version = await withAudit(sql, async (tx, audit) => {
      await lockHosting(tx);
      const [current] = await tx<{ current_version_id: string | null; hosting: string }[]>`
        SELECT current_version_id, hosting FROM public.landing_pages WHERE id = ${landingPageId} FOR UPDATE`;
      if (current === undefined) throw new InvalidInput("This landing page no longer exists.");
      const [next] = await tx<{ n: number }[]>`SELECT coalesce(max(version), 0)::int + 1 AS n FROM public.lp_versions WHERE landing_page_id = ${landingPageId}`;
      const n = next?.n ?? 1;
      const target = versionDir(root, landingPageId, n);
      await mkdir(join(root, "versions", landingPageId), { recursive: true, mode: 0o750 });
      // A directory without a row is left over from a crash between this rename and the commit.
      await rm(target, { recursive: true, force: true });
      await rename(staging.dir, target);
      state.moved = target;
      await tx`
        INSERT INTO public.uploads (id, kind, storage_path, original_filename, content_type, size_bytes, sha256, created_by_admin_user_id)
        VALUES (${uploadId}, 'lp_zip', ${storagePath}, ${upload.filename}, 'application/zip', ${zip.length}, ${sha256}, ${adminUserId})`;
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO public.lp_versions (landing_page_id, version, upload_id, file_count, uncompressed_bytes)
        VALUES (${landingPageId}, ${n}, ${uploadId}, ${site.files.length}, ${site.uncompressedBytes}) RETURNING id`;
      const versionId = row?.id ?? "";
      await tx`UPDATE public.landing_pages SET current_version_id = ${versionId}, hosting = 'zip', updated_at = clock_timestamp() WHERE id = ${landingPageId}`;
      audit({
        action: "lp_version.publish",
        entityType: "landing_page",
        entityId: landingPageId,
        fields: { current_version_id: "value", hosting: "value" },
        before: { current_version_id: current.current_version_id, hosting: current.hosting },
        after: { current_version_id: versionId, hosting: "zip" },
        facts: {
          version: n,
          file_count: site.files.length,
          uncompressed_bytes: site.uncompressedBytes,
          zip_bytes: zip.length,
          sha256: sha256.toString("hex"),
          html_injected: site.injected,
          macos_skipped: site.skipped,
          original_filename: upload.filename,
        },
      });
      return n;
    });
  } catch (error) {
    await rm(state.moved ?? staging.dir, { recursive: true, force: true });
    await rm(zipFile, { force: true });
    throw error;
  }
  // Relink first; only then may old versions go, and never one a link still points at (review US-023).
  const hostsSynced = await syncLpHostsQuietly(sql, settings);
  await purgeOldVersions(sql, settings, landingPageId).catch((error: unknown) => {
    logEvent("warn", "admin.lp_purge_failed", {}, error);
  });
  return { result: { version, fileCount: site.files.length, uncompressedBytes: site.uncompressedBytes, skipped: site.skipped, hostsSynced }, uploadId };
}

/** The version directories some host's `current` points at right now (read from disk). */
async function linkedVersionDirs(root: string): Promise<Set<string>> {
  const linked = new Set<string>();
  const hosts = join(root, "hosts");
  for (const name of await readdir(hosts).catch(() => [])) {
    const target = await readlink(join(hosts, name, "current")).catch(() => null);
    if (target !== null) linked.add(resolve(join(hosts, name), target));
  }
  return linked;
}

/**
 * Deletes the versions of a page beyond the newest LP_VERSION_RETENTION, except its current version
 * and any version a host link points at, with their ZIPs (audited, under the hosting lock).
 */
export async function purgeOldVersions(sql: Sql, settings: SettingsConfig, landingPageId: string): Promise<number> {
  const { root, dataDir } = hostingConfig(settings);
  const candidates = async (tx: Tx) => {
    const linked = await linkedVersionDirs(root);
    const old = await tx<{ id: string; version: number; upload_id: string; storage_path: string }[]>`
      SELECT v.id, v.version, v.upload_id, u.storage_path
        FROM public.lp_versions v JOIN public.uploads u ON u.id = v.upload_id JOIN public.landing_pages lp ON lp.id = v.landing_page_id
       WHERE v.landing_page_id = ${landingPageId} AND v.id IS DISTINCT FROM lp.current_version_id
       ORDER BY v.version DESC OFFSET ${LP_VERSION_RETENTION - 1}`;
    return old.filter((v) => !linked.has(resolve(versionDir(root, landingPageId, v.version))));
  };
  // Nothing to delete (the usual case) writes nothing, not even an audit row.
  const pending = await sql.begin(async (tx) => {
    await lockHosting(tx);
    return candidates(tx);
  });
  if (pending.length === 0) return 0;
  const purged = await withAudit(sql, async (tx, audit) => {
    await lockHosting(tx);
    const gone: { dir: string; zip: string }[] = [];
    for (const v of await candidates(tx)) {
      await tx`DELETE FROM public.lp_versions WHERE id = ${v.id}`;
      await tx`DELETE FROM public.uploads WHERE id = ${v.upload_id}`;
      audit({ action: "lp_version.purge", entityType: "lp_version", entityId: v.id, facts: { landing_page_id: landingPageId, version: v.version, reason: "retention" } });
      gone.push({ dir: versionDir(root, landingPageId, v.version), zip: join(dataDir, v.storage_path) });
    }
    if (gone.length === 0) audit({ action: "lp_version.purge_skipped", entityType: "landing_page", entityId: landingPageId, facts: { reason: "relinked meanwhile" } });
    return gone;
  });
  for (const p of purged) {
    // Only paths built from a uuid and a version number under our own roots; rm never follows a link.
    await rm(p.dir, { recursive: true, force: true }).catch((error: unknown) => {
      logEvent("warn", "admin.lp_purge_failed", {}, error);
    });
    if (/^lp-zips\/[0-9a-f-]{36}\.zip$/.test(p.zip.slice(dataDir.length + 1).replaceAll("\\", "/"))) {
      await rm(p.zip, { force: true }).catch((error: unknown) => {
        logEvent("warn", "admin.lp_purge_failed", {}, error);
      });
    }
  }
  return purged.length;
}

/** Rollback (or forward again): makes a kept version the live one. Returns its number. */
export async function activateLpVersion(sql: Sql, settings: SettingsConfig, landingPageId: string, versionId: string): Promise<number> {
  const { root } = hostingConfig(settings);
  const version = await withAudit(sql, async (tx, audit) => {
    await lockHosting(tx);
    const [row] = await tx<{ version: number }[]>`SELECT version FROM public.lp_versions WHERE id = ${versionId} AND landing_page_id = ${landingPageId}`;
    if (row === undefined) throw new InvalidInput("This version no longer exists.");
    const entry = await lstat(versionDir(root, landingPageId, row.version)).catch(() => null);
    if (entry === null || !entry.isDirectory() || entry.isSymbolicLink()) throw new InvalidInput(`The files of version ${String(row.version)} are missing on the server; upload the ZIP again.`);
    const [page] = await tx<{ current_version_id: string | null; hosting: string }[]>`SELECT current_version_id, hosting FROM public.landing_pages WHERE id = ${landingPageId} FOR UPDATE`;
    if (page === undefined) throw new InvalidInput("This landing page no longer exists.");
    await tx`UPDATE public.landing_pages SET current_version_id = ${versionId}, hosting = 'zip', updated_at = clock_timestamp() WHERE id = ${landingPageId}`;
    audit({
      action: "lp_version.activate",
      entityType: "landing_page",
      entityId: landingPageId,
      fields: { current_version_id: "value", hosting: "value" },
      before: { current_version_id: page.current_version_id, hosting: page.hosting },
      after: { current_version_id: versionId, hosting: "zip" },
      facts: { version: row.version },
    });
    return row.version;
  });
  await syncLpHostsQuietly(sql, settings);
  return version;
}

/** The way back to an external page (review US-023 MINOR 9): hosting 'external'; the links go, the versions stay. */
export async function stopLpHosting(sql: Sql, settings: SettingsConfig, landingPageId: string): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    await lockHosting(tx);
    const [page] = await tx<{ hosting: string }[]>`SELECT hosting FROM public.landing_pages WHERE id = ${landingPageId} FOR UPDATE`;
    if (page === undefined) throw new InvalidInput("This landing page no longer exists.");
    if (page.hosting !== "zip") throw new InvalidInput("This landing page is not hosted from a ZIP.");
    // The UPDATE of hosting NOTIFYs the ask cache (landing_pages_hosts_notify).
    await tx`UPDATE public.landing_pages SET hosting = 'external', updated_at = clock_timestamp() WHERE id = ${landingPageId}`;
    audit({ action: "lp_hosting.stop", entityType: "landing_page", entityId: landingPageId, fields: { hosting: "value" }, before: { hosting: "zip" }, after: { hosting: "external" } });
  });
  await syncLpHostsQuietly(sql, settings);
}

export interface SyncResult {
  readonly linked: number;
  readonly unchanged: number;
  readonly removed: number;
  /** Entries not of our own shape (or that failed), logged and left alone. */
  readonly leftAlone: number;
}

async function pointAt(hostDir: string, target: string): Promise<void> {
  const link = join(hostDir, "current");
  const tmp = join(hostDir, `current.${randomUUID()}.tmp`);
  if (process.platform === "win32") {
    await symlink(resolve(hostDir, target), tmp, "junction");
    await unlink(link).catch((error: unknown) => {
      if (errno(error) !== "ENOENT") throw error;
    });
  } else {
    await symlink(target, tmp);
  }
  await rename(tmp, link);
}

/**
 * Removes OUR links in a host directory (`current` unless `keepCurrent`, and stale current.<uuid>.tmp)
 * and returns whether anything else is in it. Our `current` of a host that is no longer served always
 * goes, foreign files or not, so a removed page never keeps serving; only the foreign files are left
 * alone (security re-review US-023).
 */
async function removeLinks(hostDir: string, keepCurrent: boolean): Promise<boolean> {
  let foreign = false;
  for (const name of await readdir(hostDir)) {
    if (name === "current" && keepCurrent) continue;
    const entry = await lstat(join(hostDir, name));
    if ((name === "current" || TMP_LINK.test(name)) && entry.isSymbolicLink()) await unlink(join(hostDir, name));
    else foreign = true;
  }
  return foreign;
}

/** Makes <lpDir>/hosts match public.lp_served_hosts(); see the file comment. */
export async function syncLpHosts(sql: Sql, settings: SettingsConfig): Promise<SyncResult> {
  if (settings.lpDir === null) return { linked: 0, unchanged: 0, removed: 0, leftAlone: 0 };
  const root = settings.lpDir;
  const hosts = join(root, "hosts");
  return sql.begin(async (tx) => {
    await lockHosting(tx);
    const rows = await tx<{ host: string; landing_page_id: string; version: number }[]>`SELECT host, landing_page_id, version FROM public.lp_served_hosts()`;
    await mkdir(hosts, { recursive: true, mode: 0o750 });
    let linked = 0;
    let unchanged = 0;
    let removed = 0;
    let leftAlone = 0;
    const desired = new Set<string>();
    for (const row of rows) {
      if (!HOST.test(row.host) || normalizeHost(row.host) !== row.host || !isUuid(row.landing_page_id)) {
        leftAlone++;
        continue;
      }
      desired.add(row.host);
      const hostDir = join(hosts, row.host);
      try {
        const version = await lstat(versionDir(root, row.landing_page_id, row.version)).catch(() => null);
        if (version === null || !version.isDirectory() || version.isSymbolicLink()) throw new Error("the live version's directory is missing");
        const dir = await lstat(hostDir).catch(() => null);
        if (dir === null) await mkdir(hostDir, { mode: 0o750 });
        else if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("the host entry is not a plain directory");
        await removeLinks(hostDir, true);
        const target = linkTarget(row.landing_page_id, row.version);
        const now = await readlink(join(hostDir, "current")).catch(() => null);
        if (now !== null && resolve(hostDir, now) === resolve(hostDir, target)) {
          unchanged++;
          continue;
        }
        if (now === null && (await lstat(join(hostDir, "current")).catch(() => null)) !== null) throw new Error("current is not a link");
        await pointAt(hostDir, target);
        linked++;
      } catch (error) {
        logEvent("warn", "admin.lp_host_left_alone", { reason: "link_failed" }, error);
        leftAlone++;
      }
    }
    for (const name of await readdir(hosts)) {
      if (desired.has(name)) continue;
      try {
        const entry = await lstat(join(hosts, name));
        if (!HOST.test(name) || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error("not a host directory of ours");
        if (await removeLinks(join(hosts, name), false)) throw new Error("the host directory holds other entries");
        await rmdir(join(hosts, name));
        removed++;
      } catch (error) {
        logEvent("warn", "admin.lp_host_left_alone", { reason: "unlink_failed" }, error);
        leftAlone++;
      }
    }
    return { linked, unchanged, removed, leftAlone };
  });
}

let relinkFailures = 0;

/**
 * syncLpHosts after a committed change (and by the periodic run): a failure is logged, the periodic
 * run retries, and RELINK_ALERT_AFTER failed runs in a row raise one alert (source admin).
 */
export async function syncLpHostsQuietly(sql: Sql, settings: SettingsConfig): Promise<boolean> {
  let ok: boolean;
  try {
    ok = (await syncLpHosts(sql, settings)).leftAlone === 0;
  } catch (error) {
    logEvent("warn", "admin.lp_host_sync_failed", {}, error);
    ok = false;
  }
  relinkFailures = ok ? 0 : relinkFailures + 1;
  if (relinkFailures === RELINK_ALERT_AFTER) {
    await sql`
      INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload)
      VALUES ('admin', 'lp_relink_failed', 'warning', 'lp_relink_failed',
              ${`Landing-page host links could not be brought in line ${String(RELINK_ALERT_AFTER)} times in a row: check /srv/lp/hosts and the admin log (admin.lp_host_left_alone).`},
              ${JSON.stringify({ failures: relinkFailures })}::text::jsonb)`.catch((error: unknown) => {
      logEvent("error", "admin.lp_relink_alert_failed", {}, error);
    });
  }
  return ok;
}

/**
 * Removes what a crash can leave behind, older than ORPHAN_MIN_AGE_MS, under the hosting lock (no
 * publish is half-way meanwhile): staging directories, version directories without an lp_versions row,
 * and lp-zips without an uploads row. Names must be ours.
 */
export async function sweepLpFiles(sql: Sql, settings: SettingsConfig): Promise<number> {
  if (settings.lpDir === null) return 0;
  const root = settings.lpDir;
  const dataDir = settings.dataDir;
  const old = async (path: string, dir: boolean): Promise<boolean> => {
    const entry = await lstat(path).catch(() => null);
    return entry !== null && !entry.isSymbolicLink() && (dir ? entry.isDirectory() : entry.isFile()) && Date.now() - entry.mtimeMs >= ORPHAN_MIN_AGE_MS;
  };
  const list = (path: string): Promise<string[]> => readdir(path).catch(() => []);
  return sql.begin(async (tx) => {
    await lockHosting(tx);
    let removed = 0;
    for (const name of await list(join(root, ".staging"))) {
      if (isUuid(name) && (await old(join(root, ".staging", name), true))) {
        await rm(join(root, ".staging", name), { recursive: true, force: true });
        removed++;
      }
    }
    const known = new Set((await tx<{ k: string }[]>`SELECT landing_page_id::text || '/' || version::text AS k FROM public.lp_versions`).map((r) => r.k));
    for (const lpId of (await list(join(root, "versions"))).filter(isUuid)) {
      for (const v of (await list(join(root, "versions", lpId))).filter((n) => /^[1-9]\d{0,8}$/.test(n))) {
        if (!known.has(`${lpId}/${v}`) && (await old(join(root, "versions", lpId, v), true))) {
          await rm(join(root, "versions", lpId, v), { recursive: true, force: true });
          removed++;
        }
      }
    }
    if (dataDir !== null) {
      const zips = new Set((await tx<{ p: string }[]>`SELECT storage_path AS p FROM public.uploads WHERE kind = 'lp_zip'`).map((r) => r.p));
      for (const name of await list(join(dataDir, "lp-zips"))) {
        if (/^[0-9a-f-]{36}\.zip$/.test(name) && !zips.has(`lp-zips/${name}`) && (await old(join(dataDir, "lp-zips", name), false))) {
          await rm(join(dataDir, "lp-zips", name), { force: true });
          removed++;
        }
      }
    }
    return removed;
  });
}

export interface LpVersionRow {
  readonly id: string;
  readonly version: number;
  readonly fileCount: number;
  readonly uncompressedBytes: number;
  readonly createdAt: Date;
  readonly live: boolean;
}

/** The kept versions of every landing page, newest first. */
export async function listLpVersions(sql: Sql): Promise<Map<string, LpVersionRow[]>> {
  const rows = await sql<{ id: string; landing_page_id: string; version: number; file_count: number; uncompressed_bytes: number; created_at: Date; live: boolean }[]>`
    SELECT v.id, v.landing_page_id, v.version, v.file_count, v.uncompressed_bytes, v.created_at, (lp.current_version_id = v.id AND lp.hosting = 'zip') AS live
      FROM public.lp_versions v JOIN public.landing_pages lp ON lp.id = v.landing_page_id
     ORDER BY v.version DESC`;
  const out = new Map<string, LpVersionRow[]>();
  for (const r of rows) {
    const list = out.get(r.landing_page_id) ?? [];
    list.push({ id: r.id, version: r.version, fileCount: r.file_count, uncompressedBytes: r.uncompressed_bytes, createdAt: r.created_at, live: r.live });
    out.set(r.landing_page_id, list);
  }
  return out;
}
