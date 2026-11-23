// A program's banner picture, shown to players on the trivia page (lib/next/content-routes.ts). Owner only.
import { bannerImage } from "../../../../lib/next/content-routes.ts";
import { adminRoute } from "../../../../lib/next/route.ts";

export const POST = adminRoute({ permission: "program.edit" }, bannerImage);
