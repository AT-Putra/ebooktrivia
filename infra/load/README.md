# Load tests (US-032, plan M11 item 2): k6 on staging

Two tests, both run from a **separate machine** against **staging** (4 vCPU / 8 GB, the production size), with k6 from the official Docker image pinned by digest:

| Test | Script | AC | Pass |
|---|---|---|---|
| `trivia-500` | `k6/trivia-500.js` | AC-Q13 | 500 VUs answering: **p95 of the answer submit < 300 ms**, **errors < 0.1 %** (k6 exits 99 on a miss) |
| `orders-50pm` | `k6/orders-50pm.js` + `src/verify-p8.ts` | AC-P8 | 50 orders a minute for 10 minutes through the real checkout and the Midtrans sandbox; the reconciliation identity (**zero lost orders, zero duplicate MTs, zero lost delivery jobs**) holds |

**Status: built and dry-run locally at small scale; the real runs wait for the staging VM (US-014/US-015).** A local number is never the AC result. The results go in the log at the end of this file and in [docs/go-live.md](../../docs/go-live.md) (items GL-60 to GL-68).

## What is here

| File | Role |
|---|---|
| `run.sh` | Runs a test with the pinned k6 image (`trivia`, `orders`, `version`). k6 v2.3.0, `docker.io/grafana/k6@sha256:2dd4756e...`, see [docs/versions.md](../../docs/versions.md) |
| `k6/trivia-500.js`, `k6/orders-50pm.js`, `k6/lib.js` | The scripts. Thresholds are encoded in them, so k6 exits non-zero on a miss |
| `src/seed.ts` (+ `seed-lib.ts`, `guard.ts`) | `trivia`, `orders` and `cleanup` commands: the data the tests need, in a STAGING or DEV database only |
| `src/login.ts` | Turns the seeded magic links into real player sessions through the app's own login route |
| `src/cap-pool.ts` (+ `cap-solver.ts`, `cap-worker.ts`) | Makes the Cap tokens of the orders run |
| `src/settle.ts` | Pays the pending orders so there are PAID orders to carry (see "Settlement") |
| `src/verify-p8.ts` | The post-run proof of AC-P8, over the database |
| `src/local-dry-run.ts` | The local dry run of all of it (dev stack, small scale) |

Tests: `pnpm exec vitest run infra/load` (unit, in the root `pnpm test`) and `pnpm --filter @ebooktrivia/load test:int` (seed, cleanup and the verifier against the real schema, with each identity broken in turn).

## Design decisions

- **Sessions, no bypass.** `seed.ts trivia` makes the players (eligible for the program, as a paid order leaves them, every set unlocked by back-dating `first_paid_at` under the per-player schedule of AC-Q4) and one magic link each, with plain INSERTs and the app's own `issue_magic_link` function. `login.ts` then POSTs each token to `POST /api/v1/play/auth/magic-link`, exactly as the confirm page does, and keeps the `__Host-play_session` cookie. Better Auth creates the session, signs the cookie and starts the rotation chain; k6 follows a rotated cookie like a browser. The app has no test-only code, no secret leaves the VM, and no order or delivery exists for the seeded players, so nothing can ever be sent to their numbers.
- **Cap at the production difficulty, pre-solved.** The app's Cap (stateless, 50 sub-challenges of 4 hex digits) costs about 6 CPU-seconds per token; k6 cannot solve one per order. `cap-pool.ts` calls the app's own `POST /api/v1/cap/{lpKey}/challenge` and `/redeem`, solves the proof of work with native hashing on every core (`worker_threads`), and writes the redeemed tokens. No bypass, no weaker difficulty (the app has no "staging difficulty" switch: the plan's "config only" does not exist, so staging runs the production one). A token is single use, bound to the landing page, and valid until its challenge's expiry plus 10 minutes, about 20 minutes after it was issued; `run.sh orders` makes the pool right before k6 starts and k6 refuses a pool that is too small or about to expire. `src/cap-pool.test.ts` proves the solver against the real provider.
- **The guard.** `seed.ts`, `settle.ts` and the local harness refuse to touch a database unless **all** hold (`src/guard.ts`, tested): `LOAD_TARGET_ENV` is exactly `staging` or `dev`; the database URL names one plain TCP host (no `host` or `hostaddr` query parameter, which postgres.js lets override the URL's host, no list of hosts, no socket path) and the targets postgres.js actually resolved (`sql.options`) are checked again; that host is loopback or listed in `LOAD_ALLOWED_DB_HOSTS`; `app_settings midtrans.environment` is `"sandbox"` (production flips it at go-live); and `app_settings deployment.environment` equals `LOAD_TARGET_ENV`. **The host allowlist is not a staging-vs-production separator**: the database container has the same pinned address (10.89.51.2) on staging and on production, so it only stops a typo from reaching an arbitrary host. **The real guard is the database's own markers**: the Midtrans environment and the `deployment.environment` row, the staging marker, written once by the operator on a staging or dev database and never on production (go-live item GL-61 checks it is absent there). The database URL is read from `LOAD_DATABASE_URL`, never from an argument. `cleanup` and `settle` act only on rows whose names are `LOADTEST <8 hex digits>`. For an orders run the tools also refuse unless **WhatsApp is off** (next section).
- **Cleanup.** `seed.ts cleanup --run <id>` deletes a trivia run completely (players, attempts, sessions' users, links, program, sets, questions, product). An orders run owns financial and delivery rows that the database keeps (append-only, restrict keys), so cleanup **retires** it: the landing page, adnet and product are deactivated, and every delivery and conversion not yet sent is cancelled or failed, so that nothing reaches a load-test buyer when WhatsApp is switched back on. Staging is ephemeral (plan §10 item 15): destroying the VM is the final cleanup.

## Limits for the run (Owner, Admin > Settings > Limits; audited; restore the defaults afterwards)

One load generator is one client IP, and the public API rate-limits per IP. Set these before, restore after (defaults in brackets):

| Key | For the run | Why |
|---|---|---|
| `otp.ip_cap` / `otp.ip_window_seconds` | 100 / 600 [10 / 3600] | `login.ts` logs 500 players in from one IP: the route allows `ip_cap x otp.max_attempts (5)` per window, so 500 per 10 minutes (it waits out a 429 and goes on, but slowly) |
| `checkout.ip_cap` | 1000 [100] | 550 checkouts from one IP in a 600 s window |
| `captcha.ip_cap` / `captcha.ip_window_seconds` | 1000 / 60 [300 / 600] | the pool needs two requests per token (about 1100 requests); the window bound is 60 s minimum |
| `delivery.wa_delay_seconds` | 86400 [180] | belt and braces for the orders run: no proactive WhatsApp opener leaves for ten hours (see the next section) |

The leaderboard refresh (120 a minute per client network) is not raised: k6 treats its 429 as expected and counts it (`leaderboard_rate_limited`); the answer path has no per-IP limit.

## Before the orders run: nothing may be sent to strangers

The buyers of `orders-50pm` are synthetic: valid Indonesian mobile numbers (`+62812` and 8 digits) that may belong to real people, and e-mail addresses on `EMAIL_DOMAIN`.

1. **WhatsApp off, ENFORCED.** In Admin > Settings > WAHA, set every session inactive, and set `delivery.wa_delay_seconds` to 86400. `seed.ts orders` and every poll of `settle.ts` **refuse to run** unless no WAHA session is active and the delay is at least 3600 seconds, and `verify-p8.ts` fails (identity 7) if any WhatsApp delivery of the run is `sent`. A delivery with no usable number waits (`pending`), which is all the identity needs: the **row** must exist (with WhatsApp off, only the e-mail jobs are proven processed). The validator allows no reserved or non-routable mobile range (every block 81x to 83x and 85x to 89x, 9 to 12 digits, is in service), so the buyers' numbers cannot be made safe by their shape: the enforcement is the protection. Do not switch the sessions back on before step 6 of procedure B (the cleanup), which cancels the unsent WhatsApp deliveries.
2. **E-mail to a sink.** Use an `EMAIL_DOMAIN` you own (a catch-all mailbox) or point Admin > Settings > SMTP at a sink (Mailpit) for the run. Restore the real SMTP afterwards.
3. **Postback sink.** The adnet's MO and MT postbacks go to `--postback-url`: any HTTPS endpoint that answers 2xx and that you control (a small listener on the load machine behind a tunnel, or a request bin you run). It must not be a third party's.

## Settlement: how orders become PAID (the open point)

The Snap payment page cannot be scripted (captcha and signed calls, [docs/spikes/R12.md](../../docs/spikes/R12.md)), and the worker never trusts a notification: it re-queries Midtrans, so a forged notification settles nothing. `orders-50pm.js` therefore creates the orders (checkout, Cap, rate limits, the Snap transaction in the sandbox, MO) and `settle.ts` makes the payments exist:

- `--mode stub` is **local only** (the dev stack's midtrans-stub: its control plane plus its signed notification). It is what the dry run uses.
- `--mode sandbox-card` is the **staging** mode and is **UNVERIFIED**: it pays each order through Midtrans' documented Core API (a card token from the public test card, then `POST /v2/charge` for the order's own `midtrans_order_id`, without 3-D Secure). It assumes the sandbox accepts a Core API charge for an order id whose Snap transaction has no method chosen yet (R12: Get Status answers 404 for it). Nobody has run it. **Step 1 of the staging run is a 5-order trial** (`--limit 5`); the tool stops after three identical refusals. If Midtrans refuses, the fallback is to pay N orders by hand in a browser (R12 "Refreshing the recording") and let `verify-p8.ts` cover those, which proves the identity for N and the checkout capacity for 500. This is an Owner decision to take if the trial fails (go-live item GL-63).
- The sandbox dashboard's **Payment Notification URL must point at staging** (`https://api.<DOMAIN>/api/v1/webhooks/midtrans`), or the worker only learns of the payments from the nightly reconciliation.

## Procedure on staging

Variables: `DOMAIN` is the staging base domain. The **database is reachable from the data network only** (pg_hba admits each login from its pinned address), so the three database tools (`seed.ts`, `settle.ts`, `verify-p8.ts`) run in a one-shot container of the worker image on `ebt-data` with the migrator's pinned address, the way [admin-access.md](../../docs/runbooks/admin-access.md) runs its CLI. **This container recipe is UNVERIFIED (no VM yet)**: the checkout's `infra/load/src` is mounted into the worker image, where Node finds `postgres` and `@ebooktrivia/core` under `apps/worker/node_modules`. If the layout differs, fix the mount path here.

```sh
# on the VM, from the checkout (/opt/ebooktrivia); the app user runs podman as in docs/runbooks/staging-provision.md
loadtool() { sudo runuser -u ebt -- env HOME="$(getent passwd ebt | cut -d: -f6)" XDG_RUNTIME_DIR="/run/user/$(id -u ebt)" \
  podman run --rm --network ebt-data:ip=10.89.51.16 --env-file /etc/ebooktrivia/migrate.env \
    --env-file /etc/ebooktrivia/load-sandbox.env \
    -e LOAD_TARGET_ENV=staging -e LOAD_ALLOWED_DB_HOSTS=10.89.51.2 \
    -v /opt/ebooktrivia/infra/load/src:/app/apps/worker/load:ro,Z -v /srv/load:/out:Z \
    localhost/ebooktrivia/worker:current sh -c 'LOAD_DATABASE_URL="$DATABASE_URL" exec node apps/worker/load/"$0" "$@"' "$@"; }
# once: the sandbox keys for settle.ts go in a root-owned 0600 env file (never on a command line, never in the shell history); step 7 deletes it
sudo install -m 0600 -o ebt /dev/null /etc/ebooktrivia/load-sandbox.env   # then edit: MIDTRANS_SANDBOX_SERVER_KEY=... and MIDTRANS_SANDBOX_CLIENT_KEY=...
# once: mark the database as staging (GL-61); the postgres superuser logs in over the local socket inside its container
sudo runuser -u ebt -- env HOME="$(getent passwd ebt | cut -d: -f6)" XDG_RUNTIME_DIR="/run/user/$(id -u ebt)" \
  podman exec postgres psql -U postgres -d ebooktrivia -c \
  "INSERT INTO app_settings (key, value) VALUES ('deployment.environment', '\"staging\"') ON CONFLICT (key) DO NOTHING"
```

### A. trivia-500 (AC-Q13)

Sizing: one player plays each set once, so `sets x questions x average think time` must cover ramp + hold. With the default think time (1 to 3 s, 2 s on average), 10 sets x 10 questions is 200 s of answering per VU; for ramp 60 s + hold 300 s use **10 sets x 20 questions** (400 s) or raise the think time. The question timer is 20 s: THINK_MAX_MS must stay 3 s under it (k6 refuses otherwise).

1. Owner raises the limits above. Check Settings > OTP / rate limits, program and product exist (the seed creates its own).
2. `loadtool seed.ts trivia --players 500 --sets 10 --questions 20 --out /out/links.json` (on the VM), then copy `/srv/load/links.json` to the load machine's `infra/load/work/`.
3. On the load machine: `node infra/load/src/login.ts --play-origin https://play.$DOMAIN --links infra/load/work/links.json --out infra/load/work/sessions.json`. 500 real sessions; the magic links live 72 hours.
4. `infra/load/run.sh trivia` (defaults: 500 VUs, 60 s ramp, 300 s hold). Exit 0 = AC-Q13 met; 99 = a threshold missed (read `work/results/trivia-500-summary.json`: `http_req_duration{endpoint:answer}` p(95), `http_req_failed`).
5. Note on the VM during the run: `podman stats`, PostgreSQL CPU, the `public@a/b` event loops. Record the numbers in the log below.
6. `loadtool seed.ts cleanup --run <run id>` (the id is printed by the seed and is in `links.json`), then step 7 of procedure B for the files (`/srv/load/*`, and `infra/load/work` on the load machine: the session cookies are in it).

### B. orders-50pm (AC-P8)

1. Owner raises the limits above; WhatsApp off, SMTP sink, notification URL set (previous sections).
2. `loadtool seed.ts orders --lp-host lt-<anything>.<a domain you own>.example --postback-url https://<your sink>/postback --out /out/orders-config.json`. (The landing-page host only has to be a valid name: k6 sends it as `Origin`, nothing is served there.) Copy `orders-config.json` to the load machine's `infra/load/work/`.
3. **Trial:** `loadtool settle.ts --mode sandbox-card --lp-key <lp_key> --limit 5` after a 5-order run (`RATE_PER_MIN=5 DURATION=1m infra/load/run.sh orders`); confirm 5 PAID orders in the console and 5 emails in the sink. If refused, see "Settlement".
4. On the load machine: `API_ORIGIN=https://api.$DOMAIN EMAIL_DOMAIN=<your domain> infra/load/run.sh orders` (makes about 610 Cap tokens first, minutes, then runs 10 minutes). Start `loadtool settle.ts --mode sandbox-card --lp-key <lp_key> --rate 50 --idle-exit 120` on the VM at the same time (the sandbox keys come from `/etc/ebooktrivia/load-sandbox.env`, see above). `settle.ts` refuses to start unless WhatsApp is off, and checks it again before every poll.
5. Right after, copy `work/results/orders-50pm-summary.json` and `work/results/orders-50pm-run.json` from the load machine to `/srv/load/`, then: `loadtool verify-p8.ts --lp-key <lp_key> --k6-summary /out/orders-50pm-summary.json --run-file /out/orders-50pm-run.json --wait-seconds 600 --require-email-sent --out /out/p8-report.json`. The run file holds the start time `run.sh` wrote, so **only the orders created by this run count**: the 5-order trial of step 3 is on the same landing page and cannot cause a false FAIL (nor hide a loss). Exit 0 and "AC-P8 reconciliation identity HOLDS" is the AC. `1` names the broken identity.
6. `loadtool seed.ts cleanup --run <run id>` **before** switching the WhatsApp sessions back on. Restore the limits, SMTP, the WAHA sessions and `delivery.wa_delay_seconds`.
7. Delete what holds secrets: on the VM `sudo rm -rf /srv/load/* /etc/ebooktrivia/load-sandbox.env`, on the load machine `rm -rf infra/load/work` (login links, session cookies, Cap tokens, the results). Keep only the run log below.

### What the verifier proves (src/verify-p8.ts)

With O the orders of the run (created from the start time in the run file) and PAID those with status `paid`: (1) k6's count of new orders (the checkout's HTTP 200 with `deduped: false`) equals the orders with a Snap URL, none pending without one; (2) every such order has its MO outbox row, and one s2s MO row per attributed order; (3) every PAID order has its e-mail and WhatsApp delivery rows and its `order.paid` outbox row, none stuck in `sending`; (4) per adnet, s2s MT rows (sent + failed) = PAID orders with a click id, and no live MT row for an unpaid order (AC-T4); (5) no `(order, sink, kind)` twice and no MT postback answered 2xx twice; (6) after the wait, nothing of the run is pending or sending; (7) no WhatsApp delivery of the run is `sent`. The test `test/verify.int.test.ts` breaks each identity in turn and checks that it fails by name.

## Local dry run (dev stack, small scale; LOCAL numbers only)

`node infra/load/src/local-dry-run.ts` (Docker running; ports 3410 and 3412; each run builds apps/public first (incremental), SKIP_BUILD=1 reuses the build). It starts the real public app and the real worker against a throwaway database, runs both k6 scripts at 10 VUs / 20 orders a minute, settles through the stub, runs the verifier, and tears everything down. Its numbers are in "Run log" below, marked LOCAL.

### Result of the dry run of 2026-11-22 (LOCAL: a Windows laptop with Docker Desktop, shared dev services, other agents running; never the AC result)

| | Result |
|---|---|
| Trivia, 10 VUs, 5 sets x 6 questions, ramp 10 s + hold 60 s (101 s) | k6 exit 0; 300 answers, 0 failed requests, 1050 of 1050 checks; answer p95 **63 ms** (p99 77 ms, max 85 ms); an earlier identical run: p95 88 ms |
| Orders, 20 a minute for 2 minutes through the real checkout, 49 real Cap tokens (about 170 s to solve), the stub's Snap | k6 exit 0; 41 orders created, 0 dropped iterations, 0 failed requests, checkout p95 104 ms |
| Settlement | `settle.ts --mode stub`: 41 settled, 0 failed (the stub's signed notification to the real webhook, the worker's re-query) |
| AC-P8 verifier | **holds**: 41 = 41 orders with a Snap URL, 41 MO outbox rows and 41 s2s MO rows, 41 PAID with their e-mail and WhatsApp rows and `order.paid` rows, MT 41 sent + 0 failed = 41 PAID with a click id, nothing open after the drain, no live MT for an unpaid order |
| Independent check at the postback sink | 41 MT txids received, 0 received twice |
| PAID to e-mail (US-025 AC5, AC-D1), 41 e-mails to Mailpit | p50 **1070 ms**, p95 1173 ms, max 1261 ms (the budget is 10 s; the order of magnitude matches the earlier `delivery-worker.int` measurement, 670-780 ms alone) |
| Answer path (US-027 follow-up), from `pg_stat_user_functions` over the 300 answers | per answer 3 DEFINER calls: `play_answer` 0.45 ms, `play_settle` 1.30 ms (of which `play_settle_answer` 1.11 ms), `play_reveal` 0.27 ms: about **2.0 ms** of database time, against the 23.9 ms median of the whole request (the rest is the Next.js route, Better Auth's session lookup, the network). A static count of the SQL statements on the path: 7 in the three entry functions + `play_settle_answer` 12 + `play_settle_pending` 2 + `play_program_ms` 1 = **22** ("about 20"), plus the session lookup |
| Confirmation run after the review edits (rebased onto US-031, Valkey FCALL ACL, WhatsApp-off enforcement, run file) | all green again: trivia 300 answers, 0 errors, answer p95 **61 ms**; orders 40 created (0 dropped), settled 40, the verifier holds with **7** identities including "no WhatsApp delivery sent" and the start taken from `orders-50pm-run.json`; MT 40 sent = 40 PAID, the sink saw 40 MT txids once; PAID to e-mail p50 592 ms, p95 1201 ms, max 1245 ms; answer path about 2.1 ms of database time (0.46 + 1.22 + 0.40). Its first attempt failed with HTTP 503 because the harness reused a build from before the rebase (the old EVAL path against the new ACL): the harness now always builds first |
| Local-only findings fixed on the way | `run.sh` passed a Git Bash path to Windows Node; `settle.ts` gave up before the first order (the Cap pool takes minutes); `seed.ts` registered the adnet's endpoint host without its port (staging is https:443, so this would have shown only off the default port); cleanup decided trivia vs orders by order count |

## Run log (fill in; one block per run)

| | trivia-500 | orders-50pm |
|---|---|---|
| Date, operator | | |
| Target (domain, VM size, image digests) | | |
| Seed (run id, players / sets / questions; orders planned) | | |
| k6 exit code | | |
| p95 answer / errors % (AC-Q13) | | n/a |
| Orders created / dropped iterations / checkout errors % | n/a | |
| Verifier: identities 1 to 6 | n/a | |
| VM: peak CPU, memory, PostgreSQL connections | | |
| Limits changed and restored (who, when) | | |
| Pass / fail | | |
