// Question image or trivia set thumbnail (lib/next/content-routes.ts). Staff and Owner (manage
// trivia); Staff only while the set has no attempts, decided in the change's transaction.
import { triviaImage } from "../../../../lib/next/content-routes.ts";
import { adminRoute } from "../../../../lib/next/route.ts";

export const POST = adminRoute({ permission: "trivia_set.edit" }, triviaImage);
