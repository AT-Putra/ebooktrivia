# PITR restore on a clean VM, from the escrow only (US-015, AC-P3: RTO at most 2 hours, RPO about 1 minute)

This is the step-by-step of drill **D1** in [drills.md](drills.md) (which keeps the marker procedure, the verification list and the log table; this page does not
repeat them). It restores the database to a chosen instant on a **new** AlmaLinux 10.2 VM using only the items of [escrow.md](escrow.md), the repository and the
storage. **Nothing here has been run on a real VM yet**: the staging VM and the S3 bucket do not exist (US-014); the mechanics (the encrypted base backup, the WAL
chain, `recovery_target_time`, promotion, the restic restore) were run locally with the real images and wal-g's FILE backend, and those numbers are in the last
section. Fill the timing table with real clock times (UTC, one clock); a drill with an empty table has not been done.

## The drill (D1) runs against STAGING's backups, never production's

A drill VM restores a real database and starts a real stack, so it must be a copy of **staging**: the source prefix of `--source-prefix` is **staging's** wal-g prefix, the escrowed files are staging's, the Midtrans keys
sealed in the restored database are the sandbox ones, and the domain is staging's. Wherever this page says "production's prefix" or "production's storage" for a drill, read **the source environment's, which is
staging's**. A drill is never run against production's backups: production's recovery is `--disaster`, on the day, and its rehearsal is this drill on staging. On top of that the drill VM is made unable to act on
anything real (step 3): its worker pushes to no Kuma monitor (a drill's heartbeat would hide a real outage) and holds neither the messaging nor the conversions private key (it could not open a sealed secret to
message a buyer or post a conversion back to an adnet, whatever the restored outbox holds).

## A drill and a disaster are not the same restore

A restore that promotes **archives**: the promoted server writes its own timeline (and a history file) into the storage its settings name, and a later recovery of production to "latest" would
follow that timeline and miss what production committed after the branch. So `restore-pitr.sh` refuses to run without one of two flags:

| | `--drill` (this page, a rehearsal) | `--disaster` (production is gone and this VM replaces it) |
|---|---|---|
| Storage the new server **archives to** (`walg.env`) | a **scratch** prefix, never production's (the script refuses a prefix equal to, inside or around production's) | production's own prefix: the new timeline belongs there |
| Production's prefix | only **read**: `--source-prefix s3://...` goes to the `backup-fetch` and into `restore_command` (`env WALG_S3_PREFIX=<production> wal-g wal-fetch`), nowhere else | is `walg.env`'s |
| S3 keys on the VM | the **drill keys** (E11): read-only on production's storage, read and write on the scratch prefix | E4 and E5 (the full keys) |
| Backup timers | **off**: the marker `/etc/ebooktrivia/drill-vm` (root makes it before provisioning) keeps `provision.sh` from enabling them, and the backup scripts refuse to run (their retention would delete in production's storage) | on, as on any VM |

A drill that skips any of this has failed, even if the database came back.

## Before you start

- The **escrow** (E1 to E6, E9, and for a drill E11) open on a second screen. Nothing may come from the lost VM or from memory; every secret you reach for that is not in the escrow goes into the
  "missing from the escrow" column of the log, and the drill has failed.
- On the clean VM's disk: at least the size of the database twice (the base backup and the restored cluster), and 5 GB more.
- The marker rows of D1 (`T_marker`, `T_late`) noted from the old VM, and `T0` = when the old VM was declared lost.
- Time budget, which the log is compared with:

| Step | Budget (minutes) |
|---|---|
| 1 to 3 the VM, the files from the escrow, provisioning | 15 |
| 4 the images (build on the VM, or pull by digest) | 20 |
| 5 the PostgreSQL restore (base backup fetch and WAL replay) | 30, in proportion to the database and the WAL since the base backup |
| 5b the files of `/srv/data` from restic (ebook PDFs, imports, proofs) | 10, in proportion to their size (it can run while step 5 replays; count the longer of the two, the clock is one) |
| 6 to 8 start, migrate, the stack, the first checks | 15 |
| 9 DNS and the certificates | 15 (the records' TTL decides; keep it low on the production names) |
| 10 verification | 10 |
| **Total** | **115 of 120** (the 5b time added; 105 if it fits inside step 5) |

## The steps

All commands run as `root` on the new VM unless they say otherwise. `<DOMAIN>` is the production or staging domain being restored.

1. **The VM.** Create AlmaLinux 10.2 (4 vCPU, 8 GB), add your SSH key for a wheel user, set that user's console password (E9). Point nothing at it yet.
2. **The checkout.** `git clone` the repository to `/opt/ebooktrivia` at the release tag the old VM ran (the last successful `deploy` run names the commit), readable by everyone, writable by root only.
3. **The files from the escrow, before provisioning.** Provisioning keeps a value that is already in a file, so putting the escrowed files in place first gives the old secrets back (E6):

   ```sh
   install -d -m 750 /etc/ebooktrivia /etc/ebooktrivia/postgres
   # A DRILL ONLY, first of all and before provisioning (it keeps the backup timers off and makes the backup scripts refuse):
   touch /etc/ebooktrivia/drill-vm
   install -m 600 <escrow>/provision.env /etc/ebooktrivia/provision.env
   install -m 640 <escrow>/{public,admin,worker,internal,migrate,valkey,postgres,caddy}.env /etc/ebooktrivia/
   install -m 640 <escrow>/walg_libsodium.key /etc/ebooktrivia/postgres/        # E3 (64 hex digits): the same key reads and writes
   ```

   Then the storage settings, which differ:

   - **Disaster:** `install -m 640 <escrow>/{walg,restic}.env /etc/ebooktrivia/` and `install -m 640 <escrow>/walg_aws_credentials /etc/ebooktrivia/postgres/` (E4, E5: the full keys).
   - **Drill:** `walg.env` from the escrow with **`WALG_S3_PREFIX` changed to a scratch prefix** (a path in the scratch bucket, for example `s3://ebt-drill-scratch/<date>`; production's prefix is only
     passed to the restore script in step 5), `walg_aws_credentials` holding the **drill key** (E11: read-only on production's bucket, read and write on the scratch prefix), and
     `restic.env` with the restic **read-only** key (E11), everything else as in the escrow. The drill never holds the full keys of E4 and E5: if production's storage could be written from this VM,
     the drill has failed.
   - **Drill, the worker acts on nothing real:** the escrowed `worker.env` is installed **without** `SECRETS_MESSAGING_PRIVATE_KEY` and `SECRETS_CONVERSIONS_PRIVATE_KEY` (delete those two lines), and with
     `UPTIME_KUMA_PUSH_URL` and `UPTIME_KUMA_ALERTS_PUSH_URL` empty. Without the two keys the worker builds no deliveries, no alert relay and no conversions, so the restored outbox is not drained through real
     WAHA, SMTP or the adnets' postbacks and no sealed secret can be opened to do it; with the push URLs empty it does not tell the real Kuma monitors that the production worker is alive. You do not have to
     remember this: while `/etc/ebooktrivia/drill-vm` exists `provision.sh` blanks both push URLs and removes both keys from `worker.env` (the second run still ends `0 changed`), and `host-check.sh` fails if
     any of the four is back. (The payment key stays: a drill is run against staging, whose sandbox Midtrans keys the checkout test of step 10 needs.)

   Then `sudo infra/provision/provision.sh`, **twice**: the second run must end `summary: 0 changed`. (It fixes the owners and modes, creates the app user and the quadlets,
   and starts nothing; on a drill VM it leaves the backup timers off.) `provision.env` must carry the new VM's `SSH_ALLOWED_CIDRS` and the deploy login's settings; edit them if the addresses changed.
4. **The images.** Either `sudo infra/provision/build-images.sh` (10 to 20 minutes; it builds from this checkout, so the tag must be the release's), or re-run the `deploy` workflow for
   the new host (it pulls by digest). The PostgreSQL image (`localhost/ebooktrivia/postgres-walg:18.6`) must exist before step 5.
5. **Restore PostgreSQL** (the clock of the longest step). `T_target` is `T_marker` plus 30 seconds, in UTC, or leave `--target-time` out to recover to the end of the archived WAL:

   ```sh
   # drill (production's prefix is the WALG_S3_PREFIX of the escrowed walg.env, E4):
   sudo infra/provision/as-app.sh bash infra/backup/restore-pitr.sh --drill --source-prefix s3://<production bucket>/<path> --yes-wipe-database --target-time '2026-11-22 10:15:30+00'
   # disaster (this VM replaces production; walg.env already holds production's prefix):
   sudo infra/provision/as-app.sh bash infra/backup/restore-pitr.sh --disaster --yes-wipe-database --target-time '2026-11-22 10:15:30+00'
   ```

   It refuses without exactly one of the two flags, and in a drill unless the marker exists, `walg.env` names a scratch prefix that is not production's (nor inside it, nor around it) and the source
   prefix is well formed. Then it stops the timers (belt and braces), empties `ebt-pgdata`, runs `wal-g backup-fetch LATEST` (decrypting with E3, reading with E4 or E11; in a drill `WALG_S3_PREFIX` is set to
   production's on that one command), writes `recovery.signal`, `restore_command` (in a drill `env WALG_S3_PREFIX=<production> wal-g wal-fetch %f %p`) and the target, starts `postgres.service`,
   waits until PostgreSQL has replayed the archive and promoted itself, and prints the timings. A wrong or missing key stops it at the fetch (`corrupted chunk`): that is the escrow's E3 failing.
   In a drill the promoted server archives its new timeline to the **scratch** prefix; check afterwards that production's prefix has no new `*.history` object (`aws s3 ls` with the drill key).
5b. **Restore the files** (`/srv/data`: the ebook PDFs, imports and proofs; restic's third stream). With the same restic image as the nightly job (the digest in `docs/versions.md`), as the app user, into the
   host directory, then the owner and the SELinux labels:

   ```sh
   R='podman run --rm -i --network ebt-backup --env-file /etc/ebooktrivia/restic.env -v /srv/data:/srv/data:z docker.io/restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510'
   sudo infra/provision/as-app.sh $R --no-lock restore latest --host ebooktrivia --path /srv/data --target /
   sudo chown -R ebt:ebt /srv/data && sudo restorecon -R /srv/data
   sudo ls -lZ /srv/data/deliverables | head      # the app user, mode 750 on the directories, a container_file_t label
   ```

   `--no-lock` lets a **read-only** key restore (the default lock is a file written into the repository). The snapshot records the files as the container's root saw them, which is the app user on the host,
   so the owner comes back right; the `chown` and `restorecon` make that certain whatever the restore ran as. In a disaster the same command is run with the full key and `--no-lock` is harmless.
   `/srv/data` is not needed by steps 6 to 8 until the first download or upload, but the check in step 10 downloads one ebook, so it counts toward the RTO.
6. **Check the roles and the schema.** `sudo infra/provision/db-roles.sh` must end `0 changed` (the restored roles carry the escrowed passwords; if it changes something, E6 was not the current copy:
   note it). Then `sudo infra/provision/as-app.sh systemctl --user start migrate.service`: nothing to apply.
7. **Start the stack in the deploy order** (Valkey is not backed up and starts empty; the worker loads the function library public needs):

   ```sh
   A='sudo infra/provision/as-app.sh'
   $A systemctl --user start valkey.service
   $A systemctl --user start worker.service internal.service
   $A systemctl --user start admin.service public@a.service public@b.service
   $A systemctl --user start caddy.socket caddy.service
   ```

8. **Host check.** `sudo infra/verify/host-check.sh` ends with `0 failed`.
9. **DNS and certificates.** Point `admin.`, `play.`, `order.` and `api.<DOMAIN>` at the new VM and wait for Caddy to obtain the certificates (TLS-ALPN-01 on 443). For a drill that must not touch
   production names, use the staging domain, or `curl --resolve` against the VM and skip this step (write which in the log: it is part of the real RTO).
10. **Verify** (the list of D1): the marker rows, the row counts, the reconciliation, a login (the **admin console**: a player's OTP or magic link is not sent on a drill VM, by design: its worker has no messaging key), a sandbox checkout, the worker heartbeat (in the database: it pushes to no Kuma); In a **disaster** Kuma's monitors for the new VM go green
    after the monitoring box's address list and the monitors' hosts are updated (E9); a drill touches no monitor. Stop the clock at the first successful "the application works": `T_end`.

## RTO and RPO

- **RTO** = `T_end` - `T0` (limit 2 hours), and the table below splits it by step.
- **RPO** = the time between the last row recovered and the power-off. With `archive_timeout = 60` and the worker's heartbeat keeping WAL moving, the unarchived tail at the power-off is
  at most one minute of changes. (With `--target-time` the RPO is the gap you chose.)

| Run | Date, operator | T0 | Files + provision (1 to 3) | Images (4) | PostgreSQL restore (5) | `/srv/data` (5b) | Start + checks (6 to 8) | DNS + TLS (9) | Verified `T_end` (10) | RTO | RPO | Production's prefix unchanged | Missing from the escrow | Pass / fail |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | | | | | | |

## What was proven locally

`infra/verify/local/backup-pitr.sh` runs the same restore on the real images with wal-g's FILE storage backend (no S3 here): PostgreSQL 18.6 with `archive_mode = on` and the production `archive_command`,
libsodium encryption from a key **file**, a base backup, markers, a killed server, then a fresh data directory restored with `wal-g backup-fetch` and `infra/backup/recovery-conf.sh` (the same
file the real `restore-pitr.sh` runs) to a chosen timestamp and, separately, to the end of the archive; the stored objects are checked for plaintext and a wrong key is refused; the restic copy
(`pg_dump -Fc`, `pg_dumpall --globals-only`) is restored into a database and `/srv/data` is restored with the command of step 5b against a read-only repository. A **drill** is run the way
`restore-pitr.sh --drill` runs it: production's store mounted read-only and named only on the fetch and in `restore_command`, a scratch store as the server's own; afterwards production's store is
byte for byte what it was (no new timeline or history file, nothing deleted) and the scratch store holds the drill's timeline. The measured timings and the result of the last run are in
`docs/runbooks/backups.md`, section "What was proven locally". What only a real bucket and a clean VM can show (S3 latency and egress through `ebt-backup`, the provisioning and image times, DNS and certificates) is the drill above.
