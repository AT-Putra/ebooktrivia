// Upload policy for every upload type (plan M2.5). Decides from the BYTES, never from the name or
// the browser's Content-Type, which may only agree with what the bytes are:
//
//   1. size cap of the upload kind (before any parsing);
//   2. magic-byte sniffing: PDF "%PDF-", JPEG FF D8 FF, PNG 89 "PNG" 0D 0A 1A 0A,
//      WebP "RIFF" .... "WEBP", XLSX = ZIP "PK" 03 04, SVG = text whose root element is <svg>,
//      CSV = valid UTF-8 text (optional BOM) with no NUL or other C0 control except TAB, LF and
//      CR, not starting with markup;
//   3. SVG only in the `lp_zip` context (files inside an LP ZIP, sanitised by the LP ZIP story);
//   4. the sniffed type must be allowed for the kind, and the declared extension and MIME type
//      must agree with it (a missing or application/octet-stream MIME type is "not declared");
//   5. per type: XLSX is a ZIP holding [Content_Types].xml and an xl/ part whose uncompressed
//      size is measured by streaming inflate (zip.ts); images are decoded with a pixel limit
//      and re-encoded with sharp to WebP, auto-oriented, resized to fit the dimension cap,
//      every metadata block (EXIF incl. GPS, XMP, IPTC, ICC) dropped.
//
//   kind     types                         cap (default)
//   pdf      PDF                           warn > 20 MiB, reject > 100 MiB (configurable)
//   image    JPEG, PNG, WebP (+SVG lp_zip)  5 MiB
//   import   CSV, XLSX                      5 MiB; XLSX also 50 MiB uncompressed, 1000 entries
//   proof    JPEG, PNG, WebP, PDF           10 MiB (prize-fulfilment proof: a photo, screenshot or PDF receipt)

// Caller contracts (security review US-011, for later stories):
//   - lp_zip SVGs are returned byte for byte with the warning "svg_needs_sanitizing"; the LP ZIP
//     story must sanitise them, and must make it impossible to store one unsanitised;
//   - PDFs (incl. PDF/HTML polyglots or PDFs with JavaScript) are accepted by magic bytes, so
//     /files must be served from a cookieless origin with X-Content-Type-Options: nosniff and
//     Content-Security-Policy: sandbox, and proof files with Content-Disposition: attachment;
//   - CSV/XLSX cells starting with = + - @ are accepted on import; any export of player-supplied
//     fields (M10 reports) must neutralise them (prefix with ').

import sharp from "sharp";
import {
  capFor,
  checkDeclared,
  DEFAULT_UPLOAD_LIMITS,
  extensionOf,
  type FileType,
  KIND_TYPES,
  normalizeMime,
  sniff,
  TYPES,
  type UploadContext,
  type UploadKind,
  type UploadLimits,
  UploadRejected,
  type UploadWarning,
} from "./sniff.ts";
import { inspectZip, ZipError } from "./zip.ts";

export {
  DEFAULT_UPLOAD_LIMITS,
  type FileType,
  sniff,
  type UploadContext,
  type UploadKind,
  type UploadLimits,
  UploadRejected,
  type UploadRejectCode,
  type UploadWarning,
} from "./sniff.ts";

const IMAGE_TYPES: readonly FileType[] = ["jpeg", "png", "webp"];

export interface UploadInput {
  readonly kind: UploadKind;
  readonly bytes: Uint8Array;
  /** Name as uploaded; only its extension is used (any directory part is ignored). */
  readonly filename: string;
  /** Declared Content-Type, if any. */
  readonly mimeType?: string;
  readonly context?: UploadContext;
}

export interface AcceptedUpload {
  readonly type: FileType;
  /** Content-Type to store and serve the bytes with. */
  readonly contentType: string;
  /** Extension (with the dot) matching `bytes`, e.g. ".webp" for a re-encoded JPEG. */
  readonly extension: string;
  /**
   * What to store: the re-encoded image, the canonical re-written archive for XLSX (the only copy
   * a parser may read), or the original bytes for PDF, CSV and SVG.
   */
  readonly bytes: Buffer;
  readonly warnings: readonly UploadWarning[];
}

/** Validates an XLSX upload and returns the canonical re-written archive (what to store and parse). */
async function checkXlsx(bytes: Buffer, limits: UploadLimits): Promise<Buffer> {
  let names: string[];
  let canonical: Buffer;
  try {
    const inspected = await inspectZip(bytes, {
      maxEntries: limits.xlsxMaxEntries,
      maxUncompressedBytes: limits.xlsxMaxUncompressedBytes,
    });
    names = inspected.entries.map((e) => e.name);
    canonical = inspected.canonical;
  } catch (error) {
    if (error instanceof ZipError && error.code === "too_large_uncompressed") {
      throw new UploadRejected("xlsx_too_large_uncompressed", "the spreadsheet is too large uncompressed");
    }
    if (error instanceof ZipError) throw new UploadRejected("invalid_xlsx", `not a valid XLSX file: ${error.message}`);
    throw error;
  }
  if (!names.includes("[Content_Types].xml") || !names.some((n) => n.startsWith("xl/"))) {
    throw new UploadRejected("invalid_xlsx", "not an XLSX workbook ([Content_Types].xml and xl/ expected)");
  }
  return canonical;
}

// Process-wide re-encode slots (security review US-011 #9). The while loop re-checks after every
// wake-up, so the cap holds even when calls pass different limits.
let activeReencodes = 0;
const reencodeWaiters: (() => void)[] = [];

async function withImageSlot<T>(max: number, fn: () => Promise<T>): Promise<T> {
  if (!Number.isInteger(max) || max < 1) throw new RangeError("imageMaxConcurrency must be a positive integer");
  while (activeReencodes >= max) {
    await new Promise<void>((resolve) => {
      reencodeWaiters.push(resolve);
    });
  }
  activeReencodes++;
  try {
    return await fn();
  } finally {
    activeReencodes--;
    reencodeWaiters.shift()?.();
  }
}

async function reencodeImage(bytes: Buffer, type: FileType, limits: UploadLimits): Promise<Buffer> {
  const options = { limitInputPixels: limits.imageMaxInputPixels, failOn: "error", animated: false } as const;
  return withImageSlot(limits.imageMaxConcurrency, async () => {
    try {
      const { format } = await sharp(bytes, options).metadata();
      if (format !== type) throw new UploadRejected("invalid_image", `decoded as ${format}, not ${type}`);
      // No keepMetadata()/withMetadata(): sharp writes no EXIF, XMP, IPTC or ICC block.
      return await sharp(bytes, options)
        .timeout({ seconds: limits.imageTimeoutSeconds })
        .autoOrient()
        .resize({ width: limits.imageMaxDimension, height: limits.imageMaxDimension, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
    } catch (error) {
      if (error instanceof UploadRejected) throw error;
      throw new UploadRejected("invalid_image", `the image cannot be decoded within the limits: ${(error as Error).message}`);
    }
  });
}

/** Applies the policy; throws UploadRejected, or returns what to store. */
export async function checkUpload(input: UploadInput, limits: UploadLimits = DEFAULT_UPLOAD_LIMITS): Promise<AcceptedUpload> {
  const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const context = input.context ?? "upload";
  const mime = normalizeMime(input.mimeType);

  const cap = capFor(input.kind, limits);
  if (bytes.length > cap) throw new UploadRejected("too_large", `over the ${input.kind} limit of ${cap.toString()} bytes`);

  const declaredSvg = extensionOf(input.filename) === ".svg" || mime === "image/svg+xml";
  const type = sniff(bytes);
  if ((type === "svg" || declaredSvg) && context !== "lp_zip") {
    throw new UploadRejected("svg_not_allowed", "SVG is allowed only inside a landing-page ZIP");
  }
  if (type === null) throw new UploadRejected("unknown_type", "the content is not a supported file type");
  if (!KIND_TYPES[input.kind].includes(type)) throw new UploadRejected("type_not_allowed", `${type} is not allowed for ${input.kind}`);
  checkDeclared(type, input.filename, mime);

  const warnings: UploadWarning[] = [];
  if (type === "pdf" && bytes.length > limits.pdfWarnBytes) warnings.push("pdf_large");
  if (type === "svg") warnings.push("svg_needs_sanitizing");
  if (IMAGE_TYPES.includes(type)) {
    return { type, contentType: "image/webp", extension: ".webp", bytes: await reencodeImage(bytes, type, limits), warnings };
  }
  // XLSX: store (and later parse with exceljs) only the canonical re-written archive.
  const stored = type === "xlsx" ? await checkXlsx(bytes, limits) : bytes;
  return { type, contentType: TYPES[type].mimeTypes[0] ?? "application/octet-stream", extension: TYPES[type].extensions[0] ?? "", bytes: stored, warnings };
}
