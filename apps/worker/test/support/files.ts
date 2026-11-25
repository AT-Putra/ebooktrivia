// The ebook files port for the delivery tests (US-005 R11): the real signing and disk reads of createEbookFiles, and a pre-flight that is served from the data directory
// the way the public /files route reaches the worker through Next.js: 200, application/pdf, the size in FILE_SIZE_HEADER and NO Content-Length (Next's sendResponse strips
// a route handler's Content-Length and streams the body chunked), the bytes. `content_length` is a route that keeps its Content-Length (no size header). A test sets `mode`
// to make the route answer something else, as a broken deployment would: a 404, a 200 page, a different length, a body that is not a PDF, or no answer at all.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FILE_SIZE_HEADER } from "@ebooktrivia/core";
import { createEbookFiles, type PreflightFetch, type PreflightResponse } from "../../src/delivery/access.ts";
import type { EbookFiles } from "../../src/delivery/ports.ts";

export type FileServerMode =
  | "ok"
  | "content_length"
  | "not_found"
  | "forbidden"
  | "html_200"
  | "wrong_length"
  | "length_conflict"
  | "no_length"
  | "no_magic"
  | "wrong_type"
  | "unreachable";

export interface FileServer {
  readonly fetch: PreflightFetch;
  /** Every URL the pre-flight asked for (path, expiry and nonce; the signature is dropped: it is a bearer credential). */
  readonly requested: { readonly path: string; readonly exp: string | null; readonly nonce: string | null }[];
  mode: FileServerMode;
}

const asResponse = (response: Response): PreflightResponse => ({
  status: response.status,
  headers: response.headers,
  textPrefix: async (maxBytes) => (await response.text()).slice(0, maxBytes),
  cancel: async () => {
    try {
      await response.body?.cancel();
    } catch {
      // already read: nothing to cancel
    }
  },
});

export function fileServer(dataDir: string): FileServer {
  const server: FileServer = {
    mode: "ok",
    requested: [],
    fetch: async (rawUrl) => {
      const url = new URL(rawUrl);
      server.requested.push({ path: url.pathname, exp: url.searchParams.get("exp"), nonce: url.searchParams.get("n") });
      if (server.mode === "unreachable") throw new TypeError("fetch failed");
      if (server.mode === "not_found") return asResponse(new Response("<html>Not Found</html>", { status: 404, headers: { "content-type": "text/html" } }));
      if (server.mode === "forbidden") return asResponse(new Response(null, { status: 403 }));
      const bytes = await readFile(join(dataDir, url.pathname.replace(/^\/files\//, "")));
      const size = String(bytes.byteLength);
      const pdf = { "content-type": "application/pdf", [FILE_SIZE_HEADER]: size };
      switch (server.mode) {
        case "content_length":
          return asResponse(new Response(bytes, { status: 200, headers: { "content-type": "application/pdf", "content-length": size } }));
        case "html_200":
          return asResponse(new Response("<html>Not Found</html>", { status: 200, headers: { "content-type": "text/html", "content-length": "22" } }));
        case "wrong_type":
          return asResponse(new Response(bytes, { status: 200, headers: { ...pdf, "content-type": "text/html" } }));
        case "wrong_length":
          return asResponse(new Response(bytes, { status: 200, headers: { ...pdf, [FILE_SIZE_HEADER]: String(bytes.byteLength + 1) } }));
        case "length_conflict":
          // A Content-Length that arrives is the length on the wire, and it wins over the stated size.
          return asResponse(new Response(bytes, { status: 200, headers: { ...pdf, "content-length": String(bytes.byteLength + 1) } }));
        case "no_length":
          return asResponse(new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } }));
        case "no_magic":
          return asResponse(new Response(Buffer.alloc(bytes.byteLength, 0x41), { status: 200, headers: pdf }));
        default:
          return asResponse(new Response(bytes, { status: 200, headers: pdf }));
      }
    },
  };
  return server;
}

/** createEbookFiles over the data directory of the config, with its pre-flight answered by `server` (a fresh, healthy one by default). */
export const testFiles = (config: Parameters<typeof createEbookFiles>[0], server: FileServer = fileServer(config.dataDir)): EbookFiles => createEbookFiles(config, { fetch: server.fetch });
