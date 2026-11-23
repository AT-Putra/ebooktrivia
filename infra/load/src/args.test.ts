import { describe, expect, it } from "vitest";
import { demoArgs, positiveNumber, wholeNumber } from "./args.ts";

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

describe("wholeNumber", () => {
  it("accepts a whole number inside the bounds, edges included", () => {
    expect(wholeNumber("buyers", "1", 1, 200)).toBe(1);
    expect(wholeNumber("buyers", "200", 1, 200)).toBe(200);
    expect(wholeNumber("seed", "0", 0, 4_294_967_295)).toBe(0);
  });

  it("rejects a typo, an empty or missing value, a fraction and a number outside the bounds, naming the flag and the bounds", () => {
    for (const bad of ["abc", "", "  ", undefined, "1.5", "0", "201", "-1", "Infinity", "NaN", "1e3"]) {
      expect(() => wholeNumber("buyers", bad, 1, 200), String(bad)).toThrow(/--buyers must be an integer from 1 to 200/);
    }
  });
});

describe("demoArgs (seed.ts demo)", () => {
  const ok = { "program-slug": "ebook-trivia-1", out: "/out/demo.json" };

  it("defaults to 30 buyers, no fixed seed and no lock acceptance", () => {
    expect(demoArgs(ok)).toEqual({ programSlug: "ebook-trivia-1", buyers: 30, seed: undefined, out: "/out/demo.json", acceptProgramLock: false });
  });

  it("takes buyers from 1 to 200, a seed from 0 to 2^32-1 and the lock flag", () => {
    expect(demoArgs({ ...ok, buyers: "200", seed: "4294967295", "accept-program-lock": true })).toMatchObject({ buyers: 200, seed: 4_294_967_295, acceptProgramLock: true });
    for (const buyers of ["0", "201", "x", ""]) expect(() => demoArgs({ ...ok, buyers }), buyers).toThrow(/--buyers/);
    for (const seed of ["-1", "4294967296", "1.5", "x"]) expect(() => demoArgs({ ...ok, seed }), seed).toThrow(/--seed/);
  });

  it("needs the slug of a program (lower-case words) and an output file", () => {
    for (const slug of [undefined, "", "Ebook", "a b", "-a", "a--b", "a_b", "../x", "a;drop"]) expect(() => demoArgs({ ...ok, "program-slug": slug }), String(slug)).toThrow(/--program-slug/);
    expect(() => demoArgs({ "program-slug": "ebook" })).toThrow(/--out/);
    expect(() => demoArgs({ "program-slug": "ebook", out: " " })).toThrow(/--out/);
  });
});
