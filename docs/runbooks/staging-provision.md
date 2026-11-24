# Staging VM: provision, start, verify (US-014, plan M4a)

This runbook turns a fresh AlmaLinux 10.2 VM into the staging host. When it is done, both of these
pass on the VM:

- `host-check.sh` (acceptance criterion 4);
- the client-address probe (criterion 5).

The same scripts provision production later. Everything was proven locally on a stand-in VM
(see "What was verified locally"). What only a real VM can show is listed at the end.

## 1. Prerequisites

| Item | Requirement |
|---|---|
| VM | AlmaLinux **10.2** x86_64, 4 vCPU, 8 GB RAM (the plan M4.2 memory budget), 40 GB disk or more. SELinux not disabled (enforcing or permissive; a disabled one needs a relabel reboot, which the script asks for). |
| Login | A non-root user in group `wheel` with your key in `~/.ssh/authorized_keys`. Provisioning turns off root login and passwords, and it refuses to do so without this user. |
| Console password | A password for `ADMIN_SSH_USER` (or root) that works on the provider's web console, set **before** the first run. SSH then takes keys only, and the console is the way back in after a lockout ("Rollback and recovery"). |
| Network | A public IPv4 address (IPv6 optional). Inbound TCP 22 from your admin network, and 80/443 from anywhere. If the provider has its own firewall, open the same. |
| DNS | A records (and AAAA if IPv6) for `admin.`, `play.`, `order.` and `api.<DOMAIN>` pointing at the VM, set **before** Caddy starts: Let's Encrypt validates TLS-ALPN-01 on port 443. LP domains are pointed at the VM per landing page later. |
| Repository | A checkout readable by the app user, for example `/opt/ebooktrivia` owned by root with mode 755. Both the provisioning and the image builds run from it. |

## 2. Variables

Copy `infra/provision/provision.env.example` to `/etc/ebooktrivia/provision.env` (root:root, `0600`).
Replace every value: the example holds only reserved names and documentation addresses.

| Key | Meaning |
|---|---|
| `DOMAIN` | Base domain, for example the staging subdomain. Caddy serves `admin.`, `play.`, `order.` and `api.<DOMAIN>`. |
| `ACME_EMAIL` | Contact address for the Let's Encrypt account. |
| `ADMIN_SSH_USER` | The wheel user from the prerequisites. |
| `SSH_ALLOWED_CIDRS` | Sources allowed to reach SSH, space-separated. The script refuses to apply the firewall if your current SSH session does not come from one of them. |
| `ADMIN_ALLOWED_CIDRS` | Sources that reach `admin.<DOMAIN>`; everyone else gets a 404. Include the Uptime Kuma host. `0.0.0.0/0 ::/0` opens it to all. |
| `GLITCHTIP_ALLOWED_CIDRS` | Source(s) allowed to POST the GlitchTip hook (the WAHA/GlitchTip box). |
| `WAHA_ALLOWED_CIDRS` | Source(s) allowed to POST the WAHA webhook `/api/v1/webhooks/waha` (acks and buyer messages; US-025), everyone else gets a 404 from Caddy. The WAHA servers' addresses as Caddy sees them (see `delivery.md`). `0.0.0.0/0 ::/0` leaves only the HMAC. |
| `MONITOR_ALLOWED_CIDRS` | The Uptime Kuma host (the WAHA box): the only source that reaches `https://api.<DOMAIN>/healthz`, the deep health of the public app (US-015; everyone else gets a 404). Put the **same address in `ADMIN_ALLOWED_CIDRS`** too, for `admin.<DOMAIN>/healthz` ([monitoring.md](monitoring.md) section 3). |
| `DEPLOY_USER`, `DEPLOY_ALLOWED_CIDRS`, `DEPLOY_PUBLIC_KEY`, `DEPLOY_REGISTRY_PREFIX` | Optional, all or none (US-015): the CI deploy login `ebtdeploy`, the sources that may SSH in as it, its public key (no options) and `ghcr.io/<owner>/<repo>`. Provisioning creates the login, installs `ebt-remote-deploy` and the forced command, and opens SSH for it ([deploy.md](deploy.md) section 2: the Owner decides the sources). |
| `APP_USER` | Rootless podman user (default `ebt`). |

Secrets are never typed or committed. The provisioning generates them on the VM into the env
files (`0640`, owned by root, group the app user: the containers read them, the app user cannot change them; ASVS V13.3.1):

- PostgreSQL login passwords;
- Valkey ACL passwords (`users.acl` stores only their SHA-256);
- the PostgreSQL superuser password;
- the GlitchTip hook token (`internal.env` stores only its SHA-256);
- the wal-g libsodium key (`postgres/walg_libsodium.key`) and the restic password (`restic.env`, US-015): **escrow both the day they are made** ([escrow.md](../escrow.md)). The S3 locations and credentials of both backups are the operator's to fill in (`walg.env`, `postgres/walg_aws_credentials`, `restic.env`; [backups.md](backups.md)): `host-check.sh` fails while a placeholder is left.

## 3. Run order (all as root, from the checkout)

```sh
cd /opt/ebooktrivia
sudo infra/provision/provision.sh                 # 1. host + config; run it again: "summary: 0 changed"
sudo infra/provision/build-images.sh              # 2. postgres-walg, public, admin, worker, then the landing-page SDK files into /srv/sdk (10-20 min)
```

### Operator steps

- **Uptime Kuma.** In `/etc/ebooktrivia/worker.env`, set `UPTIME_KUMA_PUSH_URL`, or leave it empty
  (`UPTIME_KUMA_PUSH_URL=`) while there is no Kuma. Later provisioning runs keep the value, even an
  empty one. The **alerts backstop** (US-015) is a second push monitor on the same Kuma: uncomment
  `UPTIME_KUMA_ALERTS_PUSH_URL` in the same file ([monitoring.md](monitoring.md), [alerts.md](alerts.md)).
- **Alert recipients (US-015).** After the first Owner exists: Admin, Alerts: the Owner's WhatsApp number,
  e-mail and lowest severity, then **Send a test alert** ([alerts.md](alerts.md)); the Owner first writes one
  message to a pool number from that phone.
- **Customer service contact.** After the first Owner exists: Admin, Customer service: the CS WhatsApp number
  (never one of the sending numbers), e-mail and hours. Buyers then see the "Butuh bantuan?" block on every
  page and a CS line in a few WhatsApp replies; with nothing set they see neither ([customer-service.md](customer-service.md)).
- **GlitchTip token.** Copy the token from `/etc/ebooktrivia/glitchtip-hook.token` into GlitchTip's
  webhook URL, `https://api.<DOMAIN>/hooks/glitchtip/<token>`. Then delete the file.
- **Checkout (US-020).** Add the escrowed `SECRETS_PAYMENT_PRIVATE_KEY` to `/etc/ebooktrivia/public.env` (the
  payment key only: the public app refuses to start with another scope's private key); without it every
  checkout answers 503. In the Midtrans dashboard (Settings, Snap preferences) set the **Unfinish** and
  **Error** redirect URLs to `https://order.<DOMAIN>/`: the checkout sends only the per-order **finish** URL
  `https://order.<DOMAIN>/{publicId}` in the Snap request (`callbacks.finish`, the one callback the Snap API
  documents), and Midtrans appends `?order_id={publicId}-{n}` to the dashboard URLs (the order page, US-022,
  maps it back). The sandbox recording of US-005 (docs/spikes/R12.md) confirmed the per-order finish URL: Snap
  redirects to it with `?order_id=&status_code=&transaction_status=` appended (an existing query is kept) after a
  successful payment, and a bank decline does NOT redirect (the buyer stays on the Snap page and can pick another
  method). The Unfinish and Error redirects exist only as dashboard settings and could not be triggered without the
  dashboard: check them once on staging.
- **Payment notifications (US-021).** Add the same escrowed `SECRETS_PAYMENT_PRIVATE_KEY` to
  `/etc/ebooktrivia/worker.env`: the worker re-queries Midtrans for every notification and runs the nightly
  reconciliation (02:00 WIB); without it no order is ever confirmed PAID. In the Midtrans dashboard (Settings,
  Payment, Notification URL) set the **Payment Notification URL** to `https://api.<DOMAIN>/api/v1/webhooks/midtrans`.
- **Cap is stateless (US-020).** A Cap challenge and a redeemed token are signed by `CAPTCHA_HMAC_KEY`
  (`/etc/ebooktrivia/public.env`, generated once, the same for public@a and public@b) and carry their landing
  page's id; neither the challenge nor the redeem route stores anything, so a flood of them cannot fill the
  `noeviction` Valkey the worker's queues live in. The only Cap memory is one single-use mark per token a
  checkout verifies (`cache:public:cap:t:<nonce>`, at most 20 minutes), behind a solved proof of work and the
  per-IP checkout limit. The routes are rate limited per client IP / IPv6 /64 (`captcha.ip_cap`) and per IPv6
  /48 (`captcha.ip48_cap`). **Rotating the key** (there is no previous-key fallback): write the new
  `CAPTCHA_HMAC_KEY` to `public.env`, then restart public@a and public@b TOGETHER (two instances with different
  keys would refuse each other's challenges and tokens). Every challenge and token in flight is void from that
  moment, for up to 20 minutes of their lifetimes: each affected buyer sees one captcha retry (the SDK solves a
  new token). The app refuses a key that is one byte repeated (a placeholder such as 64 zeros).
- **Player login (US-026).** `public.env` needs `PLAYER_AUTH_SECRETS` and `PLAYER_OTP_PEPPER` (generated) and
  `SECRETS_MESSAGING_PUBLIC_KEY` (added by the Owner with the payment key); the worker needs the messaging private
  key to send the codes. Without them only the play routes answer 503 (`play.disabled` is logged at start);
  checkout and the Midtrans webhook keep working. **Player login limits** (the admin-editable `otp.*` settings,
  plus fixed numbers in `apps/public/src/lib/play/limits.ts`):
  - code requests: `otp.ip_cap` per client IP (an IPv6 /64) per `otp.ip_window_seconds` (10 / 1 h), 10 times that per
    IPv6 /48; per phone (counted for every phone, known or not) a `otp.cooldown_seconds` cooldown (60 s) and
    `otp.phone_cap` per `otp.phone_window_seconds` (3 / 1 h, enforced again in SQL by `enqueue_otp`);
  - code checks: `otp.ip_cap` x `otp.max_attempts` per IP (50 / 1 h), 10 times that per /48, 10 per phone per 24 h over
    all its codes, 5 per code; every wrong-code answer is sent 250 ms after the request arrived (timing);
  - magic-link logins: the same per-IP and /48 budget as code checks;
  - **the global OTP send breaker**: at most `otp.global_send_cap` codes per 10 minutes over all phones (default 500,
    about 3000 logins an hour; editable on the admin limits page, 50..100000). When it trips, no code is sent, the
    API answer stays the same, and a critical alert `otp_send_breaker` is written (once an hour while it lasts).
    Look for abuse first (the `play.refused` log lines, Valkey `rl:otp:*` counts); raise the cap only for a genuine
    login wave, and resolve the alert when sending is back to normal.

### Start the stack

```sh
A=infra/provision/as-app.sh
sudo $A systemctl --user start postgres.service valkey.service
sudo infra/provision/db-roles.sh                  # logins, one group each; run again: "0 changed"
sudo $A systemctl --user start migrate.service    # roles.sql + migrations (one-shot)
sudo $A systemctl --user start internal.service worker.service admin.service public@a.service public@b.service
sudo $A systemctl --user start caddy.socket caddy.service   # :80/:443 and Caddy itself (it orders its certificates at start)
```

Start the worker before the public instances on a fresh or restored Valkey (US-031; the line above does, and
`public@.container` is ordered `After=worker.service`): the worker loads the Valkey function library the public rate limits
call; until it is there a public instance answers 503 on its rate-limited routes (it stays ready and serves every other
route), and the worker raises `valkey_function_missing` if it finds it gone later. Valkey's AOF keeps the library across restarts
(docs/runbooks/security-scans.md, section 4).

Each start returns once the unit is healthy (`Notify=healthy`): the apps answer `/livez`, the
internal process its ask endpoint, PostgreSQL `pg_isready` on its address (not the socket, which the
first-start initdb server also opens), Valkey `PING`. If a restart prints `restart needed: <unit>`
lines (provision.sh after a config change), restart those units.

After a reboot, everything comes back on its own:

- linger and `caddy.socket` are enabled;
- every long-running quadlet has `WantedBy=default.target`;
- only `migrate` must be started by hand, or by the deploy ([deploy.md](deploy.md): `deploy.yml` runs it before the rolling restart, worker first).

Logs: every container logs to the journal: `sudo journalctl CONTAINER_NAME=<container>` (for example `public-a`, `caddy`).

## 4. Verify criterion 4 (host check)

```sh
sudo infra/verify/host-check.sh
```

The check is read-only. It must end with `summary: N passed, 0 failed`. It covers:

- **OS and SELinux:** the AlmaLinux 10.2 release; `getenforce` = Enforcing; no AVC denial since boot (`ausearch`); `container_file_t` on every bind-mount source;
- **firewalld:** only zone `public` active, no interface or source in another zone; target `default`; exactly the services dhcpv6-client, http and https; no ports, protocols, source or forward ports; SSH rich rules for exactly `SSH_ALLOWED_CIDRS`; runtime equal to the permanent config;
- **listening sockets:** only sshd on 22, Caddy's 80/443 (held by the user's systemd), chronyd on loopback and the DHCP client;
- **sshd:** `sshd -T` shows key-only, no root login, no forwarding, `AllowUsers` per SSH CIDR; a live password attempt gets `Permission denied (publickey)`;
- **services:** fail2ban with the sshd jail, `dnf-automatic.timer` (security updates), EPEL limited to fail2ban, chrony synchronised;
- **host settings:** the sysctls; the app user's nologin shell, linger and memory-controller delegation; the egress guard (the app user cannot reach 169.254.0.0/16 or this host's own addresses);
- **files:** `/etc/ebooktrivia` owned by root (group `ebt`, files `0640`), nothing in it owned by the app user, no placeholder or token file left, no client-ip probe left;
- **units:** every unit active and healthy; the migrations applied;
- **memory:** each container's podman limit and its cgroup `memory.max` equal the budget; no published port;
- **network isolation:** Caddy reaches admin, internal and public; public cannot reach admin or internal (by name or address, on any network); Caddy cannot reach PostgreSQL or Valkey; the data-only containers have no egress; no container reaches the host's sshd;
- **Valkey:** the default user is refused; every user is confined to its keys and its own `cache:<app>:` prefix; `public` runs a command allowlist (US-020); INFO only for `worker`; KEYS, SCAN, RANDOMKEY, FUNCTION, CONFIG and the other @dangerous / @admin commands denied; noeviction and AOF on;
- **PostgreSQL:** logins in exactly one group; no PUBLIC CONNECT or TEMP on `postgres` or `template1`; the `pg_hba` rules; no superuser password in the server's environment;
- **Caddy:** ports 80/443 held by the user's systemd; http redirects to https.

## 5. Verify criterion 5 (real client address)

```sh
sudo infra/verify/client-ip-probe.sh start    # public@b now answers with what an app sees
```

From a machine **outside** the VM, note its public address, then run:

```sh
for i in 1 2 3 4 5 6; do curl -s https://play.<DOMAIN>/; echo; done
for i in 1 2 3 4 5 6; do curl -s -H 'X-Forwarded-For: 203.0.113.9' https://play.<DOMAIN>/; echo; done
```

About half the replies are the probe's JSON. Pass when every JSON reply has:

- `"clientIp"` = that machine's public address, also with the spoofed header;
- `"peer":"10.89.50.2"` (Caddy's pinned address).

Then put the real app back:

```sh
sudo infra/verify/client-ip-probe.sh stop
```

Caddy's access log shows the same address:

```sh
sudo journalctl CONTAINER_NAME=caddy -o cat | grep remote_ip | tail -3
```

## Rollback and recovery

- **Locked out of SSH** (wrong `SSH_ALLOWED_CIDRS` or key): log in on the provider's web console as `ADMIN_SSH_USER` or root, then
  ```sh
  rm /etc/ssh/sshd_config.d/00-ebooktrivia.conf && systemctl reload sshd     # passwords and root as before
  firewall-cmd --add-service=ssh                                              # runtime only: until the next reload
  ```
  Fix `provision.env` and run `provision.sh` again; it puts both back.
- **Stop or remove the stack:** `sudo $A systemctl --user stop caddy.socket caddy.service public@a public@b admin worker internal valkey postgres`. To remove it for good: `sudo $A systemctl --user disable caddy.socket`, delete the unit files as the app user (`sudo runuser -u ebt -- rm -r /home/ebt/.config/containers/systemd /home/ebt/.config/systemd/user/caddy.socket`), then `sudo $A systemctl --user daemon-reload`. Volumes stay until `sudo $A podman volume rm ebt-pgdata ebt-valkeydata ebt-caddy-data ebt-caddy-config`.
- **Migrations 0007 / 0008 refuse non-conforming rows (US-017).** They add CHECKs to existing tables, so `migrate.service` fails (and changes nothing) on a database holding a row that breaks one. Fix the rows, then start `migrate.service` again:
  - `waha_sessions_session_name_check`: a session name of 1-64 letters, digits, `_` or `-` (as WAHA names sessions). Find them with `SELECT id, session_name FROM waha_sessions WHERE session_name !~ '^[A-Za-z0-9_-]{1,64}$'` and rename the session in WAHA and here;
  - `smtp_settings_security_port_check` (TLS with port 465, STARTTLS with any other) and `*_allow_private_ip_check` (the private-IP flag on an IPv4 address only, in `smtp_settings` and `waha_servers`): correct the row, or turn the flag off.

  Pre-check before deploying 0008 (each must return no row; `ebt_migrate` or any admin_rw login):
  ```sql
  SELECT id, base_url_host FROM waha_servers
   WHERE allow_private_ip AND base_url_host !~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}(:[0-9]{1,5})?$';
  SELECT host FROM smtp_settings WHERE allow_private_ip AND host !~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$';
  SELECT host, port, security FROM smtp_settings WHERE (security = 'tls') <> (port = 465);
  SELECT id, session_name FROM waha_sessions WHERE session_name !~ '^[A-Za-z0-9_-]{1,64}$';
  ```
  0007 also locks every program that already has a paid order (`locked_at` = its first `paid_at`).
- **Migration 0010 refuses a click-id parameter named like personal data (US-019).** It adds `adnets_clickid_param_personal_check`, so `migrate.service` fails (and changes nothing) when an adnet's `clickid_param` has one of these as a WHOLE word, delimited by `_`, `.`, `-` or the ends of the name: phone, hp, wa, whatsapp, nama, name, email, mail, token, otp, kode, nik, ktp, card, kartu, pass, password, pwd, secret, auth, session (`no_hp`, `phone_number` and `session_id` are refused; `swap_id` and `hpid` are not). Find them with `SELECT id, slug, clickid_param FROM adnets WHERE clickid_param ~* '(^|[_.-])(phone|hp|wa|whatsapp|nama|name|email|mail|token|otp|kode|nik|ktp|card|kartu|pass|password|pwd|secret|auth|session)($|[_.-])'`, change the parameter in the adnet's settings (and in its tracking links), then start `migrate.service` again.
- **A failed first PostgreSQL start** (initdb stopped half-way, wrong superuser password file): `sudo $A systemctl --user stop postgres.service`, `sudo $A podman volume rm ebt-pgdata`, start it again, then `db-roles.sh` and `migrate.service`. This deletes the database: only before real data exists.
- **The client-ip probe did not stop** (`client-ip-probe.sh stop` failed half-way): `sudo runuser -u ebt -- rm -f /home/ebt/.config/containers/systemd/public@b.container.d/90-client-ip-probe.conf`, `sudo rm -rf /etc/ebooktrivia/probe`, `sudo $A systemctl --user daemon-reload`, `sudo $A systemctl --user restart public@b.service`. host-check fails while the drop-in exists.
- **Undo a provisioning run:** it only adds files under `/etc` and the app user's home and changes firewalld, sshd and SELinux settings; the lockout steps above undo the access changes. Uninstalling the packages is not needed for a retry: every step is idempotent.

## Content images (set thumbnails, prize images, program banners, question images)

The Owner's pictures live under `/srv/data` (the admin app writes them; `@ebooktrivia/core` `content-images.ts` names every path):

| What | Stored as | Who reads it |
|---|---|---|
| Set thumbnail, prize image, program banner | `images/<upload id>.webp` and its **display copy** `images/<upload id>.display.webp` (thumbnails fit 480 x 600, prize images 256 x 256, banners 1344 x 448, made at upload) | the public app, read-only mount of `/srv/data/images`: `play.<DOMAIN>/api/v1/play/img/set/<set>/<upload>.webp`, `.../prize/<tier>/<upload>.webp` and `.../banner/<program>/<upload>.webp`, display copy first, the original while a copy is missing (log `display_missing`) |
| Question image | `question-images/<upload id>.webp` only | nobody: the directory is **not mounted** into the public app, and question images are not shown to players (a picture is part of the question; showing one awaits an encrypted, database-gated design) |

The route answers a bare 404 for anything else (not the row's own image, a draft program, a question image, a link, a missing file), caches the lookup in-process (2000 entries, 2 minutes, nothing negative),
counts only cache misses per client (`play:img:ip:<bucket>`, 300 a minute, failing open without Valkey: log `play.image` `valkey_unavailable`) and refuses a symbolic link.

**Release that introduces this (first time), in this order** (`$A` as above).

**With the CI deploy** ([deploy.md](deploy.md)) instead, first check that nothing has to be moved out of `images/` (otherwise the new public instances would start with a mount that still holds images players are not shown, until the move): build the CLI image (`sudo infra/provision/build-images.sh admin-cli`), then

```sh
sudo $A podman exec -u postgres postgres psql -X -At -d ebooktrivia -c "SELECT count(*) FROM uploads u WHERE u.kind = 'image' AND u.storage_path = 'images/' || u.id || '.webp' AND NOT EXISTS (SELECT 1 FROM trivia_sets s WHERE s.thumbnail_upload_id = u.id) AND NOT EXISTS (SELECT 1 FROM prize_tiers t WHERE t.image_upload_id = u.id) AND NOT EXISTS (SELECT 1 FROM programs p WHERE p.banner_upload_id = u.id)"
```

and `cli move-question-images --dry-run` (the `cli` function of step 4, in a stop/start window of `admin.service`). If the count is not 0, or the dry run reports anything (a move, a `damaged`, a `stray`, a `shared`), **use the manual order below**. When both are clean: run step 1 before the deploy (it installs the quadlet and the directories; the deploy builds, migrates and restarts), and step 4's `backfill-display` after it (stop admin, run, start admin); until then the play pages serve the originals (log `display_missing`, once per upload and instance).

**On the deploy that brings migration 0025 (program banners).** The count above and `cli move-question-images` read `programs.banner_upload_id`, the column 0025 adds, so run `migrate.service` FIRST (`sudo $A systemctl --user start migrate.service`, from the `worker` image of that release), and only then the count and the dry run, with an `admin-cli` image built from that same release. Never run `move-question-images` from an `admin-cli` image older than the release that brings banners: it does not know that a banner is shown to players and would move it out of `images/` (the play page then shows the built-in picture until the Owner uploads it again). A banner needs no backfill when it was uploaded after this release (the admin writes its display copy at upload); `backfill-display` covers any other.

1. **`sudo infra/provision/provision.sh`** from the new checkout: creates `/srv/data/images` and `/srv/data/question-images` (750, the app user), writes the new `public@.container` (a read-only `/srv/data/images` mount), runs `daemon-reload`, prints `restart needed: public@a.service public@b.service`. Do not restart yet.
2. **Build the images**, the `worker` one first because `migrate` runs from it and carries `grants.sql`: `sudo infra/provision/build-images.sh worker public admin admin-cli`.
3. **Migrate**: `sudo $A systemctl --user start migrate.service`. `grants.sql` narrows `public_rw` on `uploads` to `id, kind, storage_path, content_type` (nothing else of the app reads more). Old and new apps both run on it.
4. **Backfill**, with the admin unit stopped (pg_hba admits `ebt_admin` from admin's own address, 10.89.51.13, which the one-off container takes over):

   ```sh
   A=infra/provision/as-app.sh
   sudo $A systemctl --user stop admin.service
   cli() { sudo $A podman run --rm --network ebt-data:ip=10.89.51.13 --userns=keep-id:uid=1000,gid=1000 -v /srv/data:/srv/data:z \
     --read-only --tmpfs /tmp --cap-drop=all --security-opt=no-new-privileges --memory=600m \
     --env-file /etc/ebooktrivia/admin.env --entrypoint node localhost/ebooktrivia/admin-cli:current apps/admin/src/cli/images.ts "$@"; }
   cli backfill-display --dry-run && cli backfill-display      # the display copy of every set thumbnail, prize image and program banner (diet90: 90 + 2 + banners)
   cli move-question-images --dry-run && cli move-question-images   # every image players are not shown (question images, replaced thumbnails, orphans) out of images/; staging: none expected
   ```

   Both print one line per upload (ids only) and a summary, are safe to run again, and exit 0, or 2 when they list something they could not handle: a missing file, a file whose bytes do not match the digest in its row (`damaged`: nothing is changed or deleted; restore it from the restic copy), one a question uses and a set or prize also shows (`shared`), one that is not a stored image, or a `stray` file under `images/` that no row names (reported, never deleted). Look at the lines, fix, run again.
   `move-question-images` copies to a temporary file, flushes it, checks its sha256 against the row, renames it into place, rewrites the row (exactly one row, or it stops) and only then removes the old file, so the only good copy is never deleted. The container only writes `/srv/data` (mounted), hence the read-only root.
   `backfill-display --force` makes every copy again. A crash leaves at most a temporary file: `images/.<id>.display.tmp` (reported as a `stray` by the next move run: delete it) or `question-images/.<id>.tmp` (the next run replaces it); the next run finishes an interrupted move.
5. **Restart**: `sudo $A systemctl --user restart public@a.service` (wait for it), then `public@b.service`, then `sudo $A systemctl --user start admin.service` (it was stopped in 4; on the new image its uploads already go to the right directory).
   Check one tile in a browser as a signed-in player, and `sudo journalctl CONTAINER_NAME=public-a | grep display_missing` (none).

## Routine operations

- **Rotate the GlitchTip token:** run `sudo infra/provision/rotate-glitchtip-token.sh`. It writes a new token file, puts the new SHA-256 in `internal.env` and restarts `internal`; the old token then gets a 404. Put the new URL in GlitchTip and delete the file. Caddy logs never contain the token: the URI of `/hooks/glitchtip/*` is redacted before a log line is written.
- **Rotate `SECRETS_PAYMENT_PRIVATE_KEY`:** the signed ebook download links (`/files/deliverables/...`, US-025) are signed with a key derived from it, so a rotation **voids every outstanding link**: a WhatsApp send in flight fails its download and is retried through the failover, and the 72-hour link of an e-mail whose PDF was too large stops working (the buyer still has the WhatsApp delivery and the order page; resending is US-029). Rotate when no delivery is in flight (a quiet hour), put the new key in `public.env` and `worker.env` together, and restart both.
- **Change a setting in `provision.env`:** run `provision.sh` again. It rewrites `caddy.env` (and the sshd `AllowUsers`, firewalld rules) and prints `restart needed: caddy.service`.
- **Change an env file by hand:** keys you add are kept by later runs. Generated values are never regenerated while present.
- **Drain one public instance:** `sudo $A systemctl --user restart public@a.service`. On SIGTERM, `/livez` answers 503 for `EDGE_DRAIN_MS` (5 s, more than Caddy's 2 s check + 1 s timeout), Caddy stops sending, in-flight requests finish, then the instance restarts. Local result: 0 failed requests out of 40 during a restart. A manual switch without a restart needs `EDGE_DRAIN_FILE` set in the quadlet (unset by default).
- **Reboots after kernel updates:** `dnf needs-restarting -r`. dnf-automatic applies security updates but never reboots.

## Design notes (deviations from the plan text, with the reason)

- **Caddy is socket-activated** (`caddy.socket`, `bind fd/3` / `fd/4`). The plan only says "pinned IP". Rootless podman's port forwarding (rootlessport) replaces the client address with the container's own address. Measured on podman 5.8.2: Caddy saw `10.89.50.2` for every client. With the sockets bound by systemd in the host network namespace, Caddy sees the real client and still sits on the bridge network at its pinned IP. HTTP/3 (UDP) is not offered.
- **ACME uses TLS-ALPN-01 only**, because the HTTP-01 solver would need its own `:80` listener inside the container. Locally, a Pebble ACME CA issued every certificate through `caddy.socket`, including on-demand LP certificates.
- **Four podman networks** (security review S2, S15).
  - `ebt-edge` (10.89.50.0/24, egress): Caddy, public@a/b, the worker.
  - `ebt-admin` (10.89.52.0/24, internal): Caddy and admin only. Admin listens on 10.89.52.13 only; its `TRUSTED_PROXY_IP` is Caddy's 10.89.52.2.
  - `ebt-internal` (10.89.53.0/24, internal): Caddy and the internal process only (it needs no egress).
  - `ebt-data` (10.89.51.0/24, internal): PostgreSQL, Valkey and their clients. Caddy is not on it.
  - Every app binds its Caddy-facing address only (`EDGE_HOST`, required in production), so the admin allowlist cannot be bypassed from another container.
  - Every container has a pinned address, so each app login reaches the database only from its own address.
- **Admin and internal have no egress.** If admin must reach an outside service later (GlitchTip error reports via `@sentry/nextjs`), give it an egress-only network of its own rather than `ebt-edge`.
- **sshd** (review C-M3, S5): the drop-in is `00-ebooktrivia.conf`, so it sorts first. provision.sh refuses a drop-in sorted before it that sets one of its keywords, any other `AllowUsers` / `AllowGroups` (they add up across files), and any `Match` block. It does not refuse AlmaLinux's own `50-redhat.conf`, which sets some of the same keywords but sorts after it and so cannot win. After every change it checks that `sshd -T` shows each setting. `AllowUsers` admits only `ADMIN_SSH_USER`, so the deploy story's forced-command login needs its own `AllowUsers` entry (and a shell: `ebt` has none).
- **Root never writes inside a tree the app user owns** (review S1). `/etc/ebooktrivia` and its subdirectories are `root:ebt 0750`, files `0640`; the root helpers refuse a path with a non-root ancestor; files under the app user's home are written by the app user. Provisioned config is labeled `container_file_t` by `semanage fcontext` and mounted read-only without relabeling (rootless podman cannot relabel root-owned files).
- **Data directories** (review S7): `/srv/data/deliverables` (ebook PDFs) is read-only for public and the worker; `/srv/data/images` (the set thumbnails and prize images the admin app writes as `images/<upload id>.webp`, each with a `.display.webp` copy) is read-only for public, which serves them on the play origin only (`/api/v1/play/img/...`, `apps/public/src/lib/play/images.ts`); question images are stored in `question-images/`, which public does not mount; `/srv/data` as a whole (imports, proofs) is mounted into admin only. See [Content images](#content-images-set-thumbnails-prize-images-question-images).
- **Egress guard** (review S6): an nftables table `inet ebt_egress` (`ebt-egress-guard.service`) drops the app user's traffic to 169.254.0.0/16 (provider metadata) and to this host's own addresses, except DNS (port 53, wherever the resolver is) and replies on connections others opened (Caddy's listeners); IPv6 link-local and `fd00:ec2::254` too. The app user's systemd requires the guard, so without it no container starts (fail closed).
- **Accepted risk** (review S11): `net.ipv4.ip_unprivileged_port_start=80` lets any local user bind ports 80-1023. The VM is single-tenant (root, the admin user and `ebt` only); the alternative (a root-owned socket unit handing fds to a user service) was judged not worth its complexity.
- **Accepted risk, M11 item** (review S8): Valkey runs `noeviction` with `maxmemory 384mb`; `public` can write `rl:*` and `cache:public:*` without a bound, so a bug or abuse could fill it and make every write fail. Valkey has no per-user memory quota, so every `rl:*` and `cache:public:*` key must carry a TTL, and monitoring must alert on `used_memory` (for example above 80 % of `maxmemory`); M11 load tests must watch it too.
- **Body and write timeouts** (review S10): `read_body 30s`, `read_header 10s`, `write 10m` (a 100 MB PDF on a ~1.5 Mbit/s link), `idle 2m`. Caddy 2.11.9 has no per-route body timeout (`request_body` rejects `read_timeout`, checked), so a single admin upload must finish its body in 30 s: the admin upload story (M5b) must send large PDFs in chunks.
- **`/livez` is answered by the apps' edge listener** (`packages/edge`, in front of Next.js), not by a Next route. It must work before host gating in `proxy.ts`, and SIGTERM (which only the server process sees) must flip it to 503.
- **Trusted proxy.**
  - Caddy trusts no proxy in front of it (it is the edge). It sets `X-Forwarded-For` to the TCP peer and strips other client-address headers.
  - The apps' edge listener believes `X-Forwarded-For` only from `TRUSTED_PROXY_IP=10.89.50.2`. From anyone else it uses the socket peer.
  - It rewrites `X-Forwarded-For` to that single address before Next.js or Better Auth read it.
- **Keep-alive.** Caddy closes idle upstream connections after 30 s, and the apps after 65 s. Caddy therefore never reuses a connection that an app is closing.
- **`ebt_migrate` is a superuser** (roles.sql resets cluster-wide role state), allowed from the migrate container's address only. It is also a member of `migrator`, as the roles.sql comment says.
- **SDK files:** `/srv/sdk` (app user, 750) is mounted read-only into Caddy and served at `api.<DOMAIN>/sdk/` (`handle_path /sdk/*`). `build-images.sh sdk` builds them in the Containerfile's `sdk` stage and adds them without deleting anything: `sdk-v<version>.js` and `cap-v<version>.js` are immutable (a one-year `immutable` cache; a changed file with an existing name is refused, so bump `packages/sdk/package.json` first), `v1.js` is replaced by a rename (5 minute cache). Run it again on every SDK release.
- **LP roots:** only lowercase stored-form hosts map to `/srv/lp/hosts/<host>/current`. Browsers send hosts lowercased; anything else, `..` included, is a 404. `current` must be a **relative** symlink to a release directory, swapped with `ln -s ... current.new && mv -T current.new current`.

## What was verified locally (no VM yet)

Run these from the repository root on a machine with Docker:

- `infra/verify/local/vm-sim.sh all`:
  - provisions a privileged AlmaLinux 10.2 systemd container twice (the second run: 0 changed);
  - runs the quadlet generator on the installed units;
  - runs host-check (only container-only failures).
- `infra/verify/local/stack-sim.sh all`:
  - runs the whole stack in it with rootless podman, socket-activated Caddy and the real images;
  - issues certificates from Pebble;
  - checks client addresses, blocked paths, the GlitchTip hook allowlist and log redaction, on-demand LP TLS, the symlink swap and drain on restart;
  - runs host-check with the stack up (only SELinux and chronyd fail, as expected in a container).
- `infra/verify/local/{shellcheck,caddy-adapt,quadlet-dryrun}.sh` (also CI job `infra`) and `pnpm test` (`infra/verify/src`, `packages/edge`).
- `pnpm --filter @ebooktrivia/worker test:chaos` includes the production Valkey ACL test with BullMQ.

## VM-only (cannot be shown in a container)

- **SELinux:** `getenforce` Enforcing, no AVC denial, `container_file_t` on the bind-mount sources (`semanage fcontext` for `/etc/ebooktrivia`, podman's `:z` for `/srv`).
- **chronyd** keeping time.
- **Kernel-wide sysctl:** `vm.overcommit_memory` applied by the script, not inherited.
- **Real Let's Encrypt issuance** for the real `DOMAIN` (Pebble stood in for the CA).
- **The client-address probe** run from a real outside machine through the provider's network (criterion 5).
- **fail2ban** banning through firewalld on a real interface.
- **dnf-automatic** applying a real advisory.
