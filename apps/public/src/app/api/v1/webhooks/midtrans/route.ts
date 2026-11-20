// POST /api/v1/webhooks/midtrans (US-021): lib/webhooks/midtrans.ts. Server to server: POST only, no
// preflight, no CORS. Never cached, Node runtime.
import { runtimeOrUnavailable } from "../../../../../lib/runtime.ts";
import { handleMidtransNotification } from "../../../../../lib/webhooks/midtrans.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const rt = await runtimeOrUnavailable("webhook_midtrans");
  if (rt instanceof Response) return rt;
  return handleMidtransNotification(rt.webhooks, request);
}
