// Route handlers of a prize fulfilment's proof (US-030), Owner-only (prize_fulfillment.update), POST only, behind adminRoute
// (Origin check, session, permission, mutation scope):
//   upload    POST /uploads/proof?fulfillment=<id>, the file as the raw body (one request, read with a hard cap before anything
//             is parsed; the name URL-encoded in x-file-name, the type in content-type), like the content images;
//   download  POST /fulfillment/proof?fulfillment=<id> (a POST so it gets the mutation scope its audit row needs: nothing is
//             readable on GET): the stored file as an ATTACHMENT, never rendered (Content-Disposition: attachment, nosniff, a
//             sandbox CSP, no-store), under a name with no personal data. There is no public URL of a proof. A proof whose file
//             is missing (removed by an erasure in between) answers 404.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InvalidInput, onlyParams, uuid } from "../settings/fields.ts";
import { proofForDownload } from "../settings/fulfillment.ts";
import { PROOF_MAX_BYTES, storeProof } from "../settings/fulfillment-proof.ts";
import { parseFilename } from "../settings/images.ts";
import { PROOF_PATH } from "../settings/proof-files.ts";
import { readCapped, TooLarge } from "./pdf-upload-routes.ts";
import { plain, type RouteContext } from "./route.ts";

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const fulfillmentParam = (request: Request): string => {
  const params = new URL(request.url).searchParams;
  onlyParams(params, ["fulfillment"]);
  return uuid(params.get("fulfillment") ?? "");
};

/** ?fulfillment=<id>; 200 {ok}, 400 / 413 {error} (a fixed text, never a submitted value). */
export async function uploadProof({ rt }: RouteContext, request: Request): Promise<Response> {
  try {
    const fulfillmentId = fulfillmentParam(request);
    const bytes = await readCapped(request, PROOF_MAX_BYTES);
    if (bytes.length === 0) throw new InvalidInput("Choose a file.");
    await storeProof(rt.sql, rt.settings, fulfillmentId, { bytes, filename: parseFilename(request.headers.get("x-file-name")), mimeType: request.headers.get("content-type") ?? "" });
    return json(200, { ok: true });
  } catch (error) {
    if (error instanceof InvalidInput) return json(400, { error: error.message });
    if (error instanceof TooLarge) return json(413, { error: "The proof is larger than 4 MB." });
    throw error;
  }
}

/** ?fulfillment=<id>; the proof as an attachment, audited. */
export async function downloadProof({ rt }: RouteContext, request: Request): Promise<Response> {
  let fulfillmentId: string;
  try {
    fulfillmentId = fulfillmentParam(request);
  } catch {
    return plain(400, "Bad request");
  }
  if (rt.settings.dataDir === null) return plain(404, "Not found");
  const proof = await proofForDownload(rt.sql, fulfillmentId);
  if (proof === null || !PROOF_PATH.test(proof.storagePath)) return plain(404, "Not found");
  let bytes: Buffer;
  try {
    bytes = await readFile(join(rt.settings.dataDir, proof.storagePath));
  } catch {
    return plain(404, "The proof file is missing.");
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": proof.contentType,
      "content-length": String(bytes.length),
      "content-disposition": `attachment; filename="${proof.filename}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "no-store",
    },
  });
}
