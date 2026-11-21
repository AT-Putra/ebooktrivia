// GET /api/v1/play/auth/session: whether the request is signed in; rotates a due session (US-026, lib/play/handlers.ts).
import { handleSession } from "../../../../../../lib/play/handlers.ts";
import { playRoute } from "../../../../../../lib/play/route.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = playRoute("play.session", handleSession);
