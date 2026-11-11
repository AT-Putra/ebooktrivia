import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function app(filter: string, port: number) {
  return {
    command: `pnpm --filter ${filter} run build && pnpm --filter ${filter} exec next start -p ${port}`,
    cwd: repoRoot,
    url: `http://127.0.0.1:${port}/`,
    timeout: 600_000,
    reuseExistingServer: process.env["CI"] === undefined,
    env: { ENABLE_MOCKUPS: "1" },
    stdout: "pipe" as const,
  };
}

export default defineConfig({
  testDir: "./tests",
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
  webServer: [app("@ebooktrivia/public", 3100), app("@ebooktrivia/admin", 3200)],
});
