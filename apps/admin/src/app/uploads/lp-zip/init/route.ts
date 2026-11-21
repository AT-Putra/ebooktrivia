// Chunked landing-page ZIP upload, step "init" (lib/next/lp-zip-route.ts, US-023). Owner only.
import { lpZipInit } from "../../../../lib/next/lp-zip-route.ts";
import { adminRoute } from "../../../../lib/next/route.ts";

export const POST = adminRoute({ permission: "lp_zip.publish" }, lpZipInit);
