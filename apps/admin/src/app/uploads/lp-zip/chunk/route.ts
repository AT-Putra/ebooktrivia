// Chunked landing-page ZIP upload, step "chunk" (lib/next/lp-zip-route.ts, US-023). Owner only.
import { lpZipChunk } from "../../../../lib/next/lp-zip-route.ts";
import { adminRoute } from "../../../../lib/next/route.ts";

export const POST = adminRoute({ permission: "lp_zip.publish" }, lpZipChunk);
