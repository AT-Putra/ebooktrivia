// POST /api/v1/cap/{lp_key}/challenge (US-020): the Cap widget protocol, lib/cap-routes.ts.
import { capPreflight, handleCap } from "../../../../../../lib/cap-routes.ts";
import { runtimeOrUnavailable } from "../../../../../../lib/runtime.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Context {
  readonly params: Promise<{ lpKey: string }>;
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const rt = await runtimeOrUnavailable("cap.challenge");
  if (rt instanceof Response) return rt;
  return handleCap(rt.cap, "challenge", request, (await context.params).lpKey);
}

export async function OPTIONS(request: Request, context: Context): Promise<Response> {
  const rt = await runtimeOrUnavailable("cap.challenge");
  if (rt instanceof Response) return rt;
  return capPreflight(rt.cap, request, (await context.params).lpKey);
}
