// POST /api/v1/play/attempts/current {attempt_id}: the attempt's current question, served once by the database's
// clock (US-027, lib/play/trivia.ts).
import { withPlayer } from "../../../../../../lib/play/handlers.ts";
import { playRoute } from "../../../../../../lib/play/route.ts";
import { handleCurrent } from "../../../../../../lib/play/trivia.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = playRoute("play.current", (deps, request) => withPlayer(deps, request, (playerId) => handleCurrent(deps, request, playerId)));
