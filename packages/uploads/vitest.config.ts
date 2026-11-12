import { defineConfig } from "vitest/config";

// Coverage gate for the upload policy (plan M2.5). Root `pnpm test` runs the same files through
// the root config; this config adds thresholds.
// Run: pnpm --filter @ebooktrivia/uploads test:coverage
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
