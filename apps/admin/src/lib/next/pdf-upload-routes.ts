// Route handlers of the chunked PDF upload (US-017; lib/settings/uploads.ts). POST only, behind
// adminRoute (Origin check, session, product.content.edit, mutation scope). Bodies are read with a
// hard cap before anything is parsed: init 4 KiB of JSON, a chunk exactly its expected size (at
// most CHUNK_BYTES), complete nothing. Answers are JSON, never cached.
import type { RouteContext } from "./route.ts";
import { InvalidInput } from "../settings/fields.ts";
import { CHUNK_BYTES, completeUpload, initPdfUpload, parseInit, writeChunk } from "../settings/uploads.ts";

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

class TooLarge extends Error {}

/** The request body, refused (413) beyond `max` bytes, whatever Content-Length claims. */
async function readCapped(request: Request, max: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) throw new TooLarge();
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new TooLarge();
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function answer(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InvalidInput) return json(400, { error: error.message });
    if (error instanceof TooLarge) return json(413, { error: "The request body is too large." });
    throw error;
  }
}

export function pdfInit({ rt, admin }: RouteContext, request: Request): Promise<Response> {
  return answer(async () => {
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readCapped(request, 4096)));
    } catch (error) {
      if (error instanceof TooLarge) throw error;
      throw new InvalidInput("The request is not valid JSON.");
    }
    const result = await initPdfUpload(rt.sql, rt.settings, admin.userId, parseInit(body));
    if (result.kind === "too_large") return json(413, { error: "This PDF is larger than the limit.", maxBytes: result.maxBytes });
    if (result.kind === "needs_confirmation") return json(409, { error: "needs_confirmation", warnBytes: result.warnBytes });
    return json(200, { sessionId: result.sessionId, chunkBytes: result.chunkBytes, chunkCount: result.chunkCount, received: result.received });
  });
}

export function pdfChunk({ rt, admin }: RouteContext, request: Request): Promise<Response> {
  return answer(async () => {
    const url = new URL(request.url);
    const index = Number(url.searchParams.get("index") ?? "-1");
    const bytes = await readCapped(request, CHUNK_BYTES);
    const progress = await writeChunk(rt.sql, rt.settings, admin.userId, {
      sessionId: url.searchParams.get("session") ?? "",
      index: /^\d{1,6}$/.test(url.searchParams.get("index") ?? "") ? index : -1,
      sha256: request.headers.get("x-chunk-sha256") ?? "",
      bytes,
    });
    return json(200, { received: progress.received, chunkCount: progress.chunkCount });
  });
}

export function pdfComplete({ rt, admin }: RouteContext, request: Request): Promise<Response> {
  return answer(async () => {
    await readCapped(request, 0);
    const result = await completeUpload(rt.sql, rt.settings, admin.userId, new URL(request.url).searchParams.get("session") ?? "");
    return json(200, { uploadId: result.uploadId, large: result.large });
  });
}
