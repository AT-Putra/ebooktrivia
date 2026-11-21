// POST /api/v1/play/attempts/answer {answer_id, option_id}: the pick, recorded once; the correct option and the
// explanation come back only here (US-027, lib/play/trivia.ts).
import { withPlayer } from "../../../../../../lib/play/handlers.ts";
import { playRoute } from "../../../../../../lib/play/route.ts";
import { handleAnswer } from "../../../../../../lib/play/trivia.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = playRoute("play.answer", (deps, request) => withPlayer(deps, request, (playerId) => handleAnswer(deps, request, playerId)));
