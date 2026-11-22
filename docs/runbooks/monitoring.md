# Monitoring: Uptime Kuma and GlitchTip on the WAHA box (US-015, plan section 2 and M4 item 8)

Both run on the Owner's WAHA box, **off the app VM**, so an alert reaches the Owner even when the VM is down (AC-P4). `infra/monitoring/compose.yaml` is their compose project. This runbook installs
them **without disturbing the other app on that box** and sets up the monitors, the notifications and GlitchTip's alert path. It never touches WAHA's containers, volumes, networks or session
configuration. **Nothing here has been run yet**: the monitoring box and the VM do not exist for this story. What was checked: the images and their digests (`docs/versions.md`), the compose file's
text (`infra/verify/src/deploy.test.ts`: pinned digests, loopback ports, memory limits), and the monitor list (`infra/monitoring/kuma/monitors.json`).

## 0. What runs, and its limits

| Container | Image (digest in the compose file) | Port (loopback only) | Memory limit |
|---|---|---|---|
| `kuma` | Uptime Kuma 2.5.9 | `127.0.0.1:3001` | 512 MB |
| `glitchtip` | GlitchTip 6.2.6 (web, worker and beat in one process; no Valkey: the queue lives in PostgreSQL) | `127.0.0.1:8000` | 768 MB |
| `glitchtip-postgres` | PostgreSQL 18.6 (the digest the app's own image uses) | none | 384 MB |

About 1.7 GB of memory in all, at most; 2 GB of disk to start with (Kuma's SQLite, GlitchTip's PostgreSQL, 30 days of events). The compose project is named `ebt-monitoring`: its own network, its own named volumes.

## 1. Before you start (do not disturb the other app)

On the box, read-only, and write the answers down:

```sh
docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'     # what already runs; leave all of it alone
ss -ltnp | grep -E ':(3001|8000)\b'                                  # are 3001 and 8000 free? if not, pick other ports in .env (KUMA_PORT, GLITCHTIP_PORT)
free -m; df -h /var/lib/docker                                       # about 2 GB of memory and 5 GB of disk to spare
docker network ls; docker volume ls                                  # names starting ebt-monitoring / ebt-monitoring_ must not exist yet
```

Do **not** run `docker system prune`, `docker compose down -v` in another project's directory, or anything on WAHA's containers. Use `docker compose -p ebt-monitoring ...` (the file's `name:` already does)
and only ever run compose from `infra/monitoring/`. WAHA's session configuration (webhooks, HMAC keys, engine settings) is never edited by this setup: Kuma only **reads** a session's status.

## 2. Install

1. Copy `infra/monitoring/` to the box (for example `/opt/ebt-monitoring/`), mode 0750, owned by the user that runs Docker commands.
2. `cp .env.example .env` (ports), `cp glitchtip.env.example glitchtip.env` and replace every `CHANGE_ME` (`chmod 600 glitchtip.env`): `SECRET_KEY` (`openssl rand -hex 32`), the database password in `DATABASE_URL`,
   the SMTP URL and sender, the domain. Create `glitchtip-db-password.txt` with the same database password (one line, `chmod 600`). None of these files is committed (`.gitignore`).
3. `docker compose --env-file .env up -d` from that directory. `docker compose ps` shows three healthy containers; `curl -fsS http://127.0.0.1:8000/_health/` answers.
4. **Claim both accounts over an SSH tunnel, BEFORE any public name exists** (the first visitor to a fresh Kuma becomes its admin, and a fresh GlitchTip lets anyone register; both ports are loopback only
   until step 5): `ssh -L 3001:127.0.0.1:3001 -L 8000:127.0.0.1:8000 <the box>`, then in the browser on your own computer:
   - `http://127.0.0.1:3001`: create the Kuma admin account (put the login in the escrow, E9);
   - `http://127.0.0.1:8000`: register the first GlitchTip account, then set `ENABLE_USER_REGISTRATION=False` in `glitchtip.env` and `docker compose up -d` again on the box so nobody else can.
5. **Only now, TLS and names.** Put the box's existing reverse proxy in front of the two loopback ports: `kuma.<your domain>` to `127.0.0.1:3001` (WebSocket upgrade on) and `glitchtip.<your domain>` to
   `127.0.0.1:8000` (`client_max_body_size 40M`). With nginx and certbot that is two `server` blocks; do not touch the other app's blocks. Kuma's admin page should only be reachable from the Owner's
   addresses, **but `/api/push/` must stay reachable from the app VM**: the worker pushes its heartbeat and the alerts backstop there, and a blanket `allow`/`deny` would make every push a 403 and
   Kuma would report a healthy worker DOWN. In the Kuma `server` block:

   ```nginx
   location /api/push/ {                 # the worker's pushes: the VM's address only
       allow <the app VM's public address>;
       deny all;
       proxy_pass http://127.0.0.1:3001;
   }
   location / {                          # the admin UI and its WebSocket: the Owner's addresses only
       allow <the Owner's address>;
       deny all;
       proxy_pass http://127.0.0.1:3001;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
   }
   ```

   Check from the VM: `curl -s -o /dev/null -w '%{http_code}\n' https://kuma.<domain>/api/push/x` answers 404 or 200-ish from Kuma (an unknown token), **not 403**; from another address it is 403.
6. Check from outside: `curl -sI https://glitchtip.<domain>/` answers, and a registration attempt on its sign-up page is refused (step 4 closed it).

## 3. The two addresses the app VM must allow (go-live GL-06)

- `MONITOR_ALLOWED_CIDRS` in the VM's `provision.env`: **this box's public address**. Caddy then serves `https://api.<DOMAIN>/healthz` to it and answers 404 to everyone else.
- The **same address in `ADMIN_ALLOWED_CIDRS`**: Kuma also checks `https://admin.<DOMAIN>/healthz`, and everyone outside that list gets a 404 there.
- `GLITCHTIP_ALLOWED_CIDRS`: this box's address too (GlitchTip's webhook posts to `https://api.<DOMAIN>/hooks/glitchtip/<token>`).

Run `sudo infra/provision/provision.sh` on the VM after changing them (it prints `restart needed: caddy.service`; restart it). From this box, `curl -s https://api.<DOMAIN>/healthz` answers
`{"status":"ok"}`; from anywhere else it is a 404.

## 4. Uptime Kuma: notifications and monitors

Uptime Kuma 2.x has no supported configuration import, so you create these in the UI from `infra/monitoring/kuma/monitors.json` (about ten minutes). That file is the one list; the check at the end
reads it.

**Notifications** (Settings, Notifications; tick "Default enabled" and "Apply on all existing monitors" on both):

1. **WhatsApp through WAHA.** Type *Webhook*. URL `http://<WAHA host>:3000/api/sendText` (WAHA runs on this box: its container name on a shared network, or the host's loopback port), content type
   `application/json`, custom body

   ```json
   {"session": "<alert session>", "chatId": "<Owner's number, digits only>@c.us", "text": {{ msg | json }}}
   ```

   (`{{ msg | json }}` is the message **JSON-escaped, with its own quotes**: a message that holds a `"`, a backslash or a line break would break `"{{ msg }}"` and WAHA would answer 400, so the alert
   would never arrive. Test it once with `alert-drill.sh kuma-escape down --push-url <push URL>`, [drills.md](../drills.md) D2: the WhatsApp text must show the quote, the backslash and both lines.)
   and additional headers `{"X-Api-Key": "<WAHA API key>"}`. This goes **straight to WAHA on this box**: it does not depend on the app VM. Use a session that stays `WORKING` when the pool's sessions are
   down. The Owner must have written to that number from the phone once, so WhatsApp lets it answer (first-contact limit, [alerts.md](alerts.md)). Press *Test* and see the message.
2. **E-mail.** Type *SMTP*: host, port, security, user and password of an account that is **not** the app's own SMTP, from and to addresses (the Owner's). Press *Test*.

**Monitors** (Add New Monitor), one per entry of `monitors.json`, each with the interval and retries given there:

- `ebt api healthz` and `ebt admin healthz`: type HTTP(s) - Keyword, keyword `"status":"ok"`, interval 60 s, 1 retry.
- `ebt play` and `ebt order`: HTTP(s), interval 60 s.
- `ebt worker heartbeat`: type **Push**, heartbeat interval 120 s, no retries. Copy its push URL (`https://kuma.../api/push/<token>`, without the query) into `UPTIME_KUMA_PUSH_URL` of `/etc/ebooktrivia/worker.env`
  on the VM and restart the worker. The worker pushes every 60 s while PostgreSQL and Valkey answer; no push for 120 s is DOWN, so a killed worker alerts within 3 minutes.
- `ebt alerts backstop`: a **second Push** monitor, the same settings; its URL goes into `UPTIME_KUMA_ALERTS_PUSH_URL` (uncomment it in `worker.env`) and the worker is restarted. The worker reports it DOWN
  while a critical alert has stayed unsent for 5 minutes, which means the alert relay or its channels are broken ([alerts.md](alerts.md)).
- `ebt vm ping` (type Ping, the VM's address, 2 retries) and `ebt vm https port` (type TCP Port, 443): the VM-down drill.
- `waha session <name> working`, one per pool session: type **HTTP(s) - Json Query**, URL `http://<WAHA host>:3000/api/sessions/<name>`, header `X-Api-Key`, json path `status`, expected value `WORKING`,
  interval 60 s, 1 retry. A read-only GET: it never changes a session.
- `glitchtip health`: HTTP(s), `http://127.0.0.1:8000/_health/`.

**Check**: Settings, API Keys, make a key, then on this box

```sh
KUMA_API_KEY=<key> infra/monitoring/kuma-check.sh --kuma http://127.0.0.1:3001 --name-map '<SESSION>=<your session name>'
```

It prints one line per monitor of `monitors.json` (UP, DOWN, MISSING) and exits 1 unless every one exists and is UP. The alert drills use it with `--expect-down`.

## 5. GlitchTip: the apps' errors and the alert hook

1. Create an organization and a project (platform: JavaScript or Node). Its **DSN** is on the project's Client Keys page. (Sending the apps' errors there with `@sentry/nextjs` is a later change: the apps send
   nothing yet, and `public`, `worker` and `admin`'s egress decides how; the drills send a test event by hand.)
2. **E-mail alerts**: project, Alerts, a rule "new issue" with the Owner's address as a recipient (GlitchTip sends its own mail with the `EMAIL_URL` of `glitchtip.env`).
3. **The webhook to the app**: in the same rule add a **Webhook** recipient with the URL `https://api.<DOMAIN>/hooks/glitchtip/<token>`. The token is the one `provision.sh` wrote to
   `/etc/ebooktrivia/glitchtip-hook.token` on the VM (delete the file afterwards; rotate with `infra/provision/rotate-glitchtip-token.sh`). Caddy accepts it from this box's address only, as a POST with
   the exact path shape, and never logs the token.
4. **PII masking.** The internal process stores the event as an `alerts` row with every e-mail address and phone-like number masked (`apps/worker/src/glitchtip.ts`, `pii.ts`), and the alert relay masks the text
   again before it sends the digest ([alerts.md](alerts.md)). Prove it on staging with drill D5 (`infra/monitoring/alert-drill.sh glitchtip-event --dsn <DSN>`, then `glitchtip-check` on the VM): the test
   event carries a fake e-mail address and phone number, the alert row and the digest hold `[email]` and `[number]` and none of the originals. **GlitchTip's own e-mail of the same event is the raw event**, with
   whatever the SDK sent: keep the apps' SDK from sending personal data (no `sendDefaultPii`, `beforeSend` scrubbing) when it is added.

## 6. Off-host logs (ASVS V16.4.3)

See [the decision note](../decisions/off-host-logs.md): GlitchTip for errors now, `systemd-journal-upload` to `systemd-journal-remote` on this box for the journal, staging-only.

## 7. Updating, backing up, removing

- **Update**: pick the next stable release at least 14 days old, change the digest in `compose.yaml` and `docs/versions.md` together (`docker buildx imagetools inspect <image>:<tag> --format '{{.Manifest.Digest}}'`),
  `docker compose pull && docker compose up -d`. GlitchTip migrates its own database on start; read its upgrade notes first (6.2.6 to 7.0.0 is a major version).
- **Back up**: the volumes `ebt-monitoring_kuma-data` (monitors, notifications) and `ebt-monitoring_glitchtip-pgdata`. Export Kuma's settings screenshots into the escrow (E9) after setup; the monitors can be
  rebuilt from `monitors.json` in ten minutes, so a lost Kuma volume costs time, not data.
- **Remove**: `docker compose -f infra/monitoring/compose.yaml down` (add `-v` only when you mean to delete these two projects' data), then delete the two reverse-proxy server blocks. Nothing else on the box was touched.
