// The winners export (AC-A9, plan M5a.3): Owner only, audited, streamed (lib/next/report-routes.ts).
import { winnersExport } from "../../../../../lib/next/report-routes.ts";
import { adminRoute } from "../../../../../lib/next/route.ts";

export const POST = adminRoute({ permission: "winners.export" }, winnersExport);
