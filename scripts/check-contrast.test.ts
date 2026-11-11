import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFiles, checkPairs, contrastRatio, parseThemes } from "./check-contrast.ts";

const TOKENS = "packages/ui/src/tokens.css";
const PAIRS = "packages/ui/src/contrast-pairs.json";

describe("check-contrast", () => {
  it("computes known WCAG ratios", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });

  it("parses the trivia theme with the specified hexes", () => {
    const trivia = parseThemes(readTokens())["trivia"];
    expect(trivia).toMatchObject({
      primary: "#2563EB",
      "on-primary": "#FFFFFF",
      secondary: "#7C3AED",
      accent: "#F59E0B",
      "on-accent": "#0F172A",
      background: "#EFF6FF",
      foreground: "#0F172A",
      card: "#FFFFFF",
      muted: "#F1F5FD",
      "muted-foreground": "#475569",
      border: "#E4ECFC",
      destructive: "#DC2626",
      ring: "#2563EB",
    });
  });

  it("defines trivia, admin-light and admin-dark with identical colour token sets", () => {
    const themes = parseThemes(readTokens());
    expect(Object.keys(themes).sort()).toEqual(["admin-dark", "admin-light", "trivia"]);
    const base = Object.keys(themes["trivia"] ?? {}).sort();
    expect(Object.keys(themes["admin-light"] ?? {}).sort()).toEqual(base);
    expect(Object.keys(themes["admin-dark"] ?? {}).sort()).toEqual(base);
  });

  it("fails a normal-text pair below 4.5:1", () => {
    const themes = { t: { a: "#777777", b: "#FFFFFF" } };
    const result = checkPairs(themes, [{ fg: "a", bg: "b", level: "text" }]);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("4.48:1");
  });

  it("allows the same pair as large text (3:1) and fails below 3:1 non-text", () => {
    const themes = { t: { a: "#777777", b: "#FFFFFF", c: "#CCCCCC" } };
    expect(checkPairs(themes, [{ fg: "a", bg: "b", level: "large" }]).ok).toBe(true);
    expect(checkPairs(themes, [{ fg: "c", bg: "b", level: "nontext" }]).ok).toBe(false);
  });

  it("fails on unknown tokens instead of skipping them", () => {
    const result = checkPairs({ t: { a: "#000000" } }, [{ fg: "a", bg: "nope", level: "text" }]);
    expect(result.ok).toBe(false);
  });

  it("passes on the real tokens", () => {
    const result = checkFiles(TOKENS, PAIRS);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThan(60);
  });

  it("CLI exits 1 for a bad pair and 0 for the real tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "contrast-"));
    const bad = join(dir, "pairs.json");
    writeFileSync(bad, JSON.stringify({ pairs: [{ fg: "accent", bg: "background", level: "text", themes: ["trivia"] }] }));
    const run = (pairs: string) =>
      spawnSync(process.execPath, ["--import", "tsx", "scripts/check-contrast.ts", TOKENS, pairs], {
        encoding: "utf8",
      });
    const failing = run(bad);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain("needs 4.5:1");
    expect(run(PAIRS).status).toBe(0);
  });
});

function readTokens(): string {
  return readFileSync(TOKENS, "utf8");
}
