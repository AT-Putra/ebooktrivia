// GET /api/v1/lp/{lp_key}/config (US-024): lib/sdk-routes.ts. Cacheable for 60 s by the browser, Node runtime.
import { runtimeOrUnavailable } from "../../../../../../lib/runtime.ts";
import { handleConfig } from "../../../../../../lib/sdk-routes.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Context {
  readonly params: Promise<{ lpKey: string }>;
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const rt = await runtimeOrUnavailable("sdk.config");
  if (rt instanceof Response) return rt;
  return handleConfig(rt.sdk, request, (await context.params).lpKey);
}
