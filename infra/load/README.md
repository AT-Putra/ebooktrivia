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
| `src/seed.ts` (+ `seed-lib.ts`, `guard.ts`) | `trivia`, `orders`, `demo` and `cleanup` commands: the data the tests need, in a STAGING or DEV database only |
| `src/login.ts` | Turns the seeded magic links into real player sessions through the app's own login route |
| `src/demo-lib.ts`, `src/demo-plan.ts`, `src/demo-play.ts` | Demo data for the staging leaderboard and reports: PAID fake buyers, the simulator that plays them, their cleanup (see "Demo data on staging") |
| `src/cap-pool.ts` (+ `cap-solver.ts`, `cap-worker.ts`) | Makes the Cap tokens of the orders run |
| `src/settle.ts` | Pays the pending orders so there are PAID orders to carry (see "Settlement") |
| `src/verify-p8.ts` | The post-run proof of AC-P8, over the database |
| `src/local-dry-run.ts` | The local dry run of all of it (dev stack, small scale) |
| `src/local-demo-run.ts` (+ `demo-fixture.ts`) | The local end-to-end run of the demo tools through the real public app and worker (dev stack, 3 buyers) |

Tests: `pnpm exec vitest run infra/load` (unit, in the root `pnpm test`) and `pnpm --filter @ebooktrivia/load test:int` (seed, cleanup and the verifier against the real schema, with each identity broken in turn; `test/demo.int.test.ts` runs the demo tools against the worker's own sweepers and reconciliation).

## Design decisions

- **Sessions, no bypass.** `seed.ts trivia` makes the players (eligible for the program, as a paid order leaves them, every set unlocked by back-dating `first_paid_at` under the per-player schedule of AC-Q4) and one magic link each, with plain INSERTs and the app's own `issue_magic_link` function. `login.ts` then POSTs each token to `POST /api/v1/play/auth/magic-link`, exactly as the confirm page does, and keeps the `__Host-play_session` cookie. Better Auth creates the session, signs the cookie and starts the rotation chain; k6 follows a rotated cookie like a browser. The app has no test-only code, no secret leaves the VM, and no order or delivery exists for the seeded players, so nothing can ever be sent to their numbers.
- **Cap at the production difficulty, pre-solved.** The app's Cap (stateless, 50 sub-challenges of 4 hex digits) costs about 6 CPU-seconds per token; k6 cannot solve one per order. `cap-pool.ts` calls the app's own `POST /api/v1/cap/{lpKey}/challenge` and `/redeem`, solves the proof of work with native hashing on every core (`worker_threads`), and writes the redeemed tokens. No bypass, no weaker difficulty (the app has no "staging difficulty" switch: the plan's "config only" does not exist, so staging runs the production one). A token is single use, bound to the landing page, and valid until its challenge's expiry plus 10 minutes, about 20 minutes after it was issued; `run.sh orders` makes the pool right before k6 starts and k6 refuses a pool that is too small or about to expire. `src/cap-pool.test.ts` proves the solver against the real provider.
- **The guard.** `seed.ts`, `settle.ts` and the local harness refuse to touch a database unless **all** hold (`src/guard.ts`, tested): `LOAD_TARGET_ENV` is exactly `staging` or `dev`; the database URL names one plain TCP host (no `host` or `hostaddr` query parameter, which postgres.js lets override the URL's host, no list of hosts, no socket path) and the targets postgres.js actually resolved (`sql.options`) are checked again; that host is loopback or listed in `LOAD_ALLOWED_DB_HOSTS`; `app_settings midtrans.environment` is `"sandbox"` (production flips it at go-live); and `app_settings deployment.environment` equals `LOAD_TARGET_ENV`. **The host allowlist is not a staging-vs-production separator**: the database container has the same pinned address (10.89.51.2) on staging and on production, so it only stops a typo from reaching an arbitrary host. **The real guard is the database's own markers**: the Midtrans environment and the `deployment.environment` row, the staging marker, written once by the operator on a staging or dev database and never on production (go-live item GL-61 checks it is absent there). The database URL is read from `LOAD_DATABASE_URL`, never from an argument. `cleanup` and `settle` act only on rows whose names are `LOADTEST <8 hex digits>` (the one exception: `cleanup` also removes a demo run, which it finds by its `demo-<run id>-NN@example.com` buyers, see "Demo data on staging"). For an orders run the tools also refuse unless **WhatsApp is off** (next section).
- **Cleanup.** `seed.ts cleanup --run <id>` deletes a trivia run completely (players, attempts, sessions' users, links, program, sets, questions, product). An orders run owns financial and delivery rows that the database keeps (append-only, restrict keys), so cleanup **retires** it: the landing page, adnet and product are deactivated, and every delivery and conversion not yet sent is cancelled or failed, so that nothing reaches a load-test buyer when WhatsApp is switched back on. A **demo run** is the exception to "financial rows are kept": its orders and payments are fake (no money moved, no Midtrans transaction), nothing but its own rows refers to them, and the triggers allow the delete for the migrate login, so `cleanup` deletes them. Staging is ephemeral (plan §10 item 15): destroying the VM is the final cleanup.

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

## Demo data on staging

Fills an EXISTING published program on staging with about 30 fake **PAID buyers** who have played their unlocked sets through the real play API, so that the leaderboard, the Sales and Contest reports and the prize screens show realistic data. Three tools, none of which touches the app:

| Step | Tool | Where it runs |
|---|---|---|
| 1 | `seed.ts demo`: the buyers, their PAID orders and payments, one login link each, and a plan of how each one plays (`demo.json`) | on the VM, in the one-shot worker container of "Procedure on staging" |
| 2 | `demo-play.ts`: logs the buyers in and plays their sets in real time | on your laptop, against `https://play.trivia.portalkonten.com` |
| 3 | `seed.ts cleanup --run <run id>`: removes all of it | on the VM, same container |

### What it makes, and how

- **The buyers.** About 30 (`--buyers`, 1 to 200) with Indonesian names, e-mail `demo-<run id>-<NN>@example.com` (example.com is reserved by RFC 2606: it never reaches a mailbox) and a valid Indonesian mobile number (`+62812` and 8 digits) that may belong to a real person, which is why WhatsApp must be off (below).
- **PAID through the real path.** Each order is made `pending`, then `paid` with a back-dated `paid_at`, then `public.order_paid_effects(order, paid_at)` runs: the SAME SQL function the worker's payment code and the Owner's "mark paid" run. It makes the player, the eligibility (`player_programs`, with `first_paid_at` = the order's `paid_at`, which is what unlocks the sets one a day), the deliveries, the conversion rows and the `order.paid` outbox row. No eligibility row is written by hand.
- **The payment rows.** One `payments` row per order, as a settled Midtrans transaction would leave it: `gateway_txn_id` = `demo-<run id>-<NN>` (marks the run, and cannot be a real Midtrans id), status `settlement` (`capture` for a card) + `accept`, the product price, the paid date, and a method from qris 45 %, gopay 20 %, bank_transfer 20 %, shopeepay 10 %, credit_card 5 % (so the gateway fee of Admin > Settings > Midtrans fees applies in the ROI report; a method with no fee configured counts as "fee missing" there). The orders belong to the program's first active landing page, carry no adnet and no click id (organic), and are dated a few minutes before the payment (the reports group by order date).
- **Paid dates.** Spread over the program's sales window up to now (a margin of 15 minutes before now at the latest), a little heavier in the first days, at a believable WIB time of day. A buyer's open sets follow the program's own unlock schedule (one set a day from the first paid day), so **early buyers have many sets and late buyers few**. A date outside the window is refused.
- **The plan of each buyer, deterministic from `--seed`** (printed; the same seed on the same program at the same moment gives the same plan): skill (50 to 95 % correct answers), how many of the unlocked sets are played (40 to 100 %, at least one, in order from set 1), a think-time range of its own (2 to 12 s), a small chance (0 to 3 %) that a question runs out its timer, and for about one buyer in five the last set left half played.
- **Login.** One magic link per buyer through the app's own `issue_magic_link`, exchanged by the simulator through `POST /api/v1/play/auth/magic-link` exactly like `login.ts` and the confirm page. Better Auth makes the sessions; nothing is bypassed.

### How sending, Midtrans and the review queue are kept out (data only, no app change)

Everything below happens in the seed's one transaction, so nothing is visible to the worker before it is complete, and a refusal leaves nothing behind.

| What | How a demo order is inert |
|---|---|
| E-mail and WhatsApp deliveries (`order_paid_effects` makes both) | **Cancelled** at once, `last_error = demo_seed` (payments revives only rows cancelled as `order_not_paid`). The seed then checks that no delivery of the run is still `pending` or `sending`, or it rolls back. *Trade-off:* the delivery report shows 2 cancelled deliveries per demo order instead of none; a real buyer's rows stay `pending`/`sent` |
| MO and MT postbacks | The orders carry **no adnet and no click id**, so `order_paid_effects` makes no S2S row. A Meta or TikTok pixel on the landing page would make a pending conversion row: the seed **deletes** any conversion row of its orders in the same transaction (before any claim), and checks none is left |
| The `order.paid` outbox job, which nudges deliveries and conversions | Marked relayed and processed at once, so the relay and the sweeper skip it |
| Messages to the phone numbers | Refused unless **no WAHA session is active and `delivery.wa_delay_seconds` is 3600 or more** (the same check as the orders run, `assertWhatsAppOff`). It is checked by `seedDemo` itself. The number cannot be made safe by its shape, so this is the protection if the cancellation above ever failed |
| The nightly Midtrans reconciliation (02:00 WIB), the re-query of a notification, the Owner's "re-query now" | **No `midtrans_attempts` row is made.** Every one of these paths starts from an order's attempt rows (`reconciliation.ts`: `WHERE EXISTS (SELECT 1 FROM midtrans_attempts ...)`; the notification consumer joins on `midtrans_attempts.midtrans_order_id`; the Owner's re-query reads the attempts and acts only on `review`). A demo order is never asked about at Midtrans, so there is no 404 and no `reconciliation_mismatch` alert |
| The order expiry and Snap-create sweeps, the stuck-review alert | They only look at `pending` (and `review`) orders; a demo order is `paid` |
| The Owner's review queue (US-033) | An order is never put in `review` (`review_since` stays NULL), no `order_owner_decisions` row is written, no alert and no reconciliation finding names it |
| `audit_log` (append-only, not deletable) | **No row is written**, so cleanup can leave nothing behind. *Trade-off:* the admin order page has no "status history" for a demo order |

**Other trade-offs of fake orders.** A demo order has **no landing-page visit, no click and no consent record** (a real checkout makes all three), so while a demo run is on: the **conversion rate** (orders per visit) and the **ROI report** (revenue against visits and ad spend) are **skewed upward** and must not be read as real figures; every order is organic (no adnet, no click id), so the per-adnet reports show nothing for it; and a method without a configured fee in Admin > Settings > Midtrans fees counts as "fee missing". The payments are not known to Midtrans: the dashboard of the sandbox does not list them, and "re-query now" in the console does nothing for them.

`test/demo.int.test.ts` proves each row against the worker's own code on a real database: the real sweepers (`sweepDueDeliveries`, `sweepDueConversions`, `relayOnce`, `sweepOutbox`) enqueue a job for a control order of a real buyer and none for any demo order; the real `reconcile` re-queries the control order's attempt and nothing of the demo orders; the real Owner re-query consumer skips them; `expireOrders`, `failStaleSnapCreates` and `alertStuckReviews` leave them `paid`.

### What the program must look like

`seed.ts demo` refuses, and lists every reason at once, unless the program is **published**, its product is active, its **sales window has started at least an hour ago**, its **grace end (sales end plus grace days) is at least 2 days away**, every set has questions, and it has an **active landing page** (the orders belong to one).

**The first PAID order locks a program for good** (`programs_field_lock`: product, slug and sales start can no longer change, sets can no longer be added, removed or reordered, and `locked_at` is never cleared, not even when the orders are deleted). So **move the program's first sales day back (about 60 days) and finish its sets BEFORE seeding**. The seed **refuses** a program that has no paid order yet unless `--accept-program-lock` confirms it: the flag is deliberately not in the command below, add it only after reading that refusal and accepting the lock.

**Clean up before the grace end.** At the grace end the worker's `endGracePeriods` writes the program's **results snapshot and its winners by itself** (about a minute after `sales_end_at + grace_days`). Both are immutable, so from then on cleanup refuses for ever and the demo buyers are in the results, among the winners. The seed therefore refuses a program whose grace end is less than 2 days away, and prints **`CLEAN UP BEFORE <grace end>`**. (Example: a program with sales to 2027-02-20 and 30 grace days: clean up before 2027-03-22.) Never contact a demo buyer or a demo winner: the phone numbers may belong to real people. The prize-fulfilment screens only show data after the grace end, so **the demo does not fill them**, which is what keeps the demo removable.

### Limits for the run (Admin > Settings > Limits)

One laptop is one client IP. The simulator makes **one login per buyer** and plays through the answer path, which has no per-IP limit; it asks the leaderboard once at the end (12 a minute per player, 120 per network).

| Key | Default | For 30 buyers |
|---|---|---|
| `otp.ip_cap` / `otp.ip_window_seconds` | 10 / 3600 | **Nothing to raise.** The login route allows `ip_cap x otp.max_attempts (5)` = **50 logins per window** per client network. Raise `otp.ip_cap` to 100 (500 logins per window) only for more than 50 buyers, or a second run within the hour, and restore it afterwards. A 429 is waited out (Retry-After) by the simulator in any case |
| `delivery.wa_delay_seconds` | 180 | set **86400** (at least 3600 is enforced), and every WAHA session inactive, for the seed; restore them when the cleanup is done |

### Commands

```sh
# once: the VM function of "Procedure on staging" (loadtool), the staging marker, and an (empty) env file the function reads; the demo needs no sandbox key
sudo install -m 0600 -o ebt /dev/null /etc/ebooktrivia/load-sandbox.env

# 1. on the VM: WAHA sessions inactive and delivery.wa_delay_seconds = 86400 (Admin > Settings), the program's first sales day moved back, then
sudo rm -f /srv/load/demo.json     # the seed never overwrites a file: a leftover of an earlier run must go first
loadtool seed.ts demo --program-slug <program slug> --buyers 30 --out /out/demo.json
#    prints the run id first, then: the paid dates, CLEAN UP BEFORE <grace end>, the size of the plan, and "nothing can be sent" with the counts.
#    If it refuses because the program has no paid order yet and would be locked for good, read why (above), then add --accept-program-lock.

# on your laptop: fetch the file. The container writes it 0600, so a plain scp may be refused: stream it through sudo instead (no second copy on the VM)
mkdir -p infra/load/work     # git-ignored
ssh <vm> sudo cat /srv/load/demo.json > infra/load/work/demo.json

# 2. on your laptop (Node 26, this checkout, pnpm install --frozen-lockfile done)
node infra/load/src/demo-play.ts --base https://play.trivia.portalkonten.com --in infra/load/work/demo.json --concurrency 10 --speed 1

# 3. when the data has served, BEFORE the grace end, and with demo-play.ts stopped (it would write attempts while cleanup deletes the players): on the VM
loadtool seed.ts cleanup --run <run id>            # the id is printed first by the seed and is in demo.json
sudo rm -f /srv/load/demo.json; rm -f infra/load/work/demo.json     # on the VM, and on the laptop
# restore delivery.wa_delay_seconds (180) and the WAHA sessions
```

**If the seed's output is lost** (the run id scrolled away, the connection dropped at the commit): the run id is in every demo buyer's e-mail. On the VM, `sudo runuser -u ebt -- ... podman exec postgres psql -U postgres -d ebooktrivia -c "SELECT DISTINCT substring(buyer_email from '^demo-([0-9a-f]{8})-') AS run_id, count(*) FROM orders WHERE buyer_email ~ '^demo-[0-9a-f]{8}-' GROUP BY 1"` (the form of the staging-marker command in "Procedure on staging"), then `loadtool seed.ts cleanup --run <run id>`. The file is written inside the seed's transaction (`wx`: never over an existing file, 0600), so a failed write rolls the run back instead of leaving buyers without their links, and any failure removes the file again; only a lost connection at the very commit can leave a run with no file.

**The simulator.** Time is real: the server measures each answer from the instant it served the question, so a buyer waits its think time (2 to 12 s at `--speed 1`, a range per buyer) before answering. `--speed 5` divides the waits by 5; a wait never exceeds the question's remaining time minus 3 s, so an answer always lands inside the 20 s timer. A question meant to time out is left alone for its whole timer plus the server's 1.5 s grace, at any speed. A set is left half played without asking for the next question (asking would serve it and start its timer), and is resumable (starting a set again returns the same attempt). Three refused answers in a row end a set. Against a real origin `--speed` is capped at 20 and `--concurrency` at 30 (a loopback `--base` is exempt), and every call gives up after 30 s. Duration: about `answers x 7.5 s / concurrency / speed`, plus the timeouts' timers; the seed prints the size of the plan (for example 30 buyers with a 10-set program: about 1000 answers, 15 minutes at 10 buyers at a time and speed 1) and the simulator the minutes it expects. It prints a summary: buyers logged in, sets started, finished and left half, answers and correct ones, timeouts, errors, and the top of the leaderboard. Exit 0 only when every buyer logged in and nothing failed. **Each magic link works once**: after a login, a second run of the same file logs in nothing; clean up and seed again.

**`demo.json` stays on your machine.** It holds one-time login links (valid 72 hours) and the **correct option of every question** of the program (the simulator needs it to answer at a chosen skill). It holds no name, e-mail or phone number. It is written 0600 on the VM; delete it after the run (above).

### Cleanup, exactly

`seed.ts cleanup --run <run id>` finds the run's orders by **all three** of: the e-mail `demo-<run id>-NN@example.com`, a payment whose `gateway_txn_id` is exactly `demo-<run id>-NN`, and no `midtrans_attempts` row (an order that fits the e-mail but not the rest is refused, not skipped), and **deletes** in one transaction, as the migrate login (a superuser, which no trigger stops here): the `order.paid` outbox rows, the conversion rows and attempts, the deliveries, the payments and the orders (report rollups notice a delete and rebuild on their next 5-minute refresh), then the answers (with their reveal watch rows), attempts, stats, eligibility and magic links of the players, the players and their player_auth users (sessions go with them). **After it, the leaderboard (5 s cache) and the Sales and Contest reports (within 5 minutes) no longer show the demo buyers.**

**What stays:** `programs.locked_at` of the program (the first paid order locked it; the lock is never cleared). Nothing else: no audit row was written, and Valkey rate-limit counters expire by themselves.

It **refuses, deleting nothing, and names the table** when a row exists that a restrict key or an append-only rule would keep: a deadline extension (`deadline_extensions`, ET111), a deletion request, a consent, a reconciliation finding or an Owner decision of a demo order or player, a contest winner, or the program's results snapshot (immutable, written by the worker after the grace end, with the demo players in it). It also refuses when a demo player has an order that is not of the run. So **nothing of a demo run is ever half kept**: it is removed whole, or not at all. A run id that is not a demo run falls through to the load-test cleanup above.

### Local proof (the dev stack, 2026-11-23)

`node infra/load/src/local-demo-run.ts` (Docker running; port 3410; `SKIP_BUILD=1` reuses the build) starts a throwaway migrated database, the production build of apps/public and the real worker, makes a program (4 sets of 3 questions, sales open 3 days, a landing page with a Meta pixel), and runs the three tools as their CLIs: `seed.ts demo --buyers 3 --seed 2026`, `demo-play.ts --speed 60 --concurrency 3`, `seed.ts cleanup`. Both runs below ended `ok`.

| | Result |
|---|---|
| Seed | 3 PAID buyers (paid 2026-11-20 to 2026-11-22), 6 deliveries cancelled, 3 conversion rows removed (the pixel), the program locked |
| Simulator, run 1 (speed 60) | 3 of 3 logged in through the app's own route (3 real player sessions); 7 sets started, 6 finished, 1 left half; 20 answers, 16 correct; 0 errors; 3 s |
| Leaderboard after run 1 | #1 Siti S. 100 points (4 sets, paid 11-20), #2 Ayu F. 50 points (2 sets, paid 11-21), #3 Rudi R. 10 points (a half-played set, paid 11-22): the early buyer has the most sets (names masked by the app) |
| Simulator, run 2 (buyer 1 forced to leave its 3 questions unanswered) | 3 timeouts, closed by the server after the 20 s timer plus its 1.5 s grace (67 s of real time for the run); 8 answers, 6 correct; 0 errors |
| The real worker, running all along | 0 deliveries not cancelled, 0 delivery attempts, 0 conversion rows, 0 WAHA sends, **0 alerts**; Mailpit holds 0 messages to example.com |
| Cleanup | `{"outbox":3,"conversion_attempts":0,"conversion_events":0,"deliveries":6,"payments":3,"orders":3,"attempt_questions":21,"set_attempts":7,"player_program_stats":3,"player_programs":3,"players":3,"player_auth_users":3}`; afterwards 0 orders, payments, players, eligibility rows, attempts, stats, login sessions, users and magic links, 0 leaderboard rows, and 0 rows of the program in the Sales rollup after its refresh |
| Run 3, after the review fixes (the seed CLI writes `demo.json` inside its transaction and prints the run id first and `CLEAN UP BEFORE <grace end>`; a half-played set no longer asks for the question it will not answer) | same plan and result as run 1: 3 of 3 logged in, 20 answers, 16 correct, 0 errors, 0 alerts, 0 Mailpit messages, cleanup leaves 0 rows everywhere |

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
