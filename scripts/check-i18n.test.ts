import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkI18nDir, compareCatalogs, flattenKeys } from "./check-i18n.ts";

function catalogDir(id: unknown, en: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "i18n-"));
  writeFileSync(join(dir, "id.json"), JSON.stringify(id));
  writeFileSync(join(dir, "en.json"), JSON.stringify(en));
  return dir;
}

describe("check-i18n", () => {
  it("flattens nested keys", () => {
    expect(flattenKeys({ a: { b: "x", c: { d: "y" } }, e: "z" })).toEqual(["a.b", "a.c.d", "e"]);
  });

  it("passes when both catalogs have identical keys", () => {
    const dir = catalogDir({ a: { b: "x" } }, { a: { b: "y" } });
    expect(checkI18nDir(dir)).toEqual({ ok: true, problems: [] });
  });

  it("fails when en.json is missing a key", () => {
    const dir = catalogDir({ a: { b: "x", c: "y" } }, { a: { b: "x" } });
    const result = checkI18nDir(dir);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["missing in en.json: a.c"]);
  });

  it("fails when id.json is missing a key", () => {
    const result = compareCatalogs({ a: "x" }, { a: "x", b: "y" }, "id.json", "en.json");
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["missing in id.json: b"]);
  });

  it("the real catalogs are in parity", () => {
    expect(checkI18nDir("packages/i18n/messages").ok).toBe(true);
  });
});
