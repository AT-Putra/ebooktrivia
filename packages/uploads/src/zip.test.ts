import { PassThrough } from "node:stream";
import { crc32 } from "node:zlib";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { extraBlock, localEntry, makeZip, unicodePathExtra, xlsx } from "../test/zip-fixture.ts";
import { inspectZip, readZipEntries, ZipError } from "./zip.ts";

const MiB = 1024 * 1024;
// A small injected budget (US-031): the bombs below only need to exceed it, so each test allocates and inflates a few
// MiB instead of 60, and CI stays fast under parallel load. The production budget (policy.ts DEFAULT_UPLOAD_LIMITS)
// is the same code path with a bigger number; policy.test.ts pins it.
const LIMITS = { maxEntries: 1000, maxUncompressedBytes: 4 * MiB };

async function zipError(zip: Buffer, limits = LIMITS): Promise<ZipError> {
  try {
    await inspectZip(zip, limits);
  } catch (e) {
    expect(e).toBeInstanceOf(ZipError);
    return e as ZipError;
  }
  throw new Error("expected inspectZip to fail");
}

describe("inspectZip", () => {
  it("lists entries and measures the real uncompressed size, stored and deflated", async () => {
    const data = Buffer.from("a".repeat(5000));
    const zip = makeZip([
      { name: "a.txt", data },
      { name: "b.bin", data: Buffer.from([1, 2, 3]), method: 0 },
    ]);
    const { entries, uncompressedBytes } = await inspectZip(zip, LIMITS);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b.bin"]);
    expect(uncompressedBytes).toBe(5003);
    expect(zip.length).toBeLessThan(500);
  });

  it("refuses an archive comment (security re-check D: a comment can hide a second directory)", async () => {
    expect((await zipError(makeZip([{ name: "a", data: Buffer.from("x") }], { comment: "hello" }))).message).toMatch(/comment/);
  });

  // Zip bomb: ~6 KB that inflates to 6 MiB, over the 4 MiB budget (the ratio is the same as a 60 MiB bomb's). The
  // headers are not trusted: a lying header that claims 10 bytes is stopped at the budget all the same.
  it("stops a zip bomb at the budget, whatever the headers claim", async () => {
    const zeros = Buffer.alloc(6 * MiB);
    const bomb = xlsx([{ name: "xl/bomb.bin", data: zeros }]);
    expect(bomb.length).toBeLessThan(16 * 1024);
    expect((await zipError(bomb)).code).toBe("too_large_uncompressed");
    const lying = xlsx([{ name: "xl/bomb.bin", data: zeros, declaredSize: 10 }]);
    expect((await zipError(lying)).code).toBe("too_large_uncompressed");
  });

  it("counts the budget over all entries, not per entry", async () => {
    const part = Buffer.alloc(MiB);
    const parts = Array.from({ length: 6 }, (_, i) => ({ name: `xl/part${i.toString()}.bin`, data: part }));
    expect((await zipError(makeZip(parts))).code).toBe("too_large_uncompressed");
    expect((await inspectZip(makeZip(parts.slice(0, 3)), LIMITS)).uncompressedBytes).toBe(3 * MiB);
  });

  it("refuses a stored entry larger than the budget", async () => {
    const zip = makeZip([{ name: "big", data: Buffer.alloc(2048), method: 0 }]);
    expect((await zipError(zip, { maxEntries: 10, maxUncompressedBytes: 1024 })).code).toBe("too_large_uncompressed");
  });

  it("refuses more entries than allowed", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ name: `f${i.toString()}`, data: Buffer.from("x") }));
    expect((await zipError(makeZip(many))).code).toBe("too_many_entries");
    expect((await inspectZip(makeZip(many.slice(0, 1000)), LIMITS)).entries).toHaveLength(1000);
  });

  it("refuses a header that lies about the size or CRC (within the budget)", async () => {
    const data = Buffer.from("hello world");
    expect((await zipError(makeZip([{ name: "a", data, declaredSize: 5 }]))).code).toBe("invalid_zip");
    expect((await zipError(makeZip([{ name: "a", data, crc: (crc32(data) ^ 1) >>> 0 }]))).code).toBe("invalid_zip");
    expect((await zipError(makeZip([{ name: "a", data, method: 0, declaredSize: 4 }]))).code).toBe("invalid_zip");
  });

  it("refuses encrypted entries, unsupported methods and disagreeing local headers", async () => {
    const data = Buffer.from("x");
    expect((await zipError(makeZip([{ name: "a", data, flags: 1 }]))).message).toMatch(/encrypted/);
    expect((await zipError(makeZip([{ name: "a", data, flags: 0x40 }]))).message).toMatch(/encrypted/);
    expect((await zipError(makeZip([{ name: "a", data, method: 12 }]))).message).toMatch(/method 12/);
    expect((await zipError(makeZip([{ name: "a", data, localName: "b" }]))).message).toMatch(/disagrees/);
  });

  it("refuses corrupt deflate data", async () => {
    const zip = makeZip([{ name: "a", data: Buffer.from("x".repeat(100)) }]);
    // Overwrite the deflate stream (after the 30-byte local header and 1-byte name) with junk.
    zip.fill(0xff, 31, 33);
    expect((await zipError(zip)).code).toBe("invalid_zip");
  });

  it("refuses archives that are not plain single-disk ZIPs", async () => {
    const zip = makeZip([{ name: "a", data: Buffer.from("x") }]);
    const eocd = zip.length - 22;
    const patched = (at: number, write: (b: Buffer) => void): Buffer => {
      const copy = Buffer.from(zip);
      write(copy.subarray(at));
      return copy;
    };
    for (const [what, bad] of [
      ["too short", Buffer.from("PK\x03\x04")],
      ["no end record", zip.subarray(0, zip.length - 1)],
      ["trailing junk", Buffer.concat([zip, Buffer.from("junk")])],
      ["multi-disk", patched(eocd + 4, (b) => b.writeUInt16LE(1, 0))],
      ["ZIP64 count", patched(eocd + 8, (b) => { b.writeUInt16LE(0xffff, 0); b.writeUInt16LE(0xffff, 2); })],
      ["ZIP64 offset", patched(eocd + 16, (b) => b.writeUInt32LE(0xffffffff, 0))],
      ["directory elsewhere", patched(eocd + 16, (b) => b.writeUInt32LE(1, 0))],
      ["missing entries", makeZip([{ name: "a", data: Buffer.from("x") }], { count: 2 })],
      ["extra entries", makeZip([{ name: "a", data: Buffer.from("x") }, { name: "b", data: Buffer.from("y") }], { count: 1 })],
      ["bad central signature", patched(eocd - 47, (b) => b.writeUInt32LE(0, 0))],
      ["bad local offset", patched(eocd - 47 + 42, (b) => b.writeUInt32LE(5, 0))],
      ["ZIP64 entry size", patched(eocd - 47 + 24, (b) => b.writeUInt32LE(0xffffffff, 0))],
      ["entry overruns directory", patched(eocd - 47 + 30, (b) => b.writeUInt16LE(500, 0))],
      ["data past the archive", patched(eocd - 47 + 20, (b) => b.writeUInt32LE(1000, 0))],
    ] as const) {
      const error = await zipError(bad);
      expect({ what, code: error.code }).toEqual({ what, code: "invalid_zip" });
    }
  });

  it("readZipEntries refuses a too-short buffer", () => {
    expect(() => readZipEntries(Buffer.alloc(10), 10)).toThrow(ZipError);
  });
});

// Security review US-011 #2: the budget only holds if the central directory describes every byte
// a streaming local-header parser (exceljs WorkbookReader, unzipper) would read. Entries must tile
// the archive: no gaps (hidden local entries), no overlaps, no shared local headers.
describe("inspectZip: entries tile the archive", () => {
  it("Z1: refuses a hidden local entry in a gap the central directory does not list", async () => {
    const hidden = localEntry("xl/hidden.bin", Buffer.alloc(2 * MiB));
    const zip = xlsx([], {});
    expect((await inspectZip(zip, LIMITS)).entries).toHaveLength(2);
    const withGap = makeZip(
      [
        { name: "[Content_Types].xml", data: Buffer.from("<Types/>"), gapAfter: hidden },
        { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
      ],
      {},
    );
    expect((await zipError(withGap)).message).toMatch(/contiguous|gap/);
  });

  it("refuses bytes before the first entry and between the last entry and the directory", async () => {
    const entries = [{ name: "a", data: Buffer.from("x") }];
    expect((await zipError(makeZip(entries, { prefix: Buffer.from("junk") }))).code).toBe("invalid_zip");
    expect((await zipError(makeZip(entries, { beforeCentral: localEntry("hidden", Buffer.alloc(MiB)) }))).code).toBe("invalid_zip");
  });

  it("Z2: refuses directory records that share one local header", async () => {
    const zip = makeZip([{ name: "xl/a.xml", data: Buffer.from("<a/>") }], { centralRepeat: 3 });
    expect((await zipError(zip)).code).toBe("invalid_zip");
  });

  it("Z4: refuses overlapping entries (one stream read twice)", async () => {
    const zip = makeZip([
      { name: "a", data: Buffer.from("first") },
      { name: "b", data: Buffer.from("second") },
    ]);
    // Point b's directory record at a's local header (offset 0): same bytes, read twice.
    const eocd = zip.length - 22;
    const centralOffset = zip.readUInt32LE(eocd + 16);
    const secondCentral = centralOffset + 46 + 1; // first record: 46 bytes + 1-byte name
    const patched = Buffer.from(zip);
    patched.writeUInt32LE(0, secondCentral + 42);
    expect((await zipError(patched)).code).toBe("invalid_zip");
  });

  it("still accepts entries followed by signed or unsigned data descriptors", async () => {
    const zip = makeZip([
      { name: "a.txt", data: Buffer.from("alpha".repeat(50)), descriptor: "signed" },
      { name: "b.txt", data: Buffer.from("beta".repeat(50)), descriptor: "unsigned" },
      { name: "c.txt", data: Buffer.from("gamma") },
    ]);
    expect((await inspectZip(zip, LIMITS)).entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });
});

describe("inspectZip: entry names", () => {
  it("refuses duplicate names, also when they differ only in case", async () => {
    const data = Buffer.from("x");
    expect((await zipError(makeZip([{ name: "xl/a.xml", data }, { name: "xl/a.xml", data }]))).message).toMatch(/duplicate/);
    expect((await zipError(makeZip([{ name: "xl/A.xml", data }, { name: "xl/a.xml", data }]))).message).toMatch(/duplicate/);
  });

  it.each([
    ["parent segment", "../x"],
    ["nested parent segment", "xl/../../etc/cron.d/x"],
    ["absolute path", "/etc/passwd"],
    ["backslash", "xl\\workbook.xml"],
    ["drive letter", "C:/x"],
    ["NUL", "a\u{0}b"],
    ["newline", "a\nb"],
    ["DEL", "a\u{7f}"],
    ["empty", ""],
  ])("refuses an unsafe name: %s", async (_label, name) => {
    expect((await zipError(makeZip([{ name, data: Buffer.from("x") }]))).message).toMatch(/unsafe entry name/);
  });

  it("accepts ordinary nested names and directory entries", async () => {
    const zip = makeZip([
      { name: "xl/", data: Buffer.alloc(0), method: 0 },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from("<s/>") },
      { name: "docProps/app.xml", data: Buffer.from("<p/>") },
    ]);
    expect((await inspectZip(zip, LIMITS)).entries).toHaveLength(3);
  });
});

describe("inspectZip: end of central directory", () => {
  it("refuses an archive with two end records that could both be valid", async () => {
    const entries = [{ name: "a", data: Buffer.from("x") }];
    const plain = makeZip(entries);
    // A comment that is itself a complete end record (comment length 0) ending at EOF.
    const fake = Buffer.from(plain.subarray(plain.length - 22));
    const ambiguous = makeZip(entries, { comment: fake });
    expect((await zipError(ambiguous)).message).toMatch(/ambiguous/);
  });
});

// Security re-check US-011: archives that pass a central-directory-only inspection but that the
// planned parser (exceljs 4.4.0: unzipper for WorkbookReader, JSZip for xlsx.load) reads
// differently. Each hides an entry the budget never measured, or renames one.
describe("inspectZip: local headers and streams agree with the central directory", () => {
  const hidden = localEntry("xl/sharedStrings.xml", Buffer.alloc(MiB));

  it("A: refuses a local header whose sizes or CRC disagree with the central directory", async () => {
    const zip = makeZip([{ name: "xl/a.bin", data: hidden, method: 0, localValues: { compressedSize: 0, size: 0 } }]);
    expect((await zipError(zip)).message).toMatch(/local header/);
    const crc = makeZip([{ name: "xl/a.bin", data: Buffer.from("abc"), localValues: { crc: 1 } }]);
    expect((await zipError(crc)).message).toMatch(/local header/);
  });

  it("B: refuses a stored entry with a data descriptor (its end cannot be found from the stream)", async () => {
    const zip = makeZip([{ name: "xl/a.bin", data: Buffer.concat([Buffer.from([0x50, 0x4b, 0x07, 0x08]), hidden]), method: 0, descriptor: "signed" }]);
    expect((await zipError(zip)).message).toMatch(/stored/);
  });

  it("C: refuses bytes after the end of a deflate stream", async () => {
    const zip = makeZip([{ name: "xl/a.xml", data: Buffer.from("<a/>"), trailing: hidden }]);
    expect((await zipError(zip)).message).toMatch(/after the end of the deflate stream/);
  });

  it("C2: ... also when the entry uses a data descriptor (local sizes 0)", async () => {
    const zip = makeZip([{ name: "xl/a.xml", data: Buffer.from("<a/>"), trailing: hidden, descriptor: "signed" }]);
    expect((await zipError(zip)).message).toMatch(/after the end of the deflate stream/);
  });

  it("refuses a data descriptor whose values differ from the central directory", async () => {
    const zip = makeZip([{ name: "a.txt", data: Buffer.from("alpha"), descriptor: "unsigned", descriptorValues: { size: 1 } }]);
    expect((await zipError(zip)).message).toMatch(/descriptor/);
  });

  it("refuses local flags that differ from the central flags", async () => {
    const zip = makeZip([{ name: "a.txt", data: Buffer.from("alpha"), localFlags: 0x0800 }]);
    expect((await zipError(zip)).message).toMatch(/flags/);
  });

  it("E: refuses extra fields outside the allowlist (Info-ZIP Unicode Path renames entries for JSZip)", async () => {
    const zip = xlsx([{ name: "xl/media/f.bin", data: Buffer.from("x"), extra: unicodePathExtra("xl/media/f.bin", "xl/workbook.xml") }]);
    expect((await zipError(zip)).message).toMatch(/extra field 0x7075/);
    const comment = makeZip([{ name: "a", data: Buffer.from("x"), extra: extraBlock(0x6375, Buffer.from([1, 0, 0, 0, 0])) }]);
    expect((await zipError(comment)).message).toMatch(/extra field 0x6375/);
  });

  it("refuses a malformed extra field", async () => {
    const zip = makeZip([{ name: "a", data: Buffer.from("x"), extra: Buffer.from([0x55, 0x54, 0x10, 0x00, 0x01]) }]);
    expect((await zipError(zip)).message).toMatch(/malformed extra field/);
  });

  it("accepts the allowlisted extra fields: extended timestamp, NTFS times, Unix UID/GID", async () => {
    const extra = Buffer.concat([
      extraBlock(0x5455, Buffer.from([1, 0, 0, 0, 0])),
      extraBlock(0x000a, Buffer.alloc(32)),
      extraBlock(0x7875, Buffer.from([1, 4, 0xe8, 3, 0, 0, 4, 0xe8, 3, 0, 0])),
    ]);
    expect((await inspectZip(makeZip([{ name: "a.txt", data: Buffer.from("alpha"), extra }]), LIMITS)).entries).toHaveLength(1);
  });

  it("refuses a per-entry comment", async () => {
    const zip = makeZip([{ name: "a", data: Buffer.from("x"), fileComment: "note" }]);
    expect((await zipError(zip)).message).toMatch(/comment/);
  });
});

describe("inspectZip: canonical copy (what exceljs is given)", () => {
  it("re-writes the measured entries with no comments, extras or data descriptors", async () => {
    const zip = makeZip([
      { name: "a.txt", data: Buffer.from("alpha".repeat(100)), descriptor: "signed", extra: extraBlock(0x5455, Buffer.from([1, 0, 0, 0, 0])) },
      { name: "b.bin", data: Buffer.from([1, 2, 3]), method: 0 },
      { name: "c.txt", data: Buffer.from("gamma"), descriptor: "unsigned" },
    ]);
    const first = await inspectZip(zip, LIMITS);
    const again = await inspectZip(first.canonical, LIMITS);
    const shape = (e: { name: string; method: number; crc32: number; uncompressedSize: number }) => ({
      name: e.name,
      method: e.method,
      crc32: e.crc32,
      uncompressedSize: e.uncompressedSize,
    });
    expect(again.entries.map(shape)).toEqual(first.entries.map(shape));
    expect(again.entries.every((e) => e.flags === 0)).toBe(true);
    expect(first.canonical.includes(Buffer.from([0x50, 0x4b, 0x07, 0x08]))).toBe(false);
    expect(first.canonical.readUInt16LE(first.canonical.length - 2)).toBe(0);
    expect((await inspectZip(zip, LIMITS)).canonical.equals(first.canonical)).toBe(true);
  });
});

describe("real exceljs 4.4.0 workbooks", () => {
  const rows = [
    ["question", "option_a", "option_b", "correct"],
    ["Ibu kota Indonesia?", "Jakarta", "Bandung", "a"],
  ];

  async function viaWriteBuffer(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Soal");
    for (const row of rows) sheet.addRow(row);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  async function viaStreamingWriter(): Promise<Buffer> {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: false, useSharedStrings: true });
    const sheet = workbook.addWorksheet("Soal");
    for (const row of rows) sheet.addRow(row).commit();
    sheet.commit();
    await workbook.commit();
    return Buffer.concat(chunks);
  }

  it.each([
    ["writeBuffer", viaWriteBuffer],
    ["streaming WorkbookWriter (data descriptors)", viaStreamingWriter],
  ])("accepts %s output, and exceljs reads the canonical copy back", async (_label, make) => {
    const file = await make();
    const { canonical } = await inspectZip(file, LIMITS);
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(canonical as unknown as ArrayBuffer);
    expect(loaded.getWorksheet("Soal")?.getCell("A2").value).toBe("Ibu kota Indonesia?");
    expect(loaded.getWorksheet("Soal")?.getCell("B2").value).toBe("Jakarta");
  });
});

// Security re-check INFO (a)/(b), closed here rather than in the LP ZIP story.
describe("inspectZip: entry name encoding", () => {
  it("refuses names that are not valid UTF-8 (two invalid byte strings could decode alike)", async () => {
    const zip = makeZip([{ name: "xl/ab", data: Buffer.from("x") }]);
    const centralOffset = zip.readUInt32LE(zip.length - 22 + 16);
    const patched = Buffer.from(zip);
    patched[30 + 3] = 0xfe; // local name "xl/" + 0xfe + "b"
    patched[centralOffset + 46 + 3] = 0xff; // central name "xl/" + 0xff + "b"
    expect((await zipError(patched)).message).toMatch(/UTF-8/);
    const both = Buffer.from(zip);
    both[30 + 3] = 0xff;
    both[centralOffset + 46 + 3] = 0xff;
    expect((await zipError(both)).message).toMatch(/UTF-8/);
  });

  it("marks non-ASCII names as UTF-8 (flag 0x0800) in the canonical copy, so every parser decodes them alike", async () => {
    const zip = makeZip([
      { name: "xl/media/soal-ü.xml", data: Buffer.from("<a/>") },
      { name: "xl/plain.xml", data: Buffer.from("<b/>") },
    ]);
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0);
    const { canonical } = await inspectZip(zip, LIMITS);
    const entries = (await inspectZip(canonical, LIMITS)).entries;
    expect(entries.map((e) => [e.name, e.flags & 0x0800])).toEqual([
      ["xl/media/soal-ü.xml", 0x0800],
      ["xl/plain.xml", 0],
    ]);
  });
});
