// POST /api/v1/play/cap/challenge: the Cap widget protocol of the login page (US-026, lib/play/handlers.ts).
import { handlePlayCap } from "../../../../../../lib/play/handlers.ts";
import { playRoute } from "../../../../../../lib/play/route.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = playRoute("play.cap_challenge", (deps, request) => handlePlayCap(deps, "challenge", request));
