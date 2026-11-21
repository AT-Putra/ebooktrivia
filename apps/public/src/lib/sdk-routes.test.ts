// The in-process parts of the SDK routes (lib/sdk-routes.ts): the per-address token bucket of the config route and
// the LRU of its cache, both bounded in memory (US-024 security review L8). No database, no Valkey.
import { describe, expect, it } from "vitest";
import { createConfigCache, createTokenBuckets } from "./sdk-routes.ts";

describe("createTokenBuckets", () => {
  const options = { capacity: 3, refillPerSecond: 1, maxKeys: 100 } as const;

  it("allows a burst of `capacity`, then one per refill interval, per key", () => {
    let now = 0;
    const buckets = createTokenBuckets(options, () => now);
    expect([1, 2, 3, 4].map(() => buckets.take("a"))).toEqual([true, true, true, false]);
    // Another key has its own bucket.
    expect(buckets.take("b")).toBe(true);
    now += 1000;
    expect(buckets.take("a")).toBe(true);
    expect(buckets.take("a")).toBe(false);
    // A long pause refills to the capacity, never beyond it.
    now += 60_000;
    expect([1, 2, 3, 4].map(() => buckets.take("a"))).toEqual([true, true, true, false]);
  });

  it("is bounded: the least recently used key is forgotten, never the whole table, and a forgotten key starts full", () => {
    const buckets = createTokenBuckets({ capacity: 1, refillPerSecond: 0.001, maxKeys: 3 }, () => 0);
    for (const key of ["a", "b", "c"]) expect(buckets.take(key)).toBe(true);
    // a, b and c are spent. Touching `a` makes `b` the least recently used; a new key then pushes `b` out.
    expect(buckets.take("a")).toBe(false);
    expect(buckets.take("d")).toBe(true);
    expect(buckets.take("a")).toBe(false);
    expect(buckets.take("c")).toBe(false);
    expect(buckets.take("b")).toBe(true);
  });
});

describe("createConfigCache", () => {
  const data = (id: string) => ({ landingPageId: id, hosts: [], config: { v: 1, lp_key: id } as never });

  it("loads once per page within the lifetime, and again after it", async () => {
    let now = 0;
    let loads = 0;
    const cache = createConfigCache(5000, () => now, 10);
    const load = () => {
      loads++;
      return Promise.resolve(data("x"));
    };
    await cache("lp_a", load);
    await cache("lp_a", load);
    expect(loads).toBe(1);
    now += 5001;
    await cache("lp_a", load);
    expect(loads).toBe(2);
  });

  it("is a bounded LRU: a full cache drops its least recently used page, not every page", async () => {
    const loads: string[] = [];
    const cache = createConfigCache(60_000, () => 0, 3);
    const load = (key: string) => () => {
      loads.push(key);
      return Promise.resolve(data(key));
    };
    for (const key of ["a", "b", "c"]) await cache(key, load(key));
    await cache("a", load("a")); // a is the most recently used; b the least
    await cache("d", load("d")); // evicts b only
    for (const key of ["a", "c", "d"]) await cache(key, load(key));
    expect(loads).toEqual(["a", "b", "c", "d"]);
    await cache("b", load("b"));
    expect(loads).toEqual(["a", "b", "c", "d", "b"]);
  });

  it("never remembers a failed load, and remembers 'no such page'", async () => {
    let loads = 0;
    const cache = createConfigCache(5000, () => 0, 10);
    await expect(
      cache("lp_x", () => {
        loads++;
        return Promise.reject(new Error("db down"));
      }),
    ).rejects.toThrow("db down");
    await cache("lp_x", () => {
      loads++;
      return Promise.resolve(undefined);
    });
    await cache("lp_x", () => {
      loads++;
      return Promise.resolve(undefined);
    });
    expect(loads).toBe(2);
  });
});
