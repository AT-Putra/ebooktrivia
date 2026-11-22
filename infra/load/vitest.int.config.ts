import { defineConfig } from "vitest/config";

// Integration tests of the seed tool, the cleanup and the AC-P8 verifier against a real PostgreSQL
// (TEST_PG_URL, default: the DEV ONLY local stack). Deliberately NOT matched by the root
// vitest.config.ts. Run: pnpm --filter @ebooktrivia/load test:int
export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
