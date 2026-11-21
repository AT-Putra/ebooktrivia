// GET /files/deliverables/<id>.pdf?exp&sig (US-025): lib/files.ts. The ebook PDF for a holder of a signed URL, on api.<DOMAIN> only. Never cached, Node runtime.
import { handleFileDownload } from "../../../lib/files.ts";
import { runtimeOrUnavailable } from "../../../lib/runtime.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const rt = await runtimeOrUnavailable("files");
  if (rt instanceof Response) return rt;
  return handleFileDownload(rt.files, request);
}
