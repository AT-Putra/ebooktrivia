// The preview of a program's banner picture on the admin page. The admin app serves no file (lib/settings/images.ts), so
// the page embeds the picture itself as a data URI (the console's CSP allows `img-src data:`): the display copy
// images/<upload id>.display.webp (the original while a copy is missing), read from the data directory by a path built from the
// upload id alone (@ebooktrivia/core content-images.ts). The file is opened WITHOUT following a link (O_NOFOLLOW), its type and
// size are read from the OPEN handle (a regular file, within the cap) and the bytes come from that handle, as the public app
// opens what it serves (apps/public lib/safe-file.ts). Anything else (no file, a link, too large, any error) is no preview, never
// a failed page. No sharp here: pages import it.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { contentImagePath, displayImagePath, isUuid } from "@ebooktrivia/core";

/** A display copy of a banner (1344 x 448 at most) is far smaller; a larger file (an original, say) is not inlined in every page load. */
export const PREVIEW_MAX_BYTES = 256 * 1024;

/** Read only, no link followed, no waiting (the two last ones where the platform has them). */
const OPEN_FLAGS: number = constants.O_RDONLY | ((constants.O_NOFOLLOW as number | undefined) ?? 0) | ((constants.O_NONBLOCK as number | undefined) ?? 0);

async function regularFileBytes(path: string): Promise<Buffer | null> {
  try {
    if (!(await lstat(path)).isFile()) return null;
    const handle = await open(path, OPEN_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > PREVIEW_MAX_BYTES) return null;
      const bytes = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(bytes, 0, info.size, 0);
      return bytesRead === info.size ? bytes : null;
    } finally {
      await handle.close();
    }
  } catch {
    // A missing, linked or unreadable file only costs the preview, never the page.
    return null;
  }
}

/** `data:image/webp;base64,...` of the stored banner `uploadId`, or null (no data directory, no file, a link, too large). */
export async function bannerPreviewSrc(dataDir: string | null, uploadId: string): Promise<string | null> {
  if (dataDir === null || !isUuid(uploadId)) return null;
  const bytes = (await regularFileBytes(join(dataDir, displayImagePath(uploadId)))) ?? (await regularFileBytes(join(dataDir, contentImagePath("banner", uploadId))));
  return bytes === null ? null : `data:image/webp;base64,${bytes.toString("base64")}`;
}
