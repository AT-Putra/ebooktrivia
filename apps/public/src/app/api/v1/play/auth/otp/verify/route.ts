// POST /api/v1/play/auth/otp/verify: log in with the code (US-026, lib/play/handlers.ts).
import { handleOtpVerify } from "../../../../../../../lib/play/handlers.ts";
import { playRoute } from "../../../../../../../lib/play/route.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = playRoute("play.otp_verify", handleOtpVerify);
