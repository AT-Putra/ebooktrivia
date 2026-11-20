// The upload policy's sharp-free part (split from policy.ts in US-017, code review L7): limits,
// error codes, magic-byte sniffing and the declared-type check. pdf.ts (the PDF-only subpath the
// admin app loads) and policy.ts build on it.
import { extname, win32 } from "node:path";

const MiB = 1024 * 1024;

export type UploadKind = "pdf" | "image" | "import" | "proof";
/** `lp_zip`: a file inside an uploaded landing-page ZIP (the only place SVG is allowed). */
export type UploadContext = "upload" | "lp_zip";
export type FileType = "pdf" | "jpeg" | "png" | "webp" | "svg" | "csv" | "xlsx";

export interface UploadLimits {
  readonly pdfWarnBytes: number;
  readonly pdfMaxBytes: number;
  readonly imageMaxBytes: number;
  readonly importMaxBytes: number;
  readonly xlsxMaxUncompressedBytes: number;
  readonly xlsxMaxEntries: number;
  readonly proofMaxBytes: number;
  /** sharp limitInputPixels: width x height of the decoded input (decompression bombs). */
  readonly imageMaxInputPixels: number;
  /** Longest side of a re-encoded image; larger images are scaled down to fit. */
  readonly imageMaxDimension: number;
  /** sharp timeout per pipeline (decode + re-encode); a hostile image cannot hold a thread longer. */
  readonly imageTimeoutSeconds: number;
  /**
   * Images re-encoded at the same time in this process (a 50 MP decode is ~150 MB of RGB). Further
   * uploads wait for a slot instead of piling onto the libuv threadpool.
   */
  readonly imageMaxConcurrency: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = Object.freeze({
  pdfWarnBytes: 20 * MiB,
  pdfMaxBytes: 100 * MiB,
  imageMaxBytes: 5 * MiB,
  importMaxBytes: 5 * MiB,
  xlsxMaxUncompressedBytes: 50 * MiB,
  xlsxMaxEntries: 1000,
  proofMaxBytes: 10 * MiB,
  imageMaxInputPixels: 50_000_000,
  imageMaxDimension: 4096,
  imageTimeoutSeconds: 10,
  imageMaxConcurrency: 2,
});

export type UploadRejectCode =
  | "too_large"
  | "unknown_type"
  | "type_not_allowed"
  | "extension_mismatch"
  | "mime_mismatch"
  | "svg_not_allowed"
  | "invalid_xlsx"
  | "xlsx_too_large_uncompressed"
  | "invalid_image";

export class UploadRejected extends Error {
  readonly code: UploadRejectCode;
  constructor(code: UploadRejectCode, message: string) {
    super(message);
    this.name = "UploadRejected";
    this.code = code;
  }
}

export type UploadWarning = "pdf_large" | "svg_needs_sanitizing";

interface TypeInfo {
  readonly extensions: readonly string[];
  readonly mimeTypes: readonly string[];
}

export const TYPES: Readonly<Record<FileType, TypeInfo>> = {
  pdf: { extensions: [".pdf"], mimeTypes: ["application/pdf", "application/x-pdf"] },
  jpeg: { extensions: [".jpg", ".jpeg"], mimeTypes: ["image/jpeg", "image/pjpeg"] },
  png: { extensions: [".png"], mimeTypes: ["image/png"] },
  webp: { extensions: [".webp"], mimeTypes: ["image/webp"] },
  svg: { extensions: [".svg"], mimeTypes: ["image/svg+xml"] },
  // Browsers on Windows with Excel installed send application/vnd.ms-excel for .csv.
  csv: {
    extensions: [".csv"],
    mimeTypes: ["text/csv", "application/csv", "text/comma-separated-values", "text/plain", "application/vnd.ms-excel"],
  },
  xlsx: { extensions: [".xlsx"], mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] },
};

export const KIND_TYPES: Readonly<Record<UploadKind, readonly FileType[]>> = {
  pdf: ["pdf"],
  image: ["jpeg", "png", "webp", "svg"],
  import: ["csv", "xlsx"],
  proof: ["jpeg", "png", "webp", "pdf"],
};

const UNDECLARED_MIME = ["", "application/octet-stream"];

export function capFor(kind: UploadKind, limits: UploadLimits): number {
  switch (kind) {
    case "pdf":
      return limits.pdfMaxBytes;
    case "image":
      return limits.imageMaxBytes;
    case "import":
      return limits.importMaxBytes;
    case "proof":
      return limits.proofMaxBytes;
  }
}

const startsWith = (bytes: Buffer, prefix: readonly number[] | string, at = 0): boolean => {
  const want = typeof prefix === "string" ? Buffer.from(prefix, "latin1") : Buffer.from(prefix);
  return bytes.length >= at + want.length && bytes.subarray(at, at + want.length).equals(want);
};

/** SVG when, after XML declarations, comments and a doctype, the root element is <svg>. */
function isSvgText(text: string): boolean {
  let rest = text.trimStart();
  for (;;) {
    const close = rest.startsWith("<?") ? "?>" : rest.startsWith("<!--") ? "-->" : /^<!doctype/i.test(rest) ? ">" : null;
    if (close === null) break;
    const end = rest.indexOf(close);
    if (end < 0) return false;
    rest = rest.slice(end + close.length).trimStart();
  }
  return /^<svg[\s/>]/i.test(rest);
}

/** C0 controls other than TAB, LF and CR (NUL included) never occur in CSV text. UTF-8 never
 * encodes another character with a byte below 0x80, so a byte scan is exact. */
const isBinaryControl = (byte: number): boolean => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d;

function sniffText(bytes: Buffer): FileType | null {
  if (bytes.some(isBinaryControl)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); // drops a leading BOM
  } catch {
    return null;
  }
  if (text.trimStart().startsWith("<")) return isSvgText(text) ? "svg" : null; // other markup: never CSV
  return text.trim() === "" ? null : "csv";
}

/** The file type the bytes really are, or null. */
export function sniff(bytes: Buffer): FileType | null {
  if (startsWith(bytes, "%PDF-")) return "pdf";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return "webp";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "xlsx"; // a ZIP; inspected below
  return sniffText(bytes);
}

export const normalizeMime = (mime: string | undefined): string => (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
export const extensionOf = (filename: string): string => extname(win32.basename(filename)).toLowerCase();

export function checkDeclared(type: FileType, filename: string, mime: string): void {
  if (!TYPES[type].extensions.includes(extensionOf(filename))) {
    throw new UploadRejected("extension_mismatch", `the file extension does not match its content (${type})`);
  }
  if (!UNDECLARED_MIME.includes(mime) && !TYPES[type].mimeTypes.includes(mime)) {
    throw new UploadRejected("mime_mismatch", `the declared type ${mime} does not match its content (${type})`);
  }
}
