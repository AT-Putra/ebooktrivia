// The PDF-only upload check (code review US-017 L7), without sharp: the same rules checkUpload
// applies to kind "pdf" (size cap, SVG refusal, magic bytes, declared extension / MIME type, the
// large-file warning), decided from the size and the first PDF_HEAD_BYTES of the file. The admin
// app streams a chunked upload through a hash and keeps only this head, so a 100 MiB PDF is never
// held in memory (security review US-017 M2). pdf.test.ts checks it agrees with checkUpload.
import { checkDeclared, DEFAULT_UPLOAD_LIMITS, extensionOf, normalizeMime, sniff, TYPES, type UploadLimits, UploadRejected, type UploadWarning } from "./sniff.ts";

/** Enough of the head for the magic bytes ("%PDF-") and any text sniffing. */
export const PDF_HEAD_BYTES = 4096;

export interface PdfCheckInput {
  /** The first bytes of the file (at least min(size, PDF_HEAD_BYTES)). */
  readonly head: Uint8Array;
  /** The size of the whole file in bytes. */
  readonly size: number;
  readonly filename: string;
  readonly mimeType?: string;
}

export interface AcceptedPdf {
  readonly contentType: string;
  readonly extension: string;
  readonly warnings: readonly UploadWarning[];
}

export { DEFAULT_UPLOAD_LIMITS, type UploadLimits, UploadRejected, type UploadRejectCode, type UploadWarning } from "./sniff.ts";

/** Throws UploadRejected, or returns how to store and label the PDF. */
export function checkPdf(input: PdfCheckInput, limits: UploadLimits = DEFAULT_UPLOAD_LIMITS): AcceptedPdf {
  if (!Number.isSafeInteger(input.size) || input.size < 0) throw new RangeError("size must be a non-negative integer");
  if (input.head.length < Math.min(input.size, PDF_HEAD_BYTES)) throw new RangeError("head is shorter than PDF_HEAD_BYTES");
  if (input.size > limits.pdfMaxBytes) throw new UploadRejected("too_large", `over the pdf limit of ${limits.pdfMaxBytes.toString()} bytes`);
  const mime = normalizeMime(input.mimeType);
  const head = Buffer.from(input.head.buffer, input.head.byteOffset, Math.min(input.head.byteLength, PDF_HEAD_BYTES));
  const type = sniff(head);
  if (type === "svg" || extensionOf(input.filename) === ".svg" || mime === "image/svg+xml") {
    throw new UploadRejected("svg_not_allowed", "SVG is allowed only inside a landing-page ZIP");
  }
  if (type === null) throw new UploadRejected("unknown_type", "the content is not a supported file type");
  if (type !== "pdf") throw new UploadRejected("type_not_allowed", `${type} is not allowed for pdf`);
  checkDeclared(type, input.filename, mime);
  return {
    contentType: TYPES.pdf.mimeTypes[0] ?? "application/pdf",
    extension: TYPES.pdf.extensions[0] ?? ".pdf",
    warnings: input.size > limits.pdfWarnBytes ? ["pdf_large"] : [],
  };
}
