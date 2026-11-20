import { describe, expect, it } from "vitest";
import { checkPdf, PDF_HEAD_BYTES } from "./pdf.ts";
import { checkUpload, DEFAULT_UPLOAD_LIMITS, UploadRejected } from "./policy.ts";

const pdf = (size: number): Buffer => {
  const b = Buffer.alloc(size, 0x20);
  b.write("%PDF-1.7\n", 0, "latin1");
  return b;
};
const limits = { ...DEFAULT_UPLOAD_LIMITS, pdfWarnBytes: 1000, pdfMaxBytes: 5000 };

async function viaPolicy(bytes: Buffer, filename: string, mimeType?: string): Promise<unknown> {
  try {
    const r = await checkUpload({ kind: "pdf", bytes, filename, ...(mimeType === undefined ? {} : { mimeType }) }, limits);
    return { contentType: r.contentType, extension: r.extension, warnings: r.warnings };
  } catch (error) {
    return error instanceof UploadRejected ? error.code : error;
  }
}

function viaHead(bytes: Buffer, filename: string, mimeType?: string): unknown {
  try {
    return checkPdf({ head: bytes.subarray(0, PDF_HEAD_BYTES), size: bytes.length, filename, ...(mimeType === undefined ? {} : { mimeType }) }, limits);
  } catch (error) {
    return error instanceof UploadRejected ? error.code : error;
  }
}

describe("checkPdf (head + size) agrees with checkUpload for kind pdf", () => {
  const html = Buffer.from("<html><script>alert(1)</script></html>");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  it.each([
    ["a small PDF", pdf(500), "e.pdf", "application/pdf"],
    ["a large PDF (warning)", pdf(2000), "e.PDF", undefined],
    ["over the cap", pdf(5001), "e.pdf", undefined],
    ["HTML named .pdf", html, "e.pdf", undefined],
    ["an SVG", svg, "e.pdf", undefined],
    ["a PDF named .svg", pdf(500), "e.svg", undefined],
    ["a PDF declared as SVG", pdf(500), "e.pdf", "image/svg+xml"],
    ["a PDF named .txt", pdf(500), "e.txt", undefined],
    ["a PDF declared as HTML", pdf(500), "e.pdf", "text/html"],
    ["a PNG named .pdf", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), "e.pdf", undefined],
    ["octet-stream declared", pdf(500), String.raw`dir\e.pdf`, "application/octet-stream"],
  ])("%s", async (_what, bytes, filename, mime) => {
    expect(viaHead(bytes, filename, mime)).toEqual(await viaPolicy(bytes, filename, mime));
  });

  it("refuses a head shorter than it needs and a bad size", () => {
    expect(() => checkPdf({ head: pdf(10), size: 100_000, filename: "e.pdf" })).toThrow(RangeError);
    expect(() => checkPdf({ head: pdf(10), size: -1, filename: "e.pdf" })).toThrow(RangeError);
  });
});
