// POST /api/v1/checkout/{lp_key} (US-020): lib/checkout/handler.ts. Never cached, Node runtime.
import { checkoutPreflight, handleCheckout } from "../../../../../lib/checkout/handler.ts";
import { runtimeOrUnavailable } from "../../../../../lib/runtime.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Context {
  readonly params: Promise<{ lpKey: string }>;
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const rt = await runtimeOrUnavailable("checkout");
  if (rt instanceof Response) return rt;
  return handleCheckout(rt.checkout, request, (await context.params).lpKey);
}

export async function OPTIONS(request: Request, context: Context): Promise<Response> {
  const rt = await runtimeOrUnavailable("checkout");
  if (rt instanceof Response) return rt;
  return checkoutPreflight(rt.checkout, request, (await context.params).lpKey);
}
