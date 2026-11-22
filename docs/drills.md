# Drills: the final PITR restore drill and the alert drills (US-032, plan M4 Verify and M11 item 3)

These are procedures and logs, not results. **Nothing in this file has been run**: the staging VM, the S3 bucket, the monitoring box and the credentials do not exist yet (US-014, US-015). Each drill is written against the plan's design, and every step that needs something US-015 builds is marked **[US-015]** (named, so it can be checked when US-015 lands). Fill the timing tables with real clock times; a drill with an empty table has not been done ([go-live.md](go-live.md) GL-67, GL-68).

## US-015: the scripts, the monitors and the restore procedure (added by US-015)

US-015 built what these drills need, and **none of it has been run on a real VM yet**. The triggers are `infra/monitoring/alert-drill.sh` (`alert-drill.sh` with no argument lists its subcommands; `template` prints the columns of the tables below): each subcommand
triggers or puts back one failure and prints one UTC timestamped line, so the "Start" and "Recovered" columns are the script's clock. The Kuma monitors are listed in `infra/monitoring/kuma/monitors.json` and checked with `infra/monitoring/kuma-check.sh`
([monitoring.md](runbooks/monitoring.md)); the alert relay, its backstop and the ops checks are [alerts.md](runbooks/alerts.md); the restore is [restore-drill.md](restore-drill.md); the deploy and its rollback are [deploy.md](runbooks/deploy.md). The "Needs [US-015]" lines below name what was built.

## Rules for every drill

- Run on **staging** (the same scripts and size as production), never on production, except the VM-down and PITR drills' separate clean VM.
- Use the **Owner's own** WhatsApp number and e-mail address as the alert recipient. Never a buyer's.
- Time with one clock (UTC, `date -u +%H:%M:%S` on the VM, the phone's clock for what the Owner sees, synchronised to the second). A row is **pass** only when every "Expected" below holds and the timings meet the limit.
- Write down what you changed so it can be put back (the table's "Restored" column). A drill that leaves the stack changed is not finished.
- Every drill's columns: **Start** (the action), **Detected** (the monitor noticed: the Kuma monitor turns red, the alert row appears), **WA received**, **E-mail received**, **Recovered** (the thing works again), **Pass / fail**, and a note.

---

## D1. PITR restore drill on a clean VM (AC-P3; RTO at most 2 hours, RPO about 1 minute)

**US-015 built:** the step-by-step with the exact commands, the RTO budget and the timing table is [restore-drill.md](restore-drill.md); the restore script is `infra/backup/restore-pitr.sh`; the escrow list is [escrow.md](escrow.md). Locally proven (not on a real VM): the encrypted base backup, the WAL chain, the restore to a chosen timestamp and to the end of the archive, promotion, the restic restore (`infra/verify/local/backup-pitr.sh`). **A drill VM must not archive into the production prefix** ([backups.md](runbooks/backups.md)).

**What it proves.** A new VM, given only the escrow ([docs/escrow.md](escrow.md) **[US-015]**: the scope private keys, `WAHA_WEBHOOK_HMAC_SECRET`, the wal-g libsodium key and the S3 credentials, the restic password, the env files) and the repository, restores the database to a chosen instant, starts the application, and loses at most about a minute of data.

**Before: plant a marker (on staging).**

1. Place a synthetic order through the real flow and note its order code, or `INSERT` a row in a scratch table through `podman exec postgres psql`. Record the commit time `T_marker` (`SELECT now()`).
2. Wait 3 minutes (so WAL archiving has shipped past `T_marker`; the WAL archive lag alert must be green), then place a **second** marker `T_late` and immediately "lose" the VM (power it off from the provider console). `T_late` is allowed to be lost (it is inside the RPO window); `T_marker` must not be.
3. Take `T0` = the moment the VM is declared lost. The RTO clock runs from `T0`.

**D1 runs against STAGING's backups, never production's [US-015 review].** The source prefix, the escrowed files and the domain are staging's; the Midtrans keys in the restored database are the sandbox ones. The drill
VM also acts on nothing real: `worker.env` has both Kuma push URLs empty and no `SECRETS_MESSAGING_PRIVATE_KEY` or `SECRETS_CONVERSIONS_PRIVATE_KEY` (`provision.sh` enforces it while the drill marker exists, `host-check.sh`
asserts it), so the restored outbox is not sent, no conversion is posted and no real Kuma monitor hears a drill's heartbeat. The login check below is therefore the admin console's, not a player OTP.

**Restore (new VM, same size).** **This is a drill, not a disaster [US-015 review]:** the VM must **never write to the source environment's storage**. Before provisioning, root creates
`/etc/ebooktrivia/drill-vm` (the backup timers stay off and the backup scripts refuse to run); `walg.env` gets a **scratch** `WALG_S3_PREFIX`; the S3 keys are the **drill keys** (escrow E11: read-only on
production's storage); step 5 runs `restore-pitr.sh --drill --source-prefix <production's prefix>` (the flag is required; `--disaster` is for a real loss only). The exact commands are in
[restore-drill.md](restore-drill.md) steps 3 and 5. Step 5b restores `/srv/data` from restic. After the drill production's wal-g prefix must hold **no new** `*.history` or timeline object and nothing deleted.

| # | Step | Needs |
|---|---|---|
| 1 | Create a clean AlmaLinux 10.2 VM (4 vCPU / 8 GB), your SSH key, the same `DOMAIN` records pointed at it (or an `/etc/hosts` override for the drill). | provider |
| 2 | Fetch the repository checkout (`/opt/ebooktrivia`). | git access |
| 3 | `sudo infra/provision/provision.sh` (twice: the second run says `summary: 0 changed`), then `sudo infra/provision/build-images.sh`, or pull the release images **by digest** from GHCR. | **[US-015]** image push by digest |
| 4 | Put the env files, the scope private keys and `WAHA_WEBHOOK_HMAC_SECRET` back **from the escrow copy only** (`/etc/ebooktrivia/*.env`, `0600`). Nothing may be copied from the lost VM or from memory. | escrow, **[US-015]** `docs/escrow.md` |
| 5 | Restore PostgreSQL to `T_marker`: stop `postgres.service`, empty the `ebt-pgdata` volume, `wal-g backup-fetch` the newest base backup taken before `T_marker`, write `recovery.signal` and `recovery_target_time = '<T_marker + 30 s>'` with `recovery_target_action = 'promote'`, use the libsodium key and S3 credentials from the escrow, start PostgreSQL and wait until it accepts connections. For the "latest" variant leave the target out and recover to the end of the archived WAL. | **[US-015]** wal-g in the custom image, WAL archive, `restore_command` |
| 6 | Run the `migrate` job (`systemctl --user start migrate.service`); it must report nothing to apply. Valkey is **not** backed up: start it empty. | `staging-provision.md` |
| 7 | Start the stack in the deploy order (worker, then the public apps, admin, internal, Caddy). The sweepers rebuild all scheduled work from PostgreSQL. | quadlets |
| 8 | Verify (below). Stop the clock at the first successful verification of "the application works": `T_end`. | |

**Verify** (each one a checkbox in the log): `T_marker`'s data is present and `T_late`'s is absent or present (record which); the row counts of `orders`, `payments`, `deliveries` and `conversion_events` equal the last known numbers within the RPO window; `host-check.sh` passes; the nightly reconciliation runs and reports no mismatch (`reconciliation_mismatch` raises none); a login works (the admin console's: a player's OTP or magic link is not sent on a drill VM); a sandbox checkout reaches Snap; the worker heartbeat is fresh; no secret was needed that is not in the escrow (**list any that was**: that is a failed drill).

**Result.** **RTO** = `T_end - T0` (limit 2 h). **RPO** = `T_loss - (last row recovered)`, where `T_loss` is the power-off time (about 1 minute expected from the WAL archive interval).

| Run | Date, operator | T0 (VM declared lost) | Restore started | PostgreSQL up | T_marker present | App verified `T_end` | RTO | RPO | Escrow complete (y/n, missing) | Pass / fail |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | | |
| 2 | | | | | | | | | | |

---

## D2. Kill the worker: push alert within 3 minutes (AC-P12, AC-P4)

**Needs [US-015]:** the worker push monitor in Uptime Kuma (the worker pushes a heartbeat to `UPTIME_KUMA_PUSH_URL` every 60 s), Kuma's WhatsApp notification (webhook to the WAHA `sendText` API) and its e-mail notification, and the deep `/healthz` that includes the heartbeat freshness (at most 3 minutes).

**US-015 built:** the Kuma push monitor `ebt worker heartbeat` (120 s) and the worker's push; trigger and recovery: `alert-drill.sh worker-kill` and `worker-recover` (on the VM, as root).

1. Note `T_start` and kill the worker: `systemctl --user kill --signal=SIGKILL worker.service` as the app user (`Restart=always` brings it back, so for the drill also `systemctl --user stop worker.service` to keep it down).
2. Watch Kuma: the push monitor goes red when its heartbeat is missing (record `Detected`).
3. Expected: a WhatsApp message **and** an e-mail to the Owner within **3 minutes** of `T_start`; the deep `/healthz` answers failing within 3 minutes.
4. Start the worker (`systemctl --user start worker.service`), record `Recovered` (Kuma green, a "recovered" notification if configured, the outbox drained: `SELECT count(*) FROM outbox WHERE processed_at IS NULL` falls to 0).
5. **Escaping, once (US-015 review).** The WhatsApp notification's body is `"text": {{ msg | json }}`; a message with a `"`, a backslash or a line break must arrive whole. On the monitoring box run
   `alert-drill.sh kuma-escape down --push-url https://<kuma>/api/push/<the alerts backstop's token>`: the WhatsApp text and the e-mail must show the quoted word, the backslash, both lines and the braces
   (WAHA answering 400, or a message cut at the quote, means the template is wrong: fix the notification, not the drill). Then `kuma-escape up --push-url ...` and check the monitor is green again.

| Run | Date, operator | Start (kill) | Detected | WA received | E-mail received | Recovered | Pass / fail (3 min) | Restored |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | worker started |

## D3. Stop a WAHA session: WhatsApp and e-mail within 3 minutes (AC-P12; plan alert "WAHA session")

**Needs [US-015]:** the internal check "WAHA session not `WORKING` for more than 2 minutes" and the alert delivery (WhatsApp from another number or from Kuma's route, plus e-mail). Use a spare session if there is one: the alert's WhatsApp leg must not depend on the session being stopped.

**US-015 built:** two routes. (a) Kuma's read-only JSON-query monitor `waha session <name> working` on WAHA's own `GET /api/sessions/<name>` (`status` must be `WORKING`; 60 s, 1 retry) notifies by WhatsApp from the alert session and by e-mail, independent of the worker and the app VM. (b) The worker's own session poll raises its alert and the relay sends it ([alerts.md](runbooks/alerts.md)). Trigger: `alert-drill.sh waha-session stop|start --waha <url> --session <name>` (the mock by default; a real WAHA needs `--real`).

1. Note `T_start` and stop one pool session in WAHA (dashboard, "Stop"). Never "Logout" or re-pair it: that burns the number.
2. The health poll sees it (`waha_sessions.status` leaves `WORKING`); the check fires after 2 minutes: the alert row `waha_session_down` (warning) appears, deduplicated over 30 minutes.
3. Expected: WhatsApp **and** e-mail within **3 minutes** of `T_start`. With one session left, deliveries fail over to it (AC-D4); with none, the critical `wa_pool_empty` follows and the e-mail path stays up.
4. Start the session again; record `Recovered` (`status = WORKING`).

| Run | Date, operator | Start (stop) | Detected | WA received | E-mail received | Recovered | Pass / fail (3 min) | Restored |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | session started |

## D4. The VM goes down: WhatsApp through Kuma to WAHA, plus e-mail (AC-P4, AC-P12; the plan's bold row)

**Needs [US-015]:** Kuma and its `/healthz` monitors on the **WAHA box** (not the app VM), Kuma's WhatsApp notification as a **webhook straight to WAHA `sendText`** on that box (so it does not depend on the app VM), and its e-mail notification.

**US-015 built:** Kuma on the WAHA box with `ebt api healthz`, `ebt admin healthz`, `ebt play`, `ebt order`, `ebt vm ping` and `ebt vm https port`, notifying by the WAHA `sendText` webhook and by SMTP ([monitoring.md](runbooks/monitoring.md)). The Kuma address must be in `MONITOR_ALLOWED_CIDRS` and `ADMIN_ALLOWED_CIDRS` (go-live GL-06). The HTTP-down case: `alert-drill.sh vm-down` and `vm-recover`.

1. Note `T_start` and make the VM unreachable: stop `caddy.socket` and `caddy.service` for the HTTP-down case, then repeat the drill with the VM powered off from the provider console for the VM-down case (record each as its own row).
2. Kuma's api, play and admin monitors turn red after their retries (every 60 s). Record `Detected`.
3. Expected: a WhatsApp message (sent by Kuma through the WAHA `sendText` webhook) **and** an e-mail to the Owner, within the time the monitors' retry count implies (target: 3 minutes). The WhatsApp must arrive although the app VM, its worker and its database are down: that is the point of the drill.
4. Bring the VM back; record `Recovered` (monitors green, "up" notification).

| Run | Date, operator | Case (HTTP down / VM off) | Start | Detected | WA received (via Kuma to WAHA) | E-mail received | Recovered | Pass / fail | Restored |
|---|---|---|---|---|---|---|---|---|---|
| 1 | | HTTP down | | | | | | | caddy started |
| 2 | | VM off | | | | | | | VM powered on |

## D5. A GlitchTip event: WhatsApp and e-mail, with PII masked (AC-P12)

**Needs [US-015]:** GlitchTip on the WAHA box with its alert webhook to `api.<DOMAIN>/hooks/glitchtip/<token>` (the internal process inserts an alert row only; the exact path, the 64 KB limit, the IP allowlist of the WAHA box), and the worker's relay of that alert to WhatsApp and e-mail.

**US-015 built:** GlitchTip 6.2.6 in `infra/monitoring/compose.yaml`, its alert rule with the e-mail and the webhook ([monitoring.md](runbooks/monitoring.md) section 5), the worker's alert relay ([alerts.md](runbooks/alerts.md)). Trigger: `alert-drill.sh glitchtip-event --dsn <DSN>` (a test event carrying a fake e-mail and a fake phone number); then on the VM `alert-drill.sh glitchtip-check` asserts the alert row holds `[email]` and `[number]` and none of the originals. GlitchTip's own e-mail of the event is the raw event.

1. Send an event that carries personal data to the GlitchTip project's own ingest endpoint with its DSN key (a `curl` POST of a Sentry-format event whose `message` is `fail for +62 812 3456 7890 budi@example.test`), so the path GlitchTip, alert webhook, internal process, worker relay is exercised; then, for the app's own scrubbing, cause a real error in the public app or the worker on staging (for example a checkout while PostgreSQL is stopped for 10 seconds) and read the event GlitchTip received.
2. Expected: GlitchTip shows the events with the phone and the e-mail **masked** (`@sentry/nextjs` scrubbing in the apps, `apps/worker/src/pii.ts` in the worker); an alert row `glitchtip_webhook` is created; WhatsApp and e-mail arrive within 3 minutes and contain **no** phone number, e-mail address, token or signed URL.
3. Record `Recovered` = the alert resolved or the GlitchTip issue closed.

| Run | Date, operator | Start (the error) | Detected (event in GlitchTip) | WA received | E-mail received | PII masked in GlitchTip, WA and e-mail (y/n) | Pass / fail | Restored |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |

## D6. The backup alerts (plan M4.8: base backup older than 26 h, WAL lag over 15 minutes)

**Needs [US-015]:** the backup jobs and their internal checks.

**US-015 built:** the alerts `backup_base_stale`, `backup_restic_stale`, `wal_archive_lag` (critical) and `valkey_memory_high` (warning) in `apps/worker/src/ops-checks.ts`, the failure alerts of the nightly scripts, and the relay. Triggers: `alert-drill.sh wal-break` / `wal-restore` (the WAL alert comes after 15 minutes), `backup-stale` / `backup-restore` (within a minute), `valkey-fill [percent]` / `valkey-clear` (go-live GL-17: add a third row to the table below for it).

1. WAL lag: `alert-drill.sh wal-break` saves the S3 credentials file (`/etc/ebooktrivia/postgres/walg_aws_credentials`) to a root-only copy and overwrites it **in place** with invalid keys, so every `archive_command` fails with an access error. (`ALTER SYSTEM SET archive_command` does **not** work: the quadlet starts the server with `-c archive_command=...` on the command line, which wins over `postgresql.auto.conf`.) Expected: the WAL alert after 15 minutes of lag, then WhatsApp and e-mail within 3 minutes; `alert-drill.sh wal-restore` puts the saved copy back, then check the lag falls to 0 (`SELECT last_archived_wal, last_failed_wal FROM pg_stat_archiver`). **Do not leave it broken**: a failing archive command keeps every WAL segment in `pg_wal`, about 16 MB a minute (23 GB a day) on a busy minute-by-minute archive; the disk and `pg_wal` alerts (`disk_free_low`, `pg_wal_large`, [alerts.md](runbooks/alerts.md)) fire first, and the drill is over when they do.
2. Base backup age: do not run the nightly `wal-g backup-push` (stop its timer for 27 hours), or set the alert's threshold to 1 minute on staging for the drill and put it back. Expected: the alert, WhatsApp and e-mail within 3 minutes of the threshold.

| Run | Date, operator | Check (WAL lag / base backup age) | Start | Detected | WA received | E-mail received | Recovered | Pass / fail | Restored |
|---|---|---|---|---|---|---|---|---|---|
| 1 | | WAL lag | | | | | | | |
| 2 | | Base backup age | | | | | | | |

## D7. Payment and delivery alerts that this codebase raises (what the Owner will be woken for)

The alert rows are written by the worker (`alerts`: `source`, `kind`, `severity`, `dedupe_key`, `message`, `payload`); **delivery of an alert row to WhatsApp and e-mail is [US-015]'s relay** (built: [alerts.md](runbooks/alerts.md); the Owner sets the recipients under Admin, Alerts, and writes to every pool number once first, from the alert phone). Two things are drilled per alert: **(a)** the application raises it for its real trigger (the detection logic is covered by the tests named below, so on staging use the real trigger where the Midtrans sandbox allows it and the synthetic row where it does not), and **(b)** it reaches the Owner by WhatsApp and e-mail within 3 minutes. The synthetic row, for (b), is inserted as the worker role:

```sh
# on the VM; the severity is the alert's own (see the table)
podman exec -i postgres psql -U postgres -d ebooktrivia -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE worker_rw;
INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload)
VALUES ('worker', 'payment_paid_reversed', 'critical', 'drill:' || gen_random_uuid(), 'DRILL: ignore', '{}'::jsonb);
SQL
```

| Alert (severity) | Real trigger on staging | Detection covered by | Expected |
|---|---|---|---|
| `payment_paid_reversed` (critical) | Pay an order with the sandbox test card (capture, accept: PAID), then `POST https://api.sandbox.midtrans.com/v2/{midtrans_order_id}/cancel` with the sandbox server key; the notification and the re-query put the order in `review` (D9). **To confirm on the sandbox** (R12 did not record a cancel after capture). | `apps/worker/test/payments.int.test.ts`, `packages/core/src/order-machine.test.ts` | the order is in the Owner review queue, the buyer's magic links are revoked when no program is left, and the alert reaches WhatsApp and e-mail |
| `order_decision_superseded` (critical) | Pay with the challenge test card (`4511 1111 1111 1117`, FDS challenge): the order goes to `review`; the Owner presses "mark paid" in the review queue; then `POST /v2/{id}/deny` (or cancel) in the sandbox. A new Midtrans event contradicts the decision. **To confirm on the sandbox.** | `apps/worker/test/order-review.int.test.ts` | the alert names the order; the decision is recorded and the order is back in the queue |
| `payment_on_erased_order` (critical) | Not reproducible through the sandbox (erasure is refused for a pending order, and an expired order's Snap window has closed): use the synthetic row for (b); (a) is the integration test. | `apps/worker/test/order-review.int.test.ts` (erased-order case), `apps/worker/test/payments-erased.int.test.ts` | the order is in the review queue, nothing delivered, the alert reaches the Owner |
| `payment_chargeback` (critical) | Docs only until a real chargeback is recorded (go-live GL-35): synthetic row for (b). | `apps/worker/test/payments.int.test.ts` | WhatsApp and e-mail |
| `payment_double_settlement` (critical) | Pay the same order twice: pay it, then use the Snap page's "change payment method" on a second attempt of the same order and settle that too. **To confirm on the sandbox.** | `apps/worker/test/payments.int.test.ts` | possible double charge flagged, no second delivery |
| `payment_settlement_review` / `payment_requery_failed` / `payment_requery_misconfigured` (critical) | A wrong server key in the console makes the re-query fail (`payment_requery_misconfigured` at once); restore the key. | `apps/worker/test/payments.int.test.ts`, `midtrans-access.int.test.ts` | alert at once, orders stay pending, nothing paid by guesswork |
| `checkout_no_payment_methods` (critical) | The console refuses to save an empty list: empty the setting with SQL on staging. | `apps/public/test/checkout.int.test.ts` | the checkout answers 503 and the alert is raised |
| `delivery_wrong_file` / `delivery_not_attempted` / `delivery_failed` (critical) | Break the file route (stop the public app's `/files` or rename the PDF) during a paid order. | `apps/worker/test/delivery-file-check.int.test.ts` | nothing sent wrongly, alert, the e-mail path unaffected |
| `waha_session_failing`, `wa_pool_empty`, `wa_reachout_blocked` (critical) | D3 with every session stopped (`wa_pool_empty`); the others are WhatsApp-side and cannot be provoked: synthetic row. | `apps/worker/test/delivery-edge.int.test.ts`, `delivery-limits.int.test.ts` | WhatsApp and e-mail |
| `play_reveal_misuse` (warning) | A reveal more than 60 s after the answer, or more than twice per answer, is refused and flagged; the alert is raised once 3 distinct attempts were flagged within an hour (migration 0023, `docs/runbooks/security-scans.md`). Provoke it on staging with late `play_reveal` calls of three attempts, or use the synthetic row for (b). | `packages/db/test/play-flow.int.test.ts` "raises ONE open play_reveal_misuse alert once 3 distinct attempts are flagged within an hour, with ids and counts only" | the alert reaches the Owner by WhatsApp and e-mail |

(US-015: the `source` of a synthetic row must be one of `internal`, `glitchtip`, `worker`, `monitor`, `admin` (`alerts_source_check`): the example above said `drill` and would have been refused; it now says `worker`. For a critical row with a fixed message and the seconds to notify, `alert-drill.sh relay-critical` then `relay-check` does the same.)

**US-015 sub-drills of D7** (record each as its own row of the table below):

- **The test alert.** Admin, Alerts, save the Owner's number and e-mail, press **Send a test alert**: WhatsApp and e-mail arrive within 2 minutes. Row kind: `test_alert`.
- **A second critical alert while the first is unresolved** is sent (the relay's digest, not Kuma): write two critical rows two minutes apart with `alert-drill.sh relay-critical`; both arrive.
- **The backstop.** Blank the e-mail address and the number in Admin, Alerts (so nothing can be sent) and write one critical row: after 5 minutes Kuma's `ebt alerts backstop` turns red and the Owner is told by Kuma's WhatsApp and e-mail; restore the recipients and resolve the row. Row kind: `backstop`.
- **One channel down.** Break the SMTP password in the console (restore it after) and write a critical row: the WhatsApp arrives, the row is marked sent, the worker logs `alert relay: the e-mail was not sent`. Row kind: `one channel`.

| Run | Date, operator | Alert kind | Trigger (real / synthetic) | Start | Alert row seen | WA received | E-mail received | Pass / fail (3 min) |
|---|---|---|---|---|---|---|---|---|
| 1 | | `payment_paid_reversed` | | | | | | |
| 2 | | `order_decision_superseded` | | | | | | |
| 3 | | `payment_on_erased_order` | synthetic | | | | | |
| 4 | | `payment_chargeback` | synthetic | | | | | |
| 5 | | `delivery_wrong_file` | | | | | | |
| 6 | | `checkout_no_payment_methods` | | | | | | |

## D8. The forced-failure deploy rolls back (AC-P11; added by US-015)

**Needs:** the deploy pipeline on staging ([deploy.md](runbooks/deploy.md) sections 1, 2 and 6): the GitHub environments and their secrets, the deploy login on the VM, the images in GHCR.

1. On the staging VM: `sudo touch /etc/ebooktrivia/deploy.allow-failure-drill`. Note `T_start`.
2. Actions, `deploy`, "Run workflow", environment `staging`, **force_failure** = `after_public_a` (then repeat with `health`).
3. Expected: the job's deploy step ends with a forced failure **and a rollback** (exit 10; the log says `DEPLOY FAILED and ROLLED BACK`), the job is green, `ebt-remote-deploy status` shows the stack on the **previous** images, `/healthz` of `api.<DOMAIN>` answers `{"status":"ok"}`, and the requests of a probe (`curl` in a loop against `play.<DOMAIN>`) did not fail during the roll.
4. Remove the drill file (`sudo rm /etc/ebooktrivia/deploy.allow-failure-drill`; `host-check.sh` prints a note while it exists). Record `Recovered` = the healthy stack on the previous images.

Locally proven (`infra/verify/local/deploy-sim.sh`): the forced-failure rollback and a natural failure (a broken image) in the vm-sim and stack-sim containers; **not** on GHCR, the real VM or GitHub.

| Run | Date, operator | Forced step | Start | Failure seen | Rollback complete | Recovered (previous images, healthy) | Failed requests during the roll | Pass / fail |
|---|---|---|---|---|---|---|---|---|
| 1 | | `after_public_a` | | | | | | |
| 2 | | `health` | | | | | | |

---

## Load test log

The k6 runs are logged in [infra/load/README.md](../infra/load/README.md) "Run log" (go-live GL-60, GL-62). A drill and a load test never run at the same time.
