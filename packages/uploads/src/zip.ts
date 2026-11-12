// ZIP inspection for XLSX uploads: entry list from the central directory, then every entry is
// inflated as a stream with a running byte budget, so the uncompressed size is MEASURED, never
// taken from the ZIP headers (zip-bomb safe: a small file that inflates past the budget is
// stopped as soon as the budget is crossed, and output chunks are discarded, not kept).
//
// Refused (ZipError): no / ambiguous end-of-central-directory record, multi-disk and ZIP64
// archives, more entries than allowed, encrypted entries, methods other than stored (0) and
// deflate (8), a local header that disagrees with the central directory, entry data outside the
// archive, and an entry whose real size or CRC-32 differs from its header (a header that lies).
//
// The entries must also TILE the archive (security review US-011 #2): sorted by local-header
// offset, the first starts at 0, each starts exactly where the previous one's data (and data
// descriptor) ends, and the last ends where the central directory starts. Otherwise a streaming
// local-header parser (exceljs WorkbookReader, unzipper) could read a hidden entry in a gap, or
// one stream twice, that the central directory - and so this budget - never saw. Names must be
// unique (case-insensitive) and safe: no "." / ".." segments, no leading "/", no backslash, no
// drive letter, no control characters, not empty.

import { crc32, createInflateRaw } from "node:zlib";

export type ZipErrorCode = "invalid_zip" | "too_many_entries" | "too_large_uncompressed";

export class ZipError extends Error {
  readonly code: ZipErrorCode;
  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

export interface ZipLimits {
  readonly maxEntries: number;
  /** Total uncompressed bytes over all entries. */
  readonly maxUncompressedBytes: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const EOCD_BYTES = 22;
const CENTRAL_BYTES = 46;
const LOCAL_BYTES = 30;
const MAX_COMMENT = 0xffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const STORED = 0;
const DEFLATE = 8;

const invalid = (message: string): ZipError => new ZipError("invalid_zip", message);

function findEndOfCentralDirectory(zip: Buffer): number {
  const lowest = Math.max(0, zip.length - EOCD_BYTES - MAX_COMMENT);
  let found = -1;
  for (let at = zip.length - EOCD_BYTES; at >= lowest; at--) {
    // The record must end exactly at the end of the file (its comment fills the rest).
    if (zip.readUInt32LE(at) === EOCD_SIGNATURE && at + EOCD_BYTES + zip.readUInt16LE(at + 20) === zip.length) {
      // Two candidates (e.g. a comment that is itself an end record) means parsers may disagree.
      if (found !== -1) throw invalid("ambiguous end of central directory record");
      found = at;
    }
  }
  if (found === -1) throw invalid("no end of central directory record");
  // No archive comment: a comment can carry a second directory + end record that some parsers
  // (JSZip takes the last PK\x05\x06) prefer over this one (security re-check D).
  if (found !== zip.length - EOCD_BYTES) throw invalid("archive comments are not allowed");
  return found;
}

/**
 * Extra fields allowed in either header: extended timestamp (0x5455), NTFS times (0x000a) and
 * Unix UID/GID (0x7875). Anything else - notably Info-ZIP Unicode Path 0x7075 and Unicode
 * Comment 0x6375, which make JSZip rename an entry past the name checks (re-check E) - is refused.
 */
const ALLOWED_EXTRA_FIELDS = new Set([0x5455, 0x000a, 0x7875]);

function checkExtraField(zip: Buffer, start: number, length: number, name: string): void {
  const end = start + length;
  let at = start;
  while (at < end) {
    if (at + 4 > end) throw invalid(`malformed extra field in ${name}`);
    const id = zip.readUInt16LE(at);
    const size = zip.readUInt16LE(at + 2);
    if (at + 4 + size > end) throw invalid(`malformed extra field in ${name}`);
    if (!ALLOWED_EXTRA_FIELDS.has(id)) throw invalid(`extra field 0x${id.toString(16).padStart(4, "0")} in ${name} is not allowed`);
    at += 4 + size;
  }
}

/**
 * Entry names must be valid UTF-8 (fatal decoding): lenient decoding maps different invalid byte
 * strings to the same U+FFFD text, so a local and a central name could compare equal while
 * parsers read different names. Valid UTF-8 decodes one-to-one, so the string compare against the
 * local header is then a byte compare.
 */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

function decodeName(zip: Buffer, start: number, length: number): string {
  try {
    return STRICT_UTF8.decode(zip.subarray(start, start + length));
  } catch {
    throw invalid("entry name is not valid UTF-8");
  }
}

/** Control characters, backslash, a drive letter, a leading "/", or a "." / ".." segment. */
function unsafeName(name: string): boolean {
  if (name === "") return true;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c /* backslash */) return true;
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return true;
  return name.split("/").some((segment) => segment === "." || segment === "..");
}

/** The entries listed in the central directory, validated against their local headers. */
export function readZipEntries(zip: Buffer, maxEntries: number): ZipEntry[] {
  if (zip.length < EOCD_BYTES) throw invalid("too short for a ZIP archive");
  const eocd = findEndOfCentralDirectory(zip);
  const disk = zip.readUInt16LE(eocd + 4);
  const centralDisk = zip.readUInt16LE(eocd + 6);
  const entriesOnDisk = zip.readUInt16LE(eocd + 8);
  const count = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== count) throw invalid("multi-disk archives are not supported");
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw invalid("ZIP64 is not supported");
  if (count > maxEntries) throw new ZipError("too_many_entries", `more than ${maxEntries.toString()} entries`);
  if (centralOffset + centralSize !== eocd) throw invalid("central directory is not where the end record says");

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let at = centralOffset;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_BYTES > eocd || zip.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw invalid("bad central directory entry");
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const end = at + CENTRAL_BYTES + nameLength + extraLength + commentLength;
    if (end > eocd) throw invalid("central directory entry overruns the directory");
    const centralName = decodeName(zip, at + CENTRAL_BYTES, nameLength);
    if (commentLength !== 0) throw invalid(`entry comments are not allowed (${centralName})`);
    checkExtraField(zip, at + CENTRAL_BYTES + nameLength, extraLength, centralName);
    const entry: ZipEntry = {
      flags: zip.readUInt16LE(at + 8),
      method: zip.readUInt16LE(at + 10),
      crc32: zip.readUInt32LE(at + 16),
      compressedSize: zip.readUInt32LE(at + 20),
      uncompressedSize: zip.readUInt32LE(at + 24),
      localHeaderOffset: zip.readUInt32LE(at + 42),
      name: centralName,
    };
    if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff || entry.localHeaderOffset === 0xffffffff) {
      throw invalid("ZIP64 is not supported");
    }
    if ((entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) throw invalid("encrypted entries are not supported");
    // Known flags only: deflate options (bits 1-2), data descriptor (3), UTF-8 names (11).
    if ((entry.flags & ~0x080e) !== 0) throw invalid(`unsupported general-purpose flags 0x${entry.flags.toString(16)} in ${entry.name}`);
    if (entry.method !== STORED && entry.method !== DEFLATE) throw invalid(`compression method ${entry.method.toString()} is not supported`);
    if (unsafeName(entry.name)) throw invalid(`unsafe entry name ${JSON.stringify(entry.name)}`);
    const key = entry.name.toLowerCase();
    if (seen.has(key)) throw invalid(`duplicate entry name ${JSON.stringify(entry.name)}`);
    seen.add(key);
    entries.push(entry);
    at = end;
  }
  if (at !== eocd) throw invalid("central directory has trailing bytes");
  return entries;
}

/**
 * Where an entry's compressed data lives, and where the entry ends, after checking that its local
 * header (and data descriptor) say exactly what the central directory says. A streaming parser
 * reads the local header and descriptor, not the directory, so any disagreement is a place where
 * it could see different bytes than the budget measured (security re-check A, B).
 */
function entryData(zip: Buffer, entry: ZipEntry, dataEnd: number): { data: Buffer; end: number } {
  const at = entry.localHeaderOffset;
  if (at + LOCAL_BYTES > dataEnd || zip.readUInt32LE(at) !== LOCAL_SIGNATURE) throw invalid(`bad local header for ${entry.name}`);
  const nameLength = zip.readUInt16LE(at + 26);
  const extraLength = zip.readUInt16LE(at + 28);
  const start = at + LOCAL_BYTES + nameLength + extraLength;
  if (start > dataEnd) throw invalid(`local header of ${entry.name} runs past the archive`);
  if (zip.readUInt16LE(at + 8) !== entry.method || decodeName(zip, at + LOCAL_BYTES, nameLength) !== entry.name) {
    throw invalid(`local header of ${entry.name} disagrees with the central directory`);
  }
  if (zip.readUInt16LE(at + 6) !== entry.flags) throw invalid(`local header flags of ${entry.name} differ from the central directory`);
  checkExtraField(zip, at + LOCAL_BYTES + nameLength, extraLength, entry.name);
  const hasDescriptor = (entry.flags & FLAG_DATA_DESCRIPTOR) !== 0;
  if (hasDescriptor && entry.method === STORED) {
    throw invalid(`stored entry ${entry.name} cannot use a data descriptor (its end cannot be found from the stream)`);
  }
  const central = [entry.crc32, entry.compressedSize, entry.uncompressedSize];
  const local = [zip.readUInt32LE(at + 14), zip.readUInt32LE(at + 18), zip.readUInt32LE(at + 22)];
  // Without a descriptor the local values must equal the central ones; with one they may be 0.
  if (local.some((value, i) => value !== central[i] && !(hasDescriptor && value === 0))) {
    throw invalid(`local header of ${entry.name} disagrees with the central directory (CRC-32 or sizes)`);
  }
  let end = start + entry.compressedSize;
  if (end > dataEnd) throw invalid(`data of ${entry.name} runs past the archive`);
  const data = zip.subarray(start, end);
  if (hasDescriptor) {
    // Data descriptor: crc32, compressed size, size (12 bytes), optionally after a signature.
    const signed = end + 4 <= dataEnd && zip.readUInt32LE(end) === DESCRIPTOR_SIGNATURE;
    const values = signed ? end + 4 : end;
    if (values + 12 > dataEnd) throw invalid(`data descriptor of ${entry.name} runs past the archive`);
    const descriptor = [zip.readUInt32LE(values), zip.readUInt32LE(values + 4), zip.readUInt32LE(values + 8)];
    if (descriptor.some((value, i) => value !== central[i])) {
      throw invalid(`data descriptor of ${entry.name} disagrees with the central directory`);
    }
    end = values + 12;
  }
  return { data, end };
}

/** Entries must cover [0, centralOffset) exactly, in local-header order: no gap, no overlap. */
function located(zip: Buffer, entries: readonly ZipEntry[], centralOffset: number): Map<ZipEntry, Buffer> {
  const byOffset = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  const data = new Map<ZipEntry, Buffer>();
  let expected = 0;
  for (const entry of byOffset) {
    if (entry.localHeaderOffset !== expected) {
      throw invalid(`entries are not contiguous: ${entry.name} starts at ${entry.localHeaderOffset.toString()}, expected ${expected.toString()} (gap or overlap)`);
    }
    const { data: bytes, end } = entryData(zip, entry, centralOffset);
    data.set(entry, bytes);
    expected = end;
  }
  if (expected !== centralOffset) throw invalid("bytes between the last entry and the central directory (gap)");
  return data;
}

/** Inflates `data` and counts the output, failing once it exceeds `budget`; output is discarded. */
function measure(data: Buffer, method: number, budget: number): Promise<{ size: number; crc: number }> {
  if (method === STORED) {
    if (data.length > budget) return Promise.reject(new ZipError("too_large_uncompressed", "uncompressed size over the limit"));
    return Promise.resolve({ size: data.length, crc: crc32(data) });
  }
  return new Promise((resolve, reject) => {
    const inflate = createInflateRaw();
    let size = 0;
    let crc = 0;
    inflate.on("data", (chunk: Buffer) => {
      if (inflate.destroyed) return;
      size += chunk.length;
      if (size > budget) {
        inflate.destroy(new ZipError("too_large_uncompressed", "uncompressed size over the limit"));
        return;
      }
      crc = crc32(chunk, crc);
    });
    inflate.on("error", (error) => {
      reject(error instanceof ZipError ? error : invalid("corrupt deflate data"));
    });
    inflate.on("end", () => {
      // zlib stops at the end of the deflate stream and ignores what follows; a streaming parser
      // without a central directory would read those bytes as the next entry (re-check C, C2).
      if (inflate.bytesWritten !== data.length) {
        reject(invalid("bytes after the end of the deflate stream"));
        return;
      }
      resolve({ size, crc });
    });
    inflate.end(data);
  });
}

const FLAG_UTF8 = 0x0800;
/** 1980-01-01 00:00 in MS-DOS date/time: a fixed timestamp keeps the canonical copy deterministic. */
const DOS_DATE_1980_01_01 = (1 << 5) | 1;

/**
 * The measured entries re-written as a plain archive: same names, methods, CRC-32 and compressed
 * bytes (already proven to inflate to exactly the declared size), no comments, no extra fields,
 * no data descriptors, a fixed timestamp. Downstream parsers (exceljs) only ever get this copy, so
 * any construct this inspector did not anticipate is gone - the ZIP equivalent of re-encoding an
 * image (security re-check, recommended alternative).
 */
function canonicalZip(entries: readonly ZipEntry[], data: ReadonlyMap<ZipEntry, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const body = data.get(entry);
    if (body === undefined) throw invalid(`no data for ${entry.name}`);
    const name = Buffer.from(entry.name, "utf8");
    // Names are written as UTF-8, so flag them as such whenever they are not plain ASCII: without
    // the flag unzipper decodes CP437 while JSZip guesses, and the two would disagree.
    const flags = name.length !== entry.name.length ? FLAG_UTF8 : 0;
    const local = Buffer.alloc(LOCAL_BYTES);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(entry.crc32, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(CENTRAL_BYTES);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(entry.crc32, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(EOCD_BYTES);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/**
 * Lists the entries and measures every one by inflating it. Returns them with the total size and
 * the canonical copy: hand ONLY `canonical` to a ZIP/XLSX parser, never the uploaded bytes.
 */
export async function inspectZip(
  zip: Buffer,
  limits: ZipLimits,
): Promise<{ entries: ZipEntry[]; uncompressedBytes: number; canonical: Buffer }> {
  const entries = readZipEntries(zip, limits.maxEntries);
  const data = located(zip, entries, zip.readUInt32LE(findEndOfCentralDirectory(zip) + 16));
  let total = 0;
  for (const entry of entries) {
    const bytes = data.get(entry);
    if (bytes === undefined) throw invalid(`no data for ${entry.name}`);
    const measured = await measure(bytes, entry.method, limits.maxUncompressedBytes - total);
    if (measured.size !== entry.uncompressedSize || measured.crc !== entry.crc32) {
      throw invalid(`${entry.name}: size or CRC-32 differs from its header`);
    }
    total += measured.size;
  }
  return { entries, uncompressedBytes: total, canonical: canonicalZip(entries, data) };
}
