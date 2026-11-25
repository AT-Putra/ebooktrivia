import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signFileUrl } from "@ebooktrivia/adapters";
import { FILE_SIZE_HEADER } from "@ebooktrivia/core";
import { expect, test } from "@playwright/test";
import { type PlayEnv, startPlayEnv } from "../support/play.ts";

/**
 * The signed ebook download (apps/public/src/lib/files.ts) as it leaves the REAL server: the production build of apps/public under `next start`,
 * not the route's Response object. Next.js drops a route handler's own Content-Length (its sendResponse strips it and streams the body
 * chunked), and the worker's pre-flight refuses a WhatsApp send unless the size it is told matches the stored PDF: with Content-Length gone,
 * every WhatsApp PDF was held back on staging (`file_unavailable`, reason content_length). The route states the size in FILE_SIZE_HEADER too;
 * this checks it arrives through Next, with the whole file.
 */
test.describe.configure({ mode: "serial" });

const PORT = 3106;
/** Large enough to be sent in several chunks. */
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(300_000), Buffer.from("\n%%EOF\n")]);
const storagePath = `deliverables/${randomUUID()}.pdf`;

let play: PlayEnv;
let dataDir = "";
let started = false;

/** A GET to the app with its own Host header (the route answers on api.<domain> only); fetch cannot set Host. */
function get(pathAndQuery: string, host: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: PORT, path: pathAndQuery, method: "GET", headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  dataDir = await mkdtemp(join(tmpdir(), "ebt-e2e-files-"));
  await mkdir(join(dataDir, "deliverables"), { recursive: true });
  await writeFile(join(dataDir, storagePath), PDF);
  play = await startPlayEnv(PORT, { dataDir });
  started = true;
});

test.afterAll(async () => {
  if (started) await play.stop();
  if (dataDir !== "") await rm(dataDir, { recursive: true, force: true });
});

test("a signed ebook URL answers the whole PDF and states its size in the size header through the real Next.js server (the worker's pre-flight reads it)", async () => {
  const signed = new URL(signFileUrl({ origin: `https://api.${play.domain}`, path: `/files/${storagePath}`, key: play.fileUrlKey, now: new Date(), ttlSeconds: 60 }));
  const res = await get(signed.pathname + signed.search, `api.${play.domain}`);
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toBe("application/pdf");
  expect(res.headers[FILE_SIZE_HEADER]).toBe(String(PDF.length));
  // Whatever framing Next uses, a Content-Length that does arrive is the file's (today it strips the route's own and streams chunked).
  expect([undefined, String(PDF.length)]).toContain(res.headers["content-length"]);
  expect(res.body.equals(PDF)).toBe(true);
});
