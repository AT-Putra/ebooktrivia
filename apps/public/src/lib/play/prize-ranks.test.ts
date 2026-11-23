// How the prize tiers shape the leaderboard: the winners, the rows a phone shows first, and which rank gets which medal.
import { describe, expect, it } from "vitest";
import { collapsedRows, MEDAL_TONE, medalTone, tierForRank, winnersCount } from "./prize-ranks.ts";

const tier = (rankFrom: number, rankTo = rankFrom) => ({ rankFrom, rankTo });
/** DIET90: tier 1 is rank 1, tier 2 is ranks 2-6. */
const DIET90 = [tier(1), tier(2, 6)];

describe("winnersCount (the highest rank any tier covers)", () => {
  it("is 0 with no tiers, and the highest rank_to otherwise", () => {
    expect(winnersCount([])).toBe(0);
    expect(winnersCount([tier(1)])).toBe(1);
    expect(winnersCount([tier(1), tier(2, 3)])).toBe(3);
    expect(winnersCount(DIET90)).toBe(6);
    expect(winnersCount([tier(1), tier(2, 3), tier(4, 10)])).toBe(10);
  });

  it("does not depend on the order of the tiers, and counts a gap between tiers up to the last one", () => {
    expect(winnersCount([tier(4, 10), tier(1), tier(2, 3)])).toBe(10);
    expect(winnersCount([tier(1), tier(5, 8)])).toBe(8);
  });
});

describe("collapsedRows (the phone's rows before 'Lihat semua': max(5, winners))", () => {
  it("shows 5 for no tiers, 1 prize rank and 3 prize ranks", () => {
    expect(collapsedRows([])).toBe(5);
    expect(collapsedRows([tier(1)])).toBe(5);
    expect(collapsedRows([tier(1), tier(2, 3)])).toBe(5);
    expect(collapsedRows([tier(1), tier(2, 5)])).toBe(5);
  });

  it("shows every winner above 5: 6 prize ranks show 6 rows, 10 show 10", () => {
    expect(collapsedRows(DIET90)).toBe(6);
    expect(collapsedRows([tier(1), tier(2, 3), tier(4, 10)])).toBe(10);
    expect(collapsedRows([tier(10, 12), tier(1)])).toBe(12);
  });
});

describe("tierForRank (the tier that covers a rank: its index in the prize list, or null)", () => {
  it("covers a single rank and a range, ends included", () => {
    expect(tierForRank(DIET90, 1)).toBe(0);
    for (const rank of [2, 3, 4, 5, 6]) expect(tierForRank(DIET90, rank)).toBe(1);
  });

  it("is null for a rank no tier covers: past the last tier, with no tiers, and in a gap between tiers", () => {
    expect(tierForRank(DIET90, 7)).toBeNull();
    expect(tierForRank(DIET90, 0)).toBeNull();
    expect(tierForRank([], 1)).toBeNull();
    const gap = [tier(1), tier(5, 8)];
    expect([1, 2, 3, 4, 5, 8, 9].map((rank) => tierForRank(gap, rank))).toEqual([0, null, null, null, 1, 1, null]);
  });

  it("finds the tier whatever the order of the list, answering its index in the list as given", () => {
    const unordered = [tier(4, 10), tier(1), tier(2, 3)];
    expect(tierForRank(unordered, 1)).toBe(1);
    expect(tierForRank(unordered, 3)).toBe(2);
    expect(tierForRank(unordered, 4)).toBe(0);
    expect(tierForRank(unordered, 10)).toBe(0);
    expect(tierForRank(unordered, 11)).toBeNull();
  });

  it("gives ranks 1-6 of DIET90 their tier's colour: rank 1 gold, ranks 2-6 silver, as the prize list shows it", () => {
    const tones = [1, 2, 3, 4, 5, 6].map((rank) => medalTone(tierForRank(DIET90, rank) ?? -1));
    expect(tones).toEqual(["text-accent", "text-muted-foreground", "text-muted-foreground", "text-muted-foreground", "text-muted-foreground", "text-muted-foreground"]);
  });
});

describe("medalTone (the one colour table of the prize list and the leaderboard)", () => {
  it("is gold, silver, bronze by tier order and the primary colour after", () => {
    expect(MEDAL_TONE).toEqual(["text-accent", "text-muted-foreground", "text-warning"]);
    expect([0, 1, 2, 3, 9].map(medalTone)).toEqual(["text-accent", "text-muted-foreground", "text-warning", "text-primary", "text-primary"]);
  });
});
