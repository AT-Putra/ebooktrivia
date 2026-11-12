import { defineConfig } from "vitest/config";

// Integration tests against the dev stack (Mailpit). Run: pnpm --filter @ebooktrivia/adapters test:int
export default defineConfig({ test: { include: ["test/**/*.int.test.ts"], testTimeout: 30_000 } });
