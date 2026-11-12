// A minimal ZIP writer for test fixtures (generated in memory; no binaries are committed). Each
// field can be overridden to build lying or malformed archives.
import { crc32, deflateRawSync } from "node:zlib";

export interface FixtureEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly method?: number;
  readonly flags?: number;
  /** Uncompressed size written to both headers (default: the real size). */
  readonly declaredSize?: number;
  readonly crc?: number;
  /** Name written to the local header (default: `name`). */
  readonly localName?: string;
  /** Compressed body to write instead of deflating `data`. */
  readonly body?: Buffer;
  /** Bytes appended to the compressed body (counted in the compressed size). */
  readonly trailing?: Buffer;
  /** Data descriptor after the body (sets flag 0x08 and zero local sizes / CRC). */
  readonly descriptor?: "signed" | "unsigned";
  /** Values written to the data descriptor instead of the real ones. */
  readonly descriptorValues?: { readonly crc?: number; readonly compressedSize?: number; readonly size?: number };
  /** Local-header sizes / CRC instead of the central ones (no descriptor). */
  readonly localValues?: { readonly crc?: number; readonly compressedSize?: number; readonly size?: number };
  /** Bytes written after this entry (before the next local header), not in the directory. */
  readonly gapAfter?: Buffer;
  /** Extra field written to both headers (raw blocks: id u16, size u16, data). */
  readonly extra?: Buffer;
  /** General-purpose flags written to the local header only (default: the central flags). */
  readonly localFlags?: number;
  /** Per-entry comment in the central directory record. */
  readonly fileComment?: string;
}

/** One extra-field block: header id, size, data. */
export function extraBlock(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

/** Info-ZIP Unicode Path extra field (0x7075): version 1, CRC-32 of the header name, new name. */
export function unicodePathExtra(headerName: string, newName: string): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(1, 0);
  head.writeUInt32LE(crc32(Buffer.from(headerName, "utf8")), 1);
  return extraBlock(0x7075, Buffer.concat([head, Buffer.from(newName, "utf8")]));
}

export interface FixtureOptions {
  readonly comment?: Buffer | string;
  /** Entry count written to the end record (default: the real count). */
  readonly count?: number;
  /** Bytes before the first local header. */
  readonly prefix?: Buffer;
  /** Bytes between the last entry and the central directory. */
  readonly beforeCentral?: Buffer;
  /** Repeat every central directory record this many times (all pointing at the same local header). */
  readonly centralRepeat?: number;
}

export function makeZip(entries: readonly FixtureEntry[], options: FixtureOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  const prefix = options.prefix ?? Buffer.alloc(0);
  parts.push(prefix);
  let offset = prefix.length;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = Buffer.concat([entry.body ?? (method === 8 ? deflateRawSync(entry.data, { level: 9 }) : entry.data), entry.trailing ?? Buffer.alloc(0)]);
    const name = Buffer.from(entry.name, "utf8");
    const localName = Buffer.from(entry.localName ?? entry.name, "utf8");
    const crc = entry.crc ?? crc32(entry.data);
    const size = entry.declaredSize ?? entry.data.length;
    const flags = (entry.flags ?? 0) | (entry.descriptor === undefined ? 0 : 0x08);

    const extra = entry.extra ?? Buffer.alloc(0);
    const fileComment = Buffer.from(entry.fileComment ?? "", "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.localFlags ?? flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(extra.length, 28);
    if (entry.descriptor === undefined) {
      local.writeUInt32LE(entry.localValues?.crc ?? crc, 14);
      local.writeUInt32LE(entry.localValues?.compressedSize ?? body.length, 18);
      local.writeUInt32LE(entry.localValues?.size ?? size, 22);
    }
    local.writeUInt16LE(localName.length, 26);

    let descriptor = Buffer.alloc(0);
    if (entry.descriptor !== undefined) {
      const values = Buffer.alloc(12);
      values.writeUInt32LE(entry.descriptorValues?.crc ?? crc, 0);
      values.writeUInt32LE(entry.descriptorValues?.compressedSize ?? body.length, 4);
      values.writeUInt32LE(entry.descriptorValues?.size ?? size, 8);
      const signature = Buffer.alloc(4);
      signature.writeUInt32LE(0x08074b50);
      descriptor = entry.descriptor === "signed" ? Buffer.concat([signature, values]) : values;
    }

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(fileComment.length, 32);
    central.writeUInt32LE(offset, 42);

    const gap = entry.gapAfter ?? Buffer.alloc(0);
    parts.push(local, localName, extra, body, descriptor, gap);
    for (let i = 0; i < (options.centralRepeat ?? 1); i++) centrals.push(central, name, extra, fileComment);
    offset += local.length + localName.length + extra.length + body.length + descriptor.length + gap.length;
  }
  const beforeCentral = options.beforeCentral ?? Buffer.alloc(0);
  parts.push(beforeCentral);
  offset += beforeCentral.length;
  const directory = Buffer.concat(centrals);
  const comment = typeof options.comment === "string" || options.comment === undefined ? Buffer.from(options.comment ?? "", "utf8") : options.comment;
  const records = entries.length * (options.centralRepeat ?? 1);
  return Buffer.concat([...parts, directory, endRecord(options.count ?? records, directory.length, offset, comment.length), comment]);
}

/** An end-of-central-directory record. */
export function endRecord(count: number, directorySize: number, directoryOffset: number, commentLength: number): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(directoryOffset, 16);
  end.writeUInt16LE(commentLength, 20);
  return end;
}

/** A local file header + deflated body for `data`, to plant in a gap (no directory record). */
export function localEntry(name: string, data: Buffer): Buffer {
  const body = deflateRawSync(data, { level: 9 });
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(Buffer.byteLength(name), 26);
  return Buffer.concat([header, Buffer.from(name, "utf8"), body]);
}

/** A raw deflate stream of `blocks` empty stored blocks: costly to inflate, inflates to nothing. */
export function emptyDeflateBlocks(blocks: number): Buffer {
  const out = Buffer.alloc(blocks * 5);
  for (let i = 0; i < blocks; i++) out.set([i === blocks - 1 ? 0x01 : 0x00, 0x00, 0x00, 0xff, 0xff], i * 5);
  return out;
}

const CONTENT_TYPES = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
);
const WORKBOOK = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><workbook/>');

/** The smallest archive the policy accepts as XLSX, plus any extra entries. */
export const xlsx = (extra: readonly FixtureEntry[] = [], options: FixtureOptions = {}): Buffer =>
  makeZip([{ name: "[Content_Types].xml", data: CONTENT_TYPES }, { name: "xl/workbook.xml", data: WORKBOOK }, ...extra], options);
