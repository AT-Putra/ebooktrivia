# Backups: wal-g point-in-time recovery and the restic copy (US-015, plan M4 item 5)

Two independent copies, both encrypted before they leave the VM, to two S3-compatible locations. The restore from the escrow alone is [restore-drill.md](../restore-drill.md); what the Owner keeps is
[escrow.md](../escrow.md). Valkey is **not** backed up (it holds queues and counters that the sweepers rebuild from PostgreSQL).

| | wal-g (primary, point in time) | restic (secondary, logical) |
|---|---|---|
| What | The whole cluster: nightly base backup plus every WAL segment | `pg_dump -Fc` of `ebooktrivia`, `pg_dumpall --globals-only` (roles and password hashes), and `/srv/data` (ebook PDFs, imports, proofs) |
| When | Base backup 20:30 UTC (03:30 WIB) by `ebt-backup-base.timer`; WAL continuously (`archive_command`, `archive_timeout = 60` s) | 21:30 UTC (04:30 WIB) by `ebt-backup-restic.timer` |
| Encryption | wal-g client-side **libsodium** with `walg_libsodium.key` (E3); zstd | restic's own (AES-256 with `RESTIC_PASSWORD`, E5) |
| Storage | `WALG_S3_PREFIX` on the first S3-compatible account (E4) | `RESTIC_REPOSITORY` on a **second** location, ideally another provider (E5) |
| Retention | The newest **14** full backups (nightly = 14 days) and the WAL they need (`wal-g delete retain FULL 14`) | 7 daily, 4 weekly, 6 monthly (`restic forget --prune`) |
| RPO / RTO | RPO about **1 minute**; RTO at most 2 hours ([restore-drill.md](../restore-drill.md)) | Up to a day; a logical restore into any PostgreSQL 18 |
| Failure shows as | `backup_base_failed` / `backup_base_stale`, `wal_archive_lag` (critical alerts, [alerts.md](alerts.md)) | `backup_restic_failed` / `backup_restic_stale` |

The code: `infra/backup/walg-base-backup.sh`, `restic-backup.sh`, `ops-check.sh` (free disk and `pg_wal`, every 5 minutes), `restore-pitr.sh`, `recovery-conf.sh`, `lib.sh`, the timer units in `infra/backup/units/`, the quadlet `postgres.container` and
`ebt-backup.network`, the env templates `files/env/walg.env` and `restic.env`.

Backups age out: base backups and WAL after 14 days, restic snapshots after the retention above (a monthly copy lives about 6 months). Deleting a person's data (UU PDP anonymization) applies to the live database; the privacy
policy says backups age out within their retention window (go-live GL-41).

## How wal-g reaches the storage (the egress design, and why)

The data network `ebt-data` is **internal**: PostgreSQL and Valkey and their clients cannot reach the internet. wal-g must (every WAL segment, every base backup). Options and the choice:

| Option | Verdict |
|---|---|
| Give `ebt-data` egress | No: it would give Valkey and every app container on that network a way out, undoing the isolation the plan relies on |
| Put PostgreSQL on `ebt-edge` (the existing egress network) | No: Caddy and the public apps share it, so PostgreSQL would be reachable from the internet-facing containers by a second path and would sit next to them |
| A sidecar that uploads WAL from a shared spool | More moving parts: a second container with the database credentials and the data directory mounted, a spool that is lost with the disk, and `archive_command` would succeed before the WAL is in storage (the RPO is then the upload latency, not the archive). Rejected for v1 |
| **A dedicated egress-only network `ebt-backup`, joined by the PostgreSQL container only** | **Chosen.** `ebt-backup.network` (10.89.54.0/24, not internal, no published port). Only `postgres` joins it (a test checks the member list), so nothing can reach PostgreSQL through it, and PostgreSQL listens on its `ebt-data` address only (`listen_addresses = 10.89.51.2`). `archive_command` succeeds only after the segment is in storage, so the archive is the truth. The base backup is `podman exec postgres wal-g backup-push`, the same container, no second set of credentials |

What the choice costs, and the mitigations: a PostgreSQL process now has egress. The container runs as the unprivileged `postgres` user with no capabilities, a read-only root filesystem and `no-new-privileges`; the nftables
guard still drops the app user's traffic to the metadata service (169.254.0.0/16) and to the host's own addresses; the app logins are not superusers, so `COPY ... PROGRAM` is not available to an application bug. The storage
endpoint cannot be pinned (each provider has many addresses), so the egress is not narrowed to it: that is the accepted residual. The libsodium key and the S3 credentials are **files** mounted read-only
(`/etc/ebooktrivia/postgres/walg_*`), never environment, so `podman inspect` shows neither. The restic job runs as a one-shot container on the same network, with `--env-file restic.env` (ephemeral).

**Accepted risk (v1): PostgreSQL has unrestricted egress.** `ebt-backup` is not internal, and the storage endpoint cannot be pinned to one address (a provider has many, and they change), so the PostgreSQL
container can open a connection to any host. What stops that from being a way out for a compromised application: no application login (`ebt_public`, `ebt_admin`, `ebt_worker`, `ebt_internal`) and no group role it belongs to
is a superuser or a member of `pg_execute_server_program`, `pg_read_server_files` or `pg_write_server_files`, so none can run `COPY ... PROGRAM` or read or write a file on the database host
(`packages/db/test/roles.int.test.ts` pins this for the group roles and the denials, `host-check.sh` for the logins on the VM). The one superuser login is `ebt_migrate`, which creates the roles: only the
one-shot `migrate` job holds its password (`migrate.env`) and no application process connects as it; the container runs as the unprivileged `postgres` user with no capabilities, a read-only
root filesystem and `no-new-privileges`; no other container joins the network. The residual is a PostgreSQL superuser exploit (a vulnerability in PostgreSQL itself): it could reach the internet.
Mitigation to consider after v1: an nftables rule that allows the container's address only to the storage provider's published ranges. Recorded in the ASVS checklist (the V13.2.4 and V13.2.5 rows,
[asvs-l2-checklist.md](../asvs-l2-checklist.md)).

## When the storage is unreachable: the disk fills, and the first start hangs

A failing `archive_command` (credentials, endpoint, a full bucket) never discards WAL: PostgreSQL keeps **every** segment in `pg_wal` until it is archived. With `archive_timeout = 60` and the worker's heartbeat
keeping the WAL moving, that is one 16 MB segment a minute: **about 1 GB an hour and 23 GB a day**. A VM with an 80 GB disk is full in three days and PostgreSQL then stops. The alerts, in the order they fire:

| After | Alert | Source |
|---|---|---|
| 15 minutes | `wal_archive_lag` (critical) | the worker, from `pg_stat_archiver` |
| within 5 minutes of the disk crossing 20 % / 10 % free | `disk_free_low` (warning) / `disk_free_critical` (critical) | `infra/backup/ops-check.sh`, every 5 minutes (`ebt-ops-check.timer`) |
| `pg_wal` over 2 GiB (about 2 hours) | `pg_wal_large` (critical) | the same script, `pg_ls_waldir()` as the superuser of the container's local socket |
| the script itself silent for an hour | `ops_check_stale` (critical) | the worker, from the heartbeat `ops_check` |

What to do: fix the cause first (`podman exec -u postgres postgres psql -XAt -c "SELECT last_failed_wal, last_failed_time FROM pg_stat_archiver"` and the PostgreSQL log name the error), then watch `pg_wal`
shrink as the archiver catches up. **Never delete files from `pg_wal` by hand.** If the disk is already full and the storage cannot be fixed in time, take a `pg_dump` to another disk first, then ask for help: the
only safe way to free `pg_wal` without archiving is to give up point-in-time recovery for that window (stop archiving with a new base backup once the storage works).

**The first start of PostgreSQL with an unreachable storage hangs once.** PostgreSQL archives while it shuts down, so the temporary server that initialises a new data directory cannot stop when the archive
command fails: `pg_ctl: server does not shut down`, and that first `start` of `postgres.service` fails after about a minute; the automatic restart then finds the initialised cluster and starts normally. (The local
stand-in hit exactly this.) So fill in `walg.env` and the credentials **before** the first start. Likewise a `systemctl stop postgres.service` while the storage is unreachable waits out the stop timeout and is
killed, and the next start does crash recovery.

## Set it up (staging, and production)

1. **Two buckets**, on two accounts if you can (E4 and E5): one for wal-g, one for restic. Versioning off, no lifecycle rule that deletes objects younger than 14 days (wal-g deletes by itself). An access key for each limited to its bucket.
2. `sudo infra/provision/provision.sh`. It writes `walg.env` and `restic.env` with `__SET_ME__` placeholders, **generates the wal-g libsodium key** (`postgres/walg_libsodium.key`, with a note) and the restic password, and installs the two timers. **Escrow the
   key and the password now** ([escrow.md](../escrow.md) E3, E5).
3. Fill in `walg.env` (`WALG_S3_PREFIX`, `AWS_ENDPOINT`, `AWS_REGION`), `postgres/walg_aws_credentials` (an AWS credentials file) and `restic.env` (`RESTIC_REPOSITORY`, the S3 keys). `host-check.sh` reports every placeholder left.
4. Start PostgreSQL with them filled in (`restart needed: postgres.service` from provisioning). **Fill them in BEFORE the very first start** (an unreachable storage hangs that first start once: see "When the storage is unreachable" below).
   Until the storage works, the archive command fails, `wal_archive_lag` fires after 15 minutes and `pg_wal` grows by about 16 MB a minute: fail closed, never a silent no-op. Check:
   `sudo infra/provision/as-app.sh podman exec -u postgres postgres psql -XAt -c "SELECT last_archived_wal, last_failed_wal FROM pg_stat_archiver"` (an archived name, no newer failure).
5. **Take the first base backup now**, do not wait for the night: `sudo infra/provision/as-app.sh systemctl --user start ebt-backup-base.service`, then `journalctl --user -t ebt-backup`: `BASE BACKUP OK`. The same for `ebt-backup-restic.service`.
6. Set `WORKER_OPS_CHECKS` (on by default in production): the worker now alerts when a backup is older than 26 hours or WAL stops. Prove it with the drills (D6, [drills.md](../drills.md)).

**A restore drill never writes to production's storage.** A restore that promotes starts a new timeline and archives it **into the storage its settings name**; a drill VM that kept production's
`WALG_S3_PREFIX` would leave a second timeline (and `00000002.history`) in production's archive, a later "latest" recovery of production would follow it and miss everything the first timeline committed after
the branch (the local proof hit exactly this), and its nightly timers would run the retention (`wal-g delete`, `restic forget --prune`) against production's storage. `restore-pitr.sh` therefore **requires** `--drill`
or `--disaster` ([restore-drill.md](../restore-drill.md)): a drill needs the marker `/etc/ebooktrivia/drill-vm` (the timers stay off, the backup scripts refuse to run), a **scratch** `WALG_S3_PREFIX` in `walg.env`
(refused when it equals, lies inside or surrounds production's), production's prefix only as `--source-prefix` (the `backup-fetch` and `restore_command`), and the **drill keys** of
[escrow.md](../escrow.md) E11 (read-only on production's storage). The drill server archives to the scratch prefix only. On a **real** disaster recovery, where the old VM is gone, `--disaster` keeps the same
prefix: the new timeline is then the history. `infra/verify/local/backup-pitr.sh` proves the drill: production's store (mounted read-only) is byte for byte unchanged afterwards.

## When a backup alert fires

- `backup_base_failed` / `backup_restic_failed`: `journalctl --user -t ebt-backup -n 50` as the app user (`sudo infra/provision/as-app.sh journalctl --user -t ebt-backup -n 50`) names the step. The usual causes: the S3 credentials expired or were rotated
  (E4), the storage is full or unreachable, a restic lock left by a killed run (`restic unlock`), no disk for the base backup's staging (it streams, so rarely).
- `backup_base_stale` / `backup_restic_stale`: a night was missed (the timer did not run, the VM was down, the job hung): run the service by hand and check it; `systemctl --user list-timers` shows the next run.
- `wal_archive_lag`: `pg_stat_archiver` (above) and the PostgreSQL log (`journalctl CONTAINER_NAME=postgres`): the archive command's error, usually credentials or the endpoint. While it fails, `pg_wal` grows: check `df` on the volume; do not
  delete WAL files by hand.
- A new key, endpoint or bucket: [escrow.md](../escrow.md) rotation rows E3 to E5.

## The restic copy: reading it back

```sh
R='podman run --rm -i --network ebt-backup --env-file /etc/ebooktrivia/restic.env docker.io/restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510'
sudo infra/provision/as-app.sh $R snapshots --host ebooktrivia
sudo infra/provision/as-app.sh $R dump latest --host ebooktrivia --path /db/ebooktrivia.dump /db/ebooktrivia.dump > /root/restored.dump   # latest dump of the database
sudo infra/provision/as-app.sh $R dump latest --host ebooktrivia --path /db/globals.sql /db/globals.sql > /root/globals.sql                 # roles and password hashes
```

Restore a dump into a **scratch** database first (`createdb`, then `pg_restore -d`), check the row counts, and only then decide what to do with the live one. `/srv/data` is restored with `restic restore latest --target <dir> --path /srv/data`
(mount a directory into the container). The pre-deploy dumps are in `/var/backups/ebooktrivia/predeploy/` ([deploy.md](deploy.md)).

## What was proven locally, and what is staging-only

`infra/verify/local/backup-pitr.sh` (CI job `infra`; Docker, no network but the image pulls, no host port) on the real `postgres-walg` image and the pinned restic image, with wal-g's FILE storage backend and a local restic repository. Last run
(Windows 11, Docker Desktop, 300 000 rows, 36 MB, `archive_timeout` 10 s in the proof):

| Step | Seconds |
|---|---|
| wal-g `backup-push` | 2.5 |
| PITR: `backup-fetch` + recovery config, in a fresh data directory | 10.3 (container start included) |
| PITR: WAL replay to the target and promotion | 2.2 |
| "Latest" (no target): fetch + config / replay and promotion | 10.2 / 2.2 |
| A restore DRILL (production's store read-only, a scratch store of its own): fetch + config / replay and promotion | 10.1 / 2.2 |
| Data loss with the server killed (the RPO here: newest recovered row to the kill) | 1.4 |
| restic: dump, globals, `/srv/data` four times, `forget --prune`, `check --read-data-subset=1/28` | 10.3 |
| restic: the dump restored into a database | 3.5 |
| restic: `/srv/data` restored (`restore latest --host ebooktrivia --path /srv/data --target /`, a read-only repository, `--no-lock`) | 1.4 |

Checks that passed: the stored objects hold no plaintext (a `grep` of the storage for the marker rows finds nothing); a `backup-fetch` with another libsodium key is refused; PITR to a chosen timestamp has the row committed before it and **not** the rows
after it, nor the unarchived tail; the promoted server is writable; "latest" recovers every archived row; the three restic streams restore (the dump restores into a database with all 300 000 rows; the globals hold the roles; `/srv/data` is byte for byte).

The **drill** check (the way `restore-pitr.sh --drill` runs it): production's store is mounted read-only, the drill server's own store is a scratch one; the drill recovers the archived rows, is promoted, archives its
new timeline into the scratch store (it holds `00000002.history`), no archive attempt fails, and afterwards production's store is byte for byte what it was before (same files, same checksums, no history file).

**Staging only** (needs the bucket, the VM and the credentials): the egress of the PostgreSQL container through `ebt-backup` to a real endpoint and the S3 timings, `wal-verify integrity` against real storage, the nightly timers firing (the first night),
the restic job from the real container with `--env-file`, the alerts on a real failure (D6), and the full clean-VM drill with the real RTO ([restore-drill.md](../restore-drill.md), GL-67).
