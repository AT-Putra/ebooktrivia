# Drills: the final PITR restore drill and the alert drills (US-032, plan M4 Verify and M11 item 3)

These are procedures and logs, not results. **Nothing in this file has been run**: the staging VM, the S3 bucket, the monitoring box and the credentials do not exist yet (US-014, US-015). Each drill is written against the plan's design, and every step that needs something US-015 builds is marked **[US-015]** (named, so it can be checked when US-015 lands). Fill the timing tables with real clock times; a drill with an empty table has not been done ([go-live.md](go-live.md) GL-67, GL-68).

## Rules for every drill

- Run on **staging** (the same scripts and size as production), never on production, except the VM-down and PITR drills' separate clean VM.
- Use the **Owner's own** WhatsApp number and e-mail address as the alert recipient. Never a buyer's.
- Time with one clock (UTC, `date -u +%H:%M:%S` on the VM, the phone's clock for what the Owner sees, synchronised to the second). A row is **pass** only when every "Expected" below holds and the timings meet the limit.
- Write down what you changed so it can be put back (the table's "Restored" column). A drill that leaves the stack changed is not finished.
- Every drill's columns: **Start** (the action), **Detected** (the monitor noticed: the Kuma monitor turns red, the alert row appears), **WA received**, **E-mail received**, **Recovered** (the thing works again), **Pass / fail**, and a note.

---

## D1. PITR restore drill on a clean VM (AC-P3; RTO at most 2 hours, RPO about 1 minute)

**What it proves.** A new VM, given only the escrow ([docs/escrow.md](escrow.md) **[US-015]**: the scope private keys, `WAHA_WEBHOOK_HMAC_SECRET`, the wal-g libsodium key and the S3 credentials, the restic password, the env files) and the repository, restores the database to a chosen instant, starts the application, and loses at most about a minute of data.

**Before: plant a marker (on staging).**

1. Place a synthetic order through the real flow and note its order code, or `INSERT` a row in a scratch table through `podman exec postgres psql`. Record the commit time `T_marker` (`SELECT now()`).
2. Wait 3 minutes (so WAL archiving has shipped past `T_marker`; the WAL archive lag alert must be green), then place a **second** marker `T_late` and immediately "lose" the VM (power it off from the provider console). `T_late` is allowed to be lost (it is inside the RPO window); `T_marker` must not be.
3. Take `T0` = the moment the VM is declared lost. The RTO clock runs from `T0`.

**Restore (new VM, same size).**

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

**Verify** (each one a checkbox in the log): `T_marker`'s data is present and `T_late`'s is absent or present (record which); the row counts of `orders`, `payments`, `deliveries` and `conversion_events` equal the last known numbers within the RPO window; `host-check.sh` passes; the nightly reconciliation runs and reports no mismatch (`reconciliation_mismatch` raises none); a login works (OTP or magic link); a sandbox checkout reaches Snap; the worker heartbeat is fresh; no secret was needed that is not in the escrow (**list any that was**: that is a failed drill).

**Result.** **RTO** = `T_end - T0` (limit 2 h). **RPO** = `T_loss - (last row recovered)`, where `T_loss` is the power-off time (about 1 minute expected from the WAL archive interval).

| Run | Date, operator | T0 (VM declared lost) | Restore started | PostgreSQL up | T_marker present | App verified `T_end` | RTO | RPO | Escrow complete (y/n, missing) | Pass / fail |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | | |
| 2 | | | | | | | | | | |

---

## D2. Kill the worker: push alert within 3 minutes (AC-P12, AC-P4)

**Needs [US-015]:** the worker push monitor in Uptime Kuma (the worker pushes a heartbeat to `UPTIME_KUMA_PUSH_URL` every 60 s), Kuma's WhatsApp notification (webhook to the WAHA `sendText` API) and its e-mail notification, and the deep `/healthz` that includes the heartbeat freshness (at most 3 minutes).

1. Note `T_start` and kill the worker: `systemctl --user kill --signal=SIGKILL worker.service` as the app user (`Restart=always` brings it back, so for the drill also `systemctl --user stop worker.service` to keep it down).
2. Watch Kuma: the push monitor goes red when its heartbeat is missing (record `Detected`).
3. Expected: a WhatsApp message **and** an e-mail to the Owner within **3 minutes** of `T_start`; the deep `/healthz` answers failing within 3 minutes.
4. Start the worker (`systemctl --user start worker.service`), record `Recovered` (Kuma green, a "recovered" notification if configured, the outbox drained: `SELECT count(*) FROM outbox WHERE processed_at IS NULL` falls to 0).

| Run | Date, operator | Start (kill) | Detected | WA received | E-mail received | Recovered | Pass / fail (3 min) | Restored |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | worker started |

## D3. Stop a WAHA session: WhatsApp and e-mail within 3 minutes (AC-P12; plan alert "WAHA session")

**Needs [US-015]:** the internal check "WAHA session not `WORKING` for more than 2 minutes" and the alert delivery (WhatsApp from another number or from Kuma's route, plus e-mail). Use a spare session if there is one: the alert's WhatsApp leg must not depend on the session being stopped.

1. Note `T_start` and stop one pool session in WAHA (dashboard, "Stop"). Never "Logout" or re-pair it: that burns the number.
2. The health poll sees it (`waha_sessions.status` leaves `WORKING`); the check fires after 2 minutes: the alert row `waha_session_down` (warning) appears, deduplicated over 30 minutes.
3. Expected: WhatsApp **and** e-mail within **3 minutes** of `T_start`. With one session left, deliveries fail over to it (AC-D4); with none, the critical `wa_pool_empty` follows and the e-mail path stays up.
4. Start the session again; record `Recovered` (`status = WORKING`).

| Run | Date, operator | Start (stop) | Detected | WA received | E-mail received | Recovered | Pass / fail (3 min) | Restored |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | session started |

## D4. The VM goes down: WhatsApp through Kuma to WAHA, plus e-mail (AC-P4, AC-P12; the plan's bold row)

**Needs [US-015]:** Kuma and its `/healthz` monitors on the **WAHA box** (not the app VM), Kuma's WhatsApp notification as a **webhook straight to WAHA `sendText`** on that box (so it does not depend on the app VM), and its e-mail notification.

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

1. Send an event that carries personal data to the GlitchTip project's own ingest endpoint with its DSN key (a `curl` POST of a Sentry-format event whose `message` is `fail for +62 812 3456 7890 budi@example.test`), so the path GlitchTip, alert webhook, internal process, worker relay is exercised; then, for the app's own scrubbing, cause a real error in the public app or the worker on staging (for example a checkout while PostgreSQL is stopped for 10 seconds) and read the event GlitchTip received.
2. Expected: GlitchTip shows the events with the phone and the e-mail **masked** (`@sentry/nextjs` scrubbing in the apps, `apps/worker/src/pii.ts` in the worker); an alert row `glitchtip_webhook` is created; WhatsApp and e-mail arrive within 3 minutes and contain **no** phone number, e-mail address, token or signed URL.
3. Record `Recovered` = the alert resolved or the GlitchTip issue closed.

| Run | Date, operator | Start (the error) | Detected (event in GlitchTip) | WA received | E-mail received | PII masked in GlitchTip, WA and e-mail (y/n) | Pass / fail | Restored |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |

## D6. The backup alerts (plan M4.8: base backup older than 26 h, WAL lag over 15 minutes)

**Needs [US-015]:** the backup jobs and their internal checks.

1. WAL lag: block the S3 endpoint for the app user for about 20 minutes (an `nft` rule on the VM or a wrong credential in a copy of the env), or pause archiving (`archive_command` to `false` through `ALTER SYSTEM`, reload). Expected: the WAL alert after 15 minutes of lag, then WhatsApp and e-mail within 3 minutes; restore the setting and check the lag falls to 0.
2. Base backup age: do not run the nightly `wal-g backup-push` (stop its timer for 27 hours), or set the alert's threshold to 1 minute on staging for the drill and put it back. Expected: the alert, WhatsApp and e-mail within 3 minutes of the threshold.

| Run | Date, operator | Check (WAL lag / base backup age) | Start | Detected | WA received | E-mail received | Recovered | Pass / fail | Restored |
|---|---|---|---|---|---|---|---|---|---|
| 1 | | WAL lag | | | | | | | |
| 2 | | Base backup age | | | | | | | |

## D7. Payment and delivery alerts that this codebase raises (what the Owner will be woken for)

The alert rows are written by the worker (`alerts`: `source`, `kind`, `severity`, `dedupe_key`, `message`, `payload`); **delivery of an alert row to WhatsApp and e-mail is [US-015]'s relay**. Two things are drilled per alert: **(a)** the application raises it for its real trigger (the detection logic is covered by the tests named below, so on staging use the real trigger where the Midtrans sandbox allows it and the synthetic row where it does not), and **(b)** it reaches the Owner by WhatsApp and e-mail within 3 minutes. The synthetic row, for (b), is inserted as the worker role:

```sh
# on the VM; the severity is the alert's own (see the table)
podman exec -i postgres psql -U postgres -d ebooktrivia -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE worker_rw;
INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload)
VALUES ('drill', 'payment_paid_reversed', 'critical', 'drill:' || gen_random_uuid(), 'DRILL: ignore', '{}'::jsonb);
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

| Run | Date, operator | Alert kind | Trigger (real / synthetic) | Start | Alert row seen | WA received | E-mail received | Pass / fail (3 min) |
|---|---|---|---|---|---|---|---|---|
| 1 | | `payment_paid_reversed` | | | | | | |
| 2 | | `order_decision_superseded` | | | | | | |
| 3 | | `payment_on_erased_order` | synthetic | | | | | |
| 4 | | `payment_chargeback` | synthetic | | | | | |
| 5 | | `delivery_wrong_file` | | | | | | |
| 6 | | `checkout_no_payment_methods` | | | | | | |

---

## Load test log

The k6 runs are logged in [infra/load/README.md](../infra/load/README.md) "Run log" (go-live GL-60, GL-62). A drill and a load test never run at the same time.
