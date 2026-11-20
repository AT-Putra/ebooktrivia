import { defineConfig } from "vitest/config";

// Integration tests of the public API (US-020) against a real PostgreSQL (TEST_PG_URL, default: the
// DEV ONLY local stack, on a fresh migrated database, connected as a public_rw login), a real Valkey
// (TEST_VALKEY_URL, ACL user `public` of the dev stack) and infra/midtrans-stub (its Hono app,
// in-process). Not matched by the root vitest.config.ts. Run: pnpm --filter @ebooktrivia/public test:int
export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
