// Route handlers of the chunked landing-page ZIP upload (US-023; lib/settings/lp-hosting.ts, and the
// upload sessions of lib/settings/uploads.ts with kind lp_zip). POST only, behind adminRoute (Origin
// check, session, lp_zip.publish = Owner, mutation scope). No request carries more than one 1 MiB chunk,
// so a 25 MiB ZIP fits Caddy's 30 s body timeout on a slow link. Bodies are read with a hard cap before
// anything is parsed. Answers are JSON, never cached:
//   init     200 {sessionId, chunkBytes, chunkCount, received} | 413 over 25 MiB | 400
//   chunk    200 {received, chunkCount} | 400 | 413
//   complete 200 {version, fileCount, uncompressedBytes, skipped, hostsSynced}
//            422 {error: "rejected", issues: [{code, entry, message}]}  nothing was published (audited)
//            409 {error} another publish is running (nothing was read) | 400
import { InvalidInput } from "../settings/fields.ts";
import { completeLpZipUpload, initLpZipUpload, LpZipRefused, parseLpZipInit, PublishBusy } from "../settings/lp-hosting.ts";
import { CHUNK_BYTES, writeChunk } from "../settings/uploads.ts";
import { readCapped, TooLarge } from "./pdf-upload-routes.ts";
import type { RouteContext } from "./route.ts";

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function answer(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof LpZipRefused) return json(422, { error: "rejected", issues: error.issues });
    if (error instanceof PublishBusy) return json(409, { error: error.message });
    if (error instanceof InvalidInput) return json(400, { error: error.message });
    if (error instanceof TooLarge) return json(413, { error: "The request body is too large." });
    throw error;
  }
}

export function lpZipInit({ rt, admin }: RouteContext, request: Request): Promise<Response> {
  return answer(async () => {
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readCapped(request, 4096)));
    } catch (error) {
      if (error instanceof TooLarge) throw error;
      throw new InvalidInput("The request is not valid JSON.");
    }
    const result = await initLpZipUpload(rt.sql, rt.settings, admin.userId, parseLpZipInit(body));
    if (result.kind === "too_large") return json(413, { error: "The ZIP is larger than 25 MB.", maxBytes: result.maxBytes });
    if (result.kind !== "ready") throw new InvalidInput("The upload could not start.");
    return json(200, { sessionId: result.sessionId, chunkBytes: result.chunkBytes, chunkCount: result.chunkCount, received: result.received });
  });
}

export function lpZipChunk({ rt, admin }: RouteContext, request: Request): Promise<Response> {
  return answer(async () => {
    const url = new URL(request.url);
    const raw = url.searchParams.get("index") ?? "";
    const bytes = await readCapped(request, CHUNK_BYTES);
    const progress = await writeChunk(rt.sql, rt.settings, admin.userId, {
      kind: "lp_zip",
      sessionId: url.searchParams.get("session") ?? "",
      index: /^\d{1,6}$/.test(raw) ? Number(raw) : -1,
      sha256: request.headers.get("x-chunk-sha256") ?? "",
      bytes,
    });
    return json(200, { received: progress.received, chunkCount: progress.chunkCount });
  });
}

export function lpZipComplete({ rt, admin }: RouteContext, request: Request): Promise<Response> {
  return answer(async () => {
    await readCapped(request, 0);
    const result = await completeLpZipUpload(rt.sql, rt.settings, admin.userId, new URL(request.url).searchParams.get("session") ?? "");
    return json(200, { ...result });
  });
}
