import { defineConfig } from "vitest/config";

// Integration tests against a real PostgreSQL (TEST_PG_URL, default: the DEV ONLY local stack),
// on a fresh database migrated by @ebooktrivia/db. Not matched by the root vitest.config.ts.
// Run: pnpm --filter @ebooktrivia/crypto test:int
export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
