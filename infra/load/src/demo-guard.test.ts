import { describe, expect, it } from "vitest";
import { checkDemoProgram, type DemoProgramFacts, graceEnd } from "./demo-plan.ts";

const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-11-23T05:00:00.000Z");
const GOOD: DemoProgramFacts = {
  slug: "ebook-demo",
  status: "published",
  productActive: true,
  salesStartAt: new Date(NOW.getTime() - 60 * DAY),
  salesEndAt: new Date(NOW.getTime() + 30 * DAY),
  graceDays: 30,
  lockedAt: new Date(NOW.getTime() - 10 * DAY),
  setCount: 10,
  emptySets: 0,
  activeLandingPages: 1,
};

describe("checkDemoProgram: which programs may receive demo buyers", () => {
  it("accepts a published, started, locked program with playable sets and a landing page", () => {
    expect(checkDemoProgram(GOOD, NOW, false)).toEqual([]);
  });

  it.each([
    ["a draft program", { status: "draft" }, /is draft, not published/],
    ["an archived or finished program", { status: "finalized" }, /is finalized, not published/],
    ["an inactive product", { productActive: false }, /product is not active/],
    ["sales that have not started", { salesStartAt: new Date(NOW.getTime() + DAY), salesEndAt: new Date(NOW.getTime() + 30 * DAY) }, /shorter than an hour/],
    ["sales that started 30 minutes ago", { salesStartAt: new Date(NOW.getTime() - 30 * 60_000) }, /shorter than an hour.*BEFORE seeding/],
    ["a grace period that has ended", { salesEndAt: new Date(NOW.getTime() - 40 * DAY), graceDays: 30 }, /grace period.*less than 2 days from now/],
    ["a grace period that ends tomorrow", { salesEndAt: new Date(NOW.getTime() - 29 * DAY), graceDays: 30 }, /ends 2026-11-24T05:00:00.000Z, less than 2 days from now.*results snapshot and the winners/],
    ["a program without sets", { setCount: 0 }, /no trivia set/],
    ["a set without questions", { emptySets: 2 }, /2 set\(s\).*no question/],
    ["a program without an active landing page", { activeLandingPages: 0 }, /no active landing page/],
  ] satisfies [string, Partial<DemoProgramFacts>, RegExp][])("refuses %s", (_name, change, reason) => {
    const problems = checkDemoProgram({ ...GOOD, ...change }, NOW, false);
    expect(problems.some((p) => reason.test(p)), problems.join(" | ")).toBe(true);
  });

  it("accepts a grace end just beyond 2 days and refuses one just before (the worker writes the snapshot by itself after the grace end)", () => {
    const grace = (ms: number): Partial<DemoProgramFacts> => ({ salesEndAt: new Date(NOW.getTime() + ms - 30 * DAY), graceDays: 30 });
    expect(checkDemoProgram({ ...GOOD, ...grace(2 * DAY) }, NOW, false)).toEqual([]);
    expect(checkDemoProgram({ ...GOOD, ...grace(2 * DAY - 1) }, NOW, false)).toHaveLength(1);
    expect(graceEnd(new Date("2027-02-20T00:00:00.000Z"), 30).toISOString()).toBe("2027-03-22T00:00:00.000Z");
  });

  it("refuses to lock a program that has no paid order yet unless asked to, and says what the lock costs", () => {
    const fresh = { ...GOOD, lockedAt: null };
    const problems = checkDemoProgram(fresh, NOW, false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/locks it for good/);
    expect(problems[0]).toMatch(/--accept-program-lock/);
    expect(checkDemoProgram(fresh, NOW, true)).toEqual([]);
  });

  it("reports every problem at once", () => {
    expect(checkDemoProgram({ ...GOOD, status: "draft", setCount: 0, activeLandingPages: 0, lockedAt: null }, NOW, false)).toHaveLength(4);
  });
});
