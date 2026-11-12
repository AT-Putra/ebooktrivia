import { defineConfig } from "vitest/config";

// Coverage gate for the secrets crypto (plan M2.3). Root `pnpm test` runs the same files through
// the root config; this config adds thresholds.
// Run: pnpm --filter @ebooktrivia/crypto test:coverage
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: [["text", { skipFull: false }], "json-summary"],
      thresholds: { lines: 95, statements: 95, branches: 90, functions: 90 },
    },
  },
});
