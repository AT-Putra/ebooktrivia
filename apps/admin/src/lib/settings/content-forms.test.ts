// US-018 (M5b) pure validation: question fields (forms and import rows), the CSV / XLSX import
// (row-level errors, header, formula cells, caps), the override reason, OTP / rate limits, prize
// tiers, legal pages, and the unknown-field refusal. Expected values are written out by hand.
import { crc32, deflateSync } from "node:zlib";
import { checkUpload, UploadRejected } from "@ebooktrivia/uploads";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { FIELD_MAX_CODE_POINTS, formValue, InvalidInput, onlyFields, onlyParams } from "./fields.ts";
import { IMAGE_LIMITS, IMAGE_MAX_INPUT_PIXELS } from "./images.ts";
import { parseKind, parseLegalBody } from "./legal.ts";
import { LIMITS, parseLimits } from "./limits.ts";
import { parsePrizeTier } from "./prizes.ts";
import { parseReason } from "./rescore.ts";
import {
  IMPORT_BUSY,
  IMPORT_COLUMNS,
  IMPORT_MAX_RECORDS,
  IMPORT_MAX_ROWS,
  IMPORT_TEMPLATE_CSV,
  IMPORT_UPLOAD_LIMITS,
  readQuestionFile,
  type SheetRow,
  validateRows,
  XLSX_MAX_WAITING,
} from "./trivia-import.ts";
import { parseNewQuestion, parseQuestionEdit, validateQuestion } from "./trivia.ts";

const refused = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidInput) return error.message;
    throw error;
  }
  throw new Error("expected InvalidInput");
};
const refusedAsync = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    if (error instanceof InvalidInput) return error.message;
    throw error;
  }
  throw new Error("expected InvalidInput");
};

const DEFAULTS = { points: 10, timerSeconds: 20 };
const form = (entries: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
};
const text = (overrides: Partial<Parameters<typeof validateQuestion>[0]> = {}) => ({
  prompt: "Ibu kota Indonesia?",
  options: ["Jakarta", "Bandung", "", ""],
  correct: "1",
  points: "",
  timerSeconds: "",
  explanation: "",
  ...overrides,
});

describe("validateQuestion (forms and import rows)", () => {
  it("takes the program's defaults for empty points and timer, and 2-4 options in order", () => {
    expect(validateQuestion(text(), DEFAULTS)).toEqual({ prompt: "Ibu kota Indonesia?", options: ["Jakarta", "Bandung"], correct: 1, points: 10, timerSeconds: 20, explanation: null });
    expect(validateQuestion(text({ options: ["A", "B", "C", "D"], correct: "4", points: "25", timerSeconds: "45", explanation: "Karena\r\nbegitu." }), DEFAULTS)).toEqual({
      prompt: "Ibu kota Indonesia?",
      options: ["A", "B", "C", "D"],
      correct: 4,
      points: 25,
      timerSeconds: 45,
      explanation: "Karena\nbegitu.",
    });
  });

  it.each<[string, Partial<Parameters<typeof validateQuestion>[0]>, RegExp]>([
    ["an empty prompt", { prompt: "  " }, /Enter the question/],
    ["a prompt over 500 characters", { prompt: "x".repeat(501) }, /up to 500/],
    ["one option", { options: ["A", "", "", ""] }, /2 to 4 options/],
    ["a gap in the options", { options: ["A", "", "C", ""] }, /without gaps/],
    ["an option over 120 characters", { options: ["A", "b".repeat(121), "", ""] }, /Option 2 is up to 120/],
    ["an option on two lines", { options: ["A", "B\nC", "", ""] }, /one line/],
    ["two options alike (letter case ignored)", { options: ["Jakarta", "JAKARTA", "", ""] }, /same text/],
    ["a correct answer beyond the options", { correct: "3" }, /1 to 2/],
    ["a correct answer that is not a number", { correct: "a" }, /correct answer/],
    ["negative points", { points: "-1" }, /Points are a whole number from 0 to 1000/],
    ["fractional points", { points: "1.5" }, /Points/],
    ["a timer under 5 s", { timerSeconds: "4" }, /5 to 600/],
    ["a timer over 600 s", { timerSeconds: "601" }, /5 to 600/],
    ["an explanation over 1000 characters", { explanation: "e".repeat(1001) }, /up to 1000/],
  ])("refuses %s", (_what, change, message) => {
    const result = validateQuestion(text(change), DEFAULTS);
    expect("error" in result ? result.error : "accepted").toMatch(message);
  });

  it("the new-question form and the edit form (a locked set's form has no scoring fields)", () => {
    expect(parseNewQuestion(form({ prompt: "Q?", option1: "A", option2: "B", option3: "", option4: "", correct: "2", points: "", timerSeconds: "", explanation: "" }), DEFAULTS)).toMatchObject({ correct: 2, points: 10, timerSeconds: 20 });
    expect(refused(() => parseNewQuestion(form({ prompt: "", option1: "A", option2: "B", correct: "1" }), DEFAULTS))).toMatch(/Enter the question/);
    expect(parseQuestionEdit(form({ prompt: "Q (fixed)?", option1: "A", option2: "B", explanation: "" }))).toEqual({ prompt: "Q (fixed)?", explanation: null, options: ["A", "B"], correct: null, points: null, timerSeconds: null });
    expect(parseQuestionEdit(form({ prompt: "Q?", option1: "A", option2: "B", correct: "2", points: "0", timerSeconds: "5", explanation: "x" }))).toMatchObject({ correct: 2, points: 0, timerSeconds: 5 });
    expect(refused(() => parseQuestionEdit(form({ prompt: "Q?", option1: "A", option2: "B", points: "" })))).toMatch(/Points/);
  });
});

const row = (n: number, cells: string[], problem: string | null = null): SheetRow => ({ row: n, cells, problem });
const HEADER = row(1, [...IMPORT_COLUMNS]);

describe("validateRows: all or nothing, every bad row with its number", () => {
  it("lists every invalid row (numbers as in the file) and keeps nothing to write", () => {
    const { drafts, errors } = validateRows(
      [
        HEADER,
        row(2, ["Ibu kota?", "Jakarta", "Bandung", "", "", "1", "", "", ""]),
        row(3, ["", "A", "B", "", "", "1", "", "", ""]),
        row(4, [], null),
        row(5, ["Q?", "A", "", "C", "", "1", "", "", ""]),
        row(6, ["Q?", "A", "B", "", "", "3", "", "", ""]),
        row(7, ["Q?", "A", "B", "", "", "1", "1001", "", ""]),
        row(8, ["Q?", "A", "B", "", "", "1", "", "", "", "extra"]),
        row(9, ["Q?"], "points holds a formula: paste the values only"),
      ],
      DEFAULTS,
    );
    expect(drafts).toHaveLength(1);
    expect(errors).toEqual([
      { row: 3, message: "Enter the question (up to 500 characters)." },
      { row: 5, message: "Enter 2 to 4 options, in order without gaps." },
      { row: 6, message: "The correct answer is the number of a filled option (1 to 2)." },
      { row: 7, message: "Points are a whole number from 0 to 1000." },
      { row: 8, message: "there is a value after the explanation column (column 10)" },
      { row: 9, message: "points holds a formula: paste the values only" },
    ]);
  });

  it("needs the header row first (any letter case), and at least one and at most 500 questions", () => {
    expect(validateRows([row(1, IMPORT_COLUMNS.map((c) => c.toUpperCase())), row(2, ["Q?", "A", "B", "", "", "1"])], DEFAULTS).drafts).toHaveLength(1);
    expect(refused(() => validateRows([row(1, ["question", "a", "b"]), row(2, ["Q?", "A", "B", "", "", "1"])], DEFAULTS))).toMatch(/first row must be the header/);
    expect(refused(() => validateRows([HEADER], DEFAULTS))).toMatch(/no questions/);
    expect(refused(() => validateRows([], DEFAULTS))).toMatch(/header/);
    const many = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => row(i + 2, ["Q?", "A", "B", "", "", "1"]));
    expect(refused(() => validateRows([HEADER, ...many], DEFAULTS))).toMatch(/At most 500 questions per import: this file has more/);
    expect(validateRows([HEADER, ...many.slice(0, IMPORT_MAX_ROWS)], DEFAULTS).drafts).toHaveLength(IMPORT_MAX_ROWS);
  });
});

const csv = (body: string, filename = "soal.csv") => readQuestionFile({ bytes: Buffer.from(body, "utf8"), filename, mimeType: "text/csv" });

describe("readQuestionFile: CSV", () => {
  it("reads the downloadable template, trimmed, with its defaults", async () => {
    const sheet = await csv(IMPORT_TEMPLATE_CSV);
    expect(sheet.type).toBe("csv");
    const { drafts, errors } = validateRows(sheet.rows, DEFAULTS);
    expect(errors).toEqual([]);
    expect(drafts.map((d) => [d.options.length, d.correct, d.points, d.timerSeconds])).toEqual([
      [4, 1, 10, 20],
      [2, 1, 10, 20],
    ]);
  });

  it("detects a semicolon delimiter, drops a BOM, normalises CR LF inside quoted cells, trims", async () => {
    const sheet = await csv(`${String.fromCharCode(0xfeff)}${IMPORT_COLUMNS.join(";")}\r\n"  Baris satu\r\nbaris dua  ";A;B;;;2;5;10;\r\n`);
    expect(validateRows(sheet.rows, DEFAULTS)).toEqual({ drafts: [{ prompt: "Baris satu\nbaris dua", options: ["A", "B"], correct: 2, points: 5, timerSeconds: 10, explanation: null }], errors: [] });
  });

  it("reports an unclosed quote on its row, and numbers rows like the file (blank rows keep their number)", async () => {
    const sheet = await csv(`${IMPORT_COLUMNS.join(",")}\nQ1?,A,B,,,1,,,\n\nQ3?,A,B,,,9,,,\n"Q4?,A,B,,,1,,,\n`);
    expect(validateRows(sheet.rows, DEFAULTS).errors).toEqual([
      { row: 4, message: "The correct answer is the number of a filled option (1 to 2)." },
      { row: 5, message: "a quoted cell is not closed" },
    ]);
  });

  it("refuses what is not a CSV or XLSX, by content, and files over 2 MB", async () => {
    expect(await refusedAsync(readQuestionFile({ bytes: Buffer.from("%PDF-1.7\n"), filename: "soal.csv", mimeType: "text/csv" }))).toMatch(/not a CSV/);
    expect(await refusedAsync(readQuestionFile({ bytes: Buffer.from("a,b\n"), filename: "soal.txt", mimeType: "text/plain" }))).toMatch(/must end in .csv or .xlsx/);
    expect(await refusedAsync(csv("x".repeat(2 * 1024 * 1024 + 1)))).toMatch(/larger than 2 MB/);
    expect(await refusedAsync(readQuestionFile({ bytes: Buffer.from("PK\u0003\u0004 not a zip"), filename: "soal.xlsx", mimeType: "" }))).toMatch(/cannot be read/);
  });
});

async function workbook(fill: (sheet: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  fill(book.addWorksheet("Soal"));
  return Buffer.from(await book.xlsx.writeBuffer());
}
const xlsx = (bytes: Buffer) => readQuestionFile({ bytes, filename: "soal.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

describe("readQuestionFile: XLSX (through the canonical archive)", () => {
  it("reads strings, numbers, rich text and hyperlinks as plain text; numbers as written", async () => {
    const bytes = await workbook((s) => {
      s.addRow([...IMPORT_COLUMNS]);
      s.addRow([{ richText: [{ text: "Tahun " }, { text: "kemerdekaan?", font: { bold: true } }] }, 1945, 1950, { text: "1955", hyperlink: "https://example.test" }, null, 1, 15, 30, "  Proklamasi  "]);
    });
    const sheet = await xlsx(bytes);
    expect(sheet.type).toBe("xlsx");
    expect(validateRows(sheet.rows, DEFAULTS)).toEqual({ drafts: [{ prompt: "Tahun kemerdekaan?", options: ["1945", "1950", "1955"], correct: 1, points: 15, timerSeconds: 30, explanation: "Proklamasi" }], errors: [] });
  });

  it("refuses formula cells (whatever their cached result), dates, error values and merged cells, per row", async () => {
    const bytes = await workbook((s) => {
      s.addRow([...IMPORT_COLUMNS]);
      s.addRow(["Q2?", "A", "B", null, null, { formula: "1+0", result: 1 }]);
      s.addRow(["Q3?", "A", "B", null, null, 1, { sharedFormula: "F2", result: 10 }]);
      s.addRow([new Date("2027-01-01T00:00:00Z"), "A", "B", null, null, 1]);
      s.addRow(["Q5?", "A", "B", null, null, { error: "#N/A" }]);
      s.addRow(["Q6?", "A", "B", null, null, 1]);
      s.mergeCells("B6:C6");
      s.addRow(["Q7?", "A", "B", null, null, 2]);
    });
    const { drafts, errors } = validateRows((await xlsx(bytes)).rows, DEFAULTS);
    expect(errors).toEqual([
      { row: 2, message: "correct holds a formula: paste the values only" },
      { row: 3, message: "points holds a formula: paste the values only" },
      { row: 4, message: "prompt is a date: format the column as text" },
      { row: 5, message: "correct shows an error value (#N/A)" },
      { row: 6, message: "option_2 is part of merged cells (unmerge them)" },
    ]);
    expect(drafts).toHaveLength(1);
  });
});

describe("override reason, limits, prize tiers, legal pages", () => {
  it("the override reason: 10-500 characters, no e-mail address or phone number (the audit log holds no PII)", () => {
    expect(parseReason("  Kunci jawaban soal 3 salah ketik.  ")).toBe("Kunci jawaban soal 3 salah ketik.");
    expect(parseReason("Timer terlalu panjang sejak 2027-05-01, dipendekkan.")).toMatch(/2027-05-01/);
    for (const bad of ["short", "Dilaporkan oleh budi@example.test lewat WA", "Pemain 0812 3456 7890 melapor", "Pemain +62 812-3456-7890 melapor", "Order 12345678901 bermasalah"]) {
      expect(() => parseReason(bad), bad).toThrow(InvalidInput);
    }
  });

  it("limits: every key bounded, all required, cooldown shorter than the code validity", () => {
    const values = Object.fromEntries(LIMITS.map((l) => [l.field, String(l.fallback)]));
    expect(parseLimits(form(values))).toEqual(Object.fromEntries(LIMITS.map((l) => [l.key, l.fallback])));
    expect(Object.fromEntries(LIMITS.map((l) => [l.key, [l.min, l.max]]))).toEqual({
      "otp.code_ttl_seconds": [60, 900],
      "otp.max_attempts": [1, 5],
      "otp.phone_cap": [1, 10],
      "otp.phone_window_seconds": [3600, 86_400],
      "otp.ip_cap": [1, 100],
      "otp.ip_window_seconds": [600, 86_400],
      "otp.cooldown_seconds": [15, 600],
      "orders.expiry_seconds": [900, 86_400],
      "orders.sales_close_buffer_minutes": [5, 1440],
      "checkout.ip_cap": [1, 1000],
      "checkout.ip_window_seconds": [60, 86_400],
      "checkout.phone_cap": [1, 100],
      "checkout.phone_window_seconds": [60, 86_400],
      "checkout.lp_cap": [1, 100_000],
      "checkout.lp_window_seconds": [60, 86_400],
      "captcha.ip_cap": [1, 1000],
      "captcha.ip_window_seconds": [60, 86_400],
      "captcha.ip48_cap": [1, 100_000],
    });
    for (const l of LIMITS) {
      for (const bad of [String(l.min - 1), String(l.max + 1), "", "1.5", "-5", "1e3"]) {
        expect(refused(() => parseLimits(form({ ...values, [l.field]: bad }))), `${l.key}=${bad}`).toMatch(l.label);
      }
    }
    expect(refused(() => parseLimits(form({ ...values, cooldownSeconds: "300", codeTtlSeconds: "300" })))).toMatch(/shorter than the code validity/);
  });

  it("prize tiers: rank range 1-1000 with last >= first, whole rupiah (dots allowed), optional description", () => {
    expect(parsePrizeTier(form({ rankFrom: "1", rankTo: "3", name: "Voucher", description: "", valueIdr: "1.500.000" }))).toEqual({ rankFrom: 1, rankTo: 3, name: "Voucher", description: null, valueIdr: 1_500_000 });
    expect(refused(() => parsePrizeTier(form({ rankFrom: "5", rankTo: "4", name: "X", valueIdr: "0" })))).toMatch(/last rank/);
    expect(refused(() => parsePrizeTier(form({ rankFrom: "0", rankTo: "4", name: "X", valueIdr: "0" })))).toMatch(/first rank/);
    expect(refused(() => parsePrizeTier(form({ rankFrom: "1", rankTo: "1", name: "X", valueIdr: "10,5" })))).toMatch(/whole rupiah/);
  });

  it("legal pages: two kinds, a body of 1-60 000 characters", () => {
    expect(parseKind("terms")).toBe("terms");
    expect(() => parseKind("cookies")).toThrow(InvalidInput);
    expect(parseLegalBody("# S&K\r\nIsi")).toBe("# S&K\nIsi");
    expect(() => parseLegalBody("x".repeat(60_001))).toThrow(InvalidInput);
    expect(() => parseLegalBody(" \n ")).toThrow(InvalidInput);
  });
});

describe("unknown form fields and query parameters are refused", () => {
  it("onlyFields / onlyParams", () => {
    expect(() => {
      onlyFields(form({ programId: "x", title: "y", $ACTION_ID_abc: "" }), ["programId", "title"]);
    }).not.toThrow();
    expect(refused(() => {
      onlyFields(form({ programId: "x", title: "y", points: "999" }), ["programId", "title"]);
    })).toMatch(/unexpected field/);
    const twice = form({ title: "a" });
    twice.append("title", "b");
    expect(() => {
      onlyFields(twice, ["title"]);
    }).toThrow(InvalidInput);
    expect(() => {
      onlyParams(new URLSearchParams("program=a&set=b&question=c"), ["program", "set"]);
    }).toThrow(InvalidInput);
  });
});

describe("import and image limits (security review US-018 M1, code review CSV LOW)", () => {
  it("an XLSX may unpack to 6 MiB and hold 50 entries at most", async () => {
    expect(IMPORT_UPLOAD_LIMITS).toMatchObject({ importMaxBytes: 2 * 1024 * 1024, xlsxMaxUncompressedBytes: 6 * 1024 * 1024, xlsxMaxEntries: 50 });
    const big = await workbook((sheet) => {
      sheet.addRow([...IMPORT_COLUMNS]);
      // Distinct, highly compressible strings: a small file that unpacks past 6 MiB.
      for (let i = 0; i < 260; i++) sheet.addRow([`${"x".repeat(30_000)}${String(i)}`, "A", "B", null, null, 1]);
    });
    expect(big.length).toBeLessThan(2 * 1024 * 1024);
    expect(await refusedAsync(xlsx(big))).toMatch(/too large once unpacked/);
    const many = await (async () => {
      const book = new ExcelJS.Workbook();
      for (let i = 0; i < 60; i++) book.addWorksheet(`S${String(i)}`).addRow([...IMPORT_COLUMNS]);
      return Buffer.from(await book.xlsx.writeBuffer());
    })();
    expect(await refusedAsync(xlsx(many))).toMatch(/cannot be read/);
  });

  it("parses one XLSX at a time per process", async () => {
    const book = await workbook((sheet) => {
      sheet.addRow([...IMPORT_COLUMNS]);
      sheet.addRow(["Q?", "A", "B", null, null, 1]);
    });
    const proto = Object.getPrototypeOf(new ExcelJS.Workbook().xlsx) as { load: (...args: unknown[]) => Promise<unknown> };
    const original = proto.load;
    let active = 0;
    let peak = 0;
    const spy = vi.spyOn(proto, "load").mockImplementation(async function (this: unknown, ...args: unknown[]) {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 50));
      try {
        return await original.apply(this, args);
      } finally {
        active--;
      }
    });
    try {
      const results = await Promise.all([xlsx(book), xlsx(book), xlsx(book)]);
      expect(results.map((r) => r.type)).toEqual(["xlsx", "xlsx", "xlsx"]);
      expect(peak).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses an XLSX import while 3 more already wait their turn (security review N2), and serves the queued ones", async () => {
    expect(XLSX_MAX_WAITING).toBe(3);
    const book = await workbook((sheet) => {
      sheet.addRow([...IMPORT_COLUMNS]);
      sheet.addRow(["Q?", "A", "B", null, null, 1]);
    });
    const proto = Object.getPrototypeOf(new ExcelJS.Workbook().xlsx) as { load: (...args: unknown[]) => Promise<unknown> };
    const original = proto.load;
    const spy = vi.spyOn(proto, "load").mockImplementation(async function (this: unknown, ...args: unknown[]) {
      await new Promise((r) => setTimeout(r, 100));
      return original.apply(this, args);
    });
    try {
      const running = xlsx(book);
      await new Promise((r) => setTimeout(r, 30)); // the first one is parsing, none waits
      const waiting = [xlsx(book), xlsx(book), xlsx(book)];
      expect(await refusedAsync(xlsx(book))).toBe(IMPORT_BUSY);
      expect((await Promise.all([running, ...waiting])).map((r) => r.type)).toEqual(["xlsx", "xlsx", "xlsx", "xlsx"]);
      // Once the queue has drained, imports are accepted again.
      expect((await xlsx(book)).type).toBe("xlsx");
    } finally {
      spy.mockRestore();
    }
  });

  it("a CSV stops after the header + 501 rows, and 2 MiB of blank lines is refused after a few thousand records", async () => {
    const rows = Array.from({ length: 700 }, (_, i) => `Q${String(i)}?,A,B,,,1,,,`);
    const sheet = await csv(`${IMPORT_COLUMNS.join(",")}\n${rows.join("\n")}\n`);
    expect(sheet.rows).toHaveLength(IMPORT_MAX_ROWS + 2);
    expect(refused(() => validateRows(sheet.rows, DEFAULTS))).toMatch(/At most 500 questions/);
    const started = Date.now();
    expect(await refusedAsync(csv(`${IMPORT_COLUMNS.join(",")}${"\n".repeat(2 * 1024 * 1024 - 200)}`))).toMatch(new RegExp(`more than ${IMPORT_MAX_RECORDS.toLocaleString("en-US")} rows`));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("an image may decode to 16 million pixels at most", async () => {
    expect(IMAGE_MAX_INPUT_PIXELS).toBe(16_000_000);
    expect(IMAGE_LIMITS.imageMaxInputPixels).toBe(16_000_000);
    // A valid 1-bit PNG of 4001 x 4001 = 16 008 001 pixels (tiny once deflated).
    const width = 4001;
    const chunk = (type: string, data: Buffer): Buffer => {
      const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
      const out = Buffer.alloc(12 + data.length);
      out.writeUInt32BE(data.length, 0);
      body.copy(out, 4);
      out.writeUInt32BE(crc32(body), 8 + data.length);
      return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(width, 4);
    ihdr[8] = 1; // bit depth
    ihdr[9] = 0; // greyscale
    const raw = Buffer.alloc(width * (1 + Math.ceil(width / 8)));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
    expect(png.length).toBeLessThan(2 * 1024 * 1024);
    const outcome = await checkUpload({ kind: "image", bytes: png, filename: "big.png", mimeType: "image/png" }, IMAGE_LIMITS).then(
      () => "accepted",
      (e: unknown) => (e instanceof UploadRejected ? e.message : "other"),
    );
    expect(outcome).toMatch(/pixel limit/i);
  });
});

describe("form fields are never cut (code review US-018 F11)", () => {
  it("refuses a field over 65 536 code points, and keeps astral characters whole", () => {
    expect(formValue(form({ body: "x".repeat(FIELD_MAX_CODE_POINTS) }), "body")).toHaveLength(FIELD_MAX_CODE_POINTS);
    expect(() => formValue(form({ body: "x".repeat(FIELD_MAX_CODE_POINTS + 1) }), "body")).toThrow(InvalidInput);
    // 65 536 emoji are 131 072 UTF-16 units: accepted whole, counted in code points.
    const emoji = "\u{1F600}".repeat(FIELD_MAX_CODE_POINTS);
    expect(formValue(form({ body: emoji }), "body")).toBe(emoji);
    expect(() => formValue(form({ body: `${emoji}x` }), "body")).toThrow(InvalidInput);
  });
});
