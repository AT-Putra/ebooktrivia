// A prize fulfilment's proof (US-030, lib/next/proof-routes.ts). Owner only.
import { uploadProof } from "../../../lib/next/proof-routes.ts";
import { adminRoute } from "../../../lib/next/route.ts";

export const POST = adminRoute({ permission: "prize_fulfillment.update" }, uploadProof);
