import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/.turbo/**",
      ".omc/**",
      // Agent git worktrees (.git/info/exclude hides them from git) hold a second copy of the repo.
      ".claude/**",
      "**/*.d.ts",
      // The Cap widget, copied unmodified from @cap.js/widget for the play login page (apps/public scripts/sync-cap-assets.mjs).
      "apps/public/public/cap/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // k6 scripts (infra/load/k6) run in k6's own runtime, which provides these globals (and `open` in the init context).
    files: ["infra/load/k6/**/*.js"],
    languageOptions: { sourceType: "module", globals: { __ENV: "readonly", __VU: "readonly", __ITER: "readonly", open: "readonly" } },
  },
);
