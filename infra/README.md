# infra

The local dev stack, third-party stubs replaying recorded answers, and the VM infrastructure (staging, then
production).

| Path | What |
|---|---|
| `dev/` | Docker Compose dev stack (below) |
| `images/postgres-walg/` | PostgreSQL 18.6 + wal-g image (dev and VM) |
| `images/app/Containerfile` | App images: `public`, `admin` (Next.js standalone behind `packages/edge`) and `worker` (also runs `--role=internal` and the migrate job) |
| `provision/` | Idempotent VM provisioning (AlmaLinux 10.2): `provision.sh`, `db-roles.sh`, `build-images.sh`, `as-app.sh`, `rotate-glitchtip-token.sh`, config templates in `files/` |
| `quadlet/` | Rootless podman units: `caddy` (+ `caddy.socket`), `public@` (a, b), `admin`, `worker`, `internal`, `postgres`, `valkey`, `migrate`, four networks, four volumes |
| `deploy/remote.sh` | The forced command of the CI deploy login (US-015): a manifest of image digests, `pg_dump`, migrate (expand only), the rolling restart (worker first), health checks, automatic rollback. Installed root-owned as `/usr/local/sbin/ebt-remote-deploy` by `provision.sh` ([docs/runbooks/deploy.md](../docs/runbooks/deploy.md)) |
| `backup/` | wal-g base backup and PITR restore (`restore-pitr.sh --drill\|--disaster`: a drill never writes to production's storage), the restic secondary backup, the free-disk and `pg_wal` check (`ops-check.sh`, every 5 minutes), the timer units ([docs/runbooks/backups.md](../docs/runbooks/backups.md), [docs/escrow.md](../docs/escrow.md), [docs/restore-drill.md](../docs/restore-drill.md)) |
| `monitoring/` | Uptime Kuma and GlitchTip for the WAHA box (`compose.yaml`, `kuma/monitors.json`, `kuma-check.sh`) and the alert drill triggers (`alert-drill.sh`); [docs/runbooks/monitoring.md](../docs/runbooks/monitoring.md) |
| `caddy/Caddyfile` | The edge (`adapted.test.json` is its adaptation with test values, for `pnpm test`) |
| `verify/` | `host-check.sh` (read-only VM check), `client-ip-probe.sh`, consistency tests (`src/`), local harnesses (`local/`) |
| `load/` | k6 load tests (`trivia-500`, `orders-50pm`), their seed, Cap token pool, settlement and the AC-P8 verifier; run from another machine against staging ([load/README.md](load/README.md)) |

Staging: follow [docs/runbooks/staging-provision.md](../docs/runbooks/staging-provision.md)
(prerequisites, variables, run order, and how to verify on the VM).

## VM layout in one paragraph

- **App user.** Everything runs as the rootless podman user `ebt` (no login shell), with linger and cgroup delegation. An nftables egress guard keeps it (and every container) away from 169.254.0.0/16 and the host's own addresses.
- **Caddy.**
  - It listens on 80/443 through `caddy.socket`: socket activation in the host network namespace keeps the real client address.
  - It has a pinned address on each network it shares with an app: `10.89.50.2` (public, `ebt-edge`), `10.89.52.2` (admin, `ebt-admin`), `10.89.53.2` (internal, `ebt-internal`). That address is the only `X-Forwarded-For` source the app believes (`TRUSTED_PROXY_IP`), and each app listens on its own Caddy-facing address only (`EDGE_HOST`).
- **Networks.** `ebt-edge` (egress: Caddy, public, worker); `ebt-admin` and `ebt-internal` (internal, Caddy plus one app each); `ebt-data` (internal: PostgreSQL, Valkey and their clients; Caddy is not on it); `ebt-preflight` (internal: Caddy and the worker only, for the worker's pre-flight of a WhatsApp file send to the api site, `WORKER_API_EDGE_ADDRESS`).
- **Pinned addresses.** Every container has one. `pg_hba.conf` admits each app login to the `ebooktrivia` database only, from its own address.
- **Config files.** `/etc/ebooktrivia` belongs to root (group `ebt`, files `0640`); secrets in its `*.env` files are generated on the VM, never in the repository or a unit file. Under the app user's home only the app user writes.
- **SDK.** `/srv/sdk` holds the landing-page SDK files (`sudo infra/provision/build-images.sh sdk`): the app user writes them, Caddy mounts them read-only and serves them at `api.<DOMAIN>/sdk/`, versioned files immutable for a year and the `v1.js` alias for 5 minutes. Old versions stay (pages hold them).
- **Data.** `/srv/data/deliverables` (ebook PDFs) is read-only for public and the worker; `/srv/data/images` (the set thumbnails and prize images the Owner uploads, with their display copies) is read-only for public, which shows them to players (question images are in `question-images/`, not mounted); the rest of `/srv/data` is admin's.
- **Landing pages.** `/srv/lp` is written by admin only (US-023: `versions/<lpId>/<n>` per uploaded ZIP, `hosts/<host>/current` a symlink swapped by rename) and read by Caddy, which serves it on the registered LP domains with on-demand TLS. The worker, which holds the private keys, has no access.
- **Memory.** Limits follow the plan M4.2 budget: PostgreSQL 2 GB, Valkey 512 MB, public 2 × 700 MB, admin 600 MB, worker 600 MB, internal 120 MB, Caddy 150 MB.

## Local verification of the VM infrastructure

| Command | Proves |
|---|---|
| `infra/verify/local/shellcheck.sh` | ShellCheck v0.11.0, all severities, on every infra script (CI job `infra`) |
| `infra/verify/local/caddy-adapt.sh [--check]` | `caddy validate`, `caddy fmt`, and a regenerated (or up-to-date) `caddy/adapted.test.json` (CI) |
| `infra/verify/local/healthz-routing.sh` | the deep `/healthz` routing of the real Caddyfile in Caddy 2.11.9: the monitor's address reaches the public app with it, everyone else (and every spelling of the path) gets a 404, and play and order never route it (US-015; needs Docker; CI job `infra`) |
| `infra/verify/local/backup-pitr.sh` | wal-g point-in-time recovery with libsodium-encrypted WAL after a killed server (to a chosen timestamp and to the end of the archive), a wrong key refused, a restore DRILL that leaves production's store byte for byte unchanged, and the restic copy restored (the dump and `/srv/data`), on the real images with FILE backends (US-015; needs Docker; CI job `infra`) |
| `infra/verify/local/migration-compat.sh [REF]`, `expand-only.sh [BASE]` | the previous release's integration tests run against this checkout's schema, and the expand-only rule on new migrations (US-015; CI job `migration-compat`; needs the dev stack or the CI services) |
| `infra/verify/local/deploy-sim.sh [all\|up\|run\|down]` | the deploy and its rollbacks in the vm-sim and stack-sim containers with a throwaway registry: refusals, a normal deploy under load, a forced failure and a natural failure that roll back (US-015; run after `vm-sim.sh all` and `stack-sim.sh up`) |
| `infra/verify/local/quadlet-dryrun.sh` | the quadlet generator of `podman-5.8.2-12.el10_2.alma.1` accepts every unit (CI) |
| `infra/verify/local/sdk-headers.sh` | the `/sdk/*` block of the real Caddyfile in Caddy 2.11.9: a versioned file `public, max-age=31536000, immutable`, the `v1.js` alias 5 minutes, a missing file never cached as immutable, hidden files and path tricks refused, gzip (US-019; needs Docker) |
| `infra/verify/local/order-headers.sh` | the `order.<DOMAIN>` site of the real Caddyfile in Caddy 2.11.9: exactly one `Referrer-Policy` (strict-origin), HSTS and nosniff, no `Set-Cookie`, and an access log without the order's public id (path, Midtrans `order_id`) or a Referer (US-022; needs Docker) |
| `infra/verify/local/lp-headers.sh` | the LP site of the real Caddyfile in Caddy 2.11.9: the fixed Content-Type of each allowed extension, nosniff, the default page CSP and the SVG sandbox, 404 for anything off the allowlist (a `.php`, dot files, listings, traversal, POST, an unlinked or upper-case host), and no failed request while `current` is swapped 100 times by rename (US-023; needs Docker) |
| `infra/verify/local/edge-smoke.sh [public\|admin]` | the production server entry on a `next build`: /livez, the page, the listener address (CI job `edge-smoke`) |
| `infra/verify/local/security-headers.sh [--staging <domain> <lp-host>\|--serve]` | the full security header set per host (admin, play, order, api, SDK, LP) from the real Caddyfile in front of the real builds, against one policy (`verify/src/security-headers.ts`; CI job `edge-smoke`; US-031) |
| `infra/verify/local/security-scan.sh [all\|secrets\|deps]` | gitleaks 8.30.1 over the full history and the working tree, OSV-Scanner 2.7.0 over `pnpm-lock.yaml`, both from pinned official images (US-031) |
| `infra/verify/staging/zap-baseline.sh`, `zap-auth.sh` | ZAP 2.17.0 baseline and authenticated scans, STAGING ONLY (`--local` dry run of the baseline); fail on any High, and an authenticated scan that was not signed in (docs/runbooks/security-scans.md) |
| `pnpm test` (`infra/verify/src`) | adapted Caddy JSON: strict SNI, admin off, `/internal` blocked, ask URL, log redaction, LB `/livez`, trusted proxy; quadlet budget, addresses, pg_hba, hardening |
| `pnpm --filter @ebooktrivia/worker test:chaos` | includes the production Valkey ACL with BullMQ (Docker) |
| `infra/verify/local/vm-sim.sh all` | provisioning twice in a privileged AlmaLinux 10.2 systemd container (second run: 0 changed), quadlet dry run on the installed units, read-only host-check |
| `infra/verify/local/stack-sim.sh all` | the whole stack in that container: rootless podman, socket-activated Caddy with a Pebble ACME CA, real images, and client checks from documentation-range networks |

The two sim scripts need Docker with privileged containers. They clean up with `down`.

## Dev stack

```sh
docker compose -f infra/dev/compose.yaml up -d --build --wait
docker compose -f infra/dev/compose.yaml ps      # all five services should be healthy
docker compose -f infra/dev/compose.yaml down    # add -v to drop volumes
```

Optional: `cp infra/dev/.env.example infra/dev/.env` to override defaults (the `.env` is gitignored).
Every credential in this stack is a DEV ONLY placeholder; never reuse them elsewhere.

| Service | Host port | Notes |
|---|---|---|
| postgres (18.6 + wal-g v3.0.9 binary, archiving off) | 127.0.0.1:55432 | user `postgres` |
| valkey 9.1.3 | 127.0.0.1:56379 | ACL users `public`, `worker`, `admin`, `ops` (ping only); `default` is off |
| mailpit v1.33.1 | SMTP 127.0.0.1:51025, UI 127.0.0.1:58025 | |
| waha-mock | 127.0.0.1:53000 | header `X-Api-Key`; control plane under `/__mock/*` |
| midtrans-stub | 127.0.0.1:53001 | Basic auth `base64(serverKey:)`; control plane under `/__stub/*` |

The dev Valkey ACL gives `worker` all keys (`~*`), so the worker tests can use random BullMQ
prefixes. The production ACL (`provision/files/valkey/`) allows `~ebt:* ~cache:*` only.

## Provenance of fixtures

Every fixture file carries a top-level `_provenance`.

- `midtrans-stub/fixtures` are **RECORDED** from the Midtrans sandbox on 2026-11-21 (US-005, `docs/spikes/R12.md`) and
  scrubbed: ids, merchant id, VA numbers and amounts are placeholders, and every signature is recomputed with the dev key
  `SB-Mid-server-DEVONLY`. The stub replays them (`midtrans-stub/src/replay.test.ts` pins its answers to them). One thing is NOT
  recorded: a real HTTP notification delivery (the sandbox needs a public notification URL); the notification fixture reuses
  the recorded Get Status bodies, which Midtrans documents as the same shape.
- `waha-mock/fixtures` are **RECORDED** from the Owner's WAHA 2026.10.1 (engine WEBJS) on 2026-11-21 (US-005, `docs/spikes/R11.md`) and
  scrubbed: phone, LID, own number, session name, message keys, texts and times are placeholders, and the session `config` (webhook URLs and
  HMAC keys) is never kept. The mock answers exactly like WEBJS (the raw send message with an object `id`, `201` with no body for presence,
  a 404 file URL delivered as the document with `fetchFiles: "webjs"`) and `waha-mock/src/replay.test.ts` pins its answers to them. NOT
  recorded (docs-shaped, and said so in each file's `_provenance`): a real webhook delivery (the HMAC headers and the event envelopes), a
  `@c.us` inbound sender, 463 / 475 and a stopped session's answer to a send. Verify the webhook with a real delivery on staging.

## Tests

The stubs are tested in-process (no Docker) via `pnpm test`.
