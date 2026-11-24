import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONTACT_GAP_MS,
  CONTACT_MAX_PER_HOUR,
  CONTACT_WINDOW_MS,
  contactAllowance,
  firstName,
  HUMAN_MAX_MS,
  HUMAN_TIMING,
  humanPlan,
  sampleLogNormal,
} from "./human-send.ts";

/** A cryptographic random source in [0, 1): what the worker uses. */
const cryptoRandom = (): number => randomInt(2 ** 47) / 2 ** 47;
/** A fixed sequence, to pin the maths. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
};

describe("sampleLogNormal", () => {
  it("stays inside its bounds, is not one fixed value, and is skewed like a log-normal (median near the geometric mean, a longer tail above it)", () => {
    const draws = Array.from({ length: 4000 }, () => sampleLogNormal(cryptoRandom, [600, 4000]));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(600);
    expect(Math.max(...draws)).toBeLessThanOrEqual(4000);
    expect(new Set(draws).size).toBeGreaterThan(500);
    const sorted = [...draws].sort((a, b) => a - b);
    const median = sorted[2000] ?? 0;
    const geometricMean = Math.sqrt(600 * 4000);
    expect(median).toBeGreaterThan(geometricMean * 0.9);
    expect(median).toBeLessThan(geometricMean * 1.1);
    // Not uniform: the bulk sits around the middle, the edges are rare.
    const edges = draws.filter((d) => d < 800 || d > 3500).length;
    expect(edges).toBeLessThan(draws.length * 0.15);
  });

  it("redraws a value outside the range and falls back to a uniform draw inside it after 8 tries; a one-value range is that value", () => {
    // z = sqrt(-2 ln u1) cos(2 pi u2) with u1 tiny: far outside the range every time -> the uniform fallback picks min + floor(0.5 * span).
    const calls: number[] = [];
    const rng = () => {
      calls.push(calls.length);
      return calls.length <= 16 ? (calls.length % 2 === 1 ? 1e-300 : 0) : 0.5;
    };
    expect(sampleLogNormal(rng, [1000, 2000])).toBe(1500);
    expect(sampleLogNormal(() => 0.3, [500, 500])).toBe(500);
    // A zero from the source is clamped, not -Infinity.
    expect(Number.isFinite(sampleLogNormal(sequence(0, 0.25), [100, 200]))).toBe(true);
  });

  it("refuses a malformed range", () => {
    expect(() => sampleLogNormal(cryptoRandom, [0, 10])).toThrow(RangeError);
    expect(() => sampleLogNormal(cryptoRandom, [10, 5])).toThrow(RangeError);
    expect(() => sampleLogNormal(cryptoRandom, [1.5, 10])).toThrow(RangeError);
  });
});

describe("humanPlan", () => {
  const within = (value: number, [min, max]: readonly [number, number]) => value >= min && value <= max;

  it("over many recipients every pause stays within its bounds and varies: never the same delay for consecutive recipients", () => {
    const plans = Array.from({ length: 300 }, () => humanPlan({ kind: "message", textLength: 90 }, cryptoRandom));
    for (const plan of plans) {
      expect(within(plan.readingMs, HUMAN_TIMING.reading)).toBe(true);
      expect(within(plan.typingMs, HUMAN_TIMING.typing)).toBe(true);
      expect(within(plan.pausedMs, HUMAN_TIMING.paused)).toBe(true);
    }
    for (const stage of ["readingMs", "typingMs", "pausedMs"] as const) {
      const values = plans.map((p) => p[stage]);
      expect(new Set(values).size, stage).toBeGreaterThan(150);
      const consecutiveEqual = values.filter((v, i) => i > 0 && v === values[i - 1]).length;
      expect(consecutiveEqual, stage).toBeLessThan(5);
    }
  });

  it("the typing wait scales with the length of the message (the per-message rate is random: no fixed milliseconds per character)", () => {
    const mean = (length: number) => {
      const draws = Array.from({ length: 400 }, () => humanPlan({ kind: "message", textLength: length }, cryptoRandom).typingMs);
      return draws.reduce((a, b) => a + b, 0) / draws.length;
    };
    expect(mean(20)).toBeLessThan(mean(80));
    expect(mean(80)).toBeLessThan(mean(160));
    const rates = new Set(Array.from({ length: 50 }, () => humanPlan({ kind: "message", textLength: 100 }, cryptoRandom).typingMs));
    expect(rates.size).toBeGreaterThan(30);
  });

  it("a very long message is put back inside the typing range near its top at a random place, not piled on the bound", () => {
    const draws = Array.from({ length: 300 }, () => humanPlan({ kind: "message", textLength: 600 }, cryptoRandom).typingMs);
    expect(Math.max(...draws)).toBeLessThanOrEqual(HUMAN_TIMING.typing[1]);
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(HUMAN_TIMING.typing[1] - (HUMAN_TIMING.typing[1] - HUMAN_TIMING.typing[0]) * 0.15 - 1);
    expect(new Set(draws).size).toBeGreaterThan(100);
    // ... and one that is shorter than the range allows is put back near its bottom.
    const rng = sequence(0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
    const short = humanPlan({ kind: "message", textLength: 0 }, rng).typingMs;
    expect(short).toBeGreaterThanOrEqual(HUMAN_TIMING.typing[0]);
    expect(short).toBeLessThan(HUMAN_TIMING.typing[0] + (HUMAN_TIMING.typing[1] - HUMAN_TIMING.typing[0]) * 0.15 + 1);
  });

  it("every message has a reading pause (the chat is always marked as read first), and the OTP is short: no reading, at most 3 s typing and 0.9 s pause (under 4 s in all)", () => {
    expect(humanPlan({ kind: "message", textLength: 80 }, cryptoRandom).readingMs).toBeGreaterThanOrEqual(HUMAN_TIMING.reading[0]);
    for (let i = 0; i < 300; i++) {
      const otp = humanPlan({ kind: "otp", textLength: 70 }, cryptoRandom);
      expect(otp.readingMs).toBe(0);
      expect(within(otp.typingMs, HUMAN_TIMING.otpTyping)).toBe(true);
      expect(within(otp.pausedMs, HUMAN_TIMING.otpPaused)).toBe(true);
      expect(otp.typingMs + otp.pausedMs).toBeLessThanOrEqual(4000);
    }
  });

  it("refuses a negative or fractional length", () => {
    expect(() => humanPlan({ kind: "message", textLength: -1 }, cryptoRandom)).toThrow(RangeError);
    expect(() => humanPlan({ kind: "message", textLength: 1.5 }, cryptoRandom)).toThrow(RangeError);
  });

  it("states its worst case: reading + typing + pause at their top, and the five best-effort calls (seen and its fallback, typing, paused, offline) running out their timeouts", () => {
    expect(HUMAN_MAX_MS).toBe(4000 + 14_000 + 1500 + 5 * 3000);
  });
});

describe("contactAllowance (a second message to one contact waits 30 to 60 s, at most 4 an hour)", () => {
  const now = new Date("2026-11-21T10:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("lets the first message go at once", () => {
    expect(contactAllowance({ sentAt: [], now, random: cryptoRandom })).toEqual({ ok: true, notBefore: now });
    // Messages older than the hour do not count.
    expect(contactAllowance({ sentAt: [ago(CONTACT_WINDOW_MS + 1000)], now, random: cryptoRandom })).toEqual({ ok: true, notBefore: now });
  });

  it("makes a second message wait a random 30 to 60 s after the previous one, different for each contact", () => {
    const waits = Array.from({ length: 100 }, () => {
      const decision = contactAllowance({ sentAt: [ago(5000)], now, random: cryptoRandom });
      if (!decision.ok) throw new Error("allowed");
      return decision.notBefore.getTime() - (now.getTime() - 5000);
    });
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(CONTACT_GAP_MS[0]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(CONTACT_GAP_MS[1]);
    expect(new Set(waits).size).toBeGreaterThan(50);
    // A gap that has already passed asks for no wait.
    expect(contactAllowance({ sentAt: [ago(120_000)], now, random: cryptoRandom })).toEqual({ ok: true, notBefore: now });
    // It is measured from the LAST send, wherever the earlier ones were.
    const decision = contactAllowance({ sentAt: [ago(50 * 60_000), ago(3000), ago(40 * 60_000)], now, random: () => 0 });
    expect(decision).toEqual({ ok: true, notBefore: new Date(now.getTime() - 3000 + CONTACT_GAP_MS[0]) });
  });

  it("refuses a fifth message in the hour and says when the oldest of the last four leaves the window", () => {
    const sentAt = [ago(50 * 60_000), ago(40 * 60_000), ago(30 * 60_000), ago(20 * 60_000)];
    expect(CONTACT_MAX_PER_HOUR).toBe(4);
    expect(contactAllowance({ sentAt, now, random: cryptoRandom })).toEqual({ ok: false, retryAt: new Date(now.getTime() - 50 * 60_000 + CONTACT_WINDOW_MS) });
    // Three in the hour and an old one: allowed (with the gap).
    expect(contactAllowance({ sentAt: [ago(90 * 60_000), ago(40 * 60_000), ago(30 * 60_000), ago(20 * 60_000)], now, random: cryptoRandom }).ok).toBe(true);
  });
});

describe("firstName", () => {
  it("is the first word of the name, without markup characters", () => {
    expect(firstName("Budi Santoso")).toBe("Budi");
    expect(firstName("  Siti   Aminah ")).toBe("Siti");
    expect(firstName("*Budi* <b>x</b>")).toBe("Budi");
    expect(firstName("")).toBe("");
    expect(firstName("A".repeat(100))).toHaveLength(40);
  });
});
