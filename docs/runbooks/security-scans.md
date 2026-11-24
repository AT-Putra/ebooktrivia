# Security scans, header checks and security monitors (US-031, plan M11.1)

What proves the security bar, how to run it, and how to read it. The requirement-by-requirement evidence is
[docs/asvs-l2-checklist.md](../asvs-l2-checklist.md).

| Check | Where it runs | Command |
|---|---|---|
| Secrets in the full git history and the working tree (gitleaks 8.30.1) | local; CI job `secrets-scan` | `infra/verify/local/security-scan.sh secrets` |
| Known-vulnerable dependencies (OSV-Scanner 2.7.0) | local; CI job `dependency-scan` | `infra/verify/local/security-scan.sh deps` |
| Security headers per host (admin, play, order, api, SDK, LP) | local and CI job `edge-smoke`; staging | `infra/verify/local/security-headers.sh` / `... --staging <domain> <lp-host>` |
| ZAP baseline (passive) on every entry point | **staging only** (a local dry run exists) | `infra/verify/staging/zap-baseline.sh` |
| ZAP authenticated scans (Owner console, player trivia) | **staging only** | `infra/verify/staging/zap-auth.sh` |

## 1. Secret and dependency scans

`infra/verify/local/security-scan.sh [all|secrets|deps]` runs the tools' **official images through Docker, pinned by
digest**; nothing is installed on the host. The repository is mounted read-only.

| Tool | Image | Release |
|---|---|---|
| gitleaks | `ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f` | 2026-03-21, the latest stable |
| OSV-Scanner | `ghcr.io/google/osv-scanner:v2.7.0@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0` | 2026-10-12 (2.7.1 of 2026-11-09 was under the 14-day age on 2026-11-22) |

- **gitleaks** scans every commit of every branch (a bare clone in a temporary directory: a linked worktree's `.git` is a
  file the container cannot follow), then the files a commit would hold (tracked plus untracked, minus `.gitignore`). It
  runs with `--network none` and prints findings redacted. Config: `.gitleaks.toml` (the default rules plus narrow,
  reasoned allowlists: each names the file AND the exact value or value shape). CI runs the same release
  (`GITLEAKS_VERSION: 8.30.1` in the `secrets-scan` job; the action's own default is older) with the same file.
- **OSV-Scanner** reads `pnpm-lock.yaml` (every workspace package). Its only network traffic is OSV's normal
  vulnerability-database query to `api.osv.dev`: package names, versions and ecosystems from the lockfile, no source code.
  Config: `osv-scanner.toml` next to the lockfile, read by CI's `osv-scanner-action` v2.7.0 too.

A finding:

1. **A real secret:** stop. Tell the Owner, revoke and rotate the credential at its issuer first (a secret in git history
   is public to anyone with a clone), then remove it from the tree. Only then think about rewriting history.
2. **A false positive:** add an allowlist to `.gitleaks.toml` with `targetRules`, the exact `paths` and the exact value or
   shape (`regexes`), and a `description` that says why it is not a credential. Never allowlist a whole directory or a rule.
3. **A vulnerable dependency:** upgrade (a release at least 14 days old; report it to the Owner before changing a manifest)
   or, for a transitive one, a pnpm override scoped to its parent (`parent>child`, pnpm-workspace.yaml; for example
   `exceljs>uuid`). An entry in `osv-scanner.toml` only when the advisory is not reachable here: a `[[PackageOverrides]]`
   pinned to the package name AND version (never an advisory id alone, which would hide it in any other package), with the
   advisory id and package path in its reason, and `effectiveUntil`.

**Remediation time frames** (ASVS V15.1.1), counted from the day the scan (CI or local) first reports the finding:

| Finding | Fix (upgrade or scoped override) by |
|---|---|
| Critical or High, reachable in a production path | 7 days; the same day when it is exploited in the wild or touches payments, logins or secrets |
| Medium, reachable in a production path | 30 days |
| Low, or High / Medium in a dev-only or unreachable path | the next dependency update, at most 90 days; until then a reviewed `osv-scanner.toml` entry whose `effectiveUntil` is at most 90 days away |
| A container base image (node, caddy, valkey, postgres) | its next patch release, checked monthly with docs/versions.md |

A fix still respects the 14-day minimum release age; when a fix is younger, the Owner decides between waiting and an
exemption (`minimumReleaseAgeExclude`, as for earlier exemptions).

**Re-check on 2027-02-22:** the two OSV overrides (esbuild 0.18.20 under drizzle-kit, minimatch 10.2.6 under eslint) expire
that day; the scan fails again until each is fixed or re-reviewed. An override hides every advisory of its version, so
the re-check lists them all: `docker run --rm -v "$PWD:/repo:ro" ghcr.io/google/osv-scanner:v2.7.0 scan source --config=/dev/null --lockfile=/repo/pnpm-lock.yaml`
(the image digest as in security-scan.sh).

## 2. Security headers per host

`infra/verify/local/security-headers.sh` starts the production builds of apps/public and apps/admin
(`node src/server.ts`, NODE_ENV=production, no database or Valkey) behind the real `infra/caddy/Caddyfile` in Caddy 2.11.9
(plain HTTP on 127.0.0.1 only, on three ports of its own per run, and a container name of its own; `--serve` keeps
`ebt-security-headers` on 18480, apps on 18481 / 18482), requests 23 representative responses and checks each against ONE
policy, `infra/verify/src/security-headers.ts` (its unit tests prove each rule fails when its header is missing or weak).
CI runs it in the `edge-smoke` job after the builds. On staging:

```sh
SECURITY_HEADERS_OUT=./headers-evidence infra/verify/local/security-headers.sh --staging <domain> <lp-host>
```

The policy, per host:

- **every host:** exactly one `Strict-Transport-Security: max-age=31536000; includeSubDomains` (LP domains: without
  `includeSubDomains`, they are the customers' domains), one `X-Content-Type-Options: nosniff`, one strict
  `Referrer-Policy` (the route's own where it sets one: `no-referrer` on the play login and trivia pages, `same-origin` on
  admin; `strict-origin` on `order.<DOMAIN>`, AC-T5; Caddy's `?Referrer-Policy` default elsewhere), no `Server` or
  `X-Powered-By`, no `Access-Control-Allow-Origin: *` except the SDK files, never `Access-Control-Allow-Credentials`;
  on admin, play, order and api every response, whatever its type, also carries the edge's global
  `Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'none'`, and TRACE / TRACK get 405 at the
  edge;
- **HTML on admin, play, order:** an enforced nonce CSP (fresh per load) without `'unsafe-inline'` or `'unsafe-eval'` for
  scripts, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `no-store`, COOP
  `same-origin`, a Permissions-Policy that turns off camera, microphone and geolocation, CORP `same-origin` on admin;
- **HTML on an LP domain:** the documented LP default CSP (the author's static page: inline scripts allowed, never
  `'unsafe-eval'`), `object-src 'none'`, `frame-ancestors 'self'` (docs/runbooks/landing-pages.md);
- **JSON (the API):** `no-store`;
- **cookies:** none on order, api, the SDK and LP domains; on admin and play only `__Host-` names with `Secure`, `HttpOnly`,
  `SameSite=Strict` (admin) or `Lax` (player), `Path=/` and no `Domain`. Real session cookies need a login: the e2e specs
  (`admin-auth.spec.ts`, `play-login.spec.ts`) assert them.

**HSTS preload: not requested.** Preloading is effectively permanent (removal takes months), needs `includeSubDomains`
and `preload` on the bare base domain, and would force HTTPS on every present and future name under it, including names
the Owner may use for other services. The one-year `includeSubDomains` header protects every return visit; revisit after
go-live if the base domain is dedicated to this product.

## 3. ZAP scans (staging only)

ZAP 2.17.0, the latest stable release (2025-12-15; the weekly builds are pre-releases), pinned by digest:
`ghcr.io/zaproxy/zaproxy:2.17.0@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af` (the `stable` tag on
2026-11-22). The gate is the same for every report (`infra/verify/src/zap-report.ts`): **any High alert fails** (ZAP has
no Critical), and so does any alert of a rule marked `FAIL` in `infra/verify/staging/zap/rules.tsv` (missing
anti-clickjacking, nosniff, HSTS or CSP, an `X-Powered-By` leak, a cookie without HttpOnly, Secure or SameSite). The file's
`IGNORE` lines each carry their reason; an IGNORE is never a way to pass a High.

### Preparation

1. Staging is up and verified (docs/runbooks/staging-provision.md); the run happens from a machine OUTSIDE the VM with
   Docker, git, node and this checkout (like k6, plan M11.2).
2. That machine's public address is in `ADMIN_ALLOWED_CIDRS` (otherwise admin answers 404 to everything).
3. A **staging test Owner** for the scan (staging's own Owner account, never production's), enrolled with TOTP
   (`apps/admin` CLI, docs/runbooks/admin-access.md). Keep its
   e-mail, password and TOTP secret (the text key shown at enrolment) in your password manager; they are passed only as
   environment variables. Five wrong logins lock it for 15 minutes: check the machine's clock first (TOTP).
4. A **staging test player** that is eligible (a paid sandbox order with the staging test phone).
5. One **active ZIP-hosted LP domain** on staging (its certificate issued).

### Run

```sh
export ZAP_DOMAIN=<staging domain> ZAP_LP_HOST=<lp domain>
infra/verify/staging/zap-baseline.sh --out ./zap-baseline              # 6 passive scans, ~20 min

# Owner console (browser login with the TOTP code generated by ZAP):
read -rs ZAP_ADMIN_PASSWORD; read -rs ZAP_ADMIN_TOTP_SECRET; export ZAP_ADMIN_EMAIL=<test owner e-mail> ZAP_ADMIN_PASSWORD ZAP_ADMIN_TOTP_SECRET
# Player: log in on https://play.<domain>/login with the test phone's WhatsApp code, copy the __Host-play_session cookie
# value from the browser's developer tools (Application, Cookies), right before the run (a session rotates on its first
# use after 24 h, and the old token then dies within a minute: a fresh login keeps the copied value valid for the scan):
read -rs ZAP_PLAY_SESSION_COOKIE; export ZAP_PLAY_SESSION_COOKIE
infra/verify/staging/zap-auth.sh all --out ./zap-auth                   # passive, as the Owner and the player
infra/verify/staging/zap-auth.sh all --active --out ./zap-auth-active   # optional: ZAP's active scan, staging only
unset ZAP_ADMIN_PASSWORD ZAP_ADMIN_TOTP_SECRET ZAP_PLAY_SESSION_COOKIE
```

- The spiders never post a form: every console change is a POST server action (and needs the exact Origin), every play
  write a POST with its Origin, so the scans only read. `--active` attacks what the spider found (GET pages and their
  parameters), 30 minutes at most per target. Never run it against production.
- An authenticated scan FAILS unless it stayed signed in (security review M2): each plan exports the URLs it reached
  (`<target>-urls.txt`), and one must be a page only a signed-in user reaches (a console page such as /team or
  /reports/..., a program page of the trivia; `infra/verify/src/zap-signed-in-cli.ts`). zap-auth.sh also checks the player
  session before the scan, fails if it ended during it, and signs the test player out everywhere afterwards.
- The plans turn off ZAP's rules 10111, 10112 and 10113 (authentication request, session management response,
  verification request): their evidence would copy the test account's login and session into the report. ZAP runs as
  your own user, the `--out` directory is 0700, and ZAP's own session database stays in the container (removed after).
- Each script exits 0 (no High, no FAIL rule, signed in), 1 (a finding, a scan that did not finish or was not signed in)
  or 2 (usage). The reports are `<target>.json` and `<target>.html` (`<target>-auth.*`) in the `--out` directory.

### After the scan (the same day)

1. **The evidence is the scrubbed summary only:** the verdict lines the script printed (rule, risk, count, URLs, no
   request or response content) and the date, pasted into the US-031 evidence and linked from docs/asvs-l2-checklist.md.
   The reports themselves hold page content and request headers: keep them on the operator machine, never in the
   repository (`.gitignore` has `zap-*/` and `headers-evidence/`), never in a ticket or a chat; delete them once triaged.
2. **End the test Owner's sessions:** the sessions ZAP opened must not outlive the scan. Run the admin CLI `recover` for
   the test Owner on the staging VM (docs/runbooks/admin-access.md): it revokes every session of the account and sets a
   new password (TOTP is enrolled again before the next scan). The Team page's Disable (which also revokes every
   session) works for a staff account only, never the caller's own.
3. **Take the runner's address out of `ADMIN_ALLOWED_CIDRS`** again (staging-provision.md, the caddy.env change and the
   Caddy restart), unless it is an address that belongs there anyway.
4. The test player was signed out everywhere by zap-auth.sh; check it once (its session API answers signed out).

### Read the report

The script prints one line per alert: `FAIL` (blocks: fix, re-run), `WARN` (triage), with risk, rule id, name, count and up
to five URLs. Open the HTML report for the evidence of one alert. For each WARN, decide: fix it; or, when it is wrong for
this system, add an IGNORE line with the reason (reviewed like code); or record it as an accepted risk in the ASVS
checklist. The WARNs the local dry run (2026-11-22) left, and why they stay:

| Rule | Risk | Where | Why it stays |
|---|---|---|---|
| 10055 CSP: style-src unsafe-inline | Medium | every app page | React style attributes and next/font; a style cannot run a script, the nonce script policy is the control |
| 10055 CSP: script-src unsafe-inline, wildcard (`img-src https:`) | Medium | LP domains | the documented LP default (the author's static HTML on its own origin, docs/runbooks/landing-pages.md) |
| 10202 Absence of Anti-CSRF Tokens | Medium | admin /login | server actions are refused unless the Origin equals ADMIN_ORIGIN, and the session cookie is SameSite=Strict (apps/admin/src/lib/http-security.ts, ASVS V3.5.1) |
| 90004 COEP / CORP missing | Low | pages, `/_next/static` files | no cross-origin isolation is needed (no SharedArrayBuffer); COEP require-corp would block the vendor pixels and fonts |
| 10063 Permissions Policy not set | Low | JS, CSS and font files; LP pages | a Permissions-Policy acts on documents; every app page sends one. LP pages are the author's |
| 10044 Big Redirect | Low | admin `/` (307 to /login) | the redirect body is Next's, with nothing of the session |
| 90022 Application Error Disclosure | Low | play `/` in the dry run | the dry run has no database, so the trivia page answered Next's generic 500 page (no detail); not on staging |

Fixed after the dry run: the api origin's `/`, `/sdk` and every 404 page (robots.txt, sitemap.xml) were HTML without a
script policy; the public proxy now gives every page it does not route the strict trivia nonce CSP and the play headers
(apps/public/src/proxy.ts `defaultPage`; security-headers.sh probes them).

### Local dry run

`infra/verify/local/security-headers.sh --serve` in one shell (the local stack above, kept up), then
`infra/verify/staging/zap-baseline.sh --local` in another: the same six baseline scans against the local stack over plain
HTTP, on a private Docker network (`ebt-zap-local`, removed by the exit trap). It proves the scripts and the rules file, not
staging: no database (the pages that need one answer their fail-closed 503), no TLS (no HSTS alerts possible). Stop
`--serve` with Ctrl-C (its exit trap removes the Caddy container and the two app servers); if it was killed outright,
`docker rm -f ebt-security-headers` and stop the two `node src/server.ts` processes listening on 18481 / 18482.

## 4. Valkey functions (the public rate limits)

The public app's ACL user may `FCALL` but never `EVAL`, `EVALSHA`, `SCRIPT` or `FUNCTION` (US-031): a compromised public
process can call only the loaded library, never its own Lua, and the commands inside still run under its own ACL (keys
`rl:*` and `cache:public:*` only). The library (`ebt_public`: `ebt_rate_limit_v1`, the rate limits, and `ebt_wa_read_v1`, the hand-over of an incoming
WhatsApp message to the worker to be marked as read) lives in `packages/adapters/src/valkey-functions.ts`.

- **`ebt_wa_read_v1`** (Owner rule 2026-11-24, `apps/worker/src/delivery/read-marks.ts`): the webhook calls it once per message of a person's chat. It runs under public's ACL with
  the commands public already has (`SET`, `INCR`, `PEXPIRE`) on keys under `cache:public:wa-read:*`: a per-chat pending mark (`SET NX EX 60`), a sequence counter and a **ring of 2000
  slots** (an item lives ten minutes; a lap overwrites the oldest), so the structure is capped by construction and public needs **no new command and no new key pattern**. Only the
  worker reads the ring, through a **selector** of its production ACL line, `(~cache:public:wa-read:* -@all +get +mget +del)`: it can read and delete that one pattern of public's keys and
  nothing else (it never writes the ring; not `~cache:public:*`, not `~rl:*`); `prod-valkey-acl.int.test.ts` and `host-check.sh` assert that a worker SET, INCR, EXPIRE or EXISTS there is NOPERM. An item
  holds the session name, the message id **sealed** to the messaging public key (the id embeds the sender's phone and Valkey keeps an AOF: `packages/crypto/src/wa-read.ts`) and a keyed digest of the
  chat; no text. The function builds the slot's key inside from a prefix argument (it is only known from the counter it moves), so it is not in `KEYS`; every command of a function runs under the
  CALLER's ACL, so a prefix outside public's patterns is refused at the write ("ACL failure in script"), which the production-ACL test proves.
- **Deploy order for it:** the worker first (it loads the library with both functions and gets the new ACL line), then the public instances. A public instance that calls it before the worker
  has loaded it gets `Function not found`: the webhook logs `public.valkey_function_missing` (kind `ebt_wa_read_v1`) and `webhook.waha.read_not_handed`, answers as usual, and the
  message is simply not marked (the next one is). The ACL file change (`provision.sh` renders it) needs the Valkey restart the provisioning already asks for.
- **Rolling back:** roll **public back before the worker**. An older worker loads its older library with `FUNCTION LOAD REPLACE`, which drops `ebt_wa_read_v1` while a newer public still calls it, and
  after a rollback the worker that is RUNNING is the old one with its old probe (an FCALL of the rate-limit function only), which never looks for `ebt_wa_read_v1`: for a rollback to a release before the one that
  brought the whole-library probe (`FUNCTION LIST LIBRARYNAME ebt_public`, commit 298d8ac) this order is the ONLY guard, and nothing alerts if it is not kept. From that release on the worker's heartbeat probe
  requires EVERY function of the library to be listed: it finds a library that lost one, reloads the library it has and raises the `valkey_function_missing` alert; until then the newer public hands no message over
  (it logs the code and answers as usual).

- **The worker loads it**, with `FUNCTION LOAD REPLACE`: at start-up, on every reconnect of its health connection, and from
  its heartbeat when the function is missing. Valkey's AOF keeps the library across restarts.
- **Start order:** on a fresh or restored Valkey, start the worker before the public instances (`public@.container` is
  ordered `After=worker.service`; ordering only, a public instance still starts without it). Until the function is
  loaded a public instance logs `public.valkey_function_missing` and answers 503 on its rate-limited routes only (fail
  closed: the checkout, the OTP and login routes, the leaderboard); every other page and route works, and its readiness
  does not depend on the function (code review MINOR 3: a missing function must not take the whole app out of the load
  balancer).
- **The `valkey_function_missing` alert (warning):** raised by the worker when its heartbeat finds the function missing
  (a FLUSHALL, a Valkey restored without its AOF), before it loads it again; deduped while open. Check `journalctl
  --user -u valkey` for the cause, and that the worker log says `valkey functions loaded` (reason `missing`) right after.
  The alert resolves by hand once the cause is known; a repeat means something keeps wiping Valkey.
- **Changing the logic:** a function's name is its contract. Never change the logic or the arguments of a published name:
  add a NEW function (`ebt_rate_limit_v2`) to the library, deploy the worker first (it loads both), then the public
  instances, and remove the old name only when no running public calls it. A rolling deploy then runs old and new public
  instances side by side.
- **Check on the VM:** `infra/verify/host-check.sh` asserts `FCALL ebt_rate_limit_v1 0` answers for `public` and that its
  `EVAL`, `EVALSHA`, `SCRIPT LOAD`, `FUNCTION DELETE` / `FLUSH` are refused.
- **Dev stack:** the shared dev Valkey reads `infra/dev/valkey/users.acl` at start: after this change is merged it must be
  restarted (`docker compose -f infra/dev/compose.yaml restart valkey`) so `public` gets `+fcall`. The integration tests
  and the e2e servers load the library themselves (`@ebooktrivia/test-support/valkey`), since no worker runs there.

## 5. Security alerts and log monitors

### `play_reveal_misuse` (alert, warning)

The guard against the accepted residual of US-027: someone holding the public app's database login can act as a player
and call `public.play_reveal` (sql/play.sql) for that player's answers. The app reveals a pick right after it, and again
only on its own retry within seconds, so `play_reveal`:

- **refuses** a reveal more than 60 s after the answer: `{state: "closed"}`, no option, no explanation (the app answers
  that retry 409 `already_answered`, like a timeout). Late reveals harvest nothing.
- **counts** each reveal (`answer_reveals.reveals`, within 60 s, never flagged) and each refused one
  (`late_reveals`, flagged at `flagged_at`).
- **raises** `play_reveal_misuse` when 3 or more DISTINCT attempts were flagged within an hour (one player's stale tab is
  not a harvest, many are). One alert stays open per hour. Payload: `flagged_attempts`, `window_minutes`, and the
  `answer_id`, `attempt_id`, `seconds_after_answer` of the call that crossed the line. Ids, counts and times only.
- **logs** every call, refused or not, as a server-log line (`RAISE LOG`): `ebt.play_reveal answer_id=... attempt_id=...
  after_answer_ms=... refused=true|false`. A caller that wraps its calls in `BEGIN ... ROLLBACK` erases the counts and
  the alert, never this line (code review MAJOR 1); `public_rw` cannot change `log_min_messages` (superuser only), and
  `client_min_messages` only decides what the client sees.

The flagged answers (psql as the operator, or admin_rw, which may read but not change the table):

```sql
SELECT r.answer_id, aq.attempt_id, r.reveals, r.late_reveals, r.flagged_at, r.last_revealed_at
  FROM answer_reveals r JOIN attempt_questions aq ON aq.id = r.answer_id
 WHERE r.flagged_at IS NOT NULL
 ORDER BY r.flagged_at DESC LIMIT 100;
```

**The log monitor** (the part a rollback cannot hide), on the VM, in the daily check and with the alert:

```sh
A=infra/provision/as-app.sh
sudo journalctl CONTAINER_NAME=postgres --since "-1 hour" -o cat | grep -oE 'ebt\.play_reveal [^"]*' >/tmp/reveals.log
# 1. Refused (late) reveals, distinct attempts: page on 3 or more in an hour, the alert's threshold.
grep 'refused=true' /tmp/reveals.log | grep -oE 'attempt_id=[0-9a-f-]{36}' | sort -u | wc -l
# 2. The gap: logged reveals whose answer has no answer_reveals row were rolled back. The app never rolls one back:
#    any count above 0 is the misuse signature, whatever check 1 says.
ids=$(grep -oE 'answer_id=[0-9a-f-]{36}' /tmp/reveals.log | cut -d= -f2 | sort -u | paste -sd, -)
[ -n "$ids" ] && sudo $A podman exec -i -u postgres postgres psql -X -At -d ebooktrivia -c \
  "SELECT count(*) FROM unnest('{$ids}'::uuid[]) AS l(id) WHERE NOT EXISTS (SELECT 1 FROM answer_reveals r WHERE r.answer_id = l.id)"
rm -f /tmp/reveals.log
```

A count in check 2, or many attempts in check 1: rotate the `ebt_public` database password
(docs/runbooks/staging-provision.md, db-roles.sh) and redeploy public; check the access log for the source. One attempt
flagged now and then: a stale tab or a manual replay; look at that attempt before acting. Resolve the alert when done
(`UPDATE alerts SET resolved_at = now() WHERE id = ...`). Wiring both checks into the monitoring belongs to US-015, like
the log monitor below.

### The public app's `internal` error lines (log monitor)

The public app cannot write alerts (`public_rw` has no INSERT on `alerts`), so its unexpected failures are log lines: level
`error` with `"reason":"internal"` (`checkout.failed`, `order.failed`, `play.failed`, `play.otp_issue_failed`,
`play.magic_link_resend_failed`, `cap.failed`, `sdk.failed`, `webhook.midtrans.failed`, `webhook.waha.failed`), plus
`public.valkey_function_missing` (above). The query, on the VM:

```sh
sudo journalctl CONTAINER_NAME=public-a CONTAINER_NAME=public-b --since "-1 hour" -o cat |
  grep '"role":"public"' | grep -E '"reason":"internal"|"event":"public.valkey_function_missing"' |
  sed -E 's/.*"event":"([a-z0-9_.]+)".*/\1/' | sort | uniq -c | sort -rn
```

Page on **3 or more in an hour**, or any `webhook.midtrans.failed` (a paid order whose notification could not be stored:
Midtrans retries, but a sustained fault would otherwise wait for the nightly reconciliation). The lines carry no personal
data (lib/log.ts allowlists the fields). Wiring this query into the monitoring (Uptime Kuma or a timer that raises an alert
row) belongs to the monitoring story (US-015); until then run it in the daily check and after every deploy.

## 6. Breached-password check (Have I Been Pwned)

Admin passwords are checked against Have I Been Pwned's Pwned Passwords (ASVS V6.2.12). The Owner's choice (2026-11-22):
the WORKER checks them, because the console has no egress (its networks are internal, by design) and never calls the API.

1. **Where a password is set** (a new account, a staff reset, the CLI's `recover`, enrolment, the forced change below), the
   console first applies the local rules at once (length, the 10,000 common passwords, the context words). In the same
   transaction it gives the account a new `admin_profiles.password_check_id`, clears the flag, and writes an outbox job
   `admin.password_hibp_check` (`apps/admin/src/lib/auth/password-check.ts`):
   - The payload holds `admin_user_id` and `check_id` only.
   - `sealed` holds the password's SHA-1, sealed to the messaging public key and bound to both ids. The password itself
     never leaves the console.
   - Why the full SHA-1: the range API needs its first 5 hex characters and the match needs the other 35. Anything shorter
     that keeps false matches negligible still lets an attacker test candidate passwords offline.
   - So the protection is where the hash lives. It is never in the payload, a log line or an error. Only the worker can
     open it, so the database, its WAL and its backups hold ciphertext. It is wiped from the row when the job ends.
2. **The worker** (`apps/worker/src/password-check.ts`) opens the hash with the messaging private key and asks
   `GET https://api.pwnedpasswords.com/range/<first 5 hex>` with `Add-Padding: true` (k-anonymity, 3 s timeout, safe-fetch).
   It then matches the other 35 itself. Outcomes:
   - **Breached:** `flag_breached_admin_password` sets `password_breached_at`, but only while that check is still the
     account's current password's. It audits `admin_user.password_breached` (actor system) and raises one
     `admin_password_breached` warning alert, payload `admin_user_id` only.
   - **Clean:** nothing happens.
   - **Unreachable:** retried with the outbox backoff, 6 tries over about 15 minutes, then given up with the log line
     `password check given up` (fail open: the password stays).
   - **A row that does not open:** dropped.
   - Every end wipes `sealed`; a job that never ends (past its attempt cap, or 24 h old) loses it to the minute sweep
     (`sweepExpiredOtps`).
3. **The flagged admin** (Owner or Staff) signs in as usual. After the second factor, every page and action sends them to
   **/change-password**, the only page they may reach besides sign-out. The change requires:
   - the current password;
   - a new one under the same rules.

   It then signs every other session of the account out, clears the flag, and records a new check
   (`admin_auth.breached_password_changed`).

**When the alert fires:**
- The admin changes the password at the next sign-in. Nothing else is needed.
- If the account was used from unknown addresses (audit log, `admin_auth.sign_in`), treat it as a compromise. Disable a
  staff account from the Team page, or run the CLI `recover` for an Owner, then check the audit log for what it changed.
- Resolve the alert once the password has been changed: `admin_profiles.password_breached_at` is NULL again.

**Needs:** `SECRETS_MESSAGING_PUBLIC_KEY` in admin.env and `SECRETS_MESSAGING_PRIVATE_KEY` in worker.env (both are set for
OTPs and deliveries already). Without the public key the console writes no job: it logs `admin.password_check_skipped`
and accepts the password on the local rules. Without the private key the worker logs at start that admin passwords are
not checked, and the hourly outbox alert names the topic. The tests fake the API, so CI never calls it.
