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
| `APP_USER` | Rootless podman user (default `ebt`). |

Secrets are never typed or committed. The provisioning generates them on the VM into the env
files (`0600`, owned by the app user):

- PostgreSQL login passwords;
- Valkey ACL passwords (`users.acl` stores only their SHA-256);
- the PostgreSQL superuser password;
- the GlitchTip hook token (`internal.env` stores only its SHA-256).

## 3. Run order (all as root, from the checkout)

```sh
cd /opt/ebooktrivia
sudo infra/provision/provision.sh                 # 1. host + config; run it again: "summary: 0 changed"
sudo infra/provision/build-images.sh              # 2. postgres-walg, public, admin, worker (10-20 min)
```

### Operator steps

- **Uptime Kuma.** In `/etc/ebooktrivia/worker.env`, set `UPTIME_KUMA_PUSH_URL`, or leave it empty
  (`UPTIME_KUMA_PUSH_URL=`) while there is no Kuma. Later provisioning runs keep the value, even an
  empty one.
- **GlitchTip token.** Copy the token from `/etc/ebooktrivia/glitchtip-hook.token` into GlitchTip's
  webhook URL, `https://api.<DOMAIN>/hooks/glitchtip/<token>`. Then delete the file.

### Start the stack

```sh
A=infra/provision/as-app.sh
sudo $A systemctl --user start postgres.service valkey.service
sudo infra/provision/db-roles.sh                  # logins, one group each; run again: "0 changed"
sudo $A systemctl --user start migrate.service    # roles.sql + migrations (one-shot)
sudo $A systemctl --user start internal.service worker.service admin.service public@a.service public@b.service
sudo $A systemctl --user start caddy.socket caddy.service   # :80/:443 and Caddy itself (it orders its certificates at start)
```

Each start returns once the unit is healthy (`Notify=healthy`): the apps answer `/livez`, the
internal process its ask endpoint, PostgreSQL `pg_isready` on its address (not the socket, which the
first-start initdb server also opens), Valkey `PING`. If a restart prints `restart needed: <unit>`
lines (provision.sh after a config change), restart those units.

After a reboot, everything comes back on its own:

- linger and `caddy.socket` are enabled;
- every long-running quadlet has `WantedBy=default.target`;
- only `migrate` must be started by hand, or by the deploy (a later story).

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
- **Valkey:** the default user is refused; every user is confined to its keys and its own `cache:<app>:` prefix; INFO only for `worker`; KEYS, SCAN, RANDOMKEY, FUNCTION, CONFIG and the other @dangerous / @admin commands denied; noeviction and AOF on;
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
- **A failed first PostgreSQL start** (initdb stopped half-way, wrong superuser password file): `sudo $A systemctl --user stop postgres.service`, `sudo $A podman volume rm ebt-pgdata`, start it again, then `db-roles.sh` and `migrate.service`. This deletes the database: only before real data exists.
- **The client-ip probe did not stop** (`client-ip-probe.sh stop` failed half-way): `sudo runuser -u ebt -- rm -f /home/ebt/.config/containers/systemd/public@b.container.d/90-client-ip-probe.conf`, `sudo rm -rf /etc/ebooktrivia/probe`, `sudo $A systemctl --user daemon-reload`, `sudo $A systemctl --user restart public@b.service`. host-check fails while the drop-in exists.
- **Undo a provisioning run:** it only adds files under `/etc` and the app user's home and changes firewalld, sshd and SELinux settings; the lockout steps above undo the access changes. Uninstalling the packages is not needed for a retry: every step is idempotent.

## Routine operations

- **Rotate the GlitchTip token:** run `sudo infra/provision/rotate-glitchtip-token.sh`. It writes a new token file, puts the new SHA-256 in `internal.env` and restarts `internal`; the old token then gets a 404. Put the new URL in GlitchTip and delete the file. Caddy logs never contain the token: the URI of `/hooks/glitchtip/*` is redacted before a log line is written.
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
- **Data directories** (review S7): `/srv/data/deliverables` (ebook PDFs and public images) is read-only for public and the worker; `/srv/data` as a whole (imports, proofs) is mounted into admin only.
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
