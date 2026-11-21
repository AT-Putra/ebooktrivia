import { defineConfig } from "vitest/config";

// Integration tests of the public API (US-020) against a real PostgreSQL (TEST_PG_URL, default: the
// DEV ONLY local stack, on a fresh migrated database, connected as a public_rw login), a real Valkey
// (TEST_VALKEY_URL, ACL user `public` of the dev stack) and infra/midtrans-stub (its Hono app,
// in-process). Not matched by the root vitest.config.ts. Run: pnpm --filter @ebooktrivia/public test:int
export default defineConfig({
  // The order page's .tsx components are rendered to markup in order.int.test.ts (tsconfig keeps
  // `jsx: preserve` for Next.js, like the root vitest.config.ts).
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
