import { defineConfig } from "@playwright/test";

/**
 * The landing-page SDK spec on its own (`pnpm --filter @ebooktrivia/e2e test:sdk`): it starts its own
 * stub API and fixture landing page on ephemeral ports, so it needs none of the Next.js servers that
 * playwright.config.ts builds and starts for the other specs.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: "sdk.spec.ts",
  forbidOnly: !!process.env["CI"],
  outputDir: "./test-results",
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  use: { colorScheme: "light", locale: "id-ID", timezoneId: "Asia/Jakarta" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
