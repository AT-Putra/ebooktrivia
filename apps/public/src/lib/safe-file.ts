// Opening a file the app serves from the data directory (lib/files.ts, lib/play/images.ts), without ever following a link and
// without ever blocking on something that is not a file: a symbolic link at the file's own name (planted by anyone who could write
// the data directory) must not lead the route to another file, and a FIFO there must not hang a request until a writer appears.
// What lstat says about the name must be "a regular file" first (a link, a directory, a FIFO, a socket or a device is none); the
// file is then opened WITHOUT following a link (O_NOFOLLOW: ELOOP when its last component is one) and WITHOUT blocking
// (O_NONBLOCK: a FIFO swapped in after the check opens at once instead of waiting), its type is read again from the OPEN handle
// (fstat, so a swap between the check and the open changes nothing) and the bytes are streamed from that handle. Windows
// (development only) has neither flag, but the lstat check holds there too.
import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";

export interface OpenedFile {
  /** Closed by the stream made from it (handle.createReadStream), or by `close()` when the body is not sent. */
  readonly handle: FileHandle;
  readonly size: number;
}

const NOT_THERE = new Set(["ENOENT", "ENOTDIR", "ELOOP", "EISDIR"]);

/** The file system calls used (the real ones; a test passes fakes to cover what its platform cannot do, such as a link on Windows). */
export interface FileOps {
  /** Does not follow a link: a link is not a file. */
  readonly lstat: (file: string) => Promise<{ readonly isFile: () => boolean }>;
  readonly open: (file: string, flags: number) => Promise<FileHandle>;
}

const REAL_OPS: FileOps = { lstat, open };

/** The flags a served file is opened with: read only, no link followed, no waiting (the two last ones where the platform has them). */
export const OPEN_FLAGS: number = constants.O_RDONLY | ((constants.O_NOFOLLOW as number | undefined) ?? 0) | ((constants.O_NONBLOCK as number | undefined) ?? 0);

/**
 * The regular file at `file`, open for reading, or null when there is none: missing, a symbolic link, a directory, a FIFO or anything
 * else that is not a regular file. Any other failure (permissions, I/O) is thrown.
 */
export async function openRegularFile(file: string, ops: FileOps = REAL_OPS): Promise<OpenedFile | null> {
  let handle: FileHandle | undefined;
  try {
    if (!(await ops.lstat(file)).isFile()) return null;
    handle = await ops.open(file, OPEN_FLAGS);
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      return null;
    }
    return { handle, size: info.size };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && NOT_THERE.has(code)) return null;
    throw error;
  }
}
