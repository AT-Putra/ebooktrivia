import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, CSV_BOM, csvCell, csvFileName, csvLine, mtReconciliation, rateBps, REPORT_MAX_DAYS, reportRange, wibDateOf } from "./reports.ts";

describe("rateBps (integer basis points, half up)", () => {
  it.each([
    [0, 10, 0],
    [1, 3, 3333], // 33.333 %
    [2, 3, 6667], // 66.667 %: rounded up
    [1, 8, 1250], // 12.5 % exactly
    [5, 10_000, 5], // 0.05 %
    [1, 20_000, 1], // 0.005 % rounds half up to 0.01 %
    [1, 40_000, 0], // 0.0025 % rounds down
    [7, 7, 10_000],
    [3, 2, 15_000], // more than 100 % is a number, not an error
  ])("rateBps(%d, %d) = %d", (part, whole, expected) => {
    expect(rateBps(part, whole)).toBe(expected);
  });

  it("has no rate without a whole, and refuses what is not a count", () => {
    expect(rateBps(0, 0)).toBeNull();
    expect(rateBps(5, 0)).toBeNull();
    expect(() => rateBps(-1, 5)).toThrow(RangeError);
    expect(() => rateBps(1, -5)).toThrow(RangeError);
    expect(() => rateBps(1.5, 5)).toThrow(RangeError);
    expect(() => rateBps(1, Number.NaN)).toThrow(RangeError);
  });

  it("matches rounding half up of part * 10000 / whole for any counts, with no float drift", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 1, max: 5_000_000 }), (part, whole) => {
        const exact = (part * 10_000) / whole;
        const got = rateBps(part, whole) ?? -1;
        expect(Math.abs(got - exact)).toBeLessThanOrEqual(0.5 + 1e-6);
      }),
    );
  });
});

describe("WIB dates", () => {
  it("wibDateOf is the calendar day at UTC+7", () => {
    expect(wibDateOf(new Date("2026-11-19T16:59:59.999Z"))).toBe("2026-11-19");
    expect(wibDateOf(new Date("2026-11-19T17:00:00Z"))).toBe("2026-11-20");
    expect(wibDateOf(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01-01");
  });

  it("addDays moves across months, years and leap days", () => {
    expect(addDays("2026-11-20", 0)).toBe("2026-11-20");
    expect(addDays("2026-11-20", -19)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
    expect(() => addDays("26-02-03", 1)).toThrow(RangeError);
    expect(() => addDays("2026-02-03", 1.5)).toThrow(RangeError);
  });
});

describe("reportRange (the date filter)", () => {
  const today = "2026-11-20";
  it("defaults to the last 30 days ending today", () => {
    expect(reportRange({}, today)).toEqual({ ok: true, from: "2026-10-22", to: "2026-11-20" });
    expect(reportRange({ from: "", to: "" }, today)).toEqual({ ok: true, from: "2026-10-22", to: "2026-11-20" });
  });

  it("keeps a given range, one day included both ends", () => {
    expect(reportRange({ from: "2026-11-01", to: "2026-11-20" }, today)).toEqual({ ok: true, from: "2026-11-01", to: "2026-11-20" });
    expect(reportRange({ from: "2026-11-20", to: "2026-11-20" }, today)).toEqual({ ok: true, from: "2026-11-20", to: "2026-11-20" });
    // Only the start: ends today. Only the end: 30 days back from it.
    expect(reportRange({ from: "2026-11-10" }, today)).toEqual({ ok: true, from: "2026-11-10", to: "2026-11-20" });
    expect(reportRange({ to: "2026-11-10" }, today)).toEqual({ ok: true, from: "2026-10-12", to: "2026-11-10" });
  });

  it("refuses what is not a date, a future end, an inverted range and one beyond the maximum", () => {
    expect(reportRange({ from: "2026-13-01" }, today)).toMatchObject({ ok: false, error: expect.stringContaining("YYYY-MM-DD") as string });
    expect(reportRange({ from: "yesterday" }, today)).toMatchObject({ ok: false });
    expect(reportRange({ to: "2026-02-31" }, today)).toMatchObject({ ok: false });
    expect(reportRange({}, "not a day")).toMatchObject({ ok: false });
    expect(reportRange({ to: "2026-11-21" }, today)).toMatchObject({ ok: false, error: expect.stringContaining("future") as string });
    expect(reportRange({ from: "2026-11-20", to: "2026-11-19" }, today)).toMatchObject({ ok: false, error: expect.stringContaining("after") as string });
    expect(reportRange({ from: "2025-01-01", to: "2026-11-20" }, today)).toMatchObject({ ok: false, error: expect.stringContaining(String(REPORT_MAX_DAYS)) as string });
    // The maximum itself is allowed (a leap year of days), one more is not.
    expect(reportRange({ from: addDays(today, 1 - REPORT_MAX_DAYS), to: today }, today)).toMatchObject({ ok: true });
    expect(reportRange({ from: addDays(today, -REPORT_MAX_DAYS), to: today }, today)).toMatchObject({ ok: false });
    expect(reportRange({ from: "2026-11-01", to: "2026-11-20" }, today, 5)).toMatchObject({ ok: false });
  });
});

describe("mtReconciliation (MT sent + failed = PAID orders with a click id, per adnet)", () => {
  it("holds when every paid order has a settled row", () => {
    expect(mtReconciliation({ paidOrders: 5, sent: 3, failed: 2, inFlight: 0 })).toEqual({
      paidOrders: 5, sent: 3, failed: 2, inFlight: 0, settled: 5, gap: 0, balanced: true, identity: true,
    });
  });

  it("is balanced but not yet the identity while rows are in flight", () => {
    expect(mtReconciliation({ paidOrders: 5, sent: 3, failed: 1, inFlight: 1 })).toMatchObject({ settled: 4, gap: 0, balanced: true, identity: false });
  });

  it("reports a lost conversion (a paid order without a row) as a positive gap, an extra row as a negative one", () => {
    expect(mtReconciliation({ paidOrders: 5, sent: 3, failed: 1, inFlight: 0 })).toMatchObject({ gap: 1, balanced: false, identity: false });
    expect(mtReconciliation({ paidOrders: 2, sent: 3, failed: 0, inFlight: 0 })).toMatchObject({ gap: -1, balanced: false, identity: false });
  });

  it("refuses counts that are not counts", () => {
    expect(() => mtReconciliation({ paidOrders: -1, sent: 0, failed: 0, inFlight: 0 })).toThrow(RangeError);
    expect(() => mtReconciliation({ paidOrders: 1, sent: 0.5, failed: 0, inFlight: 0 })).toThrow(/sent/);
  });
});

describe("csvCell (RFC 4180, formulas neutralized)", () => {
  it("writes plain text, numbers and empty cells as they are", () => {
    expect(csvCell("Budi Santoso")).toBe("Budi Santoso");
    expect(csvCell(49000)).toBe("49000");
    expect(csvCell(-1500)).toBe("-1500"); // a net loss is a number, not an attack
    expect(csvCell(0)).toBe("0");
    expect(csvCell(null)).toBe("");
    expect(csvCell("")).toBe("");
  });

  it("quotes a field with a comma, a semicolon (the id-ID Excel list separator), a quote or a line break, and doubles the quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("x;=1+1")).toBe('"x;=1+1"');
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("cr\rhere")).toBe('"cr\rhere"');
  });

  it.each(["=1+1", "+6281234567890", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd", "\ncmd", " =HYPERLINK(1)", "\u00A0+1", "  @x", " \t=1", "\u3000=1", "\u200B=1", "\uFEFF@x", "\n =1"])("neutralizes %j with a leading apostrophe", (text) => {
    const cell = csvCell(text);
    const inner = cell.startsWith('"') ? cell.slice(1, -1) : cell;
    expect(inner.startsWith("'")).toBe(true);
  });

  it("hardening cases: a semicolon field is quoted whole, and a formula behind a tab or an ideographic space is text", () => {
    expect(csvCell("x;=1+1")).toBe('"x;=1+1"');
    expect(csvCell(" \t=1")).toBe("' \t=1"); // starts with whitespace, then =
    expect(csvCell("　=1")).toBe("'　=1");
    expect(csvCell("a;=1")).toBe('"a;=1"'); // not first: not a formula, but the semicolon is quoted
  });

  it("neutralizes first, then quotes: a formula with a comma stays one text field", () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
  });

  it("does not touch a hyphen or sign that is not first", () => {
    expect(csvCell("promo-a")).toBe("promo-a");
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("Rp +1")).toBe("Rp +1");
  });

  it("refuses a number that is not finite", () => {
    expect(() => csvCell(Number.NaN)).toThrow(RangeError);
    expect(() => csvCell(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("never lets a text cell start a formula, whatever it holds (property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        const cell = csvCell(text);
        // Undo the CSV quoting to see the text the spreadsheet receives.
        const received = cell.startsWith('"') ? cell.slice(1, -1).replaceAll('""', '"') : cell;
        expect(/^[\s\u200B\uFEFF\u3000]*[=+\-@]|^[\t\r\n]/u.test(received) && !received.startsWith("'")).toBe(false);
        // And the original text is always recoverable from the received one.
        expect(received === text || received === `'${text}`).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("writes a record with CRLF and the BOM is the one Excel needs", () => {
    expect(csvLine(["a", 1, null, "=x", "b,c"])).toBe("a,1,,'=x,\"b,c\"\r\n");
    expect(CSV_BOM).toBe("\uFEFF");
    expect(new TextEncoder().encode(CSV_BOM)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
  });
});

describe("csvFileName", () => {
  it("names the report and the range, and keeps nothing else out of a part", () => {
    expect(csvFileName("sales", ["2026-11-01", "2026-11-20"])).toBe("sales-2026-11-01-2026-11-20.csv");
    expect(csvFileName("winners", ["alpha-juara"])).toBe("winners-alpha-juara.csv");
    expect(csvFileName("sales", ["budi@example.com/../x", "", "+62 812"])).toBe("sales-budiexamplecomx-62812.csv");
    expect(csvFileName("sales", [])).toBe("sales.csv");
  });
});
