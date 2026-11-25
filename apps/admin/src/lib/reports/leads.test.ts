import { describe, expect, it } from "vitest";
import { type LeadsDay, parseLeadsFilters, parseSort, sortDays } from "./leads.ts";

// 2026-11-25 10:00 WIB.
const NOW = new Date("2026-11-25T03:00:00Z");
const PROGRAM = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";

describe("parseLeadsFilters", () => {
  it("defaults to the 10 days before today (WIB) and all programs", () => {
    expect(parseLeadsFilters({}, NOW)).toEqual({ filters: { from: "2026-11-15", to: "2026-11-24", programId: null, isDefault: true }, error: null });
  });

  it("takes a range (today included) and a program", () => {
    expect(parseLeadsFilters({ from: "2026-11-01", to: "2026-11-25", program: PROGRAM }, NOW)).toEqual({
      filters: { from: "2026-11-01", to: "2026-11-25", programId: PROGRAM, isDefault: false },
      error: null,
    });
  });

  it("takes only an end date as the 10 days ending there", () => {
    expect(parseLeadsFilters({ to: "2026-11-20" }, NOW)).toMatchObject({ filters: { from: "2026-11-11", to: "2026-11-20", isDefault: false }, error: null });
  });

  it("refuses a future end, a reversed range or a bad program with a message, and keeps the default", () => {
    for (const query of [{ to: "2026-11-26" }, { from: "2026-11-20", to: "2026-11-10" }, { from: "nonsense" }, { to: "2026-02-31" }, { to: "garbage" }]) {
      const { filters, error } = parseLeadsFilters(query, NOW);
      expect(error, JSON.stringify(query)).not.toBeNull();
      expect(filters).toMatchObject({ from: "2026-11-15", to: "2026-11-24", isDefault: true });
    }
    expect(parseLeadsFilters({ program: "x' OR 1=1" }, NOW)).toMatchObject({ filters: { programId: null }, error: "A filter value is not valid." });
  });
});

const day = (d: string, leads: number, purchase: number, active = 0): LeadsDay => ({ day: d, leads, purchase, revenueIdr: purchase * 49000, active, waTotal: 0, waSent: 0, waFailed: 0 });
const DAYS = [day("2026-11-22", 10, 1), day("2026-11-24", 0, 0, 3), day("2026-11-23", 10, 5)];

describe("parseSort and sortDays", () => {
  it("sorts newest day first by default, and ignores a column that is not ours", () => {
    expect(parseSort({})).toEqual({ key: "day", dir: "desc" });
    expect(parseSort({ sort: "drop table", dir: "sideways" })).toEqual({ key: "day", dir: "desc" });
    expect(sortDays(DAYS, parseSort({})).map((d) => d.day)).toEqual(["2026-11-24", "2026-11-23", "2026-11-22"]);
  });

  it("sorts by a figure or a rate either way; a day without leads (no rate) is lowest; ties keep the newest day first", () => {
    expect(sortDays(DAYS, { key: "successRate", dir: "desc" }).map((d) => d.day)).toEqual(["2026-11-23", "2026-11-22", "2026-11-24"]);
    expect(sortDays(DAYS, { key: "leads", dir: "desc" }).map((d) => d.day)).toEqual(["2026-11-23", "2026-11-22", "2026-11-24"]);
    expect(sortDays(DAYS, { key: "leads", dir: "asc" }).map((d) => d.day)).toEqual(["2026-11-24", "2026-11-23", "2026-11-22"]);
    expect(sortDays(DAYS, { key: "day", dir: "asc" }).map((d) => d.day)).toEqual(["2026-11-22", "2026-11-23", "2026-11-24"]);
  });
});
