// Reports (US-029, plan M10; AC-A4..A9): the pure parts of the report pages and exports. The money of a
// metric is defined once, per order, in sql/reports.sql (packages/db) and added up by the rollup; ROI is
// money.ts netProfitIdr. Here: rates, the date range of a filter, the reconciliation identity of the
// postback report, and the CSV cell of every export.
import { WIB_OFFSET_MS } from "./unlock.ts";

// ---------------------------------------------------------------- rates

/**
 * `part / whole` as integer basis points (1 bp = 0.01 %), rounded half up, or null when `whole` is 0 (no rate
 * exists). Integer arithmetic only: a rate shown on a report is never a float that drifted. The conversion rate
 * (MO to MT) and the failure rate of a number are this.
 */
export function rateBps(part: number, whole: number): number | null {
  if (!Number.isSafeInteger(part) || !Number.isSafeInteger(whole) || part < 0 || whole < 0) throw new RangeError("part and whole must be non-negative integers");
  if (whole === 0) return null;
  // floor((2 * part * 10000 + whole) / (2 * whole)) = round half up of part * 10000 / whole, in BigInt (no overflow).
  return Number((2n * BigInt(part) * 10_000n + BigInt(whole)) / (2n * BigInt(whole)));
}

// ---------------------------------------------------------------- dates

/** The WIB calendar day (YYYY-MM-DD) of an instant: the day the reports, the filters and the rollups count in. */
export function wibDateOf(at: Date): string {
  return new Date(at.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The day number (days since 1970-01-01) of a YYYY-MM-DD date, or null when it is not a real calendar date. */
function dayNumber(date: string): number | null {
  const m = DATE.exec(date);
  if (m === null) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(ms).toISOString().slice(0, 10);
  return back === date ? ms / 86_400_000 : null;
}

const dayString = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** The date `days` days after (or before, negative) `date`. */
export function addDays(date: string, days: number): string {
  const n = dayNumber(date);
  if (n === null || !Number.isSafeInteger(days)) throw new RangeError("not a calendar date");
  return dayString(n + days);
}

/** The longest range a report may ask for, in days (one year plus a leap day): a filter with a sane maximum. */
export const REPORT_MAX_DAYS = 366;
export const REPORT_DEFAULT_DAYS = 30;

export type ReportRange = { readonly ok: true; readonly from: string; readonly to: string } | { readonly ok: false; readonly error: string };

/**
 * The date range of a report filter (WIB days, both ends inclusive): the last REPORT_DEFAULT_DAYS days ending today
 * when nothing is asked; refused when a date is not a calendar date, the end is before the start, the end is in the
 * future or the range is longer than REPORT_MAX_DAYS. A refusal gives the message for the page.
 */
export function reportRange(input: { readonly from?: string | undefined; readonly to?: string | undefined }, today: string, maxDays = REPORT_MAX_DAYS): ReportRange {
  const to = input.to === undefined || input.to === "" ? today : input.to;
  const toN = dayNumber(to);
  const todayN = dayNumber(today);
  const from = input.from === undefined || input.from === "" ? (toN === null ? "" : addDays(to, 1 - REPORT_DEFAULT_DAYS)) : input.from;
  const fromN = dayNumber(from);
  if (fromN === null || toN === null || todayN === null) return { ok: false, error: "Dates are written as YYYY-MM-DD." };
  if (toN > todayN) return { ok: false, error: "The end date cannot be in the future." };
  if (fromN > toN) return { ok: false, error: "The start date must not be after the end date." };
  if (toN - fromN + 1 > maxDays) return { ok: false, error: `Choose at most ${String(maxDays)} days.` };
  return { ok: true, from, to };
}

// ---------------------------------------------------------------- postback reconciliation

/**
 * The reconciliation identity of the postback report, per adnet (plan M10 Verify): every order that was PAID with
 * a click id has exactly one S2S MT row, and a row that is settled is `sent` or `failed`. So
 * `sent + failed = paidOrders` once nothing is in flight. `inFlight` (pending or sending) rows are not a
 * mismatch: they are the ones still on their way. `gap` is what neither a settled nor an in-flight row explains:
 * positive = a paid order has no MT row (a lost conversion), negative = an MT row without a paid order.
 */
export interface MtReconciliationInput {
  readonly paidOrders: number;
  readonly sent: number;
  readonly failed: number;
  readonly inFlight: number;
}

export interface MtReconciliation extends MtReconciliationInput {
  /** sent + failed: the rows that reached an end state. */
  readonly settled: number;
  readonly gap: number;
  /** paid orders = settled + in flight: no row is missing and none is extra. */
  readonly balanced: boolean;
  /** balanced and nothing in flight: the identity MT (sent + failed) = PAID orders with a click id holds exactly. */
  readonly identity: boolean;
}

export function mtReconciliation(input: MtReconciliationInput): MtReconciliation {
  for (const [name, value] of Object.entries(input)) if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  const settled = input.sent + input.failed;
  const gap = input.paidOrders - settled - input.inFlight;
  return { ...input, settled, gap, balanced: gap === 0, identity: gap === 0 && input.inFlight === 0 };
}

// ---------------------------------------------------------------- CSV

/** Excel reads a UTF-8 file as the local code page unless it starts with a byte order mark. */
export const CSV_BOM = "\uFEFF";

/**
 * A cell that a spreadsheet would run as a formula: it starts with = + - @ after any leading whitespace (\s: space, tab, line breaks,
 * no-break space, the byte order mark, the ideographic space U+3000, ...) or zero-width space, or it starts with a tab, a carriage
 * return or a line feed at all. request.ts accepts every one of them in a buyer's name and e-mail, and utm values come from a URL, so
 * any text cell of any export may be one.
 */
const FORMULA = /^[\s\u200B\uFEFF\u3000]*[=+\-@]|^[\t\r\n]/u;

export type CsvCell = string | number | null;

/**
 * One CSV field (RFC 4180). A TEXT cell that could be a formula is neutralized with a leading apostrophe (the
 * spreadsheet then shows it as text); a NUMBER is written as its digits (a net loss is a negative number, not an
 * attack: it is never text). Fields with a comma, a semicolon, a quote or a line break are quoted, quotes doubled (a semicolon, because
 * Excel in the id-ID locale takes it as the list separator and would split an unquoted field there).
 */
export function csvCell(value: CsvCell): string {
  if (value === null) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("a CSV number must be finite");
    return String(value);
  }
  const text = FORMULA.test(value) ? `'${value}` : value;
  return /[",;\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One CSV record, CRLF terminated. */
export const csvLine = (cells: readonly CsvCell[]): string => `${cells.map(csvCell).join(",")}\r\n`;

/**
 * The name of an export file: the report and the range only, never a person's name, phone or e-mail
 * (a file name ends up in a browser's download list and a shared drive).
 */
export function csvFileName(report: "sales" | "winners", parts: readonly string[]): string {
  const safe = parts.map((p) => p.replace(/[^A-Za-z0-9_-]/g, "")).filter((p) => p !== "");
  return `${[report, ...safe].join("-")}.csv`;
}
