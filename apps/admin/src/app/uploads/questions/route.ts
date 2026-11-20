// CSV / XLSX question import into a trivia set (lib/next/content-routes.ts, AC-Q15). Staff and Owner
// (manage trivia); Staff only while the set has no attempts, decided before anything is written.
import { questionImport } from "../../../lib/next/content-routes.ts";
import { adminRoute } from "../../../lib/next/route.ts";

export const POST = adminRoute({ permission: "trivia_set.edit" }, questionImport);
