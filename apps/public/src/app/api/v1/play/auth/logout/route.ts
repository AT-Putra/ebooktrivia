// POST /api/v1/play/auth/logout: end the session (US-026, lib/play/handlers.ts).
import { handleLogout } from "../../../../../../lib/play/handlers.ts";
import { playRoute } from "../../../../../../lib/play/route.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = playRoute("play.logout", handleLogout);
