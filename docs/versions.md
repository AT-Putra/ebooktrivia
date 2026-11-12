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
| @playwright/test | 1.65.0 | e2e (M1c), `e2e/` |
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

## M1c mockups + accessibility gate (US-008) - verified 2026-11-11 (`npm view <pkg> version`)
| Package | Version | Where |
|---|---|---|
| @tailwindcss/postcss | 4.3.5 | apps/public, apps/admin (devDependency; same as tailwindcss) |
| postcss | 8.5.32 | apps/public, apps/admin (devDependency) |
| tailwindcss | 4.3.5 | apps/public, apps/admin (devDependency) |
| @phosphor-icons/react | 2.1.10 | apps/public, apps/admin |
| typescript | 7.0.2 | apps/admin devDependency (every Next app pins it, see docs/spikes/R1.md) |
| next / react / react-dom | 16.4.6 / 19.3.1 / 19.3.1 | apps/admin (same as apps/public) |
| @playwright/test | 1.65.0 | `e2e/` (`@ebooktrivia/e2e`); install the browser with `pnpm --filter @ebooktrivia/e2e exec playwright install chromium-headless-shell chromium` |
| @axe-core/playwright | 4.14.0 | e2e |
| lighthouse | 13.6.0 | e2e (`lighthouse.ts`, mobile form factor, Playwright Chromium) |

Mockups: set `ENABLE_MOCKUPS=1` for production starts; without it every `/mockups/*` route is 404 (checked per request). Screenshots live in `docs/mockups/`.

## packages/db (US-009, M2a) - verified 2026-11-11 (`npm view <pkg> version`)
| Package | Version | Notes |
|---|---|---|
| drizzle-orm / drizzle-kit / postgres | 0.45.4 / 0.31.11 / 4.1.0 | unchanged; npm latest equals the pin |
| better-auth | 1.7.19 (devDependency) | same pin as the R13 spike; npm `latest` is 1.7.20 (published 2026-11-10). Used only to derive and regression-check the `player_auth` / `admin_auth` DDL (`scripts/better-auth-ddl.ts`, `test/better-auth.int.test.ts`) |
| kysely | 0.28.17 (devDependency) | same as the R13 spike (Better Auth accepts `^0.28.17 \|\| ^0.29.0`); npm `latest` is 0.29.8. Kept equal to the spike so the lockfile holds one kysely |
| pg / @types/pg | 8.23.1 / 8.23.1 (devDependencies) | npm latest equals the pin; Better Auth's `PostgresDialect` driver in the DDL script and test |

## packages/core (US-010, M2b) - verified 2026-11-11 (`npm view <pkg> version`)
| Package | Version | Notes |
|---|---|---|
| fast-check | 4.10.2 (devDependency) | npm `latest`, published 2026-09-19, so well past the pnpm release-age gate; property tests for unlock, ranking, money, phone, templates, shuffle and the state machines. Pulls in pure-rand 8.4.2 |
| @ebooktrivia/db | workspace (devDependency) | only for `src/db-drift.test.ts`, which asserts core's state lists equal the DB enums |
| parse5 | 8.1.1 (devDependency) | npm `latest`, published 2026-11-07; pulls in entities 9.0.0 (2026-10-29). pnpm installed it without a release-age block. Only for `src/template-html.test.ts`, the email_html sentinel that parses every rendered template with a real HTML parser. If the 2-week age policy in docs/spikes/R13.md is meant to apply here, the fallback is parse5 8.0.1 (2026-04-19, entities ^8) |

`packages/core` has no runtime dependencies (Node's `node:crypto` only). Coverage gate: `pnpm --filter @ebooktrivia/core test:coverage` (v8; lines/statements >= 95 %, branches/functions >= 90 %), also run in CI.

## packages/crypto and packages/uploads (US-011, M2c) - verified 2026-11-12
No new runtime third-party package. Both have the same coverage gate as core (`test:coverage`, run in CI). Test-only: `exceljs` 4.4.0 (npm `latest` on 2026-11-12, the version planned for M5b) as a devDependency of uploads, to prove real exceljs output (writeBuffer and the streaming WorkbookWriter with data descriptors) passes inspectZip and that exceljs reads the canonical copy back.
| Package | Version | Notes |
|---|---|---|
| @ebooktrivia/crypto | workspace | sealed box + per-secret envelope on `node:crypto` only (X25519, HKDF-SHA256, AES-256-GCM); runtime dependency `@ebooktrivia/core` (decodeSecretKey, SecretResolver). devDependencies `@ebooktrivia/db` and `postgres` 4.1.0 for `test:int` (npm `latest` is 4.1.1; kept equal to the packages/db pin so the lockfile holds one copy) |
| @ebooktrivia/uploads | workspace | upload policy; `sharp` 0.35.5 (same pin as tools/assets; npm `latest` is 0.35.5 on 2026-11-12). ZIP inspection uses `node:zlib` (streaming `createInflateRaw`, `crc32`) instead of a ZIP library, so no fflate / yauzl |

## packages/adapters (US-012, M3a) - verified 2026-11-12
| Package | Version | Notes |
|---|---|---|
| nodemailer | 10.5.0 | npm `latest` (2026-11-10; ships its own types). SMTP adapter: connects to the address checked by the safe-fetch policy, TLS servername = configured host, requireTLS, disableFileAccess/disableUrlAccess. One plain recipient only: explicit `envelope`, `maxRecipients: 1`, accepted must equal `[to]`. nodemailer stamps every socket error/timeout/close with `command: "CONN"` at any stage, so the adapter sets `transactionLog: true` with a silent logger that only records whether `DATA` was written, and classifies maybe_sent vs failed from that |
| undici | 8.12.4 | npm `latest` (published 2026-11-05; Node 26.12 bundles 8.12.2). safe-fetch uses its `Agent` with `connect.lookup` so the address is checked at connect time, and its `fetch` with `redirect: "manual"`. undici decompresses bodies transparently, so safe-fetch returns a `SafeResponse` that reads through `maxBodyBytes` (default 1 MiB, counted on decoded bytes) and wraps body-read failures as `SafeFetchError` |
| @cap.js/server | 4.0.5 | npm `latest` (published 2025-12-14). Primary captcha: `noFSState`, storage hooks injectable (Valkey in M6). Its process `beforeExit`/SIGINT/SIGTERM/SIGQUIT handlers (they call `process.exit`) are removed after construction. Single use is also enforced by the adapter's `ReplayStore`, because Cap's read-then-delete lets concurrent validations both pass with async storage |
| altcha-lib | 2.8.0 | npm `latest` (published 2026-10-24). Fallback captcha, v2 API: PBKDF2/SHA-256, deterministic counter with key signature, `expiresAt` always set and checked by the adapter with its own clock; replay via `ReplayStore` (the library has none) |
