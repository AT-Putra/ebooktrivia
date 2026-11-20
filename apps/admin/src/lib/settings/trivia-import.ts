// Bulk import of a trivia set's questions from CSV or XLSX (AC-Q15; US-018). ALL OR NOTHING: every
// row is validated first; if any row is invalid nothing is written and every bad row is reported
// with its row number and reason. Valid files append their questions after the set's last one.
//
// The one column layout (header row required, exactly these names, any letter case):
//   prompt | option_1 | option_2 | option_3 | option_4 | correct | points | timer_seconds | explanation
//   - prompt: the question, up to 500 characters (line breaks allowed);
//   - option_1..option_4: 2 to 4 options in order without gaps (leave option_3 / option_4 empty
//     for fewer), one line each, up to 120 characters, all different;
//   - correct: the number (1-4) of the correct option;
//   - points / timer_seconds: whole numbers (0-1000, 5-600 s); empty = the program's defaults;
//   - explanation: optional, up to 1000 characters, shown after a wrong pick.
//   Images cannot be imported (add them per question afterwards). Row numbers count the header
//   as row 1, like a spreadsheet; blank rows are skipped (and keep their numbers).
//
// Parsing (the file is untrusted; security review US-018 M1: one 1.7 MiB XLSX took ~311 MiB of heap
// under the earlier limits, two at once killed the admin process):
//   - one request of at most IMPORT_MAX_BYTES (2 MiB) and IMPORT_MAX_ROWS (500) questions; rows past
//     IMPORT_MAX_ROWS + 1 (with the header) are not even collected, and a CSV is parsed row by row
//     and stops there, or after IMPORT_MAX_RECORDS records blank ones included;
//   - the upload policy (@ebooktrivia/uploads checkUpload, kind "import") decides CSV or XLSX from
//     the bytes; an XLSX goes through inspectZip with tight limits (6 MiB unpacked, 50 entries;
//     a 500-question workbook is far below both) and exceljs reads ONLY the canonical archive it
//     returns, one XLSX at a time per process;
//   - CSV: UTF-8 (a BOM is dropped), delimiter detected by papaparse (comma, semicolon, tab, ...);
//   - XLSX: the first worksheet; a cell is read as plain text (string, rich text, hyperlink text;
//     numbers as written, booleans as TRUE / FALSE). FORMULA cells are REJECTED (paste values),
//     whatever their cached result, as are dates, error values and merged cells;
//   - every value is trimmed and CR LF / CR become LF.
// Cells starting with = + - @ are stored as text and never evaluated; any later export of them must
// neutralise them (upload policy caller contract).
import { createHash } from "node:crypto";
import { checkUpload, DEFAULT_UPLOAD_LIMITS, sniff, UploadRejected } from "@ebooktrivia/uploads";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { can } from "../policy.ts";
import type { Sql } from "../db.ts";
import { InvalidInput, NotAllowed } from "./fields.ts";
import { type Actor, type Defaults, importTarget, insertImported, type QuestionDraft, STAFF_LOCKED, validateQuestion } from "./trivia.ts";
import { IMPORT_COLUMNS, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from "./trivia-import-format.ts";

export { IMPORT_COLUMNS, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, IMPORT_TEMPLATE_CSV } from "./trivia-import-format.ts";

const MiB = 1024 * 1024;
/** Non-blank rows collected: the header, IMPORT_MAX_ROWS questions and one more to tell "too many". */
const COLLECT_ROWS = IMPORT_MAX_ROWS + 2;
/** CSV records read at most, blank ones included (2 MiB of line breaks is not 2 million rows). */
export const IMPORT_MAX_RECORDS = 5000;
export const IMPORT_UPLOAD_LIMITS = Object.freeze({
  ...DEFAULT_UPLOAD_LIMITS,
  importMaxBytes: IMPORT_MAX_BYTES,
  xlsxMaxUncompressedBytes: 6 * MiB,
  xlsxMaxEntries: 50,
});

export interface RowError {
  readonly row: number;
  readonly message: string;
}

export interface SheetRow {
  readonly row: number;
  readonly cells: readonly string[];
  /** A cell that cannot be read as text (formula, date, error, merged), else null. */
  readonly problem: string | null;
}

export interface QuestionFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
}

export type ImportOutcome = { readonly kind: "imported"; readonly count: number } | { readonly kind: "rejected"; readonly errors: readonly RowError[] };

const blank = (row: SheetRow): boolean => row.problem === null && row.cells.every((c) => c === "");
const clean = (value: string): string => value.replace(/\r\n?/g, "\n").trim();
const columnName = (index: number): string => IMPORT_COLUMNS[index] ?? `column ${String(index + 1)}`;

const REJECTIONS: Readonly<Partial<Record<UploadRejected["code"], string>>> = {
  too_large: "The file is larger than 2 MB.",
  unknown_type: "This file is not a CSV (UTF-8) or XLSX file.",
  type_not_allowed: "This file is not a CSV (UTF-8) or XLSX file.",
  extension_mismatch: "The file name must end in .csv or .xlsx and match its content.",
  mime_mismatch: "The file type does not match its content (CSV or XLSX expected).",
  svg_not_allowed: "This file is not a CSV (UTF-8) or XLSX file.",
  invalid_xlsx: "This XLSX file cannot be read. Save it again from your spreadsheet app, or use CSV.",
  xlsx_too_large_uncompressed: "This XLSX file is too large once unpacked.",
};

function csvRows(bytes: Buffer): SheetRow[] {
  const text = new TextDecoder("utf-8").decode(bytes).replace(/\r\n?/g, "\n");
  const rows: SheetRow[] = [];
  let records = 0;
  const limit = { reached: false };
  Papa.parse(text, {
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
    newline: "\n",
    step: (result, parser) => {
      records++;
      const error = result.errors.find((e) => e.code !== "UndetectableDelimiter");
      const problem = error === undefined ? null : error.code === "MissingQuotes" ? "a quoted cell is not closed" : "the row cannot be read (check its quotes)";
      const row = { row: records, cells: result.data.map(clean), problem };
      if (!blank(row)) rows.push(row);
      if (rows.length >= COLLECT_ROWS) {
        parser.abort();
      } else if (records > IMPORT_MAX_RECORDS) {
        limit.reached = true;
        parser.abort();
      }
    },
  });
  if (limit.reached) throw new InvalidInput(`The file has more than ${IMPORT_MAX_RECORDS.toLocaleString("en-US")} rows (blank rows count too).`);
  return rows;
}

type CellText = { readonly text: string } | { readonly problem: string };

function cellText(cell: ExcelJS.Cell, column: string): CellText {
  const value = cell.value;
  if (cell.type === ExcelJS.ValueType.Merge) return { problem: `${column} is part of merged cells (unmerge them)` };
  if (value === null || value === undefined) return { text: "" };
  if (typeof value === "string") return { text: value };
  if (typeof value === "number") return { text: String(value) };
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE" };
  if (value instanceof Date) return { problem: `${column} is a date: format the column as text` };
  if ("formula" in value || "sharedFormula" in value) return { problem: `${column} holds a formula: paste the values only` };
  if ("error" in value) return { problem: `${column} shows an error value (${value.error})` };
  if ("richText" in value) return { text: value.richText.map((part) => part.text).join("") };
  // A hyperlink cell: its shown text (exceljs may give rich text here too).
  const shown: unknown = value.text;
  if (typeof shown === "string") return { text: shown };
  if (typeof shown === "object" && shown !== null && "richText" in shown && Array.isArray(shown.richText)) {
    return { text: (shown.richText as { text?: unknown }[]).map((part) => (typeof part.text === "string" ? part.text : "")).join("") };
  }
  return { problem: `${column} cannot be read as text` };
}

async function xlsxRows(canonical: Buffer): Promise<SheetRow[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(canonical as unknown as ArrayBuffer);
  } catch {
    throw new InvalidInput(REJECTIONS.invalid_xlsx ?? "This XLSX file cannot be read.");
  }
  const sheet = workbook.worksheets[0];
  if (sheet === undefined) throw new InvalidInput("This XLSX file has no worksheet.");
  const rows: SheetRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rows.length >= COLLECT_ROWS) return;
    const cells: string[] = [];
    let problem: string | null = null;
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const read = cellText(cell, columnName(columnNumber - 1));
      if ("problem" in read) {
        problem ??= read.problem;
        return;
      }
      while (cells.length < columnNumber - 1) cells.push("");
      cells[columnNumber - 1] = clean(read.text);
    });
    const sheetRow = { row: rowNumber, cells, problem };
    if (!blank(sheetRow)) rows.push(sheetRow);
  });
  return rows;
}

/**
 * One XLSX parse at a time per process (security review US-018 M1: the parse is memory-heavy), and
 * at most XLSX_MAX_WAITING more waiting their turn (security review N2: an unbounded queue holds
 * every waiting file in memory); beyond that the import is refused with IMPORT_BUSY.
 */
export const XLSX_MAX_WAITING = 3;
export const IMPORT_BUSY = "The server is busy reading other spreadsheet imports. Try again in a minute.";
let xlsxQueue: Promise<unknown> = Promise.resolve();
let xlsxWaiting = 0;
function oneXlsxAtATime<T>(fn: () => Promise<T>): Promise<T> {
  if (xlsxWaiting > XLSX_MAX_WAITING - 1) return Promise.reject(new InvalidInput(IMPORT_BUSY));
  xlsxWaiting++;
  const start = (): Promise<T> => {
    xlsxWaiting--;
    return fn();
  };
  const run = xlsxQueue.then(start, start);
  xlsxQueue = run.catch(() => undefined);
  return run;
}

/** Reads the uploaded file into rows of trimmed text (file-level problems throw InvalidInput). */
export async function readQuestionFile(file: QuestionFile): Promise<{ readonly type: "csv" | "xlsx"; readonly rows: SheetRow[]; readonly sizeBytes: number; readonly sha256: string }> {
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const read = async () => {
    let accepted;
    try {
      accepted = await checkUpload({ kind: "import", bytes: file.bytes, filename: file.filename, mimeType: file.mimeType }, IMPORT_UPLOAD_LIMITS);
    } catch (error) {
      if (!(error instanceof UploadRejected)) throw error;
      throw new InvalidInput(REJECTIONS[error.code] ?? "This file is not accepted.");
    }
    if (accepted.type === "csv") return { type: "csv" as const, rows: csvRows(accepted.bytes), sizeBytes: file.bytes.length, sha256 };
    if (accepted.type === "xlsx") return { type: "xlsx" as const, rows: await xlsxRows(accepted.bytes), sizeBytes: file.bytes.length, sha256 };
    throw new InvalidInput(REJECTIONS.type_not_allowed ?? "This file is not accepted.");
  };
  const bytes = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
  return sniff(bytes) === "xlsx" ? oneXlsxAtATime(read) : read();
}

/** Validates every data row (pure). File-level problems throw InvalidInput. */
export function validateRows(rows: readonly SheetRow[], defaults: Defaults): { readonly drafts: QuestionDraft[]; readonly errors: RowError[] } {
  const [header, ...rest] = rows.filter((r) => !blank(r));
  const names = (header?.cells ?? []).map((c) => c.toLowerCase());
  while (names.length > IMPORT_COLUMNS.length && names[names.length - 1] === "") names.pop();
  if (header === undefined || header.problem !== null || names.join(",") !== IMPORT_COLUMNS.join(",")) {
    throw new InvalidInput(`The first row must be the header: ${IMPORT_COLUMNS.join(", ")} (download the template).`);
  }
  if (rest.length === 0) throw new InvalidInput("The file has no questions under the header.");
  if (rest.length > IMPORT_MAX_ROWS) throw new InvalidInput(`At most ${String(IMPORT_MAX_ROWS)} questions per import: this file has more.`);
  const drafts: QuestionDraft[] = [];
  const errors: RowError[] = [];
  for (const row of rest) {
    if (row.problem !== null) {
      errors.push({ row: row.row, message: row.problem });
      continue;
    }
    const extra = row.cells.findIndex((c, i) => i >= IMPORT_COLUMNS.length && c !== "");
    if (extra !== -1) {
      errors.push({ row: row.row, message: `there is a value after the explanation column (${columnName(extra)})` });
      continue;
    }
    const cell = (i: number): string => row.cells[i] ?? "";
    const result = validateQuestion({ prompt: cell(0), options: [cell(1), cell(2), cell(3), cell(4)], correct: cell(5), points: cell(6), timerSeconds: cell(7), explanation: cell(8) }, defaults);
    if ("error" in result) errors.push({ row: row.row, message: result.error });
    else drafts.push(result);
  }
  return { drafts, errors };
}

/** Imports `file` into the set: all questions, or none and the list of bad rows. */
export async function importQuestionFile(sql: Sql, actor: Actor, ids: { readonly programId: string; readonly setId: string }, file: QuestionFile): Promise<ImportOutcome> {
  const target = await importTarget(sql, ids.programId, ids.setId);
  if (target === null) throw new InvalidInput("This trivia set no longer exists.");
  if (!can(actor.role, "question.import", { setLocked: target.locked })) throw new NotAllowed(STAFF_LOCKED);
  if (target.locked) throw new InvalidInput("This set has attempts: questions can no longer be added.");
  const sheet = await readQuestionFile(file);
  const { drafts, errors } = validateRows(sheet.rows, target.defaults);
  if (errors.length > 0) return { kind: "rejected", errors };
  const count = await insertImported(sql, actor, ids, drafts, { type: sheet.type, sizeBytes: sheet.sizeBytes, sha256: sheet.sha256 });
  return { kind: "imported", count };
}
