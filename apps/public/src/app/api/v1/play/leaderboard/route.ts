// GET /api/v1/play/leaderboard?program={id}: the "Perbarui" refresh: the top N (cached 5 s) and the player's own
// rank (fresh), rate-limited (US-027, lib/play/trivia.ts).
import { withPlayer } from "../../../../../lib/play/handlers.ts";
import { playRoute } from "../../../../../lib/play/route.ts";
import { handleLeaderboard } from "../../../../../lib/play/trivia.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = playRoute("play.leaderboard", (deps, request) => withPlayer(deps, request, (playerId) => handleLeaderboard(deps, request, playerId)));
