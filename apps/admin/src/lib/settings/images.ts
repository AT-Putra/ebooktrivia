// Content images (US-018): a question's image, a trivia set's thumbnail, a prize tier's image.
//
// The upload policy (@ebooktrivia/uploads checkUpload, kind "image") decides from the BYTES: magic
// bytes (JPEG, PNG or WebP; SVG refused outside landing-page ZIPs), the declared name and type must
// agree, then sharp decodes it under a pixel limit and re-encodes it to WebP with every metadata
// block (EXIF incl. GPS, XMP, IPTC, ICC) dropped, which also neutralises polyglots: only freshly
// encoded pixels are stored. Cap: IMAGE_MAX_BYTES as uploaded (one request, Caddy's 30 s body
// timeout: 2 MiB is ~17 s at 1 Mbit/s), at most IMAGE_MAX_INPUT_PIXELS decoded (security review
// US-018 M1: a 4096 x 4096 RGBA decode is already 64 MiB), longest side scaled to IMAGE_MAX_DIMENSION.
// Callers check the role and the lock BEFORE storeImage (code review US-018 F8), so a refused upload
// costs no re-encode and no disk write; lib/settings/image-link.ts links the stored file (it loads
// no sharp, so pages and actions never do).
//
// Storage follows the ebook PDFs (lib/settings/uploads.ts): <ADMIN_DATA_DIR>/images/<upload id>.webp,
// written exclusively ("wx") before the transaction that inserts its uploads row and links it, and
// removed again if that transaction fails. The admin app never serves the file. Serving images to
// players (api / play origin with nosniff) is M9; until then they are stored only. A replaced or
// removed image keeps its file and uploads row (a cloned program may still use it); cleaning up
// unreferenced images is a follow-up.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeFileName } from "@ebooktrivia/core";
import { checkUpload, DEFAULT_UPLOAD_LIMITS, UploadRejected } from "@ebooktrivia/uploads";
import type { SettingsConfig } from "./env.ts";
import { InvalidInput, singleLine } from "./fields.ts";
import type { ImageFile, StoredImage } from "./image-link.ts";

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_DIMENSION = 2048;
export const IMAGE_MAX_INPUT_PIXELS = 16_000_000;

/** The upload policy limits content images are checked with. */
export const IMAGE_LIMITS = Object.freeze({
  ...DEFAULT_UPLOAD_LIMITS,
  imageMaxBytes: IMAGE_MAX_BYTES,
  imageMaxDimension: IMAGE_MAX_DIMENSION,
  imageMaxInputPixels: IMAGE_MAX_INPUT_PIXELS,
});

const REJECTIONS: Readonly<Partial<Record<UploadRejected["code"], string>>> = {
  too_large: "The image is larger than 2 MB.",
  svg_not_allowed: "SVG images are not accepted: use JPEG, PNG or WebP.",
  extension_mismatch: "The file name's extension does not match the image (use .jpg, .png or .webp).",
  mime_mismatch: "The file type does not match the image.",
  invalid_image: "The image cannot be read. Save it again as JPEG, PNG or WebP and retry.",
};

/** The original file name as sent (URL-encoded header value), checked like an attachment name. */
export function parseFilename(raw: string | null): string {
  const decoded = ((): string => {
    try {
      return decodeURIComponent(raw ?? "");
    } catch {
      throw new InvalidInput("The file name is not valid.");
    }
  })();
  const name = singleLine(decoded, "The file name is up to 128 characters.", { max: 128 });
  if (!isSafeFileName(name)) throw new InvalidInput('The file name may not contain / \\ : * ? " < > | or quotes, nor start with a dot. Rename the file and try again.');
  return name;
}

/** Checks and re-encodes the image, then writes it under the data directory (no database yet). */
export async function storeImage(settings: SettingsConfig, file: ImageFile): Promise<StoredImage> {
  if (settings.dataDir === null) throw new InvalidInput("Uploads are not configured on the server (ADMIN_DATA_DIR).");
  let encoded: Buffer;
  try {
    const accepted = await checkUpload({ kind: "image", bytes: file.bytes, filename: file.filename, mimeType: file.mimeType }, IMAGE_LIMITS);
    encoded = accepted.bytes;
  } catch (error) {
    if (!(error instanceof UploadRejected)) throw error;
    throw new InvalidInput(REJECTIONS[error.code] ?? "This file is not a JPEG, PNG or WebP image.");
  }
  const uploadId = randomUUID();
  const storagePath = `images/${uploadId}.webp`;
  const path = join(settings.dataDir, storagePath);
  await mkdir(join(settings.dataDir, "images"), { recursive: true });
  await writeFile(path, encoded, { flag: "wx", mode: 0o640 });
  return {
    uploadId,
    storagePath,
    sizeBytes: encoded.length,
    sha256: createHash("sha256").update(encoded).digest(),
    filename: file.filename,
    discard: () => rm(path, { force: true }),
  };
}
