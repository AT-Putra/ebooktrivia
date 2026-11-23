// The image route's in-process lookup cache: bounded (least recently used out) and short-lived.
import { describe, expect, it } from "vitest";
import { createImageCache, IMAGE_CACHE_MAX, IMAGE_CACHE_TTL_MS } from "./image-cache.ts";

describe("createImageCache", () => {
  it("is sized for a program's thumbnails and lives two minutes", () => {
    expect(IMAGE_CACHE_MAX).toBe(2000);
    expect(IMAGE_CACHE_TTL_MS).toBe(120_000);
  });

  it("remembers a path until its time is up, and forgets it after", () => {
    let now = 1_000;
    const cache = createImageCache({ ttlMs: 100, now: () => now });
    cache.set("set:a:u", "images/u.webp");
    expect(cache.get("set:a:u")).toBe("images/u.webp");
    now += 99;
    expect(cache.get("set:a:u")).toBe("images/u.webp");
    now += 1;
    expect(cache.get("set:a:u")).toBeUndefined();
    // A hit does not extend the life of an entry: a stale one cannot outlive the TTL by being popular.
    cache.set("set:b:u", "images/u.webp");
    now += 60;
    expect(cache.get("set:b:u")).toBe("images/u.webp");
    now += 60;
    expect(cache.get("set:b:u")).toBeUndefined();
  });

  it("holds at most `max` entries and drops the least recently used first", () => {
    const cache = createImageCache({ max: 3 });
    for (const key of ["a", "b", "c"]) cache.set(key, `images/${key}.webp`);
    expect(cache.get("a")).toBe("images/a.webp"); // a is now the most recently used; b the oldest
    cache.set("d", "images/d.webp");
    expect(cache.get("b")).toBeUndefined();
    expect(["a", "c", "d"].map((key) => cache.get(key))).toEqual(["images/a.webp", "images/c.webp", "images/d.webp"]);
    // Setting an existing key replaces it without growing the cache.
    cache.set("a", "images/a2.webp");
    cache.set("e", "images/e.webp");
    expect(cache.get("a")).toBe("images/a2.webp");
    expect(cache.get("c")).toBeUndefined();
  });

  it("returns nothing for a key it never had", () => {
    expect(createImageCache().get("set:x:y")).toBeUndefined();
  });
});
