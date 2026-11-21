// POST /api/v1/play/auth/logout-all: end every session of the player (US-027, the US-026 follow-up; lib/play/handlers.ts).
import { handleLogoutAll } from "../../../../../../lib/play/handlers.ts";
import { playRoute } from "../../../../../../lib/play/route.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = playRoute("play.logout_all", handleLogoutAll);
