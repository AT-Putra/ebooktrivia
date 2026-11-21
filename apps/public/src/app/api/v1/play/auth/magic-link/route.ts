// POST /api/v1/play/auth/magic-link: log in with a magic link, the confirm page's POST (US-026, lib/play/handlers.ts).
import { handleMagicLink } from "../../../../../../lib/play/handlers.ts";
import { playRoute } from "../../../../../../lib/play/route.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = playRoute("play.magic_link", handleMagicLink);
