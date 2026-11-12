import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assignRanks, compareRanking, type RankingEntry } from "./ranking.ts";

const at = (iso: string): Date => new Date(iso);
const entry = (id: string, score: number, totalMs: number, finishedAt: Date | null) => ({
  id,
  score,
  totalMs,
  finishedAt,
});

describe("compareRanking", () => {
  it("orders by score desc first", () => {
    expect(compareRanking(entry("a", 30, 9_000, null), entry("b", 20, 1, at("2027-01-01T00:00:00Z")))).toBeLessThan(0);
    expect(compareRanking(entry("a", 20, 1, null), entry("b", 30, 9_000, null))).toBeGreaterThan(0);
  });

  it("then by total time asc", () => {
    expect(compareRanking(entry("a", 30, 1_000, null), entry("b", 30, 1_001, at("2027-01-01T00:00:00Z")))).toBeLessThan(0);
  });

  it("then by finish asc, nulls last", () => {
    const early = entry("a", 30, 1_000, at("2027-01-01T00:00:00.000Z"));
    const late = entry("b", 30, 1_000, at("2027-01-01T00:00:00.001Z"));
    const none = entry("c", 30, 1_000, null);
    expect(compareRanking(early, late)).toBeLessThan(0);
    expect(compareRanking(late, early)).toBeGreaterThan(0);
    expect(compareRanking(late, none)).toBeLessThan(0);
    expect(compareRanking(none, late)).toBeGreaterThan(0);
    expect(compareRanking(none, entry("d", 30, 1_000, null))).toBe(0);
    expect(compareRanking(early, entry("e", 30, 1_000, at("2027-01-01T00:00:00.000Z")))).toBe(0);
  });
});

describe("assignRanks", () => {
  it("assigns competition ranks (1224) to exact ties and keeps input order within a tie", () => {
    const t = at("2027-07-30T10:00:00Z");
    const ranked = assignRanks([
      entry("d", 20, 500, t),
      entry("b", 50, 900, t),
      entry("a", 50, 900, t),
      entry("c", 50, 1_200, null),
      entry("e", 50, 1_200, t),
      entry("f", 10, 0, null),
    ]);
    expect(ranked.map((r) => [r.id, r.rank])).toEqual([
      ["b", 1],
      ["a", 1],
      ["e", 3],
      ["c", 4],
      ["d", 5],
      ["f", 6],
    ]);
  });

  it("does not mutate the input and keeps extra fields", () => {
    const input = [entry("x", 1, 1, null), entry("y", 2, 1, null)];
    const ranked = assignRanks(input);
    expect(input.map((e) => e.id)).toEqual(["x", "y"]);
    expect(ranked[0]).toEqual({ id: "y", score: 2, totalMs: 1, finishedAt: null, rank: 1 });
  });

  it("returns an empty list for no entries", () => {
    expect(assignRanks([])).toEqual([]);
  });

  it("rejects non-integer or negative scores and times, and invalid dates", () => {
    expect(() => assignRanks([entry("a", 1.5, 0, null)])).toThrow(RangeError);
    expect(() => assignRanks([entry("a", -1, 0, null)])).toThrow(RangeError);
    expect(() => assignRanks([entry("a", 1, Number.NaN, null)])).toThrow(RangeError);
    expect(() => assignRanks([entry("a", 1, -5, null)])).toThrow(RangeError);
    expect(() => assignRanks([entry("a", 1, 0, new Date("nope"))])).toThrow(RangeError);
  });

  it("property: sorted by the comparator, rank = 1 + entries strictly ahead", () => {
    const arbEntry = fc.record({
      score: fc.integer({ min: 0, max: 5 }),
      totalMs: fc.integer({ min: 0, max: 3 }),
      finishedAt: fc.option(
        fc.integer({ min: 0, max: 2 }).map((n) => new Date(Date.UTC(2027, 6, 30) + n)),
        { nil: null },
      ),
    });
    fc.assert(
      fc.property(fc.array(arbEntry, { maxLength: 40 }), (entries: RankingEntry[]) => {
        const ranked = assignRanks(entries);
        expect(ranked).toHaveLength(entries.length);
        for (let i = 1; i < ranked.length; i++) {
          expect(compareRanking(ranked[i - 1] as RankingEntry, ranked[i] as RankingEntry)).toBeLessThanOrEqual(0);
        }
        for (const r of ranked) {
          const ahead = entries.filter((e) => compareRanking(e, r) < 0).length;
          expect(r.rank).toBe(ahead + 1);
        }
      }),
    );
  });
});

describe("review item 11: finishedAt undefined is treated like null", () => {
  it("sorts undefined last and equal to null", () => {
    const t = at("2027-07-30T10:00:00Z");
    const missing = { score: 30, totalMs: 1_000, finishedAt: undefined };
    const none = { score: 30, totalMs: 1_000, finishedAt: null };
    const done = { score: 30, totalMs: 1_000, finishedAt: t };
    expect(compareRanking(missing, done)).toBeGreaterThan(0);
    expect(compareRanking(done, missing)).toBeLessThan(0);
    expect(compareRanking(missing, none)).toBe(0);
    expect(assignRanks([{ id: "m", ...missing }, { id: "d", ...done }, { id: "n", ...none }]).map((r) => [r.id, r.rank])).toEqual([
      ["d", 1],
      ["m", 2],
      ["n", 2],
    ]);
  });
});
