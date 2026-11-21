// POST /api/v1/webhooks/waha (US-025): lib/webhooks/waha.ts. Server to server: POST only, no preflight, no CORS. Never cached, Node runtime.
import { runtimeOrUnavailable } from "../../../../../lib/runtime.ts";
import { handleWahaWebhook } from "../../../../../lib/webhooks/waha.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const rt = await runtimeOrUnavailable("webhook_waha");
  if (rt instanceof Response) return rt;
  return handleWahaWebhook(rt.wahaWebhook, request);
}
