// The time formats of the play pages: the banner's days-and-clock countdown and the WIB deadline text.
import { describe, expect, it } from "vitest";
import { formatHms, formatWibDeadline, splitDaysHms } from "./format.ts";

const DAY = 86_400;

describe("splitDaysHms (the banner's countdown: days, then hh:mm:ss)", () => {
  it("shows only the clock under a day: 0 s, 59 s, 23:59:59", () => {
    expect(splitDaysHms(0)).toEqual({ days: 0, hms: "00:00:00" });
    expect(splitDaysHms(59)).toEqual({ days: 0, hms: "00:00:59" });
    expect(splitDaysHms(23 * 3600 + 59 * 60 + 59)).toEqual({ days: 0, hms: "23:59:59" });
  });

  it("turns exactly one day into 1 day and an empty clock, never 24 hours", () => {
    expect(splitDaysHms(DAY)).toEqual({ days: 1, hms: "00:00:00" });
    expect(splitDaysHms(DAY + 1)).toEqual({ days: 1, hms: "00:00:01" });
  });

  it("reads 89 days 04:18:22 for a long wait, not thousands of hours", () => {
    expect(splitDaysHms(89 * DAY + 4 * 3600 + 18 * 60 + 22)).toEqual({ days: 89, hms: "04:18:22" });
    // Where the plain format reads the thousands of hours the Owner saw.
    expect(formatHms(89 * DAY + 4 * 3600 + 18 * 60 + 22)).toBe("2140:18:22");
  });

  it("counts anything elapsed (negative) or not a whole second as the time left rounded down, never below 0", () => {
    expect(splitDaysHms(-5)).toEqual({ days: 0, hms: "00:00:00" });
    expect(splitDaysHms(-DAY)).toEqual({ days: 0, hms: "00:00:00" });
    expect(splitDaysHms(59.9)).toEqual({ days: 0, hms: "00:00:59" });
  });
});

describe("formatWibDeadline (the quiz deadline as a player reads it)", () => {
  it("shows a deadline at exactly 00:00 WIB as the day before at 23.59, in WIB and not in UTC", () => {
    expect(formatWibDeadline(new Date("2027-03-22T00:00:00+07:00"))).toEqual({ date: "Minggu, 21 Maret 2027", time: "23.59" });
    // The same instant given in UTC (17:00 on the 21st).
    expect(formatWibDeadline(new Date("2027-03-21T17:00:00Z"))).toEqual({ date: "Minggu, 21 Maret 2027", time: "23.59" });
  });

  it("shows one second after midnight (and one millisecond before it) as it is", () => {
    expect(formatWibDeadline(new Date("2027-03-22T00:00:01+07:00"))).toEqual({ date: "Senin, 22 Maret 2027", time: "00.00" });
    expect(formatWibDeadline(new Date("2027-03-22T00:00:00.001+07:00"))).toEqual({ date: "Senin, 22 Maret 2027", time: "00.00" });
    expect(formatWibDeadline(new Date("2027-03-21T23:59:59.999+07:00"))).toEqual({ date: "Minggu, 21 Maret 2027", time: "23.59" });
  });

  it("keeps any other time as it is: 17.32, a two-digit hour and the minutes", () => {
    expect(formatWibDeadline(new Date("2027-01-22T17:32:10+07:00"))).toEqual({ date: "Jumat, 22 Januari 2027", time: "17.32" });
    expect(formatWibDeadline(new Date("2027-04-12T09:05:00+07:00"))).toEqual({ date: "Senin, 12 April 2027", time: "09.05" });
    expect(formatWibDeadline(new Date("2027-04-12T23:59:00+07:00")).time).toBe("23.59");
  });

  it("crosses a month and a year: 00:00 on 1 April is 31 Maret, and 00:00 on 1 January is 31 Desember of the year before", () => {
    expect(formatWibDeadline(new Date("2027-04-01T00:00:00+07:00"))).toEqual({ date: "Rabu, 31 Maret 2027", time: "23.59" });
    expect(formatWibDeadline(new Date("2027-01-01T00:00:00+07:00"))).toEqual({ date: "Kamis, 31 Desember 2026", time: "23.59" });
    // A leap year has a 29 February.
    expect(formatWibDeadline(new Date("2028-03-01T00:00:00+07:00"))).toEqual({ date: "Selasa, 29 Februari 2028", time: "23.59" });
  });
});
