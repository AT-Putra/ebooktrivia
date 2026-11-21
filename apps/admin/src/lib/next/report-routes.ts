// Route handlers of the Owner-only exports (US-029): the sales CSV and the winners CSV. POST only, behind adminRoute (Origin
// check, session, the route's permission: `sales.export` / `winners.export`, both Owner-only, so a Staff session gets 403
// before anything below runs). An export is audited, so it is a POST (a GET has no mutation scope): the page's button is a form
// carrying the filters. The audit entry is committed BEFORE the first byte is streamed, so no file leaves without its record,
// and the answer is a pull stream (lib/reports/exports.ts) that reads one batch of rows at a time. The file is `no-store`, an
// attachment, and named without any personal data.
import { csvFileName, isUuid } from "@ebooktrivia/core";
import { InvalidInput, onlyFields } from "../settings/fields.ts";
import { parseSalesFilters, type Query } from "../reports/common.ts";
import { recordExport, salesCsv, winnersCsv } from "../reports/exports.ts";
import { plain, type RouteContext } from "./route.ts";

const csvResponse = (body: ReadableStream<Uint8Array>, fileName: string): Response =>
  new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

/** The fields of a posted form as a query record; anything but plain text values is refused. */
async function fields(request: Request, allowed: readonly string[]): Promise<Query> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new InvalidInput("The request is not a form.");
  }
  onlyFields(form, allowed);
  const out: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== "string") throw new InvalidInput("The request has an unexpected field.");
    out[name] = value;
  }
  return out;
}

async function answer(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InvalidInput) return plain(400, error.message);
    throw error;
  }
}

export const SALES_EXPORT_FIELDS = ["from", "to", "program", "lp", "adnet", "gateway", "status"] as const;

/** POST /reports/sales/export: the filters of the sales report; one CSV row per order created in the range. */
export function salesExport({ rt }: RouteContext, request: Request): Promise<Response> {
  return answer(async () => {
    const { filters, error } = parseSalesFilters(await fields(request, SALES_EXPORT_FIELDS), new Date());
    // A file for another range than the one asked is worse than no file: refuse, never fall back to the default.
    if (error !== null) throw new InvalidInput(error);
    await recordExport(rt.sql, "sales.export", {
      from: filters.from,
      to: filters.to,
      program_id: filters.programId,
      landing_page_id: filters.landingPageId,
      adnet: filters.adnet,
      gateway: filters.gateway,
      status: filters.status,
    });
    return csvResponse(salesCsv(rt.sql, filters), csvFileName("sales", [filters.from, filters.to]));
  });
}

/** POST /reports/contest/export: one program's winners with their contact (prize fulfillment). */
export function winnersExport({ rt }: RouteContext, request: Request): Promise<Response> {
  return answer(async () => {
    const programId = (await fields(request, ["program"]))["program"];
    if (typeof programId !== "string" || !isUuid(programId)) throw new InvalidInput("Choose a program.");
    const [program] = await rt.sql<{ slug: string }[]>`SELECT slug FROM public.programs WHERE id = ${programId}`;
    if (program === undefined) throw new InvalidInput("This program no longer exists.");
    await recordExport(rt.sql, "winners.export", { program_id: programId });
    return csvResponse(winnersCsv(rt.sql, programId), csvFileName("winners", [program.slug]));
  });
}
