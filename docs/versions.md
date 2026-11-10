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
