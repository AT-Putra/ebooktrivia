// GET /api/v1/play/img/banner/{programId}/{uploadId}.webp: a program's uploaded banner picture, public, for programs that are not
// drafts (lib/play/images.ts). The path is matched whole by the handler, which answers one bare 404 for anything else.
import { handleBannerImage } from "../../../../../../../lib/play/images.ts";
import { playRoute } from "../../../../../../../lib/play/route.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = playRoute("play.image", (deps, request) => handleBannerImage(deps, request));
/** The same handler answers HEAD: the headers of the GET and no body (the file is opened only to read its size, and closed at once). */
export const HEAD = GET;
