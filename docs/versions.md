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
| bullmq / ioredis | 6.7.5 / 6.0.0 | apps/worker (M3; see the US-013 section) |
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
| valkey/valkey | 9.1.3 | ACL users public/worker/admin (`-@dangerous -@admin`; worker also `+info`, US-013), ops (`+ping`) |
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

## apps/worker (US-013, M3b) - verified 2026-11-12 (`npm view <pkg> version`)
| Package | Version | Notes |
|---|---|---|
| bullmq | 6.7.5 | npm `latest` (published 2026-11-11T21:25Z). Younger than pnpm's minimum release age, so pnpm added it to `minimumReleaseAgeExclude` in pnpm-workspace.yaml. Its optional native decoder `msgpackr-extract` 3.0.7 is listed `false` in `allowBuilds` (no install script; msgpackr falls back to pure JS). Optional peers pg / redis / bullmq-otel unused (Redis backend only) |
| ioredis | 6.0.0 | npm `latest`; BullMQ 6's peer, also the worker's Valkey health PING |
| hono / @hono/node-server | 4.13.17 / 2.1.6 | internal process HTTP server (same pins as the stubs) |
| pino | 10.4.0 | JSON logs with key-based redaction at any depth (apps/worker/src/log.ts) |
| postgres | 4.1.0 | same pin as packages/db |

Valkey ACL (infra/dev/valkey/users.acl): the `worker` user needs `+info`. BullMQ and ioredis run INFO on connect (version / eviction-policy check and ready check) and fail with NOPERM without it; verified against the real ACL. FLUSHALL stays denied (`-@dangerous`), so the Valkey-loss chaos test runs a throwaway ACL-less Valkey container. M4: the production ACL needs the same `+info` for `worker`.

Worker gates: `pnpm --filter @ebooktrivia/worker test:coverage` (unit + in-process integration tests, needs PostgreSQL and Valkey; lines/statements >= 95 %, branches/functions >= 90 %) and `test:chaos` (the chaos tests with real worker processes and the /caddy/ask load test; needs Docker for the throwaway Valkey); both run in the CI db-integration job. `test:int` runs every integration file locally.

## Staging VM, quadlets, Caddy (US-014, M4a) - verified 2026-11-13
| Component | Version | Notes |
|---|---|---|
| AlmaLinux | 10.2 (Lavender Lion) | VM OS. 10.3 is beta: not used. Local stand-ins: `almalinux:10.2@sha256:5a4b41a427c9717be8f4ac2a32aa22efbae5f9124fbcb79a6765394f312acfe8` (dry runs) and `almalinux/10-init@sha256:967cce22cb0e0266c5f6538cda936ed8a0f24eafd5afdcf38518818d4bf403b9` (systemd PID 1, `infra/verify/local/vm-sim`) |
| podman | 5.8.2 (AlmaLinux 10.2 AppStream, `podman-5.8.2-12.el10_2.alma.1`) | quadlets need >= 4.4; `Notify=healthy` and template drop-ins need 5.x (provision.sh refuses < 5). Networking: netavark 1.17.2, aardvark-dns 1.17.1, passt/pasta 0^20251210, crun 1.30.1, conmon 2.2.1 |
| firewalld / chrony / dnf-automatic | 2.4.3 / 4.8 / 4.20.0 | AlmaLinux 10.2 BaseOS/AppStream |
| fail2ban | 1.1.0 (`fail2ban-server`, `-firewalld`, `-selinux`) | EPEL 10 (`epel-release` 10-6 from AlmaLinux extras) |
| container-selinux | 2.248.0 | |
| caddy | 2.11.9, `docker.io/library/caddy:2.11.9@sha256:e40b94d0a43b5ff69cb20568d73f10c70703df7b0ffc2298eb3d723cdc9d0bd1` | socket-activated (`bind fd/3`, `fd/4`, Caddy >= 2.9) |
| valkey/valkey | 9.1.3, `@sha256:3add1a336a920ea54770a001ab6feb3da5fceea96a40373a3a2cd469b815f0b7` | production ACL in `infra/provision/files/valkey/` |
| node (app images) | 26.13.0, `docker.io/library/node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072` | `infra/images/app/Containerfile` (public, admin, worker). Same as `.nvmrc`; the image was published 2026-11-05 |
| postgres-walg | postgres 18.6 + wal-g v3.0.9 | `infra/images/postgres-walg`, built on the VM as `localhost/ebooktrivia/postgres-walg:18.6` |
| koalaman/shellcheck | v0.11.0 | `infra/verify/local/shellcheck.sh`, CI job `infra` |
| ghcr.io/letsencrypt/pebble | 2.10.2 | local ACME test CA in `infra/verify/local/stack-sim.sh` only (2.10.3, published 2026-11-11, is newer; the older one is used) |
| docker.io/curlimages/curl | 8.17.0 | test client containers in `stack-sim.sh` only |

New workspace packages: `@ebooktrivia/edge` (`packages/edge`: the apps' HTTP listener, /livez + drain, trusted-proxy X-Forwarded-For; no dependencies) and `@ebooktrivia/infra-verify` (`infra/verify`: Caddy JSON and quadlet consistency tests). No new npm dependency.

### US-014 review fixes - verified 2026-11-13
| Component | Version | Notes |
|---|---|---|
| podman (dry run) | `podman-5.8.2-12.el10_2.alma.1` | `infra/verify/local/quadlet-dryrun.sh` installs exactly this build and fails on another |
| pnpm in the app images | 12.18.0, `@pnpm/exe.linux-x64` tarball sha512 `389f97db072b6a5742c23ef9a4221ead601141246975f8f47814ecff6383ca17de5b8eb294e9e34c813f18aadae8c9fa13bdbf8019974bc8a0ad48a86be17d7d` (registry `dist.integrity`) | `infra/images/app/Containerfile` checks it with `sha512sum -c` before using the binary; npm no longer installs pnpm there |
| postgres (base of postgres-walg) | 18.6, `docker.io/library/postgres:18.6@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722` | every `FROM` in `infra/**/{Containerfile,Dockerfile}` is now pinned by digest (checked by `infra/verify/src/quadlets.test.ts`) |
| node (dev stubs) | 26.13.0, same digest as the app images | `infra/waha-mock`, `infra/midtrans-stub` (were `node:26-slim`). `node:26-slim` now resolves to 26.13.1: bump `.nvmrc` and every pin together in a later change |
| nftables / audit | AlmaLinux 10.2 BaseOS | egress guard (`ebt-egress-guard.service`), `ausearch` for host-check |

## apps/admin auth (US-016, M5a-1) - verified 2026-11-18 (`npm view <pkg> time`)
No package outside this file or the plan. Added to apps/admin: better-auth, @node-rs/argon2, drizzle-orm, postgres and `@ebooktrivia/db` (workspace). Added to e2e: postgres and `@ebooktrivia/db`, for the test database.
| Package | Version | Notes |
|---|---|---|
| better-auth | 1.7.19 | Kept at the pin, the version spike R13 and `packages/db` verified. npm `latest` is 1.7.25 (2026-11-14). Every release after 1.7.18 (2026-11-05) is younger than the 2-week age gate, so the bump is due once 1.7.25 has aged (re-run R13's gated tests and `test/better-auth.int.test.ts` then). Used through `auth.api` only, with the HTTP handler not mounted: drizzle adapter, `twoFactor` (TOTP, account lockout 5 / 15 min, backup codes disabled), `useSecureCookies: false` + `__Host-` names (R13 recipe B), session 12 h with refresh disabled |
| @node-rs/argon2 | 2.2.2 | npm `latest` (2026-10-06). argon2id m=19456 KiB, t=2, p=1 (the package default algorithm; the `Algorithm` const enum cannot be imported under isolatedModules, so a test asserts `$argon2id$`). Prebuilt per-platform bindings (optionalDependencies), no install script. `serverExternalPackages` in next.config.ts; traced into the standalone output |
| drizzle-orm / postgres | 0.45.4 / 4.1.0 | same pins as packages/db; one postgres.js pool per app process, drizzle only for Better Auth's adapter |
| @playwright/test | 1.65.0 | unchanged. npm `latest` is 1.65.1 (2026-11-13, under the age gate) |
| next | 16.4.6 | unchanged (npm `latest`). `experimental.authInterrupts` is turned on for `forbidden()` (403); the e2e suite asserts the status, so a behaviour change on upgrade fails it |
| uqr | 0.1.3 | npm `latest`, published 2026-04-03 (past the 2-week gate), MIT, no dependencies. Owner-approved (US-016 review D2). Renders the TOTP setup QR code as SVG on the server (`lib/auth/service.ts` totpQrDataUrl), shown as a `data:` image beside the text key |

### US-016 review fixes - verified 2026-11-19
- **better-auth versioned secrets:** `secrets: [{version, value}]` (1.7.19), from `ADMIN_AUTH_SECRETS="2:<new>,1:<old>"`, so rotation keeps enrolled TOTP secrets (runbook `docs/runbooks/admin-access.md`).
- **pnpm overrides** (pnpm-workspace.yaml): `better-auth>vitest`, `better-auth>drizzle-kit` and `next>@playwright/test` are removed (`"-"`). They are optional peers (test and CLI integrations), which pnpm resolved from other workspace packages, so the admin-cli production image carried vitest, drizzle-kit, esbuild and picomatch. No package version changed (lockfile compared before and after). `resolvePeersFromWorkspaceRoot: false` / `dedupePeerDependents: false` were tried first: they do not re-resolve an existing lockfile, so they were not kept.
- **`@ebooktrivia/test-support`** (tools/test-support, workspace, test code only): the throwaway-database helper and the RFC 6238 TOTP generator shared by apps/admin integration tests and the e2e suite. No new package.

Admin gates: `pnpm --filter @ebooktrivia/admin test:int` (needs PostgreSQL: Better Auth flows, lockout, sessions, audit, CLI) and the Playwright spec `e2e/tests/admin-auth.spec.ts` (builds and starts its own `next start` on port 3202 with a throwaway database).

## apps/admin settings (US-017, M5a-2) - verified 2026-11-19 (`npm view <pkg> time`)
| Package | Version | Notes |
|---|---|---|
| tldts | 7.4.19 | Owner-approved 2026-11-19. MIT. Published 2026-10-20 (past the 2-week gate); npm `latest` is 7.5.4 (2026-11-15, under the gate). Registrable-domain (eTLD+1, Public Suffix List incl. private suffixes) check of landing-page domains (`apps/admin/src/lib/settings/lp-domains.ts`). Its one dependency `tldts-core` is pinned to the same 7.4.19 by a pnpm override (`tldts>tldts-core`), since `^7.4.19` would resolve to a release under the age gate. `tldts-core@7.4.20` in the lockfile is lighthouse's (e2e only, pre-existing) and is marked deprecated upstream ("partial release"); 7.4.19 is not |

Workspace dependencies added (no new third-party package): apps/admin gets `@ebooktrivia/core` (host normalisation, templates, phone, money), `@ebooktrivia/crypto` (the public-key-only sealer), `@ebooktrivia/adapters` (only the `./address-policy` subpath, which loads no undici / nodemailer) and `@ebooktrivia/uploads` (PDF policy); apps/worker gets `@ebooktrivia/crypto` (the messaging opener for template test-sends). `normalizeHost` moved from apps/worker to packages/core so the Caddy `ask` check and LP domain registration share one rule.

Admin gates now also cover the settings: `apps/admin/test/settings.int.test.ts` and `e2e/tests/admin-settings.spec.ts` (its own `next start` on port 3203, DOMAIN `example.test`, a temporary ADMIN_DATA_DIR and per-run public sealing keys).

## apps/admin trivia content, prizes, legal pages, limits (US-018, M5b) - verified 2026-11-20 (`npm view <pkg> time`)
| Package | Version | Notes |
|---|---|---|
| exceljs | 4.4.0 | Planned for M5b (plan version pins); already in the lockfile as a devDependency of packages/uploads, now a runtime dependency of apps/admin. Reads the first worksheet of an imported XLSX, and only the canonical archive `inspectZip` returns (`apps/admin/src/lib/settings/trivia-import.ts`). Bundled into the admin server build. Its transitive `uuid` 8.3.2 is the one pnpm audit flags (2026-11-12 note above); the M4 audit gate carry-over now covers a production path |
| papaparse | 5.7.0 | Planned for M5b. Published 2026-08-24; 5.7.1 (2026-11-11) is under the 2-week gate, so 5.7.0 is pinned. Parses imported CSV (delimiter detection). No types ship with it and `@types/papaparse` is not added: `apps/admin/src/types/papaparse.d.ts` declares the one call used |
| fast-check | 4.10.2 (devDependency) | Same pin as packages/core (US-010 section above). Test-only: `apps/admin/test/rescore-oracle.int.test.ts` checks that SQL `public.score_answer` equals core `scoreAnswer` on random rules and answer facts |

apps/admin now also loads the full `@ebooktrivia/uploads` entry (sharp 0.35.5, unchanged pin) in two modules only, `lib/settings/images.ts` (image re-encode) and `lib/settings/trivia-import.ts` (CSV / XLSX policy); `src/app/guards.test.ts` pins that list. Next.js keeps sharp external and traces its platform binary into the standalone output.

Admin gates now also cover trivia content: `apps/admin/test/trivia.int.test.ts`, `packages/db/test/trivia-override.int.test.ts` and `e2e/tests/admin-trivia.spec.ts` (its own `next start` on port 3204, a temporary ADMIN_DATA_DIR).

## packages/sdk (US-019, M6a) - verified 2026-11-20 (`npm view <pkg> time`)
| Package | Version | Notes |
|---|---|---|
| esbuild | 0.28.2 | devDependency of packages/sdk. Owner decision 2026-11-20; already in the lockfile (vite) and listed in `allowBuilds`. Bundles the SDK into one minified IIFE for ES2020 (`packages/sdk/scripts/build.ts`): no eval, no dynamic code, no source maps. The build fails on any esbuild warning. Linux (the image build) and Windows produce a byte-identical file |
| @cap.js/widget | 0.1.62 | devDependency of packages/sdk; the Cap widget the SDK loads lazily (pairs with `@cap.js/server` 4.0.5 in packages/adapters: `e2e/tests/sdk.spec.ts` has the real widget solve a real challenge from that server library). Owner decision 2026-11-20: published 2026-11-09, inside the 2-week window, so `@cap.js/widget@0.1.62` is in `minimumReleaseAgeExclude` (pnpm-workspace.yaml); 0.1.63 (2026-11-12) is also under the gate. Not bundled: the build copies the package's unmodified `cap.min.js` to `dist/cap-v0.1.62.js`, served next to the SDK under that versioned name (no CDN) |
| @cap.js/wasm | 0.0.8 | devDependency of packages/sdk. Owner-approved 2026-11-20. Apache-2.0. Published 2026-09-23 (past the 2-week gate, so no `minimumReleaseAgeExclude` entry); the exact version `@cap.js/widget` 0.1.62 asks for (`WASM_VERSION` in its source; `packages/sdk/src/build.test.ts` checks the two agree). Not bundled: the build copies `browser/cap_wasm_bg.wasm` (22.6 KB, the SHA-256 proof-of-work solver this Cap server issues) and `browser/hashwx.wasm` (12.5 KB, the solver of the `hashwx` challenge protocol that newer Cap servers can issue; `@cap.js/server` 4.0.5 never does) unmodified to `dist/cap-wasm-v0.0.8.wasm` and `dist/cap-hashwx-v0.0.8.wasm`, served next to the SDK (immutable cache, CORS `*`). Without them the widget fetches the wasm from jsdelivr; the SDK points it at these files instead, so no request leaves `api.<DOMAIN>`. Outside the SDK's 15 KB budget (loaded on demand) |

Workspace dependencies added (the third-party packages of this section are the three rows above): packages/sdk gets `@ebooktrivia/core` (`./phone` and the new `./sdk-contract` subpath, both import-free so nothing from node:* reaches the bundle) and `@ebooktrivia/i18n` (only the `sdk` section of `id.json`, tree-shaken); e2e gets `@ebooktrivia/sdk` (its build), `@ebooktrivia/core` and `@ebooktrivia/adapters` (the real Cap server library in the stub API).

SDK gates: `packages/sdk/src/*.test.ts` (attribution, redirect guard, validation, API client, pixels, Cap loader, checkout flow, boot, legal links, build output and the gzip size budget), `e2e/tests/sdk.spec.ts` (`pnpm --filter @ebooktrivia/e2e test:sdk`, ephemeral ports, no Next.js build needed; the main Playwright run in CI picks it up too), `infra/verify/src/caddyfile.test.ts` and `infra/verify/local/sdk-headers.sh` (the SDK route in a real Caddy 2.11.9).

## apps/public (US-020, M6b) - verified 2026-11-20 (`npm view <pkg> time`)
No package outside this file or the plan: the three third-party packages are pins already listed above, now also declared by apps/public. pnpm-lock.yaml changes only in the apps/public importer block (no new package, no new version).
| Package | Version | Notes |
|---|---|---|
| ioredis | 6.0.0 | same pin as apps/worker (npm `latest`, published 2026-07-31). The checkout's Valkey client as the ACL user `public`: `enableOfflineQueue: false`, `maxRetriesPerRequest: 0`, 1 s `commandTimeout` (fail closed: 503 while Valkey is down), `enableReadyCheck: false` and `disableClientInfo: true`: no INFO and no `CLIENT SETINFO` on connect (the explicit `connect()` at start-up is the gate), so the `public` ACL below needs neither |
| zod | 4.6.7 | plan pin (npm `latest`, published 2026-10-12; already in the lockfile through better-call). Validates the checkout request server-side against `SDK_LIMITS` / `SDK_PATTERNS` of `@ebooktrivia/core/sdk-contract` (apps/public/src/lib/checkout/request.ts) |
| postgres | 4.1.0 | same pin as packages/db (npm `latest` is 4.1.1, published 2026-11-11; kept equal so the lockfile holds one copy). One pool as the public_rw login (`DATABASE_URL_PUBLIC`) |

Workspace dependencies added: `@ebooktrivia/core`, `@ebooktrivia/adapters` (Snap create, the Cap provider, safe-fetch), `@ebooktrivia/crypto` (opens the sealed Midtrans server key with the payment private key) and `@ebooktrivia/db`; devDependencies `@ebooktrivia/test-support` (test database) and `@ebooktrivia/midtrans-stub` (its Hono app, in-process, for `test:int`).

Valkey ACL of `public` (infra/dev/valkey/users.acl and infra/provision/files/valkey/users.acl.template, the same line apart from the password): keys `~rl:* ~cache:public:*` only, no channels, and an explicit command allowlist instead of `+@all`: `-@all +ping +eval +incr +pttl +pexpire +set` (no `+info`: the client has no ready check; the US-020 review made INFO denied for `public`). `+eval` for the rate-limit script, whose `redis.call`s are ACL-checked too (`INCR`, `PTTL`, `PEXPIRE`; plain EVAL, no EVALSHA or SCRIPT LOAD); `SET` (NX PX) for the single-use marks of Cap tokens (Cap is stateless: challenges and redeems store nothing); `PING` for health. Everything else (INFO, GET, GETDEL, DEL, EXISTS, SCAN, KEYS, SCRIPT, FUNCTION, CONFIG, FLUSHALL, pub/sub) is NOPERM. US-026 (player OTP auth on the same user) needed nothing more (below). US-031 replaced `+eval` with `+fcall` (section "Security hardening" below).

Public gates: `pnpm --filter @ebooktrivia/public test:int` (PostgreSQL as a public_rw login, Valkey as `public` under the dev ACL, midtrans-stub in-process; CI db-integration job) and the apps/public `next build`.

## apps/public player login (US-026, M9a) - 2026-11-21
No new package. Added to apps/public: `better-auth` 1.7.19 and `drizzle-orm` 0.45.4 (the pins apps/admin and packages/db already use; the lockfile gained importer entries only) for the Better Auth player instance, and `@ebooktrivia/sdk` (workspace) for its headless Cap solver module (`@ebooktrivia/sdk/cap`). `apps/public/scripts/sync-cap-assets.mjs` copies the SDK's pinned `@cap.js/widget` 0.1.62 and `@cap.js/wasm` 0.0.8 files, unmodified, to `apps/public/public/cap/` (gitignored), so the login page solves Cap with no CDN. Added to e2e: `@ebooktrivia/crypto` (workspace), to open the sealed OTP as the worker would.

Valkey ACL of `public`: unchanged. The player login keeps nothing in Valkey but its rate-limit counters (`rl:otp:*`, `rl:captcha:play:*`, through the existing EVAL script) and the single-use Cap token marks (`cache:public:cap:t:*`, SET NX PX). Better Auth runs without secondary storage and without its own rate limiter.

## Security hardening (US-031, M11a) - verified 2026-11-22 (GitHub releases pages, `docker buildx imagetools inspect`)
No new npm package. Scan tools run from their official images through Docker (Owner decision 2026-11-22: nothing installed on Windows), each the latest stable release at least 14 days old, pinned by digest:
| Tool | Image | Notes |
|---|---|---|
| gitleaks | 8.30.1, `ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f` | `infra/verify/local/security-scan.sh`; CI's gitleaks-action v3.0.0 now gets `GITLEAKS_VERSION: 8.30.1` (its default was 8.24.3). Config `.gitleaks.toml` |
| OSV-Scanner | 2.7.0, `ghcr.io/google/osv-scanner:v2.7.0@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0` | the same release as CI's osv-scanner-action v2.7.0 (2.7.1, 2026-11-09, was under the age gate). Config `osv-scanner.toml` (2 reviewed overrides pinned to package name and version, `effectiveUntil` 2027-02-22) |
| ZAP | 2.17.0, `ghcr.io/zaproxy/zaproxy:2.17.0@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af` | released 2025-12-15 (the weekly builds are pre-releases); equal to the `stable` tag on 2026-11-22. `infra/verify/staging/zap-*.sh` (staging only) |
| caddy | 2.11.9 (unchanged pin) | `infra/verify/local/security-headers.sh` (CI job edge-smoke) |

pnpm override (pnpm-workspace.yaml, lead-approved 2026-11-22): `exceljs>uuid: "11.1.1"`, scoped to exceljs. OSV GHSA-w5hq-g745-h8pq (GitHub severity: moderate): uuid 8.3.2's v3/v5/v6 do not bounds-check a caller's buffer. exceljs 4.4.0 only calls `v4()` without a buffer (not reachable), but 11.1.1 (2026-04-29) is fixed and still CommonJS with the same `{v4}` export (checked by a `require` through the exceljs path); the uploads and admin XLSX tests pass on it. The lockfile changed for uuid only.

Valkey ACL of `public` (US-031, lead-approved): `+eval` is replaced by `+fcall` (dev and production lines identical in grants: `-@all +ping +fcall +incr +pttl +pexpire +set`). The rate-limit script is now the worker-loaded FUNCTION library `ebt_public` (`ebt_rate_limit_v1`, `packages/adapters/src/valkey-functions.ts`; logic unchanged): FUNCTION LOAD is `@write @slow @scripting` in Valkey 9.1.3, so the existing worker grant can load it. New workspace subpaths: `@ebooktrivia/adapters/valkey-functions` (import-free) and `@ebooktrivia/test-support/valkey` (raw RESP loader for tests). docs/runbooks/security-scans.md section 4 has the start order and the naming rule.

Common-password list (ASVS V6.2.4, no new package): `apps/admin/src/lib/auth/common-passwords.ts`, generated from SecLists `Passwords/Common-Credentials/Pwdb_top-1000000.txt` at commit `913b327317496d062bcc7cace524aaad8a693be2` (file sha256 `e9a88f67aafe65496682dc374559ee714e978bee50314767494c3e37a18c9fc8`), MIT licence (Daniel Miessler; the full notice is in the file's header). Why that file: the admin minimum is 12 characters, and SecLists' `10k-most-common.txt` holds only 10 entries that long. To regenerate: download that file at that commit, check its sha256, then keep, in file order, each line (trailing CR removed) of 12 to 128 printable ASCII characters that neither starts nor ends with a space, lowercased, first occurrence only, until 10,000 are kept; write them as `export const COMMON_PASSWORDS: readonly string[] = [...]` under the same header. `password-policy.test.ts` checks the count, uniqueness, case and length.

Breached-password check (ASVS V6.2.12, Owner decisions 2026-11-22: add HIBP; run it in the worker; no new package): Have I Been Pwned's Pwned Passwords range API, `GET https://api.pwnedpasswords.com/range/<first 5 hex of SHA-1>` with `Add-Padding: true` (k-anonymity; no API key). Client: `@ebooktrivia/adapters/pwned-passwords` (new subpath; takes the SHA-1, safe-fetch, 3 s timeout, 256 KiB body cap, never throws). The console (no egress) seals the password's SHA-1 to the messaging key (`@ebooktrivia/crypto` sealPasswordCheck / openPasswordCheck, AAD bound to the check id and the admin id) into an `admin.password_hibp_check` outbox job; the worker opens it, looks it up (6 tries with the outbox backoff, then fails open) and flags a breached password (`flag_breached_admin_password`, migration 0023 `admin_profiles.password_check_id` / `password_breached_at`): the admin must change it at the next sign-in. The tests fake the API; CI never calls it. docs/runbooks/security-scans.md section 6.

## Load tests (US-032, M11b) - verified 2026-11-22 (GitHub releases of grafana/k6)
No npm package: `infra/load` (workspace `@ebooktrivia/load`) only links existing workspace packages and `postgres` 4.1.0. The lockfile gains its importer block, nothing else. Nothing is installed on a developer or load machine but Docker (or Podman) and Node.
| Tool | Version | Notes |
|---|---|---|
| k6 (official image) | v2.3.0, released 2026-09-21 | `docker.io/grafana/k6@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8` (the multi-arch index digest of `grafana/k6:2.3.0`), pinned in `infra/load/run.sh`. The newest stable release of the v2 line that is at least 14 days old (Owner-approved by the lead 2026-11-22). Newer: v2.4.0 (2026-11-12) and v1.8.3 (2026-11-13) are inside the 14 days; v1.8.2 (2026-10-12) belongs to the v1 maintenance line. The scripts use only `k6/http`, `k6/data`, `k6/metrics`, `k6/execution` and `k6`; no remote `jslib` import, so the run needs no network but the target. Bump: check the releases page, keep the 14-day rule, change `K6_VERSION` and `K6_IMAGE` together |

## CI/CD, backups, monitoring (US-015, M4b) - verified 2026-11-22 (GitHub and GitLab releases, Docker Hub tags, `docker buildx imagetools inspect`)
No npm package except `ioredis` 6.0.0 added to `apps/admin` (the version `apps/public` and `apps/worker` already pin; the lockfile gained that importer entry only), for the console's `/healthz` Valkey PING. Every other tool runs from its official image or from the AlmaLinux / GitHub-hosted runner it already ships on. Each version below is the latest stable release at least 14 days old on 2026-11-22; a newer one exists where noted.
| Tool | Version, digest | Notes |
|---|---|---|
| wal-g | v3.0.9 (unchanged pin, `infra/images/postgres-walg`) | The shipped binary's client-side libsodium encryption works (checked: stored WAL holds no plaintext; another key gives `corrupted chunk`); `wal-verify integrity` is part of the nightly job |
| restic | 0.19.1, `docker.io/restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510` | v0.19.1 was released 2026-07-05. **v0.20.0 (2026-11-19) is 3 days old**: take it after 2026-12-03 |
| Uptime Kuma | 2.5.9, `docker.io/louislam/uptime-kuma:2.5.9@sha256:e88415a90dd2f7efecdbc18de0490aff292764a3ac471531bf1d0481725591bd` | Released 2026-10-31. 2.5.10 to 2.5.12 (2026-11-12 to 2026-11-17) are younger than 14 days; 3.0.0-beta.1 is a pre-release |
| GlitchTip | 6.2.6, `docker.io/glitchtip/glitchtip:6.2.6@sha256:a3d8eb1b36c1e1603d55ab32711ea3dd8115874742a781a57391a62a16e0dff6` | Image built 2026-08-08. **7.0.0 was released 2026-11-09 (13 days old on 2026-11-22)**: a major version, take it after its 14 days and the release's upgrade notes |
| PostgreSQL (GlitchTip's own) | 18.6, `docker.io/library/postgres:18.6@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722` | The digest the app's own database image is built on |
| CNCF distribution registry (**test fixture only**) | v3.1.2 (released 2026-09-24), `docker.io/library/registry:3.1.2@sha256:82f6ff4a7f982960c8aa51617fea3aabc485df6e55cce80d22deb1de36f1bc3c` | Owner-approved 2026-11-22 for the local deploy proof (`infra/verify/local/deploy-sim.sh`) only: a throwaway container on a throwaway Docker network with no published port, removed after the run. In no shipped image, quadlet or workflow |
| GitHub Actions | `actions/checkout` v7.0.1 (`3d3c42e5aac5ba805825da76410c181273ba90b1`, unchanged) | `deploy.yml` uses no other third-party action: it logs in to GHCR with `docker login` and builds with the runner's own Docker |
| GHCR | `ghcr.io/<owner>/<repo>/<component>@sha256:<digest>` | Five components: `public`, `admin`, `admin-cli`, `worker`, `postgres-walg`. The migrate job and the internal process run the `worker` image |

Not added: MinIO or any local S3 (the local wal-g proof uses wal-g's FILE storage backend and a local restic repository), actionlint, a log shipper, a Kuma API client. Uptime Kuma 2.x has no supported configuration-as-code import, so the monitors are created by hand from `infra/monitoring/kuma/monitors.json`.
