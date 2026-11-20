// The question import's column layout and limits (AC-Q15; US-018), on their own so the trivia set
// page can show them without loading the parser (exceljs, papaparse) or the upload policy (sharp):
// code review US-018 F10. lib/settings/trivia-import.ts documents the format and parses it.

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 500;
export const IMPORT_COLUMNS = ["prompt", "option_1", "option_2", "option_3", "option_4", "correct", "points", "timer_seconds", "explanation"] as const;

/** The downloadable template (UTF-8 CSV; spreadsheet apps open it, and can save it as XLSX). */
export const IMPORT_TEMPLATE_CSV = [
  IMPORT_COLUMNS.join(","),
  "Ibu kota Indonesia adalah?,Jakarta,Bandung,Surabaya,Medan,1,10,20,Jakarta adalah ibu kota Indonesia.",
  "Gunung tertinggi di Pulau Jawa?,Semeru,Merapi,,,1,,,",
  "",
].join("\r\n");
