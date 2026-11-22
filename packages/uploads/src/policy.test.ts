// Criterion 3: magic bytes, size caps, image re-encoding and the SVG rule, per upload type.
// Every fixture is generated here (sharp, the ZIP writer in test/); no binaries are committed.
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { makeZip, xlsx } from "../test/zip-fixture.ts";
import { checkUpload, DEFAULT_UPLOAD_LIMITS, sniff, type UploadInput, UploadRejected, type UploadRejectCode } from "./policy.ts";

const MiB = 1024 * 1024;
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const CSV = Buffer.from("\u{FEFF}question,option_a,option_b,correct\nIbu kota Indonesia?,Jakarta,Bandung,a\n");
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const solid = (width = 300, height = 200) =>
  sharp({ create: { width, height, channels: 3, background: { r: 37, g: 99, b: 235 } } });
const jpeg = () => solid().jpeg().toBuffer();
const png = () => solid().png().toBuffer();
const webp = () => solid().webp().toBuffer();

async function rejection(input: UploadInput, limits = DEFAULT_UPLOAD_LIMITS): Promise<UploadRejectCode> {
  try {
    await checkUpload(input, limits);
  } catch (e) {
    expect(e).toBeInstanceOf(UploadRejected);
    return (e as UploadRejected).code;
  }
  throw new Error("expected the upload to be rejected");
}

/** The rejection code, or "accepted". */
async function outcome(input: UploadInput): Promise<UploadRejectCode | "accepted"> {
  try {
    await checkUpload(input);
    return "accepted";
  } catch (e) {
    expect(e).toBeInstanceOf(UploadRejected);
    return (e as UploadRejected).code;
  }
}

/** Bytes of `size` that start with `head` (passes the magic check, trips the size cap). */
const padded = (head: Buffer, size: number): Buffer => Buffer.concat([head, Buffer.alloc(size - head.length, 0x20)]);

describe("PDF (kind pdf)", () => {
  it("accepts a PDF as is", async () => {
    const out = await checkUpload({ kind: "pdf", bytes: PDF, filename: "Ebook Final.PDF", mimeType: "application/pdf" });
    expect(out).toMatchObject({ type: "pdf", contentType: "application/pdf", extension: ".pdf", warnings: [] });
    expect(out.bytes.equals(PDF)).toBe(true);
  });

  it("rejects wrong magic, and an extension or MIME type that disagrees", async () => {
    expect(await rejection({ kind: "pdf", bytes: Buffer.from("PDF-1.7 not really"), filename: "a.pdf" })).toBe("type_not_allowed");
    expect(await rejection({ kind: "pdf", bytes: Buffer.from("\x00%PDF-1.7", "latin1"), filename: "a.pdf" })).toBe("unknown_type");
    expect(await rejection({ kind: "pdf", bytes: await png(), filename: "a.pdf", mimeType: "application/pdf" })).toBe("type_not_allowed");
    expect(await rejection({ kind: "pdf", bytes: PDF, filename: "a.exe" })).toBe("extension_mismatch");
    expect(await rejection({ kind: "pdf", bytes: PDF, filename: "a.pdf.exe" })).toBe("extension_mismatch");
    expect(await rejection({ kind: "pdf", bytes: PDF, filename: "pdf" })).toBe("extension_mismatch");
    expect(await rejection({ kind: "pdf", bytes: PDF, filename: "a.pdf", mimeType: "text/html" })).toBe("mime_mismatch");
  });

  // US-031: the production numbers are pinned here; the 100 MiB boundary runs with the same numbers scaled down in the
  // next test (configurable limits), so this file no longer allocates 200 MiB of PDFs under parallel CI load.
  it("warns above 20 MiB and rejects above the 100 MiB hard cap (defaults)", async () => {
    expect(DEFAULT_UPLOAD_LIMITS).toMatchObject({ pdfWarnBytes: 20 * MiB, pdfMaxBytes: 100 * MiB, xlsxMaxUncompressedBytes: 50 * MiB, xlsxMaxEntries: 1000 });
    // Without limits the defaults apply: the warning threshold, at the byte.
    const big = await checkUpload({ kind: "pdf", bytes: padded(PDF, 20 * MiB + 1), filename: "a.pdf" });
    expect(big.warnings).toEqual(["pdf_large"]);
    expect((await checkUpload({ kind: "pdf", bytes: padded(PDF, 20 * MiB), filename: "a.pdf" })).warnings).toEqual([]);
  });

  it("has a configurable hard cap and warning threshold", async () => {
    const limits = { ...DEFAULT_UPLOAD_LIMITS, pdfWarnBytes: 1000, pdfMaxBytes: 2000 };
    expect((await checkUpload({ kind: "pdf", bytes: padded(PDF, 1500), filename: "a.pdf" }, limits)).warnings).toEqual(["pdf_large"]);
    // Exactly at the hard cap is accepted (with the warning), one byte over is refused.
    expect((await checkUpload({ kind: "pdf", bytes: padded(PDF, 2000), filename: "a.pdf" }, limits)).warnings).toEqual(["pdf_large"]);
    expect(await rejection({ kind: "pdf", bytes: padded(PDF, 2001), filename: "a.pdf" }, limits)).toBe("too_large");
  });
});

describe("images (kind image): JPEG, PNG, WebP", () => {
  it.each([
    ["jpeg", jpeg, "photo.JPG", "image/jpeg"],
    ["jpeg", jpeg, "photo.jpeg", undefined],
    ["png", png, "c:\\fakepath\\shot.png", "image/png"],
    ["webp", webp, "art.webp", "image/webp; charset=binary"],
  ] as const)("re-encodes a valid %s to WebP", async (type, make, filename, mimeType) => {
    const input = await make();
    const out = await checkUpload({ kind: "image", bytes: input, filename, ...(mimeType === undefined ? {} : { mimeType }) });
    expect(out).toMatchObject({ type, contentType: "image/webp", extension: ".webp", warnings: [] });
    const meta = await sharp(out.bytes).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({ format: "webp", width: 300, height: 200 });
    expect(out.bytes.equals(input)).toBe(false);
  });

  it("rejects wrong magic, and an extension or MIME type that disagrees", async () => {
    expect(await rejection({ kind: "image", bytes: Buffer.from("not an image at all"), filename: "a.png" })).toBe("type_not_allowed");
    expect(await rejection({ kind: "image", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), filename: "a.png" })).toBe("unknown_type");
    expect(await rejection({ kind: "image", bytes: await png(), filename: "a.jpg", mimeType: "image/jpeg" })).toBe("extension_mismatch");
    expect(await rejection({ kind: "image", bytes: await png(), filename: "a.png", mimeType: "image/jpeg" })).toBe("mime_mismatch");
    expect(await rejection({ kind: "image", bytes: await jpeg(), filename: "a.webp" })).toBe("extension_mismatch");
    expect(await rejection({ kind: "image", bytes: PDF, filename: "a.pdf" })).toBe("type_not_allowed");
  });

  it("rejects a file with image magic that does not decode", async () => {
    const truncated = (await png()).subarray(0, 40);
    expect(await rejection({ kind: "image", bytes: truncated, filename: "a.png" })).toBe("invalid_image");
    const fakeWebp = Buffer.concat([Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1"), Buffer.alloc(16)]);
    expect(await rejection({ kind: "image", bytes: fakeWebp, filename: "a.webp" })).toBe("invalid_image");
  });

  it("rejects over 5 MiB before decoding", async () => {
    const head = await png();
    expect(await rejection({ kind: "image", bytes: padded(head, 5 * MiB + 1), filename: "a.png" })).toBe("too_large");
    expect(await outcome({ kind: "image", bytes: padded(head, 5 * MiB), filename: "a.png" })).not.toBe("too_large");
  });

  it("strips EXIF (incl. GPS) and applies the orientation", async () => {
    const tagged = await solid()
      .jpeg()
      .withExif({
        IFD0: { Copyright: "SECRET-OWNER-NAME", Artist: "SECRET-ARTIST" },
        IFD3: { GPSLatitudeRef: "S", GPSLatitude: "6/1 12/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "106/1 49/1 0/1" },
      })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const before = await sharp(tagged).metadata();
    expect(before.exif?.includes("SECRET-OWNER-NAME")).toBe(true);
    // The GPS IFD pointer (tag 0x8825), in either byte order.
    const gpsPointer = [Buffer.from([0x88, 0x25]), Buffer.from([0x25, 0x88])];
    expect(gpsPointer.some((tag) => before.exif?.includes(tag) === true)).toBe(true);
    expect(before.orientation).toBe(6);

    const out = await checkUpload({ kind: "image", bytes: tagged, filename: "a.jpg" });
    const after = await sharp(out.bytes).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect({ width: after.width, height: after.height }).toEqual({ width: 200, height: 300 }); // rotated 90 degrees
    for (const marker of ["SECRET-OWNER-NAME", "SECRET-ARTIST", "Exif", "EXIF"]) expect(out.bytes.includes(marker)).toBe(false);
  });

  it("strips EXIF from PNG and WebP too", async () => {
    for (const make of [() => solid().png(), () => solid().webp()]) {
      const tagged = await make().withExif({ IFD0: { Copyright: "SECRET-OWNER-NAME" } }).toBuffer();
      expect((await sharp(tagged).metadata()).exif?.includes("SECRET-OWNER-NAME")).toBe(true);
      const out = await checkUpload({ kind: "image", bytes: tagged, filename: tagged[0] === 0x89 ? "a.png" : "a.webp" });
      expect((await sharp(out.bytes).metadata()).exif).toBeUndefined();
      expect(out.bytes.includes("SECRET-OWNER-NAME")).toBe(false);
    }
  });

  it("scales a large image down to the dimension cap", async () => {
    const out = await checkUpload({ kind: "image", bytes: await jpeg(), filename: "a.jpg" }, { ...DEFAULT_UPLOAD_LIMITS, imageMaxDimension: 64 });
    const meta = await sharp(out.bytes).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 64, height: 43 });
  });

  // Decompression bomb: a tiny PNG whose header claims 15000 x 15000 = 225 MP (under sharp's own
  // default limit of 268 MP) is refused by the policy's pixel limit before any pixel is decoded.
  it("refuses an image over the input pixel limit (decompression bomb)", async () => {
    const chunk = (type: string, data: Buffer): Buffer => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body));
      return Buffer.concat([length, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(15000, 0);
    ihdr.writeUInt32BE(15000, 4);
    ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
    const bomb = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(Buffer.alloc(15001 * 4))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(bomb.length).toBeLessThan(1024);
    let error: unknown;
    try {
      await checkUpload({ kind: "image", bytes: bomb, filename: "bomb.png" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UploadRejected);
    expect((error as UploadRejected).code).toBe("invalid_image");
    expect((error as UploadRejected).message).toMatch(/pixel limit/i);
    const small = { ...DEFAULT_UPLOAD_LIMITS, imageMaxInputPixels: 300 * 199 };
    expect(await rejection({ kind: "image", bytes: await png(), filename: "a.png" }, small)).toBe("invalid_image");
  });
});

describe("SVG", () => {
  it("is rejected everywhere outside an LP ZIP, by content, extension or MIME type", async () => {
    for (const kind of ["image", "pdf", "import", "proof"] as const) {
      expect(await rejection({ kind, bytes: SVG, filename: "logo.svg", mimeType: "image/svg+xml" })).toBe("svg_not_allowed");
      expect(await rejection({ kind, bytes: SVG, filename: "logo.png" })).toBe("svg_not_allowed");
      expect(await rejection({ kind, bytes: await png(), filename: "logo.svg" })).toBe("svg_not_allowed");
      expect(await rejection({ kind, bytes: await png(), filename: "logo.png", mimeType: "image/svg+xml" })).toBe("svg_not_allowed");
    }
    const bare = Buffer.from("  <svg viewBox='0 0 1 1'><script>alert(1)</script></svg>");
    expect(await rejection({ kind: "image", bytes: bare, filename: "x.csv" })).toBe("svg_not_allowed");
    const doctype = Buffer.from('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg/>');
    expect(await rejection({ kind: "import", bytes: doctype, filename: "x.csv" })).toBe("svg_not_allowed");
  });

  it("is allowed in the lp_zip context, unchanged and flagged for sanitising", async () => {
    const out = await checkUpload({ kind: "image", bytes: SVG, filename: "assets/logo.svg", mimeType: "image/svg+xml", context: "lp_zip" });
    expect(out).toMatchObject({ type: "svg", contentType: "image/svg+xml", extension: ".svg", warnings: ["svg_needs_sanitizing"] });
    expect(out.bytes.equals(SVG)).toBe(true);
    expect(await rejection({ kind: "image", bytes: SVG, filename: "logo.png", context: "lp_zip" })).toBe("extension_mismatch");
    expect(await rejection({ kind: "pdf", bytes: SVG, filename: "logo.svg", context: "lp_zip" })).toBe("type_not_allowed");
  });

  it("other markup is never sniffed as CSV or SVG", async () => {
    for (const markup of ["<html><body><svg/></body></html>", "<?xml version='1.0'?><root/>", "<!-- open", "<?xml never closed"]) {
      expect(sniff(Buffer.from(markup))).toBeNull();
      expect(await rejection({ kind: "import", bytes: Buffer.from(markup), filename: "x.csv" })).toBe("unknown_type");
    }
  });
});

describe("CSV (kind import)", () => {
  it("accepts UTF-8 text with or without a BOM", async () => {
    for (const bytes of [CSV, CSV.subarray(3)]) {
      for (const mimeType of ["text/csv", "application/vnd.ms-excel", "text/plain", "application/octet-stream", ""]) {
        const out = await checkUpload({ kind: "import", bytes, filename: "soal.csv", mimeType });
        expect(out).toMatchObject({ type: "csv", contentType: "text/csv", extension: ".csv" });
        expect(out.bytes.equals(bytes)).toBe(true);
      }
    }
  });

  it("rejects NUL bytes, invalid UTF-8 and empty files (wrong magic)", async () => {
    expect(await rejection({ kind: "import", bytes: Buffer.from("a,b\n1,\u{0}2\n"), filename: "a.csv" })).toBe("unknown_type");
    expect(await rejection({ kind: "import", bytes: Buffer.from([0x61, 0x2c, 0xc3, 0x28, 0x0a]), filename: "a.csv" })).toBe("unknown_type");
    expect(await rejection({ kind: "import", bytes: Buffer.from(" \n\t"), filename: "a.csv" })).toBe("unknown_type");
    expect(await rejection({ kind: "import", bytes: Buffer.alloc(0), filename: "a.csv" })).toBe("unknown_type");
  });

  it("rejects an extension or MIME type that disagrees", async () => {
    expect(await rejection({ kind: "import", bytes: CSV, filename: "soal.xlsx", mimeType: XLSX_MIME })).toBe("extension_mismatch");
    expect(await rejection({ kind: "import", bytes: CSV, filename: "soal.csv", mimeType: XLSX_MIME })).toBe("mime_mismatch");
    expect(await rejection({ kind: "import", bytes: CSV, filename: "soal.csv", mimeType: "text/html" })).toBe("mime_mismatch");
    expect(await rejection({ kind: "image", bytes: CSV, filename: "soal.csv" })).toBe("type_not_allowed");
  });

  it("rejects over 5 MiB", async () => {
    expect(await rejection({ kind: "import", bytes: padded(CSV, 5 * MiB + 1), filename: "a.csv" })).toBe("too_large");
    expect((await checkUpload({ kind: "import", bytes: padded(CSV, 5 * MiB), filename: "a.csv" })).type).toBe("csv");
  });
});

describe("XLSX (kind import)", () => {
  it("accepts a ZIP with [Content_Types].xml and an xl/ part", async () => {
    const out = await checkUpload({ kind: "import", bytes: xlsx(), filename: "soal.xlsx", mimeType: XLSX_MIME });
    expect(out).toMatchObject({ type: "xlsx", contentType: XLSX_MIME, extension: ".xlsx", warnings: [] });
  });

  it("rejects wrong magic, a ZIP that is not a workbook, and an extension or MIME type that disagrees", async () => {
    expect(await rejection({ kind: "import", bytes: Buffer.from("PK\x05\x06rest"), filename: "a.xlsx" })).toBe("unknown_type");
    const docx = makeZip([{ name: "[Content_Types].xml", data: Buffer.from("<Types/>") }, { name: "word/document.xml", data: Buffer.from("<w/>") }]);
    expect(await rejection({ kind: "import", bytes: docx, filename: "a.xlsx" })).toBe("invalid_xlsx");
    const noTypes = makeZip([{ name: "xl/workbook.xml", data: Buffer.from("<workbook/>") }]);
    expect(await rejection({ kind: "import", bytes: noTypes, filename: "a.xlsx" })).toBe("invalid_xlsx");
    expect(await rejection({ kind: "import", bytes: Buffer.from("PK\x03\x04 truncated"), filename: "a.xlsx" })).toBe("invalid_xlsx");
    expect(await rejection({ kind: "import", bytes: xlsx(), filename: "a.csv", mimeType: "text/csv" })).toBe("extension_mismatch");
    expect(await rejection({ kind: "import", bytes: xlsx(), filename: "a.xlsx", mimeType: "application/zip" })).toBe("mime_mismatch");
    expect(await rejection({ kind: "image", bytes: xlsx(), filename: "a.xlsx" })).toBe("type_not_allowed");
  });

  it("rejects over 5 MiB on disk", async () => {
    const big = xlsx([{ name: "xl/media/noise.bin", data: Buffer.alloc(5 * MiB + 1, 7), method: 0 }]);
    expect(await rejection({ kind: "import", bytes: big, filename: "a.xlsx" })).toBe("too_large");
  });

  // Builds and inflates about 100 MiB: allow the package's 30 s, not the root run's 5 s default.
  it("rejects a zip bomb: a small file that inflates past 50 MiB, whatever its headers claim", { timeout: 30_000 }, async () => {
    const bomb = xlsx([{ name: "xl/sharedStrings.xml", data: Buffer.alloc(51 * MiB, 0x41), declaredSize: 1024 }]);
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(await rejection({ kind: "import", bytes: bomb, filename: "a.xlsx", mimeType: XLSX_MIME })).toBe("xlsx_too_large_uncompressed");
    const fits = xlsx([{ name: "xl/sharedStrings.xml", data: Buffer.alloc(49 * MiB, 0x41) }]);
    expect((await checkUpload({ kind: "import", bytes: fits, filename: "a.xlsx" })).type).toBe("xlsx");
  });

  it("caps the entry count", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ name: `xl/p${i.toString()}.xml`, data: Buffer.from("<x/>") }));
    expect(await rejection({ kind: "import", bytes: xlsx(many), filename: "a.xlsx" })).toBe("invalid_xlsx");
  });

  it("stores the canonical re-written archive, not the uploaded bytes (security re-check)", async () => {
    const upload = xlsx([{ name: "xl/sharedStrings.xml", data: Buffer.from("<sst/>".repeat(20)), descriptor: "signed" }]);
    const out = await checkUpload({ kind: "import", bytes: upload, filename: "soal.xlsx", mimeType: XLSX_MIME });
    expect(out.bytes.equals(upload)).toBe(false);
    expect(out.bytes.includes(Buffer.from([0x50, 0x4b, 0x07, 0x08]))).toBe(false); // no data descriptor
    // The stored copy is itself a valid XLSX upload, and re-canonicalising it changes nothing.
    const again = await checkUpload({ kind: "import", bytes: out.bytes, filename: "soal.xlsx", mimeType: XLSX_MIME });
    expect(again.bytes.equals(out.bytes)).toBe(true);
  });
});

describe("proof (kind proof): image or PDF, 10 MiB", () => {
  it("accepts a photo or screenshot (re-encoded) and a PDF receipt", async () => {
    expect((await checkUpload({ kind: "proof", bytes: await jpeg(), filename: "transfer.jpg", mimeType: "image/jpeg" })).contentType).toBe("image/webp");
    expect((await checkUpload({ kind: "proof", bytes: await png(), filename: "screenshot.png" })).type).toBe("png");
    expect((await checkUpload({ kind: "proof", bytes: PDF, filename: "receipt.pdf" })).type).toBe("pdf");
  });

  it("rejects other types, wrong magic and disagreeing names", async () => {
    expect(await rejection({ kind: "proof", bytes: CSV, filename: "a.csv" })).toBe("type_not_allowed");
    expect(await rejection({ kind: "proof", bytes: xlsx(), filename: "a.xlsx" })).toBe("type_not_allowed");
    expect(await rejection({ kind: "proof", bytes: Buffer.from([0xff, 0xd8, 0x00, 1, 2]), filename: "a.jpg" })).toBe("unknown_type");
    expect(await rejection({ kind: "proof", bytes: PDF, filename: "a.jpg", mimeType: "image/jpeg" })).toBe("extension_mismatch");
  });

  it("allows up to 10 MiB (above the 5 MiB image cap) and rejects above", async () => {
    const head = await png();
    expect(await rejection({ kind: "proof", bytes: padded(PDF, 10 * MiB + 1), filename: "a.pdf" })).toBe("too_large");
    expect(await rejection({ kind: "proof", bytes: padded(head, 10 * MiB + 1), filename: "a.png" })).toBe("too_large");
    expect((await checkUpload({ kind: "proof", bytes: padded(PDF, 10 * MiB), filename: "a.pdf" })).warnings).toEqual([]);
  });
});

describe("sniff", () => {
  it("identifies each type by its magic bytes only", async () => {
    expect(sniff(PDF)).toBe("pdf");
    expect(sniff(await jpeg())).toBe("jpeg");
    expect(sniff(await png())).toBe("png");
    expect(sniff(await webp())).toBe("webp");
    expect(sniff(xlsx())).toBe("xlsx");
    expect(sniff(SVG)).toBe("svg");
    expect(sniff(CSV)).toBe("csv");
    expect(sniff(Buffer.from("RIFF\x00\x00\x00\x00WAVE", "latin1"))).toBeNull();
    expect(sniff(Buffer.from("PK\x05\x06 empty zip", "latin1"))).toBeNull();
    expect(sniff(Buffer.from("a,b\x0b\n", "latin1"))).toBeNull();
    expect(sniff(Buffer.from("a\tb\r\nc,d\n"))).toBe("csv");
    expect(sniff(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
  });
});

// Security review US-011 #9: sharp has no default decode timeout, and a 50 MP image costs about
// 150 MB of RGB per decode, so a burst of uploads could stall the threadpool or exhaust memory.
describe("image decode limits", () => {
  const imageInput = async (): Promise<UploadInput> => ({ kind: "image", bytes: await jpeg(), filename: "a.jpg", mimeType: "image/jpeg" });
  const proto = sharp.prototype as unknown as { timeout: (o: { seconds: number }) => unknown; toBuffer: () => Promise<Buffer> };

  it("applies the decode timeout to the re-encode pipeline", async () => {
    const spy = vi.spyOn(proto, "timeout");
    try {
      await checkUpload(await imageInput());
      expect(spy).toHaveBeenCalledWith({ seconds: DEFAULT_UPLOAD_LIMITS.imageTimeoutSeconds });
      expect(DEFAULT_UPLOAD_LIMITS.imageTimeoutSeconds).toBe(10);
    } finally {
      spy.mockRestore();
    }
  });

  it("re-encodes at most imageMaxConcurrency images at once", async () => {
    // Fixtures first: generating them also goes through toBuffer.
    const inputs = await Promise.all(Array.from({ length: 6 }, imageInput));
    const original = proto.toBuffer;
    let active = 0;
    let peak = 0;
    const spy = vi.spyOn(proto, "toBuffer").mockImplementation(async function (this: unknown) {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((r) => setTimeout(r, 20));
        return await original.call(this);
      } finally {
        active--;
      }
    });
    try {
      const limits = { ...DEFAULT_UPLOAD_LIMITS, imageMaxConcurrency: 2 };
      const results = await Promise.all(inputs.map((input) => checkUpload(input, limits)));
      expect(results.every((r) => r.contentType === "image/webp")).toBe(true);
      expect(peak).toBeLessThanOrEqual(2);
      expect(peak).toBeGreaterThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });
});
