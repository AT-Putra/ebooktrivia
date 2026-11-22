# Alerts reach the Owner: the relay, its backstop and the ops checks (US-015, plan M4.8; closes go-live GL-16)

The code writes what the Owner must know into the `alerts` table (payments, deliveries, the backups, Valkey, GlitchTip's hook). Until US-015 nothing sent those rows anywhere: they were only visible in the
console. This page is what sends them, how to set it up and what can go wrong. The code is `apps/worker/src/alert-relay.ts` (the relay and the backstop), `alert-relay-senders.ts` (the channels) and
`ops-checks.ts` (the backup, WAL and Valkey alerts); the tests are `apps/worker/test/alert-relay.int.test.ts`, `ops-checks.int.test.ts` and `apps/admin/test/alert-recipients.int.test.ts`.

## 1. Who gets them: Admin, Alerts (Owner only)

The page "Alerts" in the console (Owner only; Staff do not see it) holds **one WhatsApp number** (an Indonesian mobile number, stored as E.164), **one e-mail address** and the **lowest severity** that is sent
(default **warning**: `info` alerts are written and shown in the console but not sent). Every change is audited (the number and the address as personal data: the audit log masks them). The button
**Send a test alert** writes an `info` alert that the relay sends **whatever the lowest severity is**, so the Owner sees the whole path work.

Until the Owner saves at least one channel nothing is sent and nothing is marked sent; a critical alert then reaches the Owner through the backstop (section 3) after 5 minutes.

## 2. The relay (the first route)

A sweeper of the worker, every minute (`WORKER_SWEEP_INTERVAL_MS`). Each sweep:

1. reads the recipients; none set: nothing happens;
2. checks its **rate limits**: at most **one digest a minute** and **20 an hour** (counted in the worker process; a restart starts the hour again). A sweep the limit refuses changes nothing: the alerts wait;
3. **claims** the unnotified, unresolved alerts at or above the lowest severity (`FOR UPDATE SKIP LOCKED`, at most 50; two workers never send the same row), the **critical ones first**, a test alert always;
4. builds **one digest**: at most **10** alerts, each as `[severity] kind: message` with the message cut to **300 characters**, then `+N more`; the subject names the worst severity and the first kinds;
5. sends it by **e-mail** (the delivery code's SMTP sender: the settings the Owner saved, TLS, the sealed password) and by **WhatsApp** (the **pool sender**: human-like pauses, check-exists before a first contact, a
   number picked by weight under its caps and health, recorded in the send ledger), side by side, each bounded to 30 seconds;
6. marks the claimed rows `notified_at` when **at least one channel** took the digest. Why per digest and not per channel: a row one channel carried would otherwise be sent to that channel again every minute until
   the other worked, so a down SMTP server would become a WhatsApp message a minute. The Owner learned of the alert, the console lists it, and the failed channel is logged (`alert relay: the e-mail was not sent`).
   When **both** fail the rows stay unnotified and are retried by the next sweep that the rate limit allows.

**No personal data leaves.** An alert holds ids, a kind and fixed or already-masked text (GlitchTip's hook masks e-mail addresses and phone-like numbers before it stores an event). The relay sends the kind,
the severity and the message **only, never the payload**, and masks e-mail addresses and phone-like numbers once more and drops control characters. The tests assert both (`apps/worker/test/alert-relay.int.test.ts`,
"never sends the payload or anything of a message that looks like personal data"). A new alert kind must keep to this: ids and codes in the message, nothing a buyer typed.

**The first-contact limitation (WhatsApp).** The alert comes from a **pool number**, to the Owner's number. WhatsApp can refuse or flag a message from a number the recipient has never been in touch with (the
reachout timelock, [delivery.md](delivery.md)); the pool sender checks that the number exists and applies the new-contact budget, but it cannot make WhatsApp deliver to a stranger. **Before the first alert,
the Owner writes one message to EVERY pool number from the alert phone** (any text; "hello" is enough), so each chat exists, and does the same for each number added to the pool later (the pool's
onboarding steps in [delivery.md](delivery.md) say so). The e-mail copy is the other half of the path. This is checked in drill D7 and go-live GL-16.

*Why every number and not one pinned number.* The pool sender picks the number by weight, under each number's caps and health, and that is what keeps an alert going out when one number is capped, banned or
its session is down: an alert path that fails exactly when a number does is the wrong trade. Pinning the alerts to one number (a setting, or the first active number in a stable order) would add a single point
of failure for the moments the alerts matter most, and a pin with a failover to "the next number" would need the Owner to have written to that one too, which is the same instruction as writing to all of them.
The cost is one "hello" per number, once, from the phone that already runs the pool; the pool is the Owner's own few numbers. What does not depend on any of this: the e-mail digest, and Kuma's own WhatsApp
channel from a dedicated session ([monitoring.md](monitoring.md)).

## 3. The backstop (the second route, independent of the relay)

Uptime Kuma on the other box also watches the alerts. The worker pushes a second Kuma push monitor (`UPTIME_KUMA_ALERTS_PUSH_URL`, [monitoring.md](monitoring.md)) every heartbeat: **DOWN** while a **critical**
alert has stayed **unnotified and unresolved for more than 5 minutes** (the relay, the recipients, SMTP or WhatsApp are broken), **UP** otherwise. The message holds a count and the alert kinds only. Kuma reaches
the Owner by its own WAHA `sendText` and e-mail channels, off the VM.

Kuma tells on a **change of state** only, so it is the net under the relay, not the first route: a second critical alert while the first is still unresolved is sent by the relay, never by Kuma. When the backstop turns
DOWN: open the console, read the alert, look at `journalctl --user -u worker` for `alert relay`, fix the channel (the SMTP settings, the WAHA session), and resolve the alert.

## 4. The ops checks (`WORKER_OPS_CHECKS`, on by default in production)

| Alert kind | Severity | Raised when | What to do |
|---|---|---|---|
| `backup_base_stale` | critical | the heartbeat `backup_base` (written by `infra/backup/walg-base-backup.sh`) is older than 26 hours, or was never written | [backups.md](backups.md) "When a backup alert fires"; run `systemctl --user start ebt-backup-base.service` and read its journal |
| `backup_restic_stale` | critical | the same for `backup_restic` | the same, `ebt-backup-restic.service` |
| `backup_base_failed`, `backup_restic_failed` | critical | the nightly script itself failed (it writes the alert at once; one an hour while it lasts) | the journal line names the step |
| `wal_archive_lag` | critical | PostgreSQL has `archive_mode = on` and has archived nothing for 15 minutes (it has been up that long); the worker's own heartbeat keeps WAL moving, so a quiet database is not a lagging one | the S3 credentials or endpoint (`walg_aws_credentials`, `walg.env`), the storage, the egress through `ebt-backup` |
| `disk_free_low` / `disk_free_critical` | warning / critical | the least free of the filesystems holding PostgreSQL's data, the pre-deploy dumps and `/srv/data` is under 20 % / 10 % free (`infra/backup/ops-check.sh`, every 5 minutes on the VM, `ebt-ops-check.timer`) | `df -h`; `pg_wal` (a failing WAL archive fills the disk, [backups.md](backups.md)), `/var/backups/ebooktrivia/predeploy`, the database's own growth |
| `pg_wal_large` | critical | `pg_wal` holds over 2 GiB (the same script; `pg_ls_waldir()`): the WAL archive is failing or far behind, about 16 MB a minute | fix the archive first ([backups.md](backups.md) "When the storage is unreachable"); never delete WAL by hand |
| `ops_check_stale` | critical | the heartbeat `ops_check` (written by that script) is over an hour old or missing: the disk and `pg_wal` alerts are not running | `systemctl --user status ebt-ops-check.timer`, its journal (`journalctl --user -t ebt-backup`) |
| `valkey_memory_high` | warning | Valkey's `used_memory` is over 70 % of `maxmemory` (it runs `noeviction`: a full Valkey fails every write) | look for `rl:` and `cache:` keys without a TTL; the memory budget |

The messages are fixed text; none holds personal data. The disk and `pg_wal` rows are raised by the **VM's own timer**, not the worker (only the host sees its disks, and only a superuser may list
`pg_wal`), so `WORKER_OPS_CHECKS` does not switch them; the worker only watches that timer (`ops_check_stale`).

## 5. Checks and drills

- The whole path, on staging: Admin, Alerts, save the Owner's number and address, **Send a test alert**: the WhatsApp message and the e-mail arrive within a minute or two (D7).
- A critical alert: `sudo infra/monitoring/alert-drill.sh relay-critical`, then `relay-check` prints the seconds to notify.
- The backstop: stop the relay's channel (blank the e-mail and the number, or stop SMTP) with a critical alert open: Kuma's `ebt alerts backstop` turns red after 5 minutes and the Owner is told by Kuma (D7).
- GlitchTip with masking: D5. The backup and Valkey alerts: D6. [drills.md](../drills.md) has the tables.
