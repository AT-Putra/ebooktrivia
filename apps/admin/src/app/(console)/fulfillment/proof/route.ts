// The download of a prize fulfilment's proof (US-030): Owner only, audited, an attachment (lib/next/proof-routes.ts).
import { downloadProof } from "../../../../lib/next/proof-routes.ts";
import { adminRoute } from "../../../../lib/next/route.ts";

export const POST = adminRoute({ permission: "prize_fulfillment.update" }, downloadProof);
