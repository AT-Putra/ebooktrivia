// Linking a stored content image (US-018; lib/settings/images.ts stores it). No sharp here: pages and
// server actions import this module (to remove an image, say) without loading the image pipeline.
import type { Tx } from "../audit.ts";

export interface ImageFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
}

export interface StoredImage {
  readonly uploadId: string;
  readonly storagePath: string;
  readonly sizeBytes: number;
  readonly sha256: Buffer;
  readonly filename: string;
  /** Removes the file (the linking transaction failed). */
  readonly discard: () => Promise<void>;
}

/** Inserts the uploads row of a stored image (in the linking transaction). */
export async function insertImageRow(tx: Tx, image: StoredImage, adminUserId: string): Promise<void> {
  await tx`
    INSERT INTO public.uploads (id, kind, storage_path, original_filename, content_type, size_bytes, sha256, created_by_admin_user_id)
    VALUES (${image.uploadId}, 'image', ${image.storagePath}, ${image.filename}, 'image/webp', ${image.sizeBytes}, ${image.sha256}, ${adminUserId})`;
}

/** Runs `link` (the audited transaction); removes the stored file if it fails. */
export async function linkImage<T>(image: StoredImage, link: () => Promise<T>): Promise<T> {
  try {
    return await link();
  } catch (error) {
    await image.discard();
    throw error;
  }
}
