import { describe, expect, it } from "vitest";
import { positiveNumber } from "./args.ts";

describe("positiveNumber", () => {
  it("accepts finite numbers above zero, and whole ones when asked", () => {
    expect(positiveNumber("rate", "50")).toBe(50);
    expect(positiveNumber("rate", "0.5")).toBe(0.5);
    expect(positiveNumber("limit", "5", { integer: true })).toBe(5);
  });

  it("rejects NaN, empty, missing, zero, negative, infinite and (when whole is required) fractional values, naming the flag", () => {
    for (const bad of ["abc", "", "  ", undefined, "0", "-1", "Infinity", "-Infinity", "NaN", "1e999"]) {
      expect(() => positiveNumber("rate", bad), String(bad)).toThrow(/--rate must be a number greater than zero/);
    }
    expect(() => positiveNumber("limit", "2.5", { integer: true })).toThrow(/--limit must be a whole number greater than zero/);
  });
});
