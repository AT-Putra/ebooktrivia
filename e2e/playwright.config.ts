import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * A production build of the admin app needs its origin at build time (next.config.ts allowedOrigins);
 * the e2e servers serve plain http on 127.0.0.1, hence the loopback flag (test builds only).
 */
export const ADMIN_BUILD_ENV = { ADMIN_ORIGIN: "http://127.0.0.1:3202", ADMIN_ALLOW_INSECURE_LOOPBACK: "1" };

function app(filter: string, port: number, extraEnv: Record<string, string> = {}) {
  return {
    command: `pnpm --filter ${filter} run build && pnpm --filter ${filter} exec next start -p ${port}`,
    cwd: repoRoot,
    url: `http://127.0.0.1:${port}/`,
    timeout: 600_000,
    reuseExistingServer: process.env["CI"] === undefined,
    env: { ENABLE_MOCKUPS: "1", ...extraEnv },
    stdout: "pipe" as const,
  };
}

export default defineConfig({
  testDir: "./tests",
  // A stray test.only must not turn the CI run into a one-test run.
  forbidOnly: !!process.env["CI"],
  outputDir: "./test-results",
  fullyParallel: true,
  workers: 4,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    colorScheme: "light",
    locale: "id-ID",
    timezoneId: "Asia/Jakarta",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [app("@ebooktrivia/public", 3100), app("@ebooktrivia/admin", 3200, ADMIN_BUILD_ENV)],
});
