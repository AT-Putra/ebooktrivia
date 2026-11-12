import { defineConfig } from "vitest/config";

// Coverage gate for the adapters (plan M3). Root `pnpm test` runs the same files through
// the root config; this config adds thresholds.
// Run: pnpm --filter @ebooktrivia/adapters test:coverage
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: [["text", { skipFull: false }], "json-summary"],
      thresholds: { lines: 95, statements: 95, branches: 90, functions: 90 },
    },
  },
});
