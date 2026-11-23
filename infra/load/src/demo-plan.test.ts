import { describe, expect, it } from "vitest";
import {
  abandonAfter,
  type BuyerPlan,
  DEMO_PAID_MARGIN_MS,
  demoEmail,
  demoLabel,
  estimateSeconds,
  formatDuration,
  mulberry32,
  paidDateProblem,
  paidWindowEnd,
  parseDemoFile,
  type PlanInput,
  planDemoBuyers,
} from "./demo-plan.ts";

const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-11-23T05:00:00.000Z");
const INPUT: PlanInput = { seed: 42, buyers: 30, sales_start_at: new Date(NOW.getTime() - 60 * DAY), sales_end_at: new Date(NOW.getTime() + 30 * DAY), grace_days: 30, set_count: 10, now: NOW };

const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

describe("mulberry32", () => {
  it("is deterministic per seed and stays in [0, 1)", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const draws = Array.from({ length: 1000 }, () => a());
    expect(draws).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(draws.every((d) => d >= 0 && d < 1)).toBe(true);
    expect(mulberry32(8)()).not.toBe(mulberry32(7)());
  });
});

describe("planDemoBuyers", () => {
  const plan = planDemoBuyers(INPUT);

  it("gives the same plan for the same seed and inputs, and another one for another seed", () => {
    expect(planDemoBuyers(INPUT)).toEqual(plan);
    expect(planDemoBuyers({ ...INPUT, seed: 43 })).not.toEqual(plan);
  });

  it("makes the requested number of buyers with unique names, indexed in paid order", () => {
    expect(plan).toHaveLength(30);
    expect(new Set(plan.map((p) => p.name)).size).toBe(30);
    expect(plan.map((p) => p.index)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    for (const p of plan) expect(["qris", "gopay", "bank_transfer", "shopeepay", "credit_card"]).toContain(p.payment_type);
  });

  it("keeps skill, coverage, think times, timeouts and the abandoned share inside their bounds, for many seeds", () => {
    for (let seed = 0; seed < 40; seed++) {
      for (const p of planDemoBuyers({ ...INPUT, seed, buyers: 50 })) {
        expect(p.skill).toBeGreaterThanOrEqual(0.5);
        expect(p.skill).toBeLessThanOrEqual(0.95);
        expect(p.unlocked_sets).toBeGreaterThanOrEqual(1);
        expect(p.sets_to_play).toBeGreaterThanOrEqual(1);
        expect(p.sets_to_play).toBeLessThanOrEqual(p.unlocked_sets);
        expect(p.sets_to_play / p.unlocked_sets).toBeGreaterThanOrEqual(0.4);
        expect(p.think_min_ms).toBeGreaterThanOrEqual(2000);
        expect(p.think_max_ms).toBeLessThanOrEqual(12_000);
        expect(p.think_max_ms - p.think_min_ms).toBeGreaterThanOrEqual(3000);
        expect(p.timeout_rate).toBeGreaterThanOrEqual(0);
        expect(p.timeout_rate).toBeLessThanOrEqual(0.03);
        expect(p.abandon_fraction).toBeGreaterThanOrEqual(0.3);
        expect(p.abandon_fraction).toBeLessThanOrEqual(0.7);
      }
    }
  });

  it("puts every paid date inside the sales window up to now, spread over it", () => {
    const end = paidWindowEnd(INPUT.sales_end_at, NOW);
    expect(end.getTime()).toBe(NOW.getTime() - DEMO_PAID_MARGIN_MS);
    for (const p of plan) expect(paidDateProblem(p.paid_at, INPUT.sales_start_at, INPUT.sales_end_at, NOW)).toBe("");
    const times = plan.map((p) => p.paid_at.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const span = end.getTime() - INPUT.sales_start_at.getTime();
    expect(times[0]).toBeLessThan(INPUT.sales_start_at.getTime() + span / 4);
    expect(times.at(-1)).toBeGreaterThan(INPUT.sales_start_at.getTime() + (span * 3) / 4);
  });

  it("never plans a date past the end of sales when the sales are already over", () => {
    const over = planDemoBuyers({ ...INPUT, sales_end_at: new Date(NOW.getTime() - 5 * DAY), grace_days: 30 });
    for (const p of over) expect(p.paid_at.getTime()).toBeLessThan(NOW.getTime() - 5 * DAY);
  });

  it("gives early buyers more sets than late ones", () => {
    const unlocked = plan.map((p) => p.unlocked_sets);
    for (let i = 1; i < unlocked.length; i++) expect(unlocked[i] ?? 0).toBeLessThanOrEqual(unlocked[i - 1] ?? 0);
    expect(mean(unlocked.slice(0, 10))).toBeGreaterThan(mean(unlocked.slice(-10)));
    expect(unlocked[0]).toBe(10);
    expect(mean(plan.slice(0, 10).map((p) => p.sets_to_play))).toBeGreaterThan(mean(plan.slice(-10).map((p) => p.sets_to_play)));
  });

  it("refuses a window that cannot hold the dates, and a number of buyers out of range", () => {
    expect(() => planDemoBuyers({ ...INPUT, sales_start_at: new Date(NOW.getTime() - 30 * 60_000) })).toThrow(/shorter than an hour/);
    expect(() => planDemoBuyers({ ...INPUT, sales_start_at: new Date(NOW.getTime() + DAY), sales_end_at: new Date(NOW.getTime() + 2 * DAY) })).toThrow(/shorter than an hour/);
    expect(() => planDemoBuyers({ ...INPUT, buyers: 0 })).toThrow(/from 1 to 200/);
    expect(() => planDemoBuyers({ ...INPUT, buyers: 201 })).toThrow(/from 1 to 200/);
    expect(() => planDemoBuyers({ ...INPUT, set_count: 0 })).toThrow(/no set/);
  });
});

describe("paidDateProblem", () => {
  const start = new Date("2026-10-01T00:00:00.000Z");
  const end = new Date("2026-12-31T00:00:00.000Z");

  it("accepts a date from the start of sales to a margin before now, and refuses every other", () => {
    expect(paidDateProblem(start, start, end, NOW)).toBe("");
    expect(paidDateProblem(new Date(NOW.getTime() - DEMO_PAID_MARGIN_MS - 1), start, end, NOW)).toBe("");
    expect(paidDateProblem(new Date(start.getTime() - 1), start, end, NOW)).toMatch(/outside the sales window/);
    expect(paidDateProblem(new Date(NOW.getTime() - DEMO_PAID_MARGIN_MS), start, end, NOW)).toMatch(/outside the sales window/);
    expect(paidDateProblem(NOW, start, end, NOW)).toMatch(/outside the sales window/);
    // Sales ended before now: the end of sales is the bound.
    const ended = new Date("2026-11-01T00:00:00.000Z");
    expect(paidDateProblem(ended, start, ended, NOW)).toMatch(/outside the sales window/);
    expect(paidDateProblem(new Date(ended.getTime() - 1), start, ended, NOW)).toBe("");
  });
});

describe("demo labels", () => {
  it("tags a buyer with the run, padded to at least two digits, on the reserved example.com domain", () => {
    expect(demoLabel("1a2b3c4d", 7, 30)).toBe("demo-1a2b3c4d-07");
    expect(demoEmail("1a2b3c4d", 7, 30)).toBe("demo-1a2b3c4d-07@example.com");
    expect(demoEmail("1a2b3c4d", 7, 150)).toBe("demo-1a2b3c4d-007@example.com");
    expect(demoEmail("1a2b3c4d", 150, 150)).toBe("demo-1a2b3c4d-150@example.com");
    // The pattern cleanup matches (demo-lib.ts) accepts every e-mail made here, for the smallest and the largest run.
    const pattern = /^demo-1a2b3c4d-[0-9]{2,3}@example\.com$/;
    for (const buyers of [1, 9, 10, 99, 100, 200]) for (let i = 1; i <= buyers; i++) expect(pattern.test(demoEmail("1a2b3c4d", i, buyers))).toBe(true);
    expect(pattern.test("demo-deadbeef-07@example.com")).toBe(false);
    expect(pattern.test("demo-1a2b3c4d-07@example.com.evil.test")).toBe(false);
  });
});

describe("estimateSeconds", () => {
  const plan = (over: Partial<BuyerPlan>): BuyerPlan => ({ ...(planDemoBuyers({ ...INPUT, buyers: 1 })[0] as BuyerPlan), think_min_ms: 3000, think_max_ms: 7000, abandon_last_set: false, sets_to_play: 2, ...over });

  it("adds every planned answer at its average think time plus half a second", () => {
    expect(estimateSeconds([plan({})], [5, 5, 5])).toEqual({ answers: 10, sets: 2, seconds: 55 });
  });

  it("counts a half-played last set by its share", () => {
    expect(estimateSeconds([plan({ abandon_last_set: true, abandon_fraction: 0.5 })], [4, 4])).toEqual({ answers: 6, sets: 2, seconds: 33 });
  });
});

describe("abandonAfter", () => {
  it("stops after the planned share of the questions, at least one and never all of them", () => {
    expect(abandonAfter(4, 0.5)).toBe(2);
    expect(abandonAfter(3, 0.7)).toBe(2);
    expect(abandonAfter(4, 0.99)).toBe(3);
    expect(abandonAfter(10, 0.3)).toBe(3);
    expect(abandonAfter(2, 0.3)).toBe(1);
    // A set of one question cannot be left half played.
    expect(abandonAfter(1, 0.5)).toBe(1);
  });
});

describe("formatDuration", () => {
  it("says seconds below two minutes, minutes below two hours and hours after", () => {
    expect(formatDuration(3)).toBe("3 s");
    expect(formatDuration(119)).toBe("119 s");
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(7140)).toBe("119 min");
    expect(formatDuration(7500)).toBe("2 h 05 min");
  });
});

describe("parseDemoFile", () => {
  const good = {
    kind: "demo",
    run_id: "1a2b3c4d",
    seed: 1,
    planned_at: NOW.toISOString(),
    program_id: "p",
    program_slug: "demo-program",
    set_ids: ["s1"],
    questions_per_set: [2],
    correct_option_ids: ["o1"],
    buyers: [
      {
        index: 1,
        label: "demo-1a2b3c4d-01",
        token: "t",
        plan: { sets_to_play: 1, skill: 0.7, think_min_ms: 2000, think_max_ms: 5000, timeout_rate: 0, abandon_last_set: false, abandon_fraction: 0.5, play_seed: 1 },
      },
    ],
  };

  it("reads a demo file", () => {
    expect(parseDemoFile(JSON.stringify(good)).buyers).toHaveLength(1);
  });

  it("refuses anything that is not one: another tool's file, missing fields, a bad plan, a truncated file", () => {
    expect(() => parseDemoFile(JSON.stringify({ kind: "trivia", players: [] }))).toThrow(/not a demo file/);
    expect(() => parseDemoFile(JSON.stringify([]))).toThrow(/not a demo file/);
    expect(() => parseDemoFile(JSON.stringify({ ...good, run_id: undefined }))).toThrow(/lacks run_id/);
    expect(() => parseDemoFile(JSON.stringify({ ...good, set_ids: "s1" }))).toThrow(/lacks set_ids/);
    expect(() => parseDemoFile(JSON.stringify({ ...good, buyers: [{ ...good.buyers[0], token: 5 }] }))).toThrow(/lacks its index, label, token or plan/);
    expect(() => parseDemoFile(JSON.stringify({ ...good, buyers: [{ ...good.buyers[0], plan: { ...good.buyers[0]?.plan, skill: "high" } }] }))).toThrow(/lacks a number for skill/);
    expect(() => parseDemoFile(JSON.stringify({ ...good, buyers: [{ ...good.buyers[0], plan: { ...good.buyers[0]?.plan, abandon_last_set: 1 } }] }))).toThrow(/abandon_last_set/);
    expect(() => parseDemoFile('{"kind":"demo"')).toThrow();
  });
});
