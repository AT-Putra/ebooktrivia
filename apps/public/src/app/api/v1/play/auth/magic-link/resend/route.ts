// POST /api/v1/play/auth/magic-link/resend: "send my login link again" (US-027, Owner decision; lib/play/handlers.ts).
import { handleMagicLinkResend } from "../../../../../../../lib/play/handlers.ts";
import { playRoute } from "../../../../../../../lib/play/route.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = playRoute("play.magic_link_resend", handleMagicLinkResend);
