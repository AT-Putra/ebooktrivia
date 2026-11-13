import { defineConfig } from "vitest/config";

// Coverage gate for the worker (plan M3). Most of the worker is I/O against PostgreSQL and
// Valkey, so the gate runs the unit tests (src/, also run by root `pnpm test`) AND the in-process
// integration tests (test/, real PostgreSQL + Valkey, see vitest.int.config.ts). The chaos and
// load tests are left out: they only drive child processes, which v8 coverage does not measure
// (`test:chaos` runs them; `test:int` runs every integration file).
// Run: pnpm --filter @ebooktrivia/worker test:coverage (needs the dev stack, or TEST_PG_URL and
// TEST_VALKEY_URL).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.int.test.ts"],
    exclude: ["test/chaos.int.test.ts", "test/caddy-load.int.test.ts", "**/node_modules/**"],
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: [["text", { skipFull: false }], "json-summary"],
      thresholds: { lines: 95, statements: 95, branches: 90, functions: 90 },
    },
  },
});
