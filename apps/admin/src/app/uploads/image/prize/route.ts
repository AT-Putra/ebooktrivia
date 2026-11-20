// Prize tier image (lib/next/content-routes.ts). Owner only.
import { prizeImage } from "../../../../lib/next/content-routes.ts";
import { adminRoute } from "../../../../lib/next/route.ts";

export const POST = adminRoute({ permission: "prize_tier.edit" }, prizeImage);
