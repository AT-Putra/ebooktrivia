# Deploy: GitHub Actions to the VM by digest, with automatic rollback (US-015, plan M4 item 4)

`.github/workflows/deploy.yml` builds the images, pushes them to GHCR, and hands the VM a **manifest of image digests** over SSH. The key it connects with can do exactly one
thing: run the forced command `infra/deploy/remote.sh` (installed as `/usr/local/sbin/ebt-remote-deploy`), which accepts that manifest and nothing else. This page is the setup, the
day-to-day, the expand/contract rule and what to do when a deploy fails. The proof that it works is in section 8; what only staging can show is marked **staging**.

## 1. One-time setup

**On GitHub** (no secret lives in the repository):

| Where | Name | Value |
|---|---|---|
| Environment `staging` and environment `production` (Settings, Environments) | secret `DEPLOY_SSH_KEY` | the private half of a new ed25519 key made for this: `ssh-keygen -t ed25519 -N '' -C ci-deploy@<env> -f key`; the public half goes in `provision.env` (section 2) |
| the same | secret `DEPLOY_KNOWN_HOSTS` | the VM's host key line: `ssh-keyscan -t ed25519 <host>`, **checked against the provider console's fingerprint** (a wrong line here is a man in the middle) |
| the same | variables `DEPLOY_HOST`, `DEPLOY_USER` (`ebtdeploy`), `DOMAIN` | the VM's address, the login, the environment's base domain |
| Repository variables | `STAGING_DOMAIN`, `PRODUCTION_DOMAIN` | the two base domains (names, not secrets: the admin image bakes its origin in at build time) |
| Environment `production` | protection rules | **required reviewers** (the Owner), and "only the `main` branch" |
| Environment `staging` | protection rules | the branch rule `main`; reviewers optional |

A push to `main` runs `ci`; when `ci` passes, `deploy` runs by itself for **staging**. **Production** is only ever a manual run (Actions, deploy, "Run workflow", environment `production`) from `main`,
and waits for the reviewers. The workflow refuses to run from another branch, and refuses the failure drill outside staging.

## 2. On the VM

Add to `/etc/ebooktrivia/provision.env` (`provision.env.example` has the lines) and run `provision.sh`:

```
DEPLOY_USER=ebtdeploy                                   # the default
DEPLOY_PUBLIC_KEY="ssh-ed25519 AAAA... ci-deploy@staging"   # the public half, no options
DEPLOY_REGISTRY_PREFIX=ghcr.io/<owner>/<repo>           # lowercase; the images are <prefix>/<component>@sha256:<digest>
DEPLOY_ALLOWED_CIDRS="..."                              # the sources that may SSH in as the deploy login: see below
```

Provisioning then creates the login (a shell only because the forced command needs one, no password, not an administrator, a home that only root can write), installs `ebt-remote-deploy`
root-owned in `/usr/local/sbin`, writes `/etc/ebooktrivia/deploy.env` (the registry prefix), a sudoers rule that allows exactly `ebt-remote-deploy deploy|rollback|status` as root, and the key line
`restrict,command="sudo -n /usr/local/sbin/ebt-remote-deploy \"$SSH_ORIGINAL_COMMAND\"" <key>`. A stolen CI key can therefore run what is installed and cannot change it; with the manifest it can
only name digests of **this repository's** registry prefix. Take `DEPLOY_*` out of `provision.env` and run `provision.sh` again to revoke it.

**Owner decision: where may the deploy login connect from?** GitHub-hosted runners have no fixed addresses (thousands of ranges that change weekly), and SSH is otherwise limited to
`SSH_ALLOWED_CIDRS`. The options:

| Option | Cost |
|---|---|
| `DEPLOY_ALLOWED_CIDRS="0.0.0.0/0 ::/0"` (recommended for v1) | Port 22 is reachable by anyone, but **only the deploy login is allowed from outside** (`AllowUsers` per source: the administrator stays on `SSH_ALLOWED_CIDRS`), key-only, `MaxAuthTries 3`, fail2ban's sshd jail, and the key's only power is the forced command. The remaining risk is a flaw in OpenSSH or in `remote.sh` |
| A self-hosted runner on a fixed address (CIDR of that runner) | A machine to run and patch: a new tool, not in the plan; ask first |
| GitHub's published `actions` ranges | About 4 000 CIDRs in firewalld, rewritten every week: not workable |

The same sshd and firewalld rules are checked by `host-check.sh` (its section "CI deploy access and backups").

## 3. What a deploy does (`remote.sh`)

1. **Verifies the manifest**: at most 8 KiB, `key=value` lines only, `version=1`, a 40-hex `git_sha`, and for each of the five components (`public`, `admin`, `admin-cli`, `worker`, `postgres-walg`)
   exactly `<DEPLOY_REGISTRY_PREFIX>/<component>@sha256:<64 hex>`: a tag, another registry, a missing or extra key is refused before anything is pulled. (`migrate` and `internal` run the `worker`
   image, so five digests are enough.)
2. **Pulls the images by digest** (the job's short-lived `GITHUB_TOKEN`, sent over the SSH connection and held in a temporary auth file for the pull only; no registry credential is stored on the VM).
3. **`pg_dump -Fc`** of `ebooktrivia` to `/var/backups/ebooktrivia/predeploy/` (root, 0700), checked with `pg_restore -l`, the newest 7 kept and none older than 14 days (except the newest 2). A
   full disk or a dump that does not read back stops the deploy before anything changed.
4. **Tags** the new images as the names the quadlets run (`localhost/ebooktrivia/<component>:current`, `Pull=never`), after noting the image ids they replace.
5. **Runs the one-shot `migrate`** (the expand phase only: section 5).
6. **Restarts the units that got a new image, in this order**: `worker` first (it loads the Valkey function library `public` calls; a `public` instance started before it answers 503 on its rate-limited
   routes), waiting for its first heartbeat; then `internal`; then `public@a`, waiting for its `/livez` and for Caddy to see it; then `public@b`; then `admin`. "Caddy sees it" is checked from the Caddy container itself (`edge_sees` in `remote.sh`: Caddy's own
   active check, `GET /livez` within 1 s, twice in a row, 2 s apart) plus a 6 s margin for Caddy's checker: a freshly started app can answer slower than that for a while, and `public@b` must not go down
   before Caddy routes to `public@a` (the first local run had two failed requests of 154 without this wait).
7. **Checks health**: `/livez` of every unit (`podman healthcheck run`), the worker heartbeat (at most 3 minutes old), the deep **`/healthz`** of `public-a`, `public-b` and `admin` on their internal
   addresses (the answer must be `{"status":"ok"}`; a **new** release that answers 404 has no such route and fails; only a **rollback** to a release from before the route accepts the 404 and then makes the same
   checks directly: PostgreSQL, Valkey, the heartbeat), and Caddy answering `https://play.<DOMAIN>/` from the VM.
8. **On any failure after step 4: rolls back.** The previous images are tagged back and the units restarted in the same order, then checked again. The schema is **not** rolled back (section 5).
9. On success the manifest becomes `current` and the old one `previous` (`/var/lib/ebooktrivia/deploy/`); images no longer named by either are not pruned by the deploy.

**A dropped SSH connection does not leave the stack half rolled.** `deploy` and `rollback` run in their own transient systemd unit (`systemd-run --wait --pipe --collect --unit=ebt-deploy-<time>-<pid>`), so
the connection, `sudo` and the session can die and the unit goes on to its end: a success, or its own rollback. Inside it SIGHUP and SIGPIPE are ignored and a log write to a closed pipe is ignored too
(the journal has every line). If the script is **stopped** after step 4 (SIGTERM from `systemctl stop ebt-deploy-*`, a shutdown) or ends unexpectedly in any other way, it rolls the images back before it exits
(`on_exit`; the unit gets `TimeoutStopSec=1200` for it). `status` shows `deploy running: <unit>` while one runs and `last deploy: <time> <sha> OK|ROLLED_BACK|ROLLBACK_FAILED` after it. The workflow
therefore treats a lost connection (ssh exit 255) as "wait for the unit", polls `status` for up to 40 minutes and takes the result from `last deploy` for this release's sha (the job has 60 minutes).
`infra/verify/local/deploy-sim.sh` section 8 proves both: the SSH session killed while `public@a` rolls (the deploy runs on, here into the drill's failure and its rollback) and the unit stopped mid-roll
(rolled back before the script exits).

The script is idempotent (the same manifest again finds nothing to pull, dumps again, runs the re-runnable migrations and checks health), takes a lock (a second deploy waits for none: it refuses), and logs to
stdout and to the journal: `sudo journalctl -t ebt-deploy`. The workflow's job fails on a non-zero exit: **10** = the deploy failed and was rolled back (the stack runs the previous images, healthy), **2** = the
rollback itself failed (the stack needs a hand), **1** = refused before any change (a bad manifest, a full disk, a failed dump, a failed pull).

PostgreSQL itself is **not** restarted by a deploy: a changed `postgres-walg` digest is tagged and a line says so; restart `postgres.service` in a maintenance window (it is downtime):
`sudo infra/provision/as-app.sh systemctl --user restart postgres.service`.

## 4. Rollback

- **Automatic** (step 8 above): nothing to do; read the journal for why.
- **By hand**, after a deploy that passed its checks but turned out bad: from the VM, `sudo /usr/local/sbin/ebt-remote-deploy rollback` (no migration, no dump; it needs the previous images still on the host
  and the previous manifest), or from CI: re-run `deploy` on the previous commit (it pulls by digest again and runs the checks).
- `sudo /usr/local/sbin/ebt-remote-deploy status` prints the current and previous manifests (digests, never a token) and the unit states.
- **When the rollback fails** (exit 2): `sudo journalctl -t ebt-deploy -n 200`; `sudo infra/provision/as-app.sh systemctl --user status worker public@a public@b admin internal`; fix the cause; then
  `ebt-remote-deploy rollback` again. The pre-deploy dump is the way out of a damaged database (`pg_restore` into a scratch database first); the PITR restore is [restore-drill.md](../restore-drill.md).

## 5. Expand and contract: the rule, and how it is enforced

A deploy migrates **first** and restarts the apps after, and a failed deploy rolls back the **images** and leaves the schema alone. So for as long as a deploy lasts, the previous release runs on the new schema.
A release's migrations may therefore only **expand** it:

| Allowed in the release that adds it | A later release, after nothing deployed uses it |
|---|---|
| a new table, a nullable or defaulted column, an index, a function, a constraint every existing row and the previous release's writes satisfy | dropping or renaming a table or column, changing a column's type, `SET NOT NULL` on an existing column, a `NOT NULL` column without a default |

A rename is therefore three releases: add the new column and write both; switch the reads and drop the writes of the old; drop the old.

**Enforced two ways** (both in CI, both runnable locally):

- `infra/verify/local/expand-only.sh [--refuse-contract-ok] [BASE]` (and `infra/verify/src/expand-only.ts`) refuses a **new** `packages/db/migrations/*.sql` that drops or renames a table, column, schema, type,
  function, view, trigger, policy or sequence, retypes a column, makes a column `NOT NULL`, drops a column's `DEFAULT`, adds a `NOT NULL` column without a default, `REVOKE`s a privilege or truncates, and refuses a
  change to an applied migration. A file that really is a contract step says why on a line of its own, `-- contract-ok: <why the previous release no longer needs it>`, which the reviewer sees.
- **The deploy job checks the whole range, not only the last commit** (`deploy.yml`, before anything is sent): it reads the release running on the VM (`ssh ... status`, the `git_sha` of the current manifest;
  none on a first deploy) and runs `expand-only.sh --refuse-contract-ok <that sha>`, so every migration of **every commit** between the two is checked. A `contract-ok` line promises only that the *previous*
  release no longer needs what the file removes, which is known for a one-step deploy and not across a jump (the VM may be many commits behind), so in this range a marked file is **refused too**, unless
  the run is a manual `deploy` with the input **`allow_contract_ok`** ticked after you checked that no deployed release uses what it removes. A release older than the one on the VM (migrations the VM has are
  missing) is refused as "an applied migration was removed". The range logic is tested against a real history in `infra/verify/src/expand-only-range.test.ts`.
- The CI job **`migration-compat`** (`infra/verify/local/migration-compat.sh [PREVIOUS_REF]`) exports the previous release (the pull request's base, or the commit before the push), gives it this checkout's
  migrations, SQL files and migration runner, and runs **its own** integration tests on that schema: public, admin, worker, crypto. A previous release that breaks on the new schema fails the build.
  It does not run the db package's own tests (they pin this schema) or the chaos and load tests.

A failed `migrate` (the job exits non-zero) is a failed deploy: the images roll back, and since every migration file runs in one transaction, nothing of it was applied. The migrations known to refuse
non-conforming rows (`staging-provision.md`, Rollback and recovery) are handled by their own pre-checks.

## 6. The failure drill (staging only)

To prove the rollback on the real VM (AC-P11): on **staging**, `sudo touch /etc/ebooktrivia/deploy.allow-failure-drill` (the manifest key `force_fail` is refused anywhere that file does not exist), then
run `deploy` from Actions with the input **force_failure** set to one of `after_migrate`, `after_worker`, `after_internal`, `after_public_a`, `health`. The job passes when the deploy failed at that step
**and** rolled back (exit 10) and `status` shows the stack healthy on the previous images. Remove the file afterwards (`host-check.sh` prints a note while it exists; it must not exist on production).
Record the drill in [drills.md](../drills.md) (D8).

## 7. First deploy on a VM whose images were built by `build-images.sh`

The first manifest finds `localhost/ebooktrivia/<c>:current` already there from the local build: the deploy notes their image ids, pulls the manifest's, retags, and a rollback goes back to the local
build. There is no `previous` manifest after it (nothing to `rollback` to by manifest, only the automatic rollback to the ids). From the second deploy on, both exist.

## 8. What was proven, and what is staging-only

Proven locally (`infra/verify/local/deploy-sim.sh`, 0 failures: the vm-sim and stack-sim containers with the real images and a throwaway registry fixture, the deploy entered through the forced-command and
sudo path as the deploy user): the forced command's refusals (a tag, another registry, an unknown or doubled key, a missing component, a manifest over 8 KiB, `force_fail` without the drill file, a shell
injection, any other sudo argument), a normal deploy in the order above, the same manifest again (nothing restarted), a forced failure that rolls back, a natural failure (a broken image) that rolls back, a good
deploy afterwards and the manual `rollback`. Timings of that run (Windows 11, Docker Desktop, the nested AlmaLinux 10.2 VM; one run, so an order of magnitude, not a promise):

| Step | Seconds |
|---|---|
| First deploy of the images already running (nothing restarted, pg_dump of 14 MB, migrate) | 11 |
| Normal deploy, three new images (pull, pg_dump, migrate, rolling restart, health) | 115, with a request every 0.2 s through Caddy: **205 of 205 answered** (the play page's answer is a redirect to the login) |
| The same manifest again | 6 |
| Forced failure after `public@a`: detected (the drill's failure point, `public@a` up and visible to Caddy) | 50 after `public@a` was restarted |
| ...rolled back and healthy again | 57 after the failure; the whole run 140 |
| Natural failure (a `public` image whose entrypoint exits): detected | 16 after `public@a` was restarted |
| ...rolled back and healthy again | 57 after the failure; the whole run 89 |
| Manual `rollback` to the previous manifest (worker, internal, `public@a`, `public@b`, admin, health) | 59 |

Checked as text by `infra/verify/src/deploy.test.ts`: the order of the units, the manifest rules, the image names against the quadlets, the workflow's permissions and pins. The local stack needs the same
sealed-secret keys the real one does (the public app's payment private key and messaging public key): without them `/healthz` answers 503, a page 500s and the deploy's health check rightly fails. `stack-sim.sh`
makes throwaway keys for that.

**Staging only** (needs GHCR, the VM, and a runner that reaches it): `deploy.yml` end to end (build, push by digest, the SSH step with the pinned host key, GitHub's environment protection and secrets),
the pull from GHCR with the job's token, and the forced-failure drill of section 6 against the real VM (GL-11). The steps: set up section 1 and 2, push to `main`, watch `deploy` run for staging; then run
the drill.

## 9. Accepted risks of v1

- **A stolen deploy key can deploy an OLDER digest.** The forced command accepts any manifest of digests of this repository's registry prefix; it does not know which digest is newer, so a thief with the key
  and a still-published older image can deploy a release with a known vulnerability (the schema stays expanded, so it runs). It cannot deploy anything that is not in the repository's own registry, run another
  command, or read a secret. The deploy key is also useless without the SSH path (`DEPLOY_ALLOWED_CIDRS`, GL-22). Accepted for v1; the mitigations to consider later are a signed manifest (sigstore) the VM verifies
  against the repository, or a minimum `git_sha` ancestry check on the VM. Rotation: [escrow.md](../escrow.md) E10. Through the workflow itself an older release is refused anyway (section 5: its migrations
  are missing from the range).
- **The deploy login's reach is the registry prefix.** Anyone who can push to `ghcr.io/<owner>/<repo>/*` (the workflow's `GITHUB_TOKEN`, a maintainer's PAT) can get an image onto the VM through a stolen key
  or a compromised workflow. Keep package write access to the workflow.
