// The sales CSV (AC-A5): Owner only, audited, streamed (lib/next/report-routes.ts).
import { salesExport } from "../../../../../lib/next/report-routes.ts";
import { adminRoute } from "../../../../../lib/next/route.ts";

export const POST = adminRoute({ permission: "sales.export" }, salesExport);
