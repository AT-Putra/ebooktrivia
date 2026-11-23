// Route handlers of the content uploads (US-018): question images and set thumbnails, prize images,
// and the CSV / XLSX question import. POST only, behind adminRoute (Origin check, session, the
// route's permission, mutation scope). Files are sent as the raw request body (one request, no
// multipart), read with a hard cap before anything is parsed; the original name comes URL-encoded
// in `x-file-name`, the type in `content-type`. The query names the target ids (each scoped to its
// parent in the database queries) and nothing else. Answers are JSON, never cached.
// A role refused (NotAllowed: Staff on a set with attempts) answers 403 with the reason. The role,
// the lock and the target are checked BEFORE an image is re-encoded or written (code review US-018
// F8), and again in the linking transaction.
import { InvalidInput, NotAllowed, onlyParams, uuid } from "../settings/fields.ts";
import { IMAGE_MAX_BYTES, parseFilename, storeImage } from "../settings/images.ts";
import { checkPrizeImageTarget, setPrizeImage } from "../settings/prizes.ts";
import { IMPORT_MAX_BYTES, importQuestionFile } from "../settings/trivia-import.ts";
import { checkImageTarget, setQuestionImage, setSetThumbnail } from "../settings/trivia.ts";
import { readCapped, TooLarge } from "./pdf-upload-routes.ts";
import type { RouteContext } from "./route.ts";

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function answer(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InvalidInput) return json(400, { error: error.message });
    if (error instanceof TooLarge) return json(413, { error: "The file is larger than 2 MB." });
    if (error instanceof NotAllowed) return json(403, { error: error.message });
    throw error;
  }
}

async function file(request: Request, max: number) {
  const bytes = await readCapped(request, max);
  if (bytes.length === 0) throw new InvalidInput("Choose a file.");
  return { bytes, filename: parseFilename(request.headers.get("x-file-name")), mimeType: request.headers.get("content-type") ?? "" };
}

/** ?program=&set= (thumbnail) or ?program=&set=&question= (question image). */
export function triviaImage({ rt, admin }: RouteContext, request: Request): Promise<Response> {
  return answer(async () => {
    const params = new URL(request.url).searchParams;
    onlyParams(params, ["program", "set", "question"]);
    const programId = uuid(params.get("program") ?? "");
    const setId = uuid(params.get("set") ?? "");
    const rawQuestion = params.get("question");
    const questionId = rawQuestion === null ? undefined : uuid(rawQuestion);
    const actor = { userId: admin.userId, role: admin.role };
    await checkImageTarget(rt.sql, actor, questionId === undefined ? { programId, setId } : { programId, setId, questionId });
    const image = await storeImage(rt.settings, await file(request, IMAGE_MAX_BYTES), questionId === undefined ? "thumbnail" : "question");
    if (questionId === undefined) await setSetThumbnail(rt.sql, actor, programId, setId, image);
    else await setQuestionImage(rt.sql, actor, { programId, setId, questionId }, image);
    return json(200, { ok: true });
  });
}

/** ?program=&tier= */
export function prizeImage({ rt, admin }: RouteContext, request: Request): Promise<Response> {
  return answer(async () => {
    const params = new URL(request.url).searchParams;
    onlyParams(params, ["program", "tier"]);
    const programId = uuid(params.get("program") ?? "");
    const tierId = uuid(params.get("tier") ?? "");
    await checkPrizeImageTarget(rt.sql, programId, tierId);
    const image = await storeImage(rt.settings, await file(request, IMAGE_MAX_BYTES), "prize");
    await setPrizeImage(rt.sql, admin.userId, programId, tierId, image);
    return json(200, { ok: true });
  });
}

/** ?program=&set= ; 200 {imported}, or 422 {errors: [{row, message}]} when any row is invalid (nothing written). */
export function questionImport({ rt, admin }: RouteContext, request: Request): Promise<Response> {
  return answer(async () => {
    const params = new URL(request.url).searchParams;
    onlyParams(params, ["program", "set"]);
    const ids = { programId: uuid(params.get("program") ?? ""), setId: uuid(params.get("set") ?? "") };
    const outcome = await importQuestionFile(rt.sql, { userId: admin.userId, role: admin.role }, ids, await file(request, IMPORT_MAX_BYTES));
    if (outcome.kind === "rejected") return json(422, { error: "rows", errors: outcome.errors });
    return json(200, { imported: outcome.count });
  });
}
