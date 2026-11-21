// POST /api/v1/order/status (US-022): the order page's poll. lib/order/handler.ts. Never cached, Node runtime.
// Served on order.<DOMAIN> only (src/proxy.ts); there is no CORS and no GET.
import { handleOrderApi } from "../../../../../lib/order/handler.ts";
import { runtimeOrUnavailable } from "../../../../../lib/runtime.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const rt = await runtimeOrUnavailable("order.status");
  if (rt instanceof Response) return rt;
  return handleOrderApi(rt.order, "status", request);
}
