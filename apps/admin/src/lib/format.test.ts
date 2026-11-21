import { describe, expect, it } from "vitest";
import { formatBps, formatDay, formatRupiah, formatRupiahSigned, formatWibTime } from "./format.ts";

describe("report formats", () => {
  it("formats rupiah with a sign for a loss", () => {
    expect(formatRupiah(1_250_000)).toBe("Rp 1.250.000");
    expect(formatRupiahSigned(1_250_000)).toBe("Rp 1.250.000");
    expect(formatRupiahSigned(-1_250_000)).toBe("-Rp 1.250.000");
    expect(formatRupiahSigned(0)).toBe("Rp 0");
  });

  it("formats basis points as a percentage, with no rate shown as a dash", () => {
    expect(formatBps(null)).toBe("-");
    expect(formatBps(0)).toBe("0%");
    expect(formatBps(1250)).toBe("12.5%");
    expect(formatBps(3333)).toBe("33.33%");
    expect(formatBps(5)).toBe("0.05%");
    expect(formatBps(10_000)).toBe("100%");
    expect(formatBps(15_000)).toBe("150%");
  });

  it("formats an instant and a day in WIB", () => {
    expect(formatWibTime(new Date("2026-11-20T07:05:00Z"))).toBe("20 Nov, 14:05 WIB");
    expect(formatDay("2026-11-20")).toBe("20 Nov");
  });
});
