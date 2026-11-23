// GET /api/v1/play/img/prize/{tierId}/{uploadId}.webp: a prize tier's uploaded image, public, for programs that are not drafts
// (lib/play/images.ts). The path is matched whole by the handler, which answers one bare 404 for anything else.
import { handlePrizeImage } from "../../../../../../../lib/play/images.ts";
import { playRoute } from "../../../../../../../lib/play/route.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = playRoute("play.image", (deps, request) => handlePrizeImage(deps, request));
/** The same handler answers HEAD: the headers of the GET and no body (the file is opened only to read its size, and closed at once). */
export const HEAD = GET;
