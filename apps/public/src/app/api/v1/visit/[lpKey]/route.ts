// POST /api/v1/visit/{lp_key} (US-024): the SDK's visit beacon, lib/sdk-routes.ts. Never cached, Node runtime.
import { checkoutPreflight } from "../../../../../lib/checkout/handler.ts";
import { runtimeOrUnavailable } from "../../../../../lib/runtime.ts";
import { handleVisit } from "../../../../../lib/sdk-routes.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Context {
  readonly params: Promise<{ lpKey: string }>;
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const rt = await runtimeOrUnavailable("sdk.visit");
  if (rt instanceof Response) return rt;
  return handleVisit(rt.sdk, request, (await context.params).lpKey);
}

/** The same per-landing-page preflight as checkout: POST from a registered origin, content-type and accept. */
export async function OPTIONS(request: Request, context: Context): Promise<Response> {
  const rt = await runtimeOrUnavailable("sdk.visit");
  if (rt instanceof Response) return rt;
  return checkoutPreflight(rt.sdk, request, (await context.params).lpKey);
}
