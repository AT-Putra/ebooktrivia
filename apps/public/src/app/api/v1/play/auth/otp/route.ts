// POST /api/v1/play/auth/otp: request a login code (US-026, lib/play/handlers.ts).
import { handleOtpRequest } from "../../../../../../lib/play/handlers.ts";
import { playRoute } from "../../../../../../lib/play/route.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = playRoute("play.otp", handleOtpRequest);
