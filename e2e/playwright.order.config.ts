import { defineConfig } from "@playwright/test";

/**
 * The order status page and legal pages spec on its own (`pnpm --filter @ebooktrivia/e2e test:order`): it
 * starts its own `next start` of apps/public (port 3205, a throwaway database, the dev Valkey) and builds
 * the app first when there is no build, so it needs none of the servers playwright.config.ts starts.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: "order.spec.ts",
  forbidOnly: !!process.env["CI"],
  outputDir: "./test-results",
  workers: 1,
  reporter: [["list"]],
  timeout: 90_000,
  use: { colorScheme: "light", locale: "id-ID", timezoneId: "Asia/Jakarta" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
