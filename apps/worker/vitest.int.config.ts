import { defineConfig } from "vitest/config";

// Integration and chaos tests against a real PostgreSQL (TEST_PG_URL, default: the DEV ONLY local
// stack, on a fresh migrated database) and a real Valkey (TEST_VALKEY_URL, default: the DEV ONLY
// local stack with its ACL users). Worker / internal processes are real child processes.
// Not matched by the root vitest.config.ts. Run: pnpm --filter @ebooktrivia/worker test:int
export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Removes the Valkey keys of every test prefix after each file (test/support/cleanup.ts).
    setupFiles: ["test/support/cleanup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
