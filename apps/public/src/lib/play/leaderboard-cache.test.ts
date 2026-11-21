// The leaderboard's in-process top-N cache (US-027): 5 s per program, one load for a burst, failures not cached.
import { describe, expect, it, vi } from "vitest";
import { createTopCache, LEADERBOARD_TTL_MS } from "./leaderboard-cache.ts";
import type { LeaderRow } from "./trivia-data.ts";

const row = (rank: number): LeaderRow => ({ rank, name: "A***", score: 10, totalMs: 1_000, finished: false });

describe("createTopCache", () => {
  it("serves one load for 5 s per program, then loads again", async () => {
    let now = 1_000_000;
    const cache = createTopCache(() => now);
    const load = vi.fn(() => Promise.resolve([row(1)]));
    const first = await cache.get("p1", load);
    expect(first).toEqual({ rows: [row(1)], loadedAt: 1_000_000 });
    now += LEADERBOARD_TTL_MS - 1;
    expect(await cache.get("p1", load)).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    now += 1;
    expect((await cache.get("p1", load)).loadedAt).toBe(1_000_000 + LEADERBOARD_TTL_MS);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares a load in flight, keeps programs apart, and drops expired entries", async () => {
    let now = 0;
    const cache = createTopCache(() => now);
    let release: (rows: LeaderRow[]) => void = () => undefined;
    const slow = vi.fn(() => new Promise<LeaderRow[]>((resolve) => (release = resolve)));
    const a = cache.get("p1", slow);
    const b = cache.get("p1", slow);
    expect(slow).toHaveBeenCalledTimes(1);
    release([row(2)]);
    expect(await a).toBe(await b);
    const other = vi.fn(() => Promise.resolve([row(3)]));
    expect((await cache.get("p2", other)).rows).toEqual([row(3)]);
    now = LEADERBOARD_TTL_MS * 3;
    await cache.get("p3", other);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed load", async () => {
    const cache = createTopCache(() => 0);
    await expect(cache.get("p1", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    await Promise.resolve();
    expect((await cache.get("p1", () => Promise.resolve([row(1)]))).rows).toEqual([row(1)]);
  });
});
