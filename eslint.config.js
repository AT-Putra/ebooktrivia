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
    // The two Next.js apps bundle a copy of every library and workspace package per bundle (pages, routes, the proxy, server
    // actions, instrumentation), and their process-wide clients (the public runtime, the admin runtime: the auth instance, the
    // PostgreSQL pool, the sealer and opener, safe-fetch, the Cap store) are built by whichever bundle asks first. An error those
    // clients throw is then another copy's class, and `instanceof` is false: a wrong OTP code answered 503 and every trivia
    // refusal answered 503 on staging (2026-11-24). Check these errors by shape instead.
    files: ["apps/public/src/**/*.{ts,tsx}", "apps/admin/src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "BinaryExpression[operator='instanceof'][right.name=/^(APIError|BetterAuthError|PostgresError|CryptoError|SafeFetchError|CaptchaStoreUnavailable|WahaError|NotSentError|SmtpError|ValkeyUnavailable|SettingsUnavailable|ServerKeyUnavailable|PublicConfigError)$/]",
          message:
            "instanceof fails across Next.js bundles for errors of shared clients. Use isAPIError (better-auth/api), sqlState (@ebooktrivia/db/sql-state), isCryptoError (@ebooktrivia/crypto), isSafeFetchError (@ebooktrivia/adapters), or the public app's isValkeyUnavailable, isSettingsUnavailable, isServerKeyUnavailable, isPublicConfigError; for another class, add a check by name (and code) next to it.",
        },
        {
          selector: "BinaryExpression[operator='instanceof'][right.type='MemberExpression'][right.property.name=/^(APIError|BetterAuthError|PostgresError)$/]",
          message: "instanceof fails across Next.js bundles for errors of shared clients. Use sqlState (@ebooktrivia/db/sql-state) or isAPIError (better-auth/api).",
        },
      ],
    },
  },
  {
    // k6 scripts (infra/load/k6) run in k6's own runtime, which provides these globals (and `open` in the init context).
    files: ["infra/load/k6/**/*.js"],
    languageOptions: { sourceType: "module", globals: { __ENV: "readonly", __VU: "readonly", __ITER: "readonly", open: "readonly" } },
  },
);
