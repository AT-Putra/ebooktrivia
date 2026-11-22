import { describe, expect, it } from "vitest";
import { parseRunFile } from "./verify-p8.ts";

describe("parseRunFile (run.sh's orders-50pm-run.json)", () => {
  it("reads the start time of the run", () => {
    expect(parseRunFile('{"started_at":"2026-11-22T05:40:38Z","run_seed":123,"rate_per_min":50,"duration":"10m"}').toISOString()).toBe("2026-11-22T05:40:38.000Z");
  });

  it("refuses a file without a usable started_at, so a verification never silently counts every order of the landing page", () => {
    for (const bad of ["{}", '{"started_at":42}', '{"started_at":"yesterday"}', '{"started_at":""}']) {
      expect(() => parseRunFile(bad), bad).toThrow(/no valid started_at/);
    }
    expect(() => parseRunFile("not json")).toThrow();
  });
});
