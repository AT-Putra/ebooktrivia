// POST /api/v1/play/sets/start {set_id}: start (or resume) the player's one attempt on a set (US-027, lib/play/trivia.ts).
import { withPlayer } from "../../../../../../lib/play/handlers.ts";
import { playRoute } from "../../../../../../lib/play/route.ts";
import { handleStartSet } from "../../../../../../lib/play/trivia.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = playRoute("play.start", (deps, request) => withPlayer(deps, request, (playerId) => handleStartSet(deps, request, playerId)));
