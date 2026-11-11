import { defineConfig } from "vitest/config";

// Spike-only config. Requires the dev stack (postgres 55432, valkey 56379).
// Deliberately NOT included by the root vitest.config.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.spike.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
