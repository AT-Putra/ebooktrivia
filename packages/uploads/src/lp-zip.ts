// Landing-page ZIP validation (US-023, plan M6.7). An LP ZIP is untrusted input that ends up served
// on the public internet, so it is checked as a whole before a single byte reaches the disk, and the
// result is the exact list of files to write:
//
//   1. size: at most 25 MiB compressed (before anything is parsed);
//   2. structure: every check of zip.ts (one end record, no comments, no ZIP64 / multi-disk, no
//      encryption, stored or deflate only, local headers and descriptors agree with the central
//      directory, entries tile the archive, unique case-insensitive names, no control character,
//      backslash, leading "/", drive letter, "." or ".." segment);
//   3. macOS metadata (__MACOSX/..., .DS_Store, ._* AppleDouble files) is skipped: never inflated or
//      written, left out of the top-folder rule and the file count (it still counts against the ZIP
//      size and the entry cap, which apply to the archive as received); the number skipped is reported;
//   4. entries, before anything is inflated: no symlink (Unix mode in the external attributes), no
//      device, FIFO or socket, no directory posing as a file (a directory mode or the MS-DOS
//      directory attribute on a name without "/", or a "directory" with content); names normalized
//      to NFC (macOS writes NFD) and then unique case-insensitively, at most 512 bytes, 128 bytes per segment, 16 levels, letters / digits / . _ ~ @ + , ( ) = ! ' -
//      and inner spaces only (no "%", "?", "#", no hidden or trailing-dot segment, no bidi or other
//      format character); no name that is both a file and a folder; at most 500 files; an extension
//      on the allowlist LP_FILE_TYPES; an index.html at the top (a ZIP of one folder holding it is
//      read from inside that folder);
//   5. contents, inflated one entry at a time under a running budget: 150 MiB in total and at most
//      100 times the ZIP's size (the compression ratio), 25 MiB per file. The budget is MEASURED
//      while inflating and the stream stops as soon as it is crossed; the headers' sizes are never
//      trusted (they must match afterwards, with the CRC-32);
//   6. each file's bytes against its extension: magic bytes for images, fonts and video (sniff.ts
//      for PNG / JPEG / WebP); valid UTF-8 text without control characters for HTML, CSS, JS, JSON,
//      source maps and text; SVG through svg.ts (refused unless every construct is allowed);
//   7. HTML: the LP's SDK tag injected before the first </head> (lp-html.ts), refused without a
//      </head> or with an SDK tag of its own.
// File-level problems are collected (up to 50) so the uploader sees them together; a structural or
// budget problem stops the check at once. Each accepted file is handed to `onFile` as soon as it is
// checked and then dropped, so at most one inflated file (25 MiB) is held at a time; the caller writes it
// to its staging directory and throws the directory away if the check fails later.

import { injectSdk } from "./lp-html.ts";
import { sniff, utf8Text } from "./sniff.ts";
import { svgProblem } from "./svg.ts";
import { inflateEntry, readZip, ZipError, type ZipEntry } from "./zip.ts";

const MiB = 1024 * 1024;

export interface LpZipLimits {
  readonly maxZipBytes: number;
  readonly maxUncompressedBytes: number;
  /** Uncompressed bytes in total may be at most this many times the ZIP's size. */
  readonly maxRatio: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxPathBytes: number;
  readonly maxSegmentBytes: number;
  readonly maxDepth: number;
}

export const LP_ZIP_LIMITS: LpZipLimits = Object.freeze({
  maxZipBytes: 25 * MiB,
  maxUncompressedBytes: 150 * MiB,
  maxRatio: 100,
  maxFiles: 500,
  maxFileBytes: 25 * MiB,
  maxPathBytes: 512,
  maxSegmentBytes: 128,
  maxDepth: 16,
});

const MAX_ISSUES = 50;

type Kind = "html" | "text" | "svg" | "binary";

interface LpFileType {
  /** The Content-Type Caddy serves the file with (infra/caddy/Caddyfile maps the same extensions). */
  readonly contentType: string;
  readonly kind: Kind;
  readonly magic?: (bytes: Buffer) => boolean;
}

const at = (bytes: Buffer, offset: number, text: string): boolean => bytes.length >= offset + text.length && bytes.toString("latin1", offset, offset + text.length) === text;
const ftypBrands = (bytes: Buffer): string[] => {
  if (!at(bytes, 4, "ftyp") || bytes.length < 16) return [];
  const end = Math.min(bytes.readUInt32BE(0), bytes.length);
  const brands = [bytes.toString("latin1", 8, 12)];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(bytes.toString("latin1", i, i + 4));
  return brands;
};
const isAvif = (b: Buffer): boolean => ftypBrands(b).some((brand) => brand === "avif" || brand === "avis");
const ttf = (b: Buffer): boolean => (b.length >= 4 && b.readUInt32BE(0) === 0x00010000) || at(b, 0, "true");

/** The extensions an LP may contain (lower-cased), each with its Content-Type and content check. */
export const LP_FILE_TYPES: Readonly<Record<string, LpFileType>> = {
  ".html": { contentType: "text/html; charset=utf-8", kind: "html" },
  ".htm": { contentType: "text/html; charset=utf-8", kind: "html" },
  ".css": { contentType: "text/css; charset=utf-8", kind: "text" },
  ".js": { contentType: "text/javascript; charset=utf-8", kind: "text" },
  ".mjs": { contentType: "text/javascript; charset=utf-8", kind: "text" },
  ".json": { contentType: "application/json", kind: "text" },
  ".map": { contentType: "application/json", kind: "text" },
  ".txt": { contentType: "text/plain; charset=utf-8", kind: "text" },
  ".svg": { contentType: "image/svg+xml", kind: "svg" },
  ".png": { contentType: "image/png", kind: "binary", magic: (b) => sniff(b) === "png" },
  ".jpg": { contentType: "image/jpeg", kind: "binary", magic: (b) => sniff(b) === "jpeg" },
  ".jpeg": { contentType: "image/jpeg", kind: "binary", magic: (b) => sniff(b) === "jpeg" },
  ".webp": { contentType: "image/webp", kind: "binary", magic: (b) => sniff(b) === "webp" },
  ".gif": { contentType: "image/gif", kind: "binary", magic: (b) => at(b, 0, "GIF87a") || at(b, 0, "GIF89a") },
  ".avif": { contentType: "image/avif", kind: "binary", magic: isAvif },
  // A favicon.ico is often a PNG renamed; browsers take both.
  ".ico": { contentType: "image/x-icon", kind: "binary", magic: (b) => (b.length >= 4 && b.readUInt32BE(0) === 0x00000100) || sniff(b) === "png" },
  ".woff": { contentType: "font/woff", kind: "binary", magic: (b) => at(b, 0, "wOFF") },
  ".woff2": { contentType: "font/woff2", kind: "binary", magic: (b) => at(b, 0, "wOF2") },
  ".ttf": { contentType: "font/ttf", kind: "binary", magic: ttf },
  ".otf": { contentType: "font/otf", kind: "binary", magic: (b) => at(b, 0, "OTTO") },
  ".mp4": { contentType: "video/mp4", kind: "binary", magic: (b) => at(b, 4, "ftyp") && !isAvif(b) },
  ".webm": { contentType: "video/webm", kind: "binary", magic: (b) => b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3 },
};

export type LpZipIssueCode =
  | "too_large"
  | "invalid_zip"
  | "too_many_files"
  | "too_large_uncompressed"
  | "file_too_large"
  | "unsafe_name"
  | "duplicate_name"
  | "symlink"
  | "not_a_file"
  | "extension_not_allowed"
  | "content_mismatch"
  | "svg_unsafe"
  | "html_no_head"
  | "html_sdk_tag"
  | "no_index";

export interface LpZipIssue {
  readonly code: LpZipIssueCode;
  /** The entry's name in the ZIP, or null for the archive as a whole. */
  readonly entry: string | null;
  readonly message: string;
}

export class LpZipRejected extends Error {
  readonly issues: readonly LpZipIssue[];
  constructor(issues: readonly LpZipIssue[]) {
    super(issues.map((i) => (i.entry === null ? i.message : `${i.entry}: ${i.message}`)).join("; "));
    this.name = "LpZipRejected";
    this.issues = issues;
  }
}

export interface LpFile {
  /** Relative path inside the version directory ("/"-separated, validated). */
  readonly path: string;
  readonly bytes: Buffer;
  readonly contentType: string;
}

export interface LpSite {
  /** The files handed to `onFile`, in order (no bytes). */
  readonly files: readonly { readonly path: string; readonly contentType: string; readonly size: number }[];
  /** Every folder the files need, parents first. */
  readonly directories: readonly string[];
  readonly uncompressedBytes: number;
  /** HTML files that got the SDK tag (the others already held it). */
  readonly injected: number;
  /** macOS metadata entries skipped (never inflated or written). */
  readonly skipped: number;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const UNIX_HOSTS = new Set([3, 19]);
const DOS_DIRECTORY = 0x10;
/** macOS metadata: the __MACOSX folder, Finder's .DS_Store and AppleDouble "._name" files. */
export const isMacMetadata = (name: string): boolean => name.startsWith("__MACOSX/") || name.split("/").some((segment) => segment === ".DS_Store" || segment.startsWith("._"));
const SEGMENT = /^[\p{L}\p{M}\p{N}_~@+,()=!'-](?:[\p{L}\p{M}\p{N}._~@+,()=!' -]*[\p{L}\p{M}\p{N}_~@+,()=!'-])?$/u;

const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");
export const extensionOfPath = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};

/** Why the entry's type is not a plain file or folder, or null. */
function typeProblem(entry: ZipEntry, isDir: boolean): LpZipIssue | null {
  if (UNIX_HOSTS.has(entry.versionMadeBy >>> 8)) {
    const type = (entry.externalAttributes >>> 16) & S_IFMT;
    if (type === S_IFLNK) return { code: "symlink", entry: entry.name, message: "symbolic links are not allowed" };
    if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) return { code: "not_a_file", entry: entry.name, message: "only plain files and folders are allowed (no device, pipe or socket)" };
    if (type === S_IFDIR && !isDir) return { code: "not_a_file", entry: entry.name, message: "a folder posing as a file" };
    if (type === S_IFREG && isDir) return { code: "not_a_file", entry: entry.name, message: "a file posing as a folder" };
  }
  if ((entry.externalAttributes & DOS_DIRECTORY) !== 0 && !isDir) return { code: "not_a_file", entry: entry.name, message: "a folder posing as a file" };
  if (isDir && entry.uncompressedSize !== 0) return { code: "not_a_file", entry: entry.name, message: "a folder with content" };
  return null;
}

/** Why the path (after the top folder is stripped) cannot be an LP file name, or null. */
function nameProblem(path: string, limits: LpZipLimits): string | null {
  if (bytesOf(path) > limits.maxPathBytes) return `the path is longer than ${String(limits.maxPathBytes)} bytes`;
  const segments = path.split("/");
  if (segments.length > limits.maxDepth) return `more than ${String(limits.maxDepth)} folder levels`;
  for (const segment of segments) {
    if (bytesOf(segment) > limits.maxSegmentBytes) return `a name is longer than ${String(limits.maxSegmentBytes)} bytes`;
    if (!SEGMENT.test(segment)) return "names may use letters, digits, spaces inside and . _ ~ @ + , ( ) = ! ' - only, and may not start with a dot";
  }
  return null;
}

/** The single top folder holding index.html when the ZIP has no index.html of its own, or "". */
function topFolder(names: readonly string[]): string {
  if (names.includes("index.html")) return "";
  const first = names[0]?.split("/")[0] ?? "";
  if (first === "" || !names.every((n) => n === `${first}/` || n.startsWith(`${first}/`))) return "";
  return names.includes(`${first}/index.html`) ? `${first}/` : "";
}

const contentMismatch = (path: string, type: string): LpZipIssue => ({ code: "content_mismatch", entry: path, message: `the content is not ${type}` });

function checkContent(path: string, bytes: Buffer, type: LpFileType, sdkTag: string): { issue: LpZipIssue } | { bytes: Buffer; injected: boolean } {
  const ext = extensionOfPath(path);
  if (type.kind === "binary") return type.magic?.(bytes) === true ? { bytes, injected: false } : { issue: contentMismatch(path, `a ${ext.slice(1).toUpperCase()} file`) };
  const text = utf8Text(bytes);
  if (text === null) return { issue: contentMismatch(path, "UTF-8 text") };
  if (type.kind === "svg") {
    if (sniff(bytes) !== "svg") return { issue: contentMismatch(path, "an SVG image") };
    const problem = svgProblem(text);
    return problem === null ? { bytes, injected: false } : { issue: { code: "svg_unsafe", entry: path, message: `SVG refused: ${problem}` } };
  }
  if (type.kind === "text") return { bytes, injected: false };
  const injected = injectSdk(text, sdkTag);
  if (!injected.ok) {
    return injected.problem === "no_head"
      ? { issue: { code: "html_no_head", entry: path, message: "no </head> end tag: add <head>...</head> so the checkout script can be added" } }
      : { issue: { code: "html_sdk_tag", entry: path, message: "the page loads the SDK itself: remove its <script> tag (the hosting adds it)" } };
  }
  return injected.changed ? { bytes: Buffer.from(injected.html, "utf8"), injected: true } : { bytes, injected: false };
}

function zipFailure(error: unknown): never {
  if (error instanceof ZipError) {
    if (error.code === "too_many_entries") throw new LpZipRejected([{ code: "too_many_files", entry: null, message: "the ZIP holds too many entries" }]);
    throw new LpZipRejected([{ code: error.code === "too_large_uncompressed" ? "too_large_uncompressed" : "invalid_zip", entry: null, message: error.message }]);
  }
  throw error;
}

/** Validates an LP ZIP and returns the files to write; throws LpZipRejected with every problem found. */
export async function checkLpZip(zip: Buffer, options: { readonly sdkTag: string; readonly onFile: (file: LpFile) => Promise<void>; readonly limits?: LpZipLimits }): Promise<LpSite> {
  const limits = options.limits ?? LP_ZIP_LIMITS;
  if (zip.length > limits.maxZipBytes) throw new LpZipRejected([{ code: "too_large", entry: null, message: `the ZIP is larger than ${String(limits.maxZipBytes / MiB)} MiB` }]);
  let read: ReturnType<typeof readZip>;
  try {
    read = readZip(zip, limits.maxFiles * 2);
  } catch (error) {
    zipFailure(error);
  }
  const issues: LpZipIssue[] = [];
  const add = (issue: LpZipIssue): void => {
    if (issues.length < MAX_ISSUES) issues.push(issue);
  };

  const kept = read.entries.filter((e) => !isMacMetadata(e.name));
  const skipped = read.entries.length - kept.length;
  const strip = topFolder(kept.map((e) => e.name.normalize("NFC")));
  const planned: { entry: ZipEntry; path: string; isDir: boolean; type: LpFileType | null }[] = [];
  const fileKeys = new Set<string>();
  /** Lower-cased folder path -> its spelling: "Img/" and "img/" are one folder to a person. */
  const dirKeys = new Map<string, string>();
  const addDir = (dir: string, entryName: string): void => {
    const spelled = dirKeys.get(dir.toLowerCase());
    if (spelled !== undefined && spelled !== dir) add({ code: "duplicate_name", entry: entryName, message: `the folder ${dir} differs from ${spelled} only in case` });
    dirKeys.set(dir.toLowerCase(), dir);
  };
  for (const entry of kept) {
    const isDir = entry.name.endsWith("/");
    const typeIssue = typeProblem(entry, isDir);
    if (typeIssue !== null) {
      add(typeIssue);
      continue;
    }
    const name = entry.name.normalize("NFC");
    if (name === strip) continue;
    const path = name.slice(strip.length).replace(/\/$/, "");
    const problem = nameProblem(path, limits);
    if (problem !== null) {
      add({ code: "unsafe_name", entry: entry.name, message: problem });
      continue;
    }
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) addDir(segments.slice(0, i).join("/"), entry.name);
    if (isDir) {
      addDir(path, entry.name);
      planned.push({ entry, path, isDir, type: null });
      continue;
    }
    const type = LP_FILE_TYPES[extensionOfPath(path)];
    if (type === undefined) {
      add({ code: "extension_not_allowed", entry: entry.name, message: `the file type ${extensionOfPath(path) || "(none)"} is not allowed` });
      continue;
    }
    if (fileKeys.has(path.toLowerCase())) {
      add({ code: "duplicate_name", entry: entry.name, message: "another file has the same name (case or Unicode form aside)" });
      continue;
    }
    fileKeys.add(path.toLowerCase());
    planned.push({ entry, path, isDir, type });
  }
  for (const key of fileKeys) {
    if (dirKeys.has(key)) add({ code: "duplicate_name", entry: key, message: "the same name is both a file and a folder" });
  }
  if (fileKeys.size > limits.maxFiles) add({ code: "too_many_files", entry: null, message: `more than ${String(limits.maxFiles)} files` });
  if (!planned.some((p) => p.path === "index.html") && !issues.some((i) => i.code === "unsafe_name" || i.code === "extension_not_allowed")) {
    add({ code: "no_index", entry: null, message: "no index.html at the top of the ZIP" });
  }
  if (issues.length > 0) throw new LpZipRejected(issues);

  const total = Math.min(limits.maxUncompressedBytes, limits.maxRatio * zip.length);
  let used = 0;
  let injected = 0;
  const files: { path: string; contentType: string; size: number }[] = [];
  for (const { entry, path, isDir, type } of planned) {
    const remaining = total - used;
    const perFile = isDir ? 0 : Math.min(limits.maxFileBytes, remaining);
    let bytes: Buffer;
    try {
      bytes = await inflateEntry(entry, read.data.get(entry) ?? Buffer.alloc(0), perFile);
    } catch (error) {
      if (error instanceof ZipError && error.code === "too_large_uncompressed" && !isDir && perFile < remaining) {
        throw new LpZipRejected([{ code: "file_too_large", entry: entry.name, message: `the file is larger than ${String(limits.maxFileBytes / MiB)} MiB uncompressed` }]);
      }
      if (error instanceof ZipError && error.code === "too_large_uncompressed" && !isDir) {
        throw new LpZipRejected([{ code: "too_large_uncompressed", entry: null, message: `the files are larger than ${String(Math.floor(total / MiB))} MiB uncompressed (at most ${String(limits.maxUncompressedBytes / MiB)} MiB, and ${String(limits.maxRatio)} times the ZIP's size)` }]);
      }
      if (error instanceof ZipError && error.code === "too_large_uncompressed") throw new LpZipRejected([{ code: "not_a_file", entry: entry.name, message: "a folder with content" }]);
      zipFailure(error);
    }
    used += bytes.length;
    if (type === null) continue;
    const checked = checkContent(path, bytes, type, options.sdkTag);
    if ("issue" in checked) {
      add({ ...checked.issue, entry: entry.name });
      continue;
    }
    if (checked.injected) injected++;
    if (issues.length > 0) continue; // already refused: nothing more is written
    await options.onFile({ path, bytes: checked.bytes, contentType: type.contentType });
    files.push({ path, contentType: type.contentType, size: checked.bytes.length });
  }
  if (issues.length > 0) throw new LpZipRejected(issues);
  const directories = [...new Set(files.flatMap((f) => f.path.split("/").slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join("/"))))].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return { files, directories, uncompressedBytes: used, injected, skipped };
}
