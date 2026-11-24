import { describe, expect, it } from "vitest";
import { SAPAAN_CASUAL_CHANCE, SAPAAN_VALUES, sapaan, sapaanForTime } from "./greeting.ts";

// WIB is UTC+7 with no daylight saving: the greeting follows the clock in Jakarta.
const wib = (hhmm: string): Date => new Date(`2027-06-01T${hhmm}:00+07:00`);

describe("{sapaan}: the greeting of the time of day in Jakarta", () => {
  it("changes at 04:00, 11:00, 15:00 and 18:00 WIB, one minute either side of each", () => {
    const table: readonly (readonly [string, string])[] = [
      ["00:00", "Selamat malam"],
      ["03:59", "Selamat malam"],
      ["04:00", "Selamat pagi"],
      ["10:59", "Selamat pagi"],
      ["11:00", "Selamat siang"],
      ["14:59", "Selamat siang"],
      ["15:00", "Selamat sore"],
      ["17:59", "Selamat sore"],
      ["18:00", "Selamat malam"],
      ["23:59", "Selamat malam"],
    ];
    for (const [time, greeting] of table) expect(sapaanForTime(wib(time)), time).toBe(greeting);
  });

  it("reads the hour in WIB, not in UTC (21:00 UTC is 04:00 WIB the next day)", () => {
    expect(sapaanForTime(new Date("2027-06-01T21:00:00Z"))).toBe("Selamat pagi");
    expect(sapaanForTime(new Date("2027-06-01T20:59:59Z"))).toBe("Selamat malam");
    expect(sapaanForTime(new Date("2027-06-01T04:00:00Z"))).toBe("Selamat siang");
  });

  it("with probability 1/3 uses a casual Halo or Hai (equally likely) instead, whatever the time; otherwise the time's greeting", () => {
    expect(SAPAAN_CASUAL_CHANCE).toBeCloseTo(1 / 3, 12);
    const draws = (...values: number[]) => {
      let i = 0;
      return () => values[i++] ?? 0.99;
    };
    // First draw below 1/3: casual; the second draw picks which one.
    expect(sapaan(wib("08:00"), draws(0, 0.49))).toBe("Halo");
    expect(sapaan(wib("08:00"), draws(0.3333, 0.5))).toBe("Hai");
    expect(sapaan(wib("20:00"), draws(0.1, 0.99))).toBe("Hai");
    // At 1/3 and above: the time of day.
    expect(sapaan(wib("08:00"), draws(1 / 3))).toBe("Selamat pagi");
    expect(sapaan(wib("12:00"), draws(0.99))).toBe("Selamat siang");
    expect(sapaan(wib("16:00"), draws(0.5))).toBe("Selamat sore");
    expect(sapaan(wib("20:00"), draws(0.7))).toBe("Selamat malam");
  });

  it("only ever produces a value the renderer accepts, and about a third of draws are casual", () => {
    // mulberry32: a small seeded generator, uniform in [0, 1).
    let state = 12345;
    const random = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    let casual = 0;
    const n = 6000;
    for (let i = 0; i < n; i++) {
      const value = sapaan(wib("09:00"), random);
      expect(SAPAAN_VALUES).toContain(value);
      if (value === "Halo" || value === "Hai") casual++;
    }
    expect(casual / n).toBeGreaterThan(0.3);
    expect(casual / n).toBeLessThan(0.37);
  });
});
