import { defineConfig } from "vitest/config";

// Integration tests against a real PostgreSQL (TEST_PG_URL, default: the DEV ONLY local stack).
// Deliberately NOT matched by the root vitest.config.ts, so root `pnpm test` needs no database.
// Run: pnpm --filter @ebooktrivia/db test:int
export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // One shared, freshly migrated database per run; files run one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
