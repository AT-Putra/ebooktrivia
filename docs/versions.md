# Verified dependency versions

Re-verified against the npm registry on **2026-11-10** (`npm view <pkg> version`).
`.npmrc` sets `save-exact=true`, so every install pins these exact versions (no `^`/`~`).
Re-verify before adding a package in a later milestone; bump this table in the same commit.

| Package | Version | Where pinned / planned |
|---|---|---|
| pnpm | 12.18.0 | root `packageManager` (native binary; install with `npm i -g pnpm@12.18.0 --allow-scripts=pnpm`) |
| Node.js | 26.13.0 (`.nvmrc`), engines `>=26.12.0 <27` | root |
| typescript (TS 7, `tsc`) | 7.0.2 | root alias `ts7` → provides `tsc` |
| @typescript/typescript6 (TS 6 API) | 6.0.2 | root alias `typescript` (for typescript-eslint, Next.js, drizzle-kit; see docs/spikes/R1.md) |
| eslint / @eslint/js | 10.14.0 / 10.0.1 | root |
| typescript-eslint | 8.72.2 | root (peer `typescript <6.1.0`) |
| vitest / @vitest/coverage-v8 | 5.1.0 / 5.1.0 | root |
| tsx | 4.23.15 | root |
| globals | 17.14.0 | root |
| @types/node | 26.6.6 | root |
| next | 16.4.6 | apps/public, apps/admin (M0b/M5/M6) |
| react / react-dom | 19.3.1 | apps (M0b) |
| tailwindcss | 4.3.5 | packages/ui (M1) |
| drizzle-orm / drizzle-kit | 0.45.4 / 0.31.11 | packages/db (M0b spike, M2) |
| postgres (driver) | 4.1.0 | packages/db (M2) |
| bullmq / ioredis | 6.7.3 / 6.0.0 | apps/worker (M3) |
| better-auth | 1.7.19 | apps/admin, apps/public (M0d spike, M5a, M9) |
| zod | 4.6.7 | packages/core (M2) |
| @cap.js/server / @cap.js/widget | 4.0.5 / 0.1.62 | adapters / sdk (M3, M6) |
| altcha-lib | 2.8.0 | adapters fallback (M3) |
| nodemailer | 10.5.0 | adapters (M3) |
| pino | 10.4.0 | apps (M3) |
| @sentry/nextjs | 11.11.0 | apps → GlitchTip (M4) |
| @node-rs/argon2 | 2.2.2 | admin auth (M5a) |
| exceljs / papaparse | 4.4.0 / 5.7.0 | question import (M5b) |
| sharp | 0.35.5 | assets + uploads (M1, M2) |
| next-intl | 4.14.9 | apps (M6/M9) |
| @playwright/test | 1.65.0 | e2e (M1c) |
| hono / @hono/node-server | 4.13.17 / 2.1.6 | infra/waha-mock, infra/midtrans-stub (M0c) |

### Container images (dev stack, M0c)
| Image | Version | Notes |
|---|---|---|
| postgres | 18.6 | built as `infra/images/postgres-walg` |
| wal-g | v3.0.9 | asset `wal-g-pg-24.04-amd64.tar.gz`, sha256 `444ce216230c254edef803e098a59a1746806da3e0d55671d7b0f0082db14ef4` (verified at build) |
| valkey/valkey | 9.1.3 | ACL users public/worker/admin (`-@dangerous -@admin`), ops (`+ping`) |
| axllent/mailpit | v1.33.1 | dev SMTP sink |
| node | 26-slim | stub containers (Node built-in type stripping; dev-only, installs not lockfile-locked) |

## Tooling decisions recorded during M0a
- **turbo removed.** `turbo run` could not spawn the npm-shimmed pnpm on Windows. Workspace scripts run through `pnpm -r`, which already runs packages in topological order. Turbo can come back later if build caching is needed.
- **GitHub Actions are pinned to commit SHAs** (latest releases on 2026-11-10): actions/checkout v7.0.1, actions/setup-node v7.1.0, gitleaks/gitleaks-action v3.0.0, google/osv-scanner-action v2.7.0.

## packages/ui (US-006, M1a) — verified 2026-11-11 (`npm view <pkg> version`)
| Package | Version | Notes |
|---|---|---|
| tailwindcss | 4.3.5 | `@theme` semantic tokens in `packages/ui/src/tokens.css` |
| tw-animate-css | 1.4.0 | enter/exit animation utilities used by dialog/tooltip |
| shadcn (CLI) | 4.23.0 | devDependency; `packages/ui/components.json` (new-york, Tailwind 4, no config file). Components are hand-adapted to `on-*` token names instead of shadcn's `*-foreground` |
| radix-ui (unified package) | 1.8.1 | provides Dialog, Tooltip, Tabs, Label, Slot used by shadcn components |
| @phosphor-icons/react | 2.1.10 | only icon library; no emoji icons |
| class-variance-authority | 0.7.1 | |
| clsx | 2.1.1 | |
| tailwind-merge | 3.7.0 | |
| react / react-dom | 19.3.1 | as in apps |
| @types/react / @types/react-dom | 19.3.0 | as in apps/public |

## tools/assets (US-007, M1b) — verified 2026-11-11
| Package | Version | Notes |
|---|---|---|
| sharp | 0.35.5 | `tools/assets` (`@ebooktrivia/assets-tools`): raw PNG to AVIF + WebP at 1x/2x |

## Assets
- **Model / endpoint:** `cx/gpt-image-2.6-flare` via the local 9router, `POST http://localhost:20128/v1/images/generations` (`Authorization: Bearer <key>`). The key lives in the Windows user environment variable `9router`. Git Bash does not pass digit-leading names to Node, so `tools/assets/src/key.ts` falls back to `reg query HKCU\Environment /v 9router`. The key is never logged or written.
- **Style statement (prepended to every prompt, see `tools/assets/prompts.json`):** premium playful 3D-rendered cartoon illustration, soft clay-like shapes, gentle rim lighting; quiz blue `#2563EB` + violet `#7C3AED` + gold `#F59E0B` on a light `#EFF6FF` background; no text, letters, logos, real people or brands; all-ages safe.
- **Actual sizes:** the model returns its own dimensions (a 1024x1024 request returned 1254x1254), so `optimize.ts` reads real dimensions with sharp. 2x = raw size, 1x = half.
- **Transparent overlays:** requested with `background: "transparent"` + `output_format: "png"`; the endpoint honours it, so alpha is preserved into AVIF/WebP.
- **Regenerate:** `pnpm assets` (generate then optimize). Raw PNGs go to `tools/assets/raw/` (gitignored) and existing ones are skipped. Use `pnpm --filter @ebooktrivia/assets-tools run assets:generate -- --force [asset-id ...]` to redo specific assets, then `pnpm --filter @ebooktrivia/assets-tools run assets:optimize`.
- **Output:** `packages/ui/assets/<stem>/<stem>@{1,2}x.{avif,webp}` plus `packages/ui/assets/manifest.json` (sha256, prompt, model, generatedAt). `tools/assets/src/manifest.test.ts` verifies it offline.
