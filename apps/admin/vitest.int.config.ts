import { defineConfig } from "vitest/config";

// Integration tests against a real PostgreSQL (TEST_PG_URL, default: the DEV ONLY local stack, on
// a fresh migrated database): Better Auth flows, throttle, sessions, audit, CLI. Not matched by
// the root vitest.config.ts. Run: pnpm --filter @ebooktrivia/admin test:int
export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
