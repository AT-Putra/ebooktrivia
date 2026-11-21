// POST /api/v1/order/claim (US-022): the exactly-once claim of the browser MT pixel, called once by the
// order page when its order is PAID. lib/order/handler.ts. Never cached, Node runtime. Served on
// order.<DOMAIN> only (src/proxy.ts); there is no CORS and no GET.
import { handleOrderApi } from "../../../../../lib/order/handler.ts";
import { runtimeOrUnavailable } from "../../../../../lib/runtime.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const rt = await runtimeOrUnavailable("order.claim");
  if (rt instanceof Response) return rt;
  return handleOrderApi(rt.order, "claim", request);
}
