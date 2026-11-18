# infra

The local dev stack, provisional third-party stubs, and the VM infrastructure (staging, then
production).

| Path | What |
|---|---|
| `dev/` | Docker Compose dev stack (below) |
| `images/postgres-walg/` | PostgreSQL 18.6 + wal-g image (dev and VM) |
| `images/app/Containerfile` | App images: `public`, `admin` (Next.js standalone behind `packages/edge`) and `worker` (also runs `--role=internal` and the migrate job) |
| `provision/` | Idempotent VM provisioning (AlmaLinux 10.2): `provision.sh`, `db-roles.sh`, `build-images.sh`, `as-app.sh`, `rotate-glitchtip-token.sh`, config templates in `files/` |
| `quadlet/` | Rootless podman units: `caddy` (+ `caddy.socket`), `public@` (a, b), `admin`, `worker`, `internal`, `postgres`, `valkey`, `migrate`, four networks, four volumes |
| `caddy/Caddyfile` | The edge (`adapted.test.json` is its adaptation with test values, for `pnpm test`) |
| `verify/` | `host-check.sh` (read-only VM check), `client-ip-probe.sh`, consistency tests (`src/`), local harnesses (`local/`) |

Staging: follow [docs/runbooks/staging-provision.md](../docs/runbooks/staging-provision.md)
(prerequisites, variables, run order, and how to verify on the VM).

## VM layout in one paragraph

- **App user.** Everything runs as the rootless podman user `ebt` (no login shell), with linger and cgroup delegation. An nftables egress guard keeps it (and every container) away from 169.254.0.0/16 and the host's own addresses.
- **Caddy.**
  - It listens on 80/443 through `caddy.socket`: socket activation in the host network namespace keeps the real client address.
  - It has a pinned address on each network it shares with an app: `10.89.50.2` (public, `ebt-edge`), `10.89.52.2` (admin, `ebt-admin`), `10.89.53.2` (internal, `ebt-internal`). That address is the only `X-Forwarded-For` source the app believes (`TRUSTED_PROXY_IP`), and each app listens on its own Caddy-facing address only (`EDGE_HOST`).
- **Networks.** `ebt-edge` (egress: Caddy, public, worker); `ebt-admin` and `ebt-internal` (internal, Caddy plus one app each); `ebt-data` (internal: PostgreSQL, Valkey and their clients; Caddy is not on it).
- **Pinned addresses.** Every container has one. `pg_hba.conf` admits each app login to the `ebooktrivia` database only, from its own address.
- **Config files.** `/etc/ebooktrivia` belongs to root (group `ebt`, files `0640`); secrets in its `*.env` files are generated on the VM, never in the repository or a unit file. Under the app user's home only the app user writes.
- **Data.** `/srv/data/deliverables` (ebook PDFs) is read-only for public and the worker; the rest of `/srv/data` is admin's.
- **Memory.** Limits follow the plan M4.2 budget: PostgreSQL 2 GB, Valkey 512 MB, public 2 × 700 MB, admin 600 MB, worker 600 MB, internal 120 MB, Caddy 150 MB.

## Local verification of the VM infrastructure

| Command | Proves |
|---|---|
| `infra/verify/local/shellcheck.sh` | ShellCheck v0.11.0, all severities, on every infra script (CI job `infra`) |
| `infra/verify/local/caddy-adapt.sh [--check]` | `caddy validate`, `caddy fmt`, and a regenerated (or up-to-date) `caddy/adapted.test.json` (CI) |
| `infra/verify/local/quadlet-dryrun.sh` | the quadlet generator of `podman-5.8.2-12.el10_2.alma.1` accepts every unit (CI) |
| `infra/verify/local/edge-smoke.sh [public\|admin]` | the production server entry on a `next build`: /livez, the page, the listener address (CI job `edge-smoke`) |
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

## PROVISIONAL status of fixtures

All files in `waha-mock/fixtures` and `midtrans-stub/fixtures` carry a top-level `_provenance` of
`PROVISIONAL`: they are shaped from public docs, not recorded from a real WAHA session or Midtrans sandbox.
WAHA fixtures are to be replaced in US-005. The Midtrans duplicate `order_id` 400 body is also unverified.

## Tests

The stubs are tested in-process (no Docker) via `pnpm test`.
