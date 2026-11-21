import { EFFECT_CANCELLED, NO_MT_TEMPLATE, REVERSAL_SKIPPED } from "@ebooktrivia/core";
import { describe, expect, it } from "vitest";
import { niceMax } from "./chart.ts";
import { idrOf, isStale, MAX_PAGE, pageOf, param, parseSalesFilters, ROLLUP_STALE_MS, wibInstants } from "./common.ts";
import { MARKERS, markerOf, parsePostbackFilters } from "./postbacks.ts";
import { isRoiGroup } from "./roi.ts";

const NOW = new Date("2026-11-20T09:00:00Z");

describe("idrOf", () => {
  it("reads a bigint column (text) as whole rupiah, nothing as 0, and refuses what a safe integer cannot hold", () => {
    expect(idrOf("591000")).toBe(591_000);
    expect(idrOf(42)).toBe(42);
    expect(idrOf(null)).toBe(0);
    expect(idrOf(undefined)).toBe(0);
    expect(idrOf("-1500")).toBe(-1500);
    expect(() => idrOf("9007199254740993")).toThrow(RangeError);
    expect(() => idrOf("12.5")).toThrow(RangeError);
    expect(() => idrOf("abc")).toThrow(RangeError);
  });
});

describe("wibInstants", () => {
  it("is 00:00 WIB of the first day up to 00:00 WIB of the day after the last", () => {
    const { start, end } = wibInstants({ from: "2026-11-18", to: "2026-11-20" });
    expect(start.toISOString()).toBe("2026-11-17T17:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-20T17:00:00.000Z");
  });
});

describe("query values", () => {
  it("reads the first of a repeated parameter, '' when absent, and a page only inside 1..MAX_PAGE", () => {
    expect(param({ a: "x" }, "a")).toBe("x");
    expect(param({ a: ["x", "y"] }, "a")).toBe("x");
    expect(param({}, "a")).toBe("");
    expect(pageOf({ page: "3" })).toBe(3);
    for (const bad of ["0", "-1", "1.5", "abc", String(MAX_PAGE + 1), ""]) expect(pageOf({ page: bad }), bad).toBe(1);
    expect(pageOf({})).toBe(1);
  });

  it("calls the rollups stale after 15 minutes, and when there is no time at all", () => {
    expect(ROLLUP_STALE_MS).toBe(900_000);
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale(new Date(NOW.getTime() - ROLLUP_STALE_MS), NOW)).toBe(false);
    expect(isStale(new Date(NOW.getTime() - ROLLUP_STALE_MS - 1), NOW)).toBe(true);
  });

  it("parses the ROI grouping, and only ours", () => {
    expect(isRoiGroup("adnet")).toBe(true);
    expect(isRoiGroup("landing_page")).toBe(true);
    expect(isRoiGroup("utm_campaign")).toBe(true);
    expect(isRoiGroup("ip")).toBe(false);
    expect(isRoiGroup("")).toBe(false);
  });
});

describe("parseSalesFilters", () => {
  it("defaults to the last 30 days ending today (WIB) with nothing filtered", () => {
    expect(parseSalesFilters({}, NOW)).toEqual({
      filters: { from: "2026-10-22", to: "2026-11-20", programId: null, landingPageId: null, adnet: null, gateway: null, status: null },
      error: null,
    });
  });

  it("takes today from the WIB clock: 17:30 UTC is already tomorrow", () => {
    expect(parseSalesFilters({}, new Date("2026-11-20T17:30:00Z")).filters.to).toBe("2026-11-21");
  });

  it("keeps one error (the first) and falls back to the default for a wrong range, but keeps the other valid filters", () => {
    const r = parseSalesFilters({ from: "2026-11-21", to: "2026-11-30", status: "paid" }, NOW);
    expect(r.error).toBe("The end date cannot be in the future.");
    expect(r.filters).toMatchObject({ from: "2026-10-22", to: "2026-11-20", status: "paid" });
  });
});

describe("parsePostbackFilters", () => {
  it("accepts the sinks, events, statuses and markers we have and nothing else", () => {
    const ok = parsePostbackFilters({ from: "2026-11-18", to: "2026-11-20", sink: "s2s", kind: "reversal", status: "failed", marker: "order_not_paid", adnet: "2f3b2e0a-4f7d-4b87-8d36-6f1d7a7c9d11" }, NOW);
    expect(ok).toEqual({
      filters: { from: "2026-11-18", to: "2026-11-20", sink: "s2s", kind: "reversal", status: "failed", marker: "order_not_paid", adnet: "2f3b2e0a-4f7d-4b87-8d36-6f1d7a7c9d11" },
      error: null,
    });
    for (const bad of [{ sink: "smtp" }, { kind: "refund" }, { status: "done" }, { marker: "x" }, { adnet: "1' OR '1'='1" }]) {
      const r = parsePostbackFilters(bad, NOW);
      expect(r.error, JSON.stringify(bad)).toBe("A filter value is not valid.");
      expect(r.filters).toMatchObject({ sink: null, kind: null, status: null, marker: null, adnet: null });
    }
    expect(parsePostbackFilters({ from: "nope" }, NOW).filters).toMatchObject({ from: "2026-10-22", to: "2026-11-20" });
  });

  it("names the three marks a failed row can carry by the exact text the worker writes", () => {
    expect(MARKERS.order_not_paid.lastError).toBe(EFFECT_CANCELLED);
    expect(MARKERS.reversal_skipped.lastError).toBe(REVERSAL_SKIPPED);
    expect(MARKERS.no_mt_template.lastError).toBe(NO_MT_TEMPLATE);
    expect(markerOf(EFFECT_CANCELLED)).toBe("order_not_paid");
    expect(markerOf(REVERSAL_SKIPPED)).toBe("reversal_skipped");
    expect(markerOf(NO_MT_TEMPLATE)).toBe("no_mt_template");
    expect(markerOf("HTTP 500")).toBeNull();
    expect(markerOf(null)).toBeNull();
  });
});

describe("niceMax (the y axis of a chart)", () => {
  it.each([
    [0, 5],
    [3, 5],
    [5, 5],
    [6, 10],
    [11, 25],
    [26, 50],
    [51, 100],
    [100, 100],
    [101, 250],
    [999, 1000],
    [1234, 2500],
    [Number.NaN, 5],
  ])("niceMax(%d) = %d", (v, expected) => {
    expect(niceMax(v)).toBe(expected);
  });

  it("never goes below the data", () => {
    for (let v = 0; v < 5000; v += 7) expect(niceMax(v)).toBeGreaterThanOrEqual(v);
  });
});
