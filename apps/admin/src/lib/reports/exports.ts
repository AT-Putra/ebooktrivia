// CSV exports (US-029; AC-A1, AC-A5, plan M5a.3): the sales export and the winners export. Both are OWNER ONLY, decided
// by the route (policy `sales.export`, `winners.export`: lib/next/report-routes.ts) and both are AUDITED before the first
// byte leaves (recordExport: the filters and the program, never a person). Each file is streamed:
//   - bounded memory: a ReadableStream that PULLS one batch of rows at a time (keyset pages of EXPORT_BATCH rows by
//     (created_at, id), each its own short query, no long transaction), so a slow download holds one batch, not the
//     file, and a cancelled download stops reading;
//   - Excel-safe: UTF-8 with a byte order mark, CRLF records, and every text cell neutralized against formulas
//     (core csvCell: request.ts accepts = + - @ in a buyer's name and e-mail, utm values come from a URL);
//   - no PII in the file NAME (core csvFileName: the report and the range only).
// The sales file is one row per ORDER created in the range (WIB days), so a total in the file adds up to the report.
import { CSV_BOM, type CsvCell, csvLine } from "@ebooktrivia/core";
import { type AuditChange, type Fact, withAudit } from "../audit.ts";
import type { Sql } from "../db.ts";
import { FLAG_LABELS, getContestResults } from "../settings/contest.ts";
import { idrOf, type SalesFilters, wibInstants } from "./common.ts";

/** Rows per page of an export: small enough to hold in memory twice over, large enough for few round trips. */
export const EXPORT_BATCH = 1000;

/** A CSV as a pull stream: BOM and header first, then one chunk per batch. `cancel` closes the batches. */
export function csvStream(header: readonly string[], batches: AsyncIterator<CsvCell[][]>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(CSV_BOM + csvLine(header)));
        return;
      }
      const next = await batches.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next.value.map(csvLine).join("")));
    },
    async cancel() {
      await batches.return?.();
    },
  });
}

/** The audit entry of an export, written (and committed) before the file is streamed: no file without its record. */
export async function recordExport(sql: Sql, action: "sales.export" | "winners.export", facts: Readonly<Record<string, Fact>>): Promise<void> {
  await withAudit(sql, (_tx, audit) => {
    const change: AuditChange = { action, entityType: "export", entityId: null, facts };
    audit(change);
    return Promise.resolve();
  });
}

// ---------------------------------------------------------------- sales

export const SALES_CSV_HEADER = [
  "order_code",
  "created_at_wib",
  "paid_at_wib",
  "program",
  "landing_page",
  "source",
  "utm_campaign",
  "status",
  "payment_type",
  "amount_idr",
  "buyer_name",
  "buyer_phone",
  "buyer_email",
] as const;

interface SalesCsvRow {
  order_code: string;
  created_at_wib: string;
  paid_at_wib: string | null;
  program: string;
  landing_page: string;
  source: string;
  utm_campaign: string | null;
  status: string;
  payment_type: string | null;
  amount_idr: string;
  buyer_name: string;
  buyer_phone: string;
  buyer_email: string;
  /** created_at as PostgreSQL prints it (microseconds): the keyset cursor is kept as text, because a JS Date holds milliseconds only. */
  cursor_at: string;
  id: string;
}

/**
 * The orders of the filters, oldest first, as pages after the cursor (created_at, id). created_at has MICROSECOND precision and a JS Date
 * only milliseconds, so the cursor travels as the text PostgreSQL printed (`created_at::text`) and is cast back to timestamptz in the
 * comparison: a Date cursor would repeat the last row of a batch (its truncated instant sorts before it) and loop forever on a batch of
 * orders that share one millisecond.
 */
async function* salesBatches(sql: Sql, f: SalesFilters, batch: number): AsyncGenerator<CsvCell[][]> {
  const { start, end } = wibInstants(f);
  let after: { readonly at: string; readonly id: string } | null = null;
  for (;;) {
    const rows: SalesCsvRow[] = await sql<SalesCsvRow[]>`
      SELECT o.order_code, to_char((o.created_at AT TIME ZONE 'UTC') + interval '7 hours', 'YYYY-MM-DD HH24:MI:SS') AS created_at_wib,
             to_char((o.paid_at AT TIME ZONE 'UTC') + interval '7 hours', 'YYYY-MM-DD HH24:MI:SS') AS paid_at_wib,
             p.name AS program, lp.name AS landing_page, public.report_source_label(public.order_source_adnet(o.adnet_id, o.clickid)) AS source,
             o.utm_campaign, o.status::text AS status, pay.payment_type, o.amount_idr::text AS amount_idr,
             o.buyer_name, o.buyer_phone, o.buyer_email, o.created_at::text AS cursor_at, o.id
        FROM public.orders o
        JOIN public.landing_pages lp ON lp.id = o.landing_page_id
        JOIN public.programs p ON p.id = o.program_id
        LEFT JOIN LATERAL (
          SELECT x.payment_type FROM public.payments x WHERE x.order_id = o.id ORDER BY (x.settled_at IS NULL), x.settled_at, x.created_at, x.id LIMIT 1
        ) pay ON true
       WHERE o.created_at >= ${start} AND o.created_at < ${end}
         ${after === null ? sql`` : sql`AND (o.created_at, o.id) > (${after.at}::timestamptz, ${after.id}::uuid)`}
         ${f.programId === null ? sql`` : sql`AND o.program_id = ${f.programId}`}
         ${f.landingPageId === null ? sql`` : sql`AND o.landing_page_id = ${f.landingPageId}`}
         ${f.adnet === null ? sql`` : f.adnet === "organic" ? sql`AND public.order_source_adnet(o.adnet_id, o.clickid) IS NULL` : sql`AND public.order_source_adnet(o.adnet_id, o.clickid) = ${f.adnet}`}
         ${f.gateway === null ? sql`` : sql`AND lp.gateway = ${f.gateway}`}
         ${f.status === null ? sql`` : sql`AND o.status = ${f.status}`}
       ORDER BY o.created_at, o.id
       LIMIT ${batch}`;
    if (rows.length === 0) return;
    yield rows.map((r) => [
      r.order_code,
      r.created_at_wib,
      r.paid_at_wib,
      r.program,
      r.landing_page,
      r.source,
      r.utm_campaign,
      r.status,
      r.payment_type,
      idrOf(r.amount_idr),
      r.buyer_name,
      r.buyer_phone,
      r.buyer_email,
    ]);
    const last = rows[rows.length - 1];
    if (last === undefined || rows.length < batch) return;
    after = { at: last.cursor_at, id: last.id };
  }
}

/** The sales CSV of the filters, streamed. The caller has checked `sales.export` and recorded the export. */
export const salesCsv = (sql: Sql, f: SalesFilters, batch: number = EXPORT_BATCH): ReadableStream<Uint8Array> => csvStream(SALES_CSV_HEADER, salesBatches(sql, f, batch));

// ---------------------------------------------------------------- winners

export const WINNERS_CSV_HEADER = ["rank", "prize", "status", "name", "phone", "email", "flags", "confirmed_at_wib"] as const;

/**
 * The program's winners with their contact (prize fulfillment needs it), and the anti-cheat flags the Owner reviewed, in pages after the
 * last rank (rank is an integer, unique in a snapshot: no precision to lose).
 */
async function* winnerBatches(sql: Sql, programId: string, batch: number): AsyncGenerator<CsvCell[][]> {
  const results = await getContestResults(sql, programId);
  const flagsByRank = new Map((results?.winners ?? []).map((w) => [w.rank, w.flags.map((f) => FLAG_LABELS[f]).join("; ")] as const));
  let after = 0;
  for (;;) {
    const rows = await sql<{ rank: number; prize: string; status: string; name: string; phone: string | null; email: string | null; confirmed_at_wib: string | null }[]>`
      SELECT w.rank, t.name AS prize, w.status::text AS status, pl.name, pl.phone, pl.email,
             to_char((w.confirmed_at AT TIME ZONE 'UTC') + interval '7 hours', 'YYYY-MM-DD HH24:MI:SS') AS confirmed_at_wib
        FROM public.winners w
        JOIN public.prize_tiers t ON t.id = w.prize_tier_id
        JOIN public.players pl ON pl.id = w.player_id
       WHERE w.program_id = ${programId} AND w.rank > ${after}
       ORDER BY w.rank
       LIMIT ${batch}`;
    if (rows.length === 0) return;
    yield rows.map((r) => [r.rank, r.prize, r.status, r.name, r.phone, r.email, flagsByRank.get(r.rank) ?? "", r.confirmed_at_wib]);
    const last = rows[rows.length - 1];
    if (last === undefined || rows.length < batch) return;
    after = last.rank;
  }
}

/** The winners CSV of a program, streamed. The caller has checked `winners.export` and recorded the export. */
export const winnersCsv = (sql: Sql, programId: string, batch: number = EXPORT_BATCH): ReadableStream<Uint8Array> => csvStream(WINNERS_CSV_HEADER, winnerBatches(sql, programId, batch));
