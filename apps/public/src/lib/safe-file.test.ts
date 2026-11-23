// openRegularFile: the file is opened without following a link and without blocking, and its type is read from the open handle.
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireOrSkip } from "../../test/capabilities.ts";
import { type FileOps, OPEN_FLAGS, openRegularFile } from "./safe-file.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ebt-safe-file-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Whether this machine may create a symbolic link (Windows needs a privilege; the VM and CI do). */
async function canSymlink(): Promise<boolean> {
  const target = join(dir, "probe-target");
  await writeFile(target, "x");
  try {
    await symlink(target, join(dir, "probe-link"));
    return true;
  } catch {
    return false;
  }
}

/** Makes a FIFO at `path` where the platform has mkfifo (not Windows). */
function makeFifo(path: string): boolean {
  try {
    execFileSync("mkfifo", [path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("openRegularFile", () => {
  it("opens a regular file with its size, for reading from the handle", async () => {
    await writeFile(join(dir, "a.webp"), "hello");
    const opened = await openRegularFile(join(dir, "a.webp"));
    expect(opened?.size).toBe(5);
    expect((await opened?.handle.readFile())?.toString()).toBe("hello");
    await opened?.handle.close();
  });

  it("is null for a missing file, a missing directory and a directory", async () => {
    await mkdir(join(dir, "folder"));
    expect(await openRegularFile(join(dir, "nope.webp"))).toBeNull();
    expect(await openRegularFile(join(dir, "nodir", "nope.webp"))).toBeNull();
    expect(await openRegularFile(join(dir, "folder"))).toBeNull();
  });

  it("refuses a symbolic link at the file's name, never reading what it points at (the real thing, where the machine can make one; CI must)", async (context) => {
    requireOrSkip(context, await canSymlink(), "this machine cannot create symbolic links (Windows without the privilege)");
    await writeFile(join(dir, "secret.txt"), "not an image");
    await symlink(join(dir, "secret.txt"), join(dir, "linked.webp"));
    expect(await openRegularFile(join(dir, "linked.webp"))).toBeNull();
    // A link to a directory, and a dangling one.
    await symlink(join(dir, "folder"), join(dir, "linked-folder"));
    expect(await openRegularFile(join(dir, "linked-folder"))).toBeNull();
    await symlink(join(dir, "nope"), join(dir, "dangling.webp"));
    expect(await openRegularFile(join(dir, "dangling.webp"))).toBeNull();
  });

  it("answers null at once for a FIFO instead of waiting for a writer (the real thing, where the machine has mkfifo; CI must)", async (context) => {
    const fifo = join(dir, "pipe.webp");
    requireOrSkip(context, makeFifo(fifo), "this machine has no mkfifo (Windows)");
    const hung = new Promise<"hung">((resolve) => {
      setTimeout(() => {
        resolve("hung");
      }, 3000);
    });
    const outcome = await Promise.race([openRegularFile(fifo), hung]);
    expect(outcome).toBeNull();
  });

  it("opens read-only, without following a link and without blocking, where the platform has those flags", () => {
    expect(OPEN_FLAGS & constants.O_RDONLY).toBe(constants.O_RDONLY);
    expect(OPEN_FLAGS & ((constants.O_NOFOLLOW as number | undefined) ?? 0)).toBe((constants.O_NOFOLLOW as number | undefined) ?? 0);
    expect(OPEN_FLAGS & ((constants.O_NONBLOCK as number | undefined) ?? 0)).toBe((constants.O_NONBLOCK as number | undefined) ?? 0);
  });

  describe("with the platform's answers faked", () => {
    const handleOf = (isFile: boolean, size = 1) => ({ stat: () => Promise.resolve({ isFile: () => isFile, size }), close: vi.fn(() => Promise.resolve()) });
    const asFile = (isFile: boolean) => () => Promise.resolve({ isFile: () => isFile });

    it("refuses what lstat says is not a regular file (a link, a FIFO, a socket, a device) without opening it", async () => {
      const open = vi.fn();
      const ops = { lstat: asFile(false), open } as unknown as FileOps;
      expect(await openRegularFile("/data/images/x.webp", ops)).toBeNull();
      expect(open).not.toHaveBeenCalled();
    });

    it("opens with the no-follow, no-block flags, and answers null for the ELOOP of a link raced in after the check", async () => {
      const flags: number[] = [];
      const ops = {
        lstat: asFile(true),
        open: (_file: string, flag: number) => {
          flags.push(flag);
          return Promise.reject(Object.assign(new Error("loop"), { code: "ELOOP" }));
        },
      } as unknown as FileOps;
      expect(await openRegularFile("/data/images/x.webp", ops)).toBeNull();
      expect(flags).toEqual([OPEN_FLAGS]);
    });

    it("closes the handle and answers null when what it opened is not a regular file (fstat, not a path check)", async () => {
      const handle = handleOf(false);
      const ops = { lstat: asFile(true), open: () => Promise.resolve(handle) } as unknown as FileOps;
      expect(await openRegularFile("/data/images/x.webp", ops)).toBeNull();
      expect(handle.close).toHaveBeenCalledTimes(1);
    });

    it("throws every other failure (permissions, I/O): the caller answers 503, not a 404 that hides a broken mount", async () => {
      const ops = { lstat: () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })), open: vi.fn() } as unknown as FileOps;
      await expect(openRegularFile("/data/images/x.webp", ops)).rejects.toMatchObject({ code: "EACCES" });
    });
  });
});
