import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  cumulativeUnlocked,
  lastPlayDay,
  nextUnlockAt,
  scheduleDays,
  unlockedCount,
  wibDay,
  wibDayStart,
  type UnlockSchedule,
} from "./unlock.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** An instant given as a WIB wall-clock time. */
const wib = (date: string, time = "00:00:00.000"): Date => new Date(`${date}T${time}+07:00`);
/** Independent oracle for the WIB day number (UTC+7, no DST). */
const dayOf = (ms: number): number => Math.floor((ms + 7 * HOUR) / DAY);
const startOfDay = (day: number): number => day * DAY - 7 * HOUR;

const count = (schedule: UnlockSchedule, at: Date | number, attempted = 0): number =>
  unlockedCount({ ...schedule, now: typeof at === "number" ? new Date(at) : at, attempted });

/** Count at the last millisecond of each WIB day from the first-paid day through `lastDay`. */
function endOfDayCounts(schedule: UnlockSchedule, lastDay: number): number[] {
  const out: number[] = [];
  for (let day = dayOf(schedule.firstPaidAt.getTime()); day <= lastDay; day++) {
    out.push(count(schedule, startOfDay(day + 1) - 1));
  }
  return out;
}

const deltas = (xs: readonly number[]): number[] => xs.slice(1).map((x, i) => x - (xs[i] ?? 0));

/** WIB day of the instant the given set count is first reached (scans day starts). */
function dayReached(schedule: UnlockSchedule, target: number, lastDay: number): number {
  const first = dayOf(schedule.firstPaidAt.getTime());
  if (count(schedule, schedule.firstPaidAt) >= target) return first;
  for (let day = first + 1; day <= lastDay; day++) {
    if (count(schedule, startOfDay(day)) >= target) return day;
  }
  return Number.NaN;
}

describe("AC-Q5 fixtures: S = 90, sales 2027-04-01..2027-06-30, grace 30 (D_end 2027-07-30)", () => {
  // Sales close at 00:00 WIB on 07-01, i.e. 06-30 is the last sales day.
  const program = { salesEnd: wib("2027-07-01"), graceDays: 30, setCount: 90 };
  const dEnd = dayOf(wib("2027-07-30").getTime());
  const buyer = (date: string): UnlockSchedule => ({ ...program, firstPaidAt: wib(date, "10:15:00.000") });

  it("D_end is 2027-07-30 WIB", () => {
    expect(lastPlayDay(program.salesEnd, program.graceDays)).toBe(dEnd);
    expect(wibDayStart(dEnd).toISOString()).toBe("2027-07-29T17:00:00.000Z");
  });

  it("buyer on 04-01: A = 121, 1 set/day, last set on 06-29", () => {
    const s = buyer("2027-04-01");
    expect(scheduleDays(s)).toBe(121);
    expect(count(s, s.firstPaidAt)).toBe(1);
    const counts = endOfDayCounts(s, dEnd);
    expect(counts[0]).toBe(1);
    expect(new Set(deltas(counts.slice(0, 90)))).toEqual(new Set([1]));
    expect(dayReached(s, 90, dEnd)).toBe(dayOf(wib("2027-06-29").getTime()));
    expect(count(s, wib("2027-06-28", "23:59:59.999"))).toBe(89);
    expect(count(s, wib("2027-06-29"))).toBe(90);
    expect(counts.at(-1)).toBe(90);
  });

  it("buyer on 05-02: A = 90, 1 set/day, last set on 07-30", () => {
    const s = buyer("2027-05-02");
    expect(scheduleDays(s)).toBe(90);
    const counts = endOfDayCounts(s, dEnd);
    expect(counts).toHaveLength(90);
    expect(counts[0]).toBe(1);
    expect(new Set(deltas(counts))).toEqual(new Set([1]));
    expect(count(s, wib("2027-07-29", "23:59:59.999"))).toBe(89);
    expect(count(s, wib("2027-07-30"))).toBe(90);
  });

  it("buyer on 06-01: A = 60, 1-2 sets/day, last set on 07-30", () => {
    const s = buyer("2027-06-01");
    expect(scheduleDays(s)).toBe(60);
    const counts = endOfDayCounts(s, dEnd);
    expect(counts[0]).toBe(1);
    expect(counts.slice(0, 4)).toEqual([1, 2, 4, 5]);
    expect(new Set(deltas(counts))).toEqual(new Set([1, 2]));
    expect(count(s, wib("2027-07-29", "23:59:59.999"))).toBeLessThan(90);
    expect(count(s, wib("2027-07-30"))).toBe(90);
  });

  it("buyer on 06-30 (last sales day): A = 31, 1 set on day 0, then 2-3/day, last on 07-30", () => {
    const s = buyer("2027-06-30");
    expect(scheduleDays(s)).toBe(31);
    const counts = endOfDayCounts(s, dEnd);
    expect(counts.slice(0, 4)).toEqual([1, 3, 6, 9]);
    expect(new Set(deltas(counts))).toEqual(new Set([2, 3]));
    expect(count(s, wib("2027-07-29", "23:59:59.999"))).toBe(87);
    expect(count(s, wib("2027-07-30"))).toBe(90);
  });

  it("total is always 90, also long after the grace period", () => {
    for (const date of ["2027-04-01", "2027-05-02", "2027-06-01", "2027-06-30"]) {
      expect(count(buyer(date), wib("2027-07-30", "23:59:59.999"))).toBe(90);
      expect(count(buyer(date), wib("2030-01-01"))).toBe(90);
    }
  });

  it("gives the same D_end for every way of storing the sales end on 06-30", () => {
    for (const salesEnd of [wib("2027-07-01"), wib("2027-06-30", "23:59:59.999"), wib("2027-06-30", "17:00:00.000")]) {
      expect(lastPlayDay(salesEnd, 30)).toBe(dEnd);
    }
    // One millisecond later the last open instant falls on 07-01.
    expect(lastPlayDay(new Date(wib("2027-07-01").getTime() + 1), 30)).toBe(dEnd + 1);
  });
});

describe("WIB day boundary (00:00 WIB = 17:00 UTC of the previous day)", () => {
  const program = { salesEnd: wib("2027-07-01"), graceDays: 30, setCount: 90 };

  it("maps 16:59:59.999Z and 17:00:00.000Z to consecutive WIB days", () => {
    expect(wibDay(new Date("2027-06-01T16:59:59.999Z"))).toBe(dayOf(wib("2027-06-01").getTime()));
    expect(wibDay(new Date("2027-06-01T17:00:00.000Z"))).toBe(dayOf(wib("2027-06-02").getTime()));
    expect(wibDayStart(wibDay(new Date("2027-06-01T17:00:00.000Z"))).toISOString()).toBe("2027-06-01T17:00:00.000Z");
  });

  it("assigns a payment at 23:59:59.999 WIB to that day and at 00:00 WIB to the next", () => {
    expect(scheduleDays({ ...program, firstPaidAt: new Date("2027-06-01T16:59:59.999Z") })).toBe(60);
    expect(scheduleDays({ ...program, firstPaidAt: new Date("2027-06-01T17:00:00.000Z") })).toBe(59);
  });

  it("unlocks the next sets exactly at 17:00:00.000Z", () => {
    const s = { ...program, firstPaidAt: wib("2027-06-01", "10:00:00.000") };
    expect(count(s, new Date("2027-06-01T16:59:59.999Z"))).toBe(1);
    expect(count(s, new Date("2027-06-01T17:00:00.000Z"))).toBe(2);
    expect(count(s, new Date("2027-06-02T16:59:59.999Z"))).toBe(2);
    expect(count(s, new Date("2027-06-02T17:00:00.000Z"))).toBe(4);
  });
});

describe("edge cases", () => {
  // Sales close at 00:00 WIB on 2027-02-01 (last sales day 01-31); grace 0 => D_end = 01-31.
  const salesEnd = wib("2027-02-01");
  const dEnd = dayOf(wib("2027-01-31").getTime());
  /** Buyer whose schedule has exactly `a` days (A) with S = `s`, grace 0. */
  const withDays = (a: number, s: number): UnlockSchedule => ({
    salesEnd,
    graceDays: 0,
    setCount: s,
    firstPaidAt: new Date(startOfDay(dEnd - a + 1) + 9 * HOUR),
  });

  it("S = 1 unlocks the only set on payment and nothing ever after", () => {
    const s = withDays(20, 1);
    expect(count(s, s.firstPaidAt)).toBe(1);
    expect(endOfDayCounts(s, dEnd + 2).every((c) => c === 1)).toBe(true);
    expect(nextUnlockAt({ ...s, now: s.firstPaidAt })).toBeNull();
  });

  it("A = S: 1/day with the last set on D_end", () => {
    const s = withDays(10, 10);
    expect(endOfDayCounts(s, dEnd)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("A = S - 1: last set on D_end, never earlier", () => {
    const s = withDays(9, 10);
    expect(scheduleDays(s)).toBe(9);
    expect(endOfDayCounts(s, dEnd)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10]);
    expect(dayReached(s, 10, dEnd)).toBe(dEnd);
  });

  it("A = 2: one set on day 0, the rest on D_end", () => {
    expect(endOfDayCounts(withDays(2, 10), dEnd)).toEqual([1, 10]);
  });

  it("A = 1: all S sets on day 0", () => {
    const s = withDays(1, 10);
    expect(scheduleDays(s)).toBe(1);
    expect(count(s, s.firstPaidAt)).toBe(10);
    expect(nextUnlockAt({ ...s, now: s.firstPaidAt })).toBeNull();
  });

  it("sets != days: 91 days with 90 sets is 1/day ending a day before D_end", () => {
    const s = withDays(91, 90);
    expect(dayReached(s, 90, dEnd)).toBe(dEnd - 1);
    expect(new Set(deltas(endOfDayCounts(s, dEnd)))).toEqual(new Set([1, 0]));
  });

  it("sets != days: 90 days with 91 sets spreads to D_end", () => {
    const s = withDays(90, 91);
    const counts = endOfDayCounts(s, dEnd);
    expect(counts).toHaveLength(90);
    expect(counts[0]).toBe(1);
    expect(counts.at(-1)).toBe(91);
    expect(new Set(deltas(counts))).toEqual(new Set([1, 2]));
    expect(dayReached(s, 91, dEnd)).toBe(dEnd);
  });

  it("returns max(formula, attempted)", () => {
    const s = withDays(30, 30);
    expect(count(s, s.firstPaidAt, 0)).toBe(1);
    expect(count(s, s.firstPaidAt, 5)).toBe(5);
    expect(count(s, wib("2027-01-31"), 3)).toBe(30);
  });

  it("unlocks nothing before the payment instant", () => {
    const s = withDays(30, 30);
    expect(count(s, new Date(s.firstPaidAt.getTime() - 1))).toBe(0);
    expect(count(s, new Date(s.firstPaidAt.getTime() - 1), 2)).toBe(2);
  });

  it("treats a settlement on or after D_end as A = 1 (everything unlocked)", () => {
    const late = { salesEnd, graceDays: 0, setCount: 12, firstPaidAt: wib("2027-03-05", "08:00:00.000") };
    expect(scheduleDays(late)).toBe(1);
    expect(count(late, late.firstPaidAt)).toBe(12);
  });

  it("returns 0 for a program without sets", () => {
    const s = withDays(5, 0);
    expect(count(s, s.firstPaidAt)).toBe(0);
    expect(nextUnlockAt({ ...s, now: s.firstPaidAt })).toBeNull();
  });

  it("rejects invalid input", () => {
    const s = withDays(10, 10);
    const now = s.firstPaidAt;
    expect(() => unlockedCount({ ...s, now, attempted: 11 })).toThrow(RangeError);
    expect(() => unlockedCount({ ...s, now, attempted: -1 })).toThrow(RangeError);
    expect(() => unlockedCount({ ...s, now, attempted: 1.5 })).toThrow(RangeError);
    expect(() => unlockedCount({ ...s, now: new Date(Number.NaN), attempted: 0 })).toThrow(RangeError);
    expect(() => unlockedCount({ ...s, graceDays: -1, now, attempted: 0 })).toThrow(RangeError);
    expect(() => unlockedCount({ ...s, setCount: 2.5, now, attempted: 0 })).toThrow(RangeError);
    expect(() => unlockedCount({ ...s, firstPaidAt: new Date("x"), now, attempted: 0 })).toThrow(RangeError);
    expect(() => wibDayStart(1.5)).toThrow(RangeError);
    expect(() => cumulativeUnlocked(0.5, 2, 2)).toThrow(RangeError);
    expect(() => cumulativeUnlocked(0, 0, 2)).toThrow(RangeError);
  });

  it("nextUnlockAt gives the next 00:00 WIB that adds a set", () => {
    const s = withDays(4, 10); // cumulative 1, 4, 7, 10
    expect(nextUnlockAt({ ...s, now: new Date(s.firstPaidAt.getTime() - 1) })).toEqual(s.firstPaidAt);
    expect(nextUnlockAt({ ...s, now: s.firstPaidAt })).toEqual(new Date(startOfDay(dEnd - 2)));
    expect(nextUnlockAt({ ...s, now: new Date(startOfDay(dEnd - 1) - 1) })).toEqual(new Date(startOfDay(dEnd - 1)));
    expect(nextUnlockAt({ ...s, now: new Date(startOfDay(dEnd)) })).toBeNull();
    const slow = withDays(20, 3); // 1/day for 3 days, then nothing more
    expect(nextUnlockAt({ ...slow, now: slow.firstPaidAt })).toEqual(new Date(startOfDay(dEnd - 18)));
  });
});

describe("properties over random programs and purchase dates", () => {
  const BASE_DAY = dayOf(Date.UTC(2026, 0, 1));
  /** salesEndMs: sales close this many ms into the last sales day (DAY = 00:00 WIB of the next day). */
  const build = (r: {
    setCount: number;
    salesStartDay: number;
    salesDays: number;
    graceDays: number;
    salesEndMs: number;
    purchaseDay: number;
    purchaseMs: number;
  }) => {
    const lastSalesDay = r.salesStartDay + r.salesDays - 1;
    const salesEnd = startOfDay(lastSalesDay) + r.salesEndMs;
    // A purchase is always strictly before the sales end (and stays on its day).
    const paidAt = Math.min(startOfDay(r.purchaseDay) + r.purchaseMs, salesEnd - 1);
    const dEnd = lastSalesDay + r.graceDays;
    const schedule: UnlockSchedule = {
      salesEnd: new Date(salesEnd),
      graceDays: r.graceDays,
      setCount: r.setCount,
      firstPaidAt: new Date(paidAt),
    };
    return { schedule, dEnd, days: dEnd - dayOf(paidAt) + 1 };
  };
  const randomScenario = fc
    .record({
      setCount: fc.integer({ min: 1, max: 150 }),
      salesStartOffset: fc.integer({ min: 0, max: 3650 }),
      salesDays: fc.integer({ min: 1, max: 200 }),
      graceDays: fc.integer({ min: 0, max: 120 }),
      salesEndMs: fc.integer({ min: 1, max: DAY }),
      purchaseDayOffset: fc.nat(),
      purchaseMs: fc.integer({ min: 0, max: DAY - 1 }),
    })
    .map((r) => {
      const salesStartDay = BASE_DAY + r.salesStartOffset;
      return build({ ...r, salesStartDay, purchaseDay: salesStartDay + (r.purchaseDayOffset % r.salesDays) });
    });
  /** Review item 13: aim A at the formula's edges, 1, 2, S - 1, S and S + 1. */
  const TARGETS = ["1", "2", "S-1", "S", "S+1"] as const;
  const targetedScenario = fc
    .record({
      setCount: fc.integer({ min: 1, max: 150 }),
      target: fc.constantFrom(...TARGETS),
      salesStartOffset: fc.integer({ min: 0, max: 3650 }),
      graceSeed: fc.nat(),
      extraSalesDays: fc.integer({ min: 0, max: 60 }),
      salesEndMs: fc.integer({ min: 1, max: DAY }),
      purchaseMs: fc.integer({ min: 0, max: DAY - 1 }),
    })
    .map((r) => {
      const s = r.setCount;
      const a = Math.max(1, { "1": 1, "2": 2, "S-1": s - 1, S: s, "S+1": s + 1 }[r.target]);
      const graceDays = r.graceSeed % a; // 0 .. A - 1 keeps the purchase day inside the sales window
      const salesStartDay = BASE_DAY + r.salesStartOffset;
      return build({
        ...r,
        salesStartDay,
        salesDays: a - graceDays + r.extraSalesDays,
        graceDays,
        purchaseDay: salesStartDay + r.extraSalesDays,
      });
    });
  const scenario = fc.oneof(randomScenario, targetedScenario);

  it("item 13: the targeted branch hits A = 1, 2, S - 1, S and S + 1", () => {
    const seen = new Set<string>();
    for (const { schedule, days } of fc.sample(targetedScenario, { numRuns: 500, seed: 13 })) {
      const s = schedule.setCount;
      if (days === 1) seen.add("1");
      if (days === 2) seen.add("2");
      if (days === s - 1) seen.add("S-1");
      if (days === s) seen.add("S");
      if (days === s + 1) seen.add("S+1");
      expect([1, 2, s - 1, s, s + 1]).toContain(days);
    }
    expect([...seen].sort()).toEqual([...TARGETS].sort());
  });

  it("item 2: after extending grace with floor = the count at the reschedule, the schedule is monotone, never below the floor, and ends on the new D_end", () => {
    fc.assert(
      fc.property(scenario, fc.integer({ min: 1, max: 120 }), fc.nat(), ({ schedule, dEnd, days }, extra, x) => {
        const p = dayOf(schedule.firstPaidAt.getTime());
        const from = schedule.firstPaidAt.getTime();
        const rescheduledAt = from + (x % (startOfDay(dEnd + 1) - from));
        const floor = count(schedule, rescheduledAt);
        const extended = { ...schedule, graceDays: schedule.graceDays + extra };
        const newDEnd = dEnd + extra;
        const newDays = days + extra;
        const s = schedule.setCount;
        const at = (t: number): number => unlockedCount({ ...extended, now: new Date(t), attempted: 0, floor });
        const ends: number[] = [];
        for (let day = p; day <= newDEnd + 1; day++) ends.push(at(startOfDay(day + 1) - 1));
        // Monotone in time and never below the floor.
        ends.forEach((c, i) => {
          expect(c).toBeGreaterThanOrEqual(floor);
          if (i > 0) expect(c).toBeGreaterThanOrEqual(ends[i - 1] ?? 0);
        });
        // Reaches S exactly on the new D_end when A_new < S (else on day p + S - 1), unless the floor already is S.
        if (floor < s) {
          const lastDay = newDays < s ? newDEnd : p + s - 1;
          expect(at(startOfDay(lastDay))).toBe(s);
          if (lastDay > p) expect(at(startOfDay(lastDay) - 1)).toBeLessThan(s);
        }
        expect(ends.at(-1)).toBe(s);
      }),
    );
  });

  it("A matches the definition: days from p to D_end inclusive", () => {
    fc.assert(
      fc.property(scenario, ({ schedule, dEnd, days }) => {
        expect(lastPlayDay(schedule.salesEnd, schedule.graceDays)).toBe(dEnd);
        expect(scheduleDays(schedule)).toBe(days);
      }),
    );
  });

  it("is monotone in time", () => {
    fc.assert(
      fc.property(scenario, fc.nat(), fc.nat(), ({ schedule, dEnd }, x, y) => {
        const from = schedule.firstPaidAt.getTime() - 2 * DAY;
        const span = startOfDay(dEnd + 3) - from;
        const [t1, t2] = [from + (x % span), from + (y % span)].sort((a, b) => a - b) as [number, number];
        expect(count(schedule, t1)).toBeLessThanOrEqual(count(schedule, t2));
      }),
    );
  });

  it("day 0 = 1 set (S when A = 1), set 1 at the payment instant", () => {
    fc.assert(
      fc.property(scenario, ({ schedule, days }) => {
        const expected = days === 1 ? schedule.setCount : 1;
        expect(count(schedule, schedule.firstPaidAt)).toBe(expected);
        expect(count(schedule, startOfDay(dayOf(schedule.firstPaidAt.getTime()) + 1) - 1)).toBe(expected);
        expect(count(schedule, schedule.firstPaidAt.getTime() - 1)).toBe(0);
      }),
    );
  });

  it("the last set unlocks on D_end when A < S, and on day S - 1 when A >= S", () => {
    fc.assert(
      fc.property(scenario, ({ schedule, dEnd, days }) => {
        const p = dayOf(schedule.firstPaidAt.getTime());
        const lastDay = days < schedule.setCount ? dEnd : p + schedule.setCount - 1;
        expect(lastDay).toBeLessThanOrEqual(dEnd);
        expect(dayReached(schedule, schedule.setCount, dEnd)).toBe(lastDay);
      }),
    );
  });

  it("the total is S and never exceeds S", () => {
    fc.assert(
      fc.property(scenario, ({ schedule, dEnd }) => {
        const counts = endOfDayCounts(schedule, dEnd + 2);
        expect(Math.max(...counts)).toBe(schedule.setCount);
        expect(counts.at(-1)).toBe(schedule.setCount);
        expect(count(schedule, startOfDay(dEnd + 400))).toBe(schedule.setCount);
      }),
    );
  });

  it("is never front-loaded: at or below the straight line, daily steps floor/ceil of the pace", () => {
    fc.assert(
      fc.property(scenario, ({ schedule, dEnd, days }) => {
        const s = schedule.setCount;
        const counts = endOfDayCounts(schedule, dEnd);
        expect(counts).toHaveLength(days);
        if (days === 1) return;
        if (days >= s) {
          expect(deltas(counts).every((d) => d === 0 || d === 1)).toBe(true);
          counts.forEach((c, i) => {
            expect(c).toBe(Math.min(s, i + 1));
          });
          return;
        }
        counts.forEach((c, i) => {
          // (c - 1) / i <= (S - 1) / (A - 1), compared in integers.
          expect((c - 1) * (days - 1)).toBeLessThanOrEqual(i * (s - 1));
          expect(c * (days - 1)).toBeGreaterThan(i * (s - 1));
        });
        const lo = Math.floor((s - 1) / (days - 1));
        const hi = Math.ceil((s - 1) / (days - 1));
        expect(deltas(counts).every((d) => d === lo || d === hi)).toBe(true);
      }),
    );
  });

  it("result = max(formula, attempted)", () => {
    fc.assert(
      fc.property(scenario, fc.nat(), fc.nat(), ({ schedule, dEnd }, x, k) => {
        const from = schedule.firstPaidAt.getTime() - DAY;
        const at = from + (x % (startOfDay(dEnd + 2) - from));
        const attempted = k % (schedule.setCount + 1);
        expect(count(schedule, at, attempted)).toBe(Math.max(count(schedule, at), attempted));
      }),
    );
  });

  it("nextUnlockAt is the first later instant with a higher count", () => {
    fc.assert(
      fc.property(scenario, fc.nat(), ({ schedule, dEnd }, x) => {
        const from = schedule.firstPaidAt.getTime() - DAY;
        const now = from + (x % (startOfDay(dEnd + 2) - from));
        const next = nextUnlockAt({ ...schedule, now: new Date(now) });
        const current = count(schedule, now);
        if (next === null) {
          expect(current).toBe(schedule.setCount);
          return;
        }
        expect(next.getTime()).toBeGreaterThan(now);
        expect(count(schedule, next)).toBeGreaterThan(current);
        expect(count(schedule, next.getTime() - 1)).toBe(current);
      }),
    );
  });
});

describe("review fixes: floor after an extend-only reschedule (item 2)", () => {
  const program = { salesEnd: wib("2027-07-01"), setCount: 90 };
  const buyer = { ...program, graceDays: 30, firstPaidAt: wib("2027-06-30", "10:15:00.000") };
  const now = wib("2027-07-05", "12:00:00.000");

  it("item 2: grace 30 -> 60 keeps the 15 sets already shown when the floor is passed", () => {
    const shown = count(buyer, now);
    expect(shown).toBe(15);
    const extended = { ...buyer, graceDays: 60 };
    expect(count(extended, now)).toBe(8); // what the formula alone gives after the extension
    expect(unlockedCount({ ...extended, now, attempted: 0, floor: shown })).toBe(15);
    expect(unlockedCount({ ...extended, now, attempted: 20, floor: shown })).toBe(20);
  });

  it("item 2: nextUnlockAt counts from max(formula, attempted, floor)", () => {
    const extended = { ...buyer, graceDays: 60 };
    const next = nextUnlockAt({ ...extended, now, floor: 15 });
    expect(next).not.toBeNull();
    const at = next ?? new Date(0);
    expect(count(extended, at)).toBeGreaterThan(15);
    expect(count(extended, new Date(at.getTime() - 1))).toBeLessThanOrEqual(15);
    expect(nextUnlockAt({ ...extended, now, attempted: 90 })).toBeNull();
  });

  it("item 2: rejects an invalid floor", () => {
    expect(() => unlockedCount({ ...buyer, now, attempted: 0, floor: 91 })).toThrow(RangeError);
    expect(() => unlockedCount({ ...buyer, now, attempted: 0, floor: -1 })).toThrow(RangeError);
    expect(() => unlockedCount({ ...buyer, now, attempted: 0, floor: 1.5 })).toThrow(RangeError);
  });
});

describe("review round 2: attempted is required", () => {
  it("rejects a missing attempted at runtime", () => {
    const s = { salesEnd: wib("2027-07-01"), graceDays: 30, setCount: 90, firstPaidAt: wib("2027-06-01") };
    expect(() => unlockedCount({ ...s, now: wib("2027-06-02") } as unknown as Parameters<typeof unlockedCount>[0])).toThrow(RangeError);
  });
});
