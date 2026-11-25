// The Owner's hint that a leaderboard shorter than the last prize rank leaves some prize winners off it (English like the rest of the console, read-only).
import { describe, expect, it } from "vitest";
import { leaderboardHint } from "./prizes.ts";

describe("leaderboardHint", () => {
  it("is silent when the leaderboard shows every prize rank (equal or longer) and when there are no prizes", () => {
    expect(leaderboardHint(10, 0)).toBeNull();
    expect(leaderboardHint(10, 6)).toBeNull();
    expect(leaderboardHint(6, 6)).toBeNull();
    expect(leaderboardHint(1, 1)).toBeNull();
  });

  it("warns, naming the leaderboard length and the last prize rank, when some winners would not appear", () => {
    const hint = leaderboardHint(5, 6);
    expect(hint).toContain("top 5 players");
    expect(hint).toContain("ranks 1 to 6");
    expect(hint).toContain("some prize winners would not appear on it");
    expect(hint).toContain("at least 6");
    expect(leaderboardHint(10, 100)).toContain("at least 100");
  });
});
