import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mockupsEnabled } from "./mockups.ts";

describe("mockupsEnabled", () => {
  it("is enabled outside production", () => {
    expect(mockupsEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(mockupsEnabled({ NODE_ENV: "test" })).toBe(true);
    expect(mockupsEnabled({})).toBe(true);
  });

  it("is disabled in production unless ENABLE_MOCKUPS=1", () => {
    expect(mockupsEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(mockupsEnabled({ NODE_ENV: "production", ENABLE_MOCKUPS: "" })).toBe(false);
    expect(mockupsEnabled({ NODE_ENV: "production", ENABLE_MOCKUPS: "0" })).toBe(false);
    expect(mockupsEnabled({ NODE_ENV: "production", ENABLE_MOCKUPS: "true" })).toBe(false);
  });

  it("is enabled in production when ENABLE_MOCKUPS=1", () => {
    expect(mockupsEnabled({ NODE_ENV: "production", ENABLE_MOCKUPS: "1" })).toBe(true);
  });
});

describe("mockup pages", () => {
  const mockupsDir = fileURLToPath(new URL("../app/(mockups)/", import.meta.url));
  const pages = readdirSync(mockupsDir, { recursive: true, encoding: "utf8" }).filter(
    (p) => basename(p) === "page.tsx",
  );

  it("are found", () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  // Without force-dynamic, a build made without ENABLE_MOCKUPS prerenders notFound() into a
  // static 404, so the flag would stop being checked per request.
  it.each(pages)("%s guards and renders per request", (page) => {
    const source = readFileSync(join(mockupsDir, page), "utf8");
    expect(source).toMatch(/^export const dynamic = "force-dynamic";$/m);
    expect(source).toContain("assertMockupsEnabled();");
  });
});
