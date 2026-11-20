import { defineConfig } from "vitest/config";

export default defineConfig({
  // apps/admin's .tsx components keep tsconfig `jsx: preserve` (Next.js compiles them); a unit test
  // that renders one (e.g. the legal page preview's XSS test) needs JSX compiled for React.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: [
      "scripts/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "tools/*/src/**/*.test.ts",
      "infra/*/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
  },
});
