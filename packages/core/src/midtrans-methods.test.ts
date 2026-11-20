import { describe, expect, it } from "vitest";
import { enabledMidtransMethods, isMidtransMethod, MIDTRANS_METHODS } from "./midtrans-methods.ts";

describe("Midtrans method codes (one list for the console and Snap)", () => {
  it("has distinct codes", () => {
    const codes = MIDTRANS_METHODS.map((m) => m.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("recognises the listed codes only", () => {
    expect(isMidtransMethod("other_qris")).toBe(true);
    expect(isMidtransMethod("bitcoin")).toBe(false);
    expect(isMidtransMethod(1)).toBe(false);
  });

  it("keeps the known codes of a stored list once each, in order, and drops the rest", () => {
    expect(enabledMidtransMethods(["gopay", "bitcoin", 3, "bca_va", "gopay"])).toEqual(["gopay", "bca_va"]);
    expect(enabledMidtransMethods("gopay")).toEqual([]);
    expect(enabledMidtransMethods(null)).toEqual([]);
  });
});
