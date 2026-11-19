#!/usr/bin/env bash
# Read-only check of a provisioned ebooktrivia host (story US-014, acceptance criterion 4).
#
#   sudo infra/verify/host-check.sh [CONFIG]     CONFIG defaults to /etc/ebooktrivia/provision.env
#
# Prints one PASS / FAIL line per check and exits 1 when any check fails. It changes nothing: no
# service is started or reloaded, Valkey is only sent read commands (a denied command is never
# one that would write), PostgreSQL only SELECTs, network probes only open and close a TCP
# connection. Failures that are expected in the local stand-in (infra/verify/local/vm-sim.sh,
# EBT_PROVISION_SIM=1) are marked "[container]".
#
# Covers: OS release; SELinux (mode, AVC denials, labels of the bind-mount sources); firewalld
# (zones, target, services, ports, rich rules, runtime = permanent); listening sockets; sshd
# (sshd -T and a live password attempt); fail2ban; dnf-automatic and the EPEL scope; chrony sync;
# sysctl; the egress guard for the app user; the app user (nologin shell, linger, cgroup
# delegation); /etc/ebooktrivia ownership and placeholders; unit and health states; memory limits;
# published ports; network isolation between the containers; the Valkey ACL users and config; the
# PostgreSQL logins, groups, privileges and pg_hba rules; Caddy's listeners.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/provision/lib.sh
. "$HERE/../provision/lib.sh"
require_root
load_config "${1:-/etc/ebooktrivia/provision.env}"
APP=$CFG_APP_USER
ETC=/etc/ebooktrivia
ACME_HOST=acme-v02.api.letsencrypt.org # the CA Caddy needs; the egress probes use it

PASSES=0
FAILS=0
CONTAINER=0
in_container && CONTAINER=1

pass() {
  PASSES=$((PASSES + 1))
  printf 'PASS  %s\n' "$*"
}
fail() {
  FAILS=$((FAILS + 1))
  printf 'FAIL  %s%s\n' "$*" "$( ((CONTAINER)) && printf ' [container]')"
}
# check DESCRIPTION COMMAND...: PASS when COMMAND succeeds.
check() {
  local what=$1
  shift
  if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi
}
# expect DESCRIPTION WANT GOT
expect() {
  if [[ $3 == "$2" ]]; then pass "$1: $3"; else fail "$1: want '$2', got '${3:-<none>}'"; fi
}
section() { printf '\n== %s\n' "$*"; }

section "OS"
expect "AlmaLinux release" "AlmaLinux release 10.2 (Lavender Lion)" "$(cat /etc/almalinux-release 2>/dev/null)"

section "SELinux"
expect "getenforce" Enforcing "$(getenforce 2>/dev/null || printf 'unavailable')"
expect "/etc/selinux/config" "SELINUX=enforcing" "$(grep -E '^SELINUX=' /etc/selinux/config 2>/dev/null)"
avc=$(ausearch -m AVC,USER_AVC -ts boot 2>&1)
if [[ $avc == *"<no matches>"* ]]; then pass "no AVC denial since boot"; else fail "AVC denials since boot (ausearch -m AVC,USER_AVC -ts boot): $(head -c 300 <<<"$avc")"; fi
for path in /srv/lp /srv/data /srv/data/deliverables "$ETC/caddy" "$ETC/caddy/Caddyfile" "$ETC/postgres/pg_hba.conf" \
  "$ETC/postgres/superuser.pass" "$ETC/valkey/valkey.conf" "$ETC/valkey/users.acl"; do
  label=$(stat -c %C "$path" 2>/dev/null)
  if [[ $label == *:container_file_t:* ]]; then pass "$path labeled container_file_t"; else fail "$path label: ${label:-<none>}"; fi
done

section "firewalld"
if firewall-cmd --state >/dev/null 2>&1; then
  pass "firewalld running"
  expect "default zone" public "$(firewall-cmd --get-default-zone)"
  expect "active zones" public "$(firewall-cmd --get-active-zones 2>/dev/null | grep -v '^[[:space:]]' | awk '{print $1}' | sort -u | xargs)"
  for zone in $(firewall-cmd --get-zones); do
    expect "zone $zone: bound sources" "" "$(printf '%s %s' "$(firewall-cmd --permanent --zone="$zone" --list-sources)" "$(firewall-cmd --zone="$zone" --list-sources)" | xargs)"
    if [[ $zone != public ]]; then
      expect "zone $zone: bound interfaces" "" "$(firewall-cmd --zone="$zone" --list-interfaces | xargs)"
    fi
  done
  for iface in $(ip -o link show | awk -F': ' '$2 != "lo" { sub(/@.*/, "", $2); print $2 }'); do
    zone=$(firewall-cmd --get-zone-of-interface="$iface" 2>/dev/null || true)
    if [[ -z $zone || $zone == public ]]; then pass "interface $iface in zone public"; else fail "interface $iface in zone $zone"; fi
  done
  expect "public target" default "$(firewall-cmd --permanent --zone=public --get-target)"
  expect "public services" "dhcpv6-client http https" "$(firewall-cmd --permanent --zone=public --list-services | tr ' ' '\n' | sort | xargs)"
  for item in ports protocols source-ports forward-ports icmp-blocks; do
    expect "public $item" "" "$(firewall-cmd --permanent --zone=public --list-"$item" | xargs)"
  done
  expect "public masquerade" no "$(firewall-cmd --permanent --zone=public --query-masquerade)"
  # Policies and direct rules act outside the zones (SL4): only the shipped policies, no direct rule.
  expect "firewalld policies (only the shipped ones)" "$(shipped_firewalld_policies)" "$(firewall-cmd --get-policies | tr ' ' '\n' | sort | xargs)"
  expect "firewalld policies in /etc/firewalld/policies" "" "$(find /etc/firewalld/policies -name '*.xml' 2>/dev/null | paste -sd ' ' -)"
  expect "firewalld direct rules" "" "$(printf '%s %s' "$(firewall-cmd --direct --get-all-rules)" "$(firewall-cmd --direct --get-all-passthroughs)" | xargs)"
  want=$(ssh_rich_rules | normalize_rich_rules)
  expect "rich rules (permanent) = SSH from SSH_ALLOWED_CIDRS" "$want" "$(firewall-cmd --permanent --zone=public --list-rich-rules | normalize_rich_rules)"
  # fail2ban's bans are runtime-only reject rules, and NetworkManager binds the interfaces at
  # runtime; everything else must match the permanent config.
  expect "runtime = permanent (besides fail2ban bans)" "$(firewall_view --permanent)" "$(firewall_view "")"
else
  fail "firewalld running"
fi

section "listening sockets"
# Allowed: sshd 22, Caddy's 80/443 (held by the app user's systemd), chronyd on loopback, the DHCP
# client. In the local stand-in, Docker's embedded DNS resolver (127.0.0.11) is there too.
while read -r proto local process; do
  port=${local##*:}
  addr=${local%:*}
  case "$proto $port $process" in
    "tcp 22 "*'"sshd"'*) ok_socket=1 ;;
    "tcp 80 "*'"systemd"'* | "tcp 443 "*'"systemd"'*) ok_socket=1 ;;
    "udp 323 "*'"chronyd"'*) [[ $addr == 127.0.0.1 || $addr == "[::1]" ]] && ok_socket=1 || ok_socket=0 ;;
    "udp 68 "*'"NetworkManager"'* | "udp 546 "*'"NetworkManager"'*) ok_socket=1 ;;
    *) ok_socket=0 ;;
  esac
  if ((!ok_socket)) && ((CONTAINER)) && [[ $addr == 127.0.0.11 ]]; then ok_socket=1; fi
  if ((ok_socket)); then pass "listening $proto $local ${process:-}"; else fail "unexpected listener $proto $local ${process:-<no process>}"; fi
done < <(ss -Hltunp 2>/dev/null | awk '{ print $1, $5, $7 }')

section "sshd"
# 00-: sshd keeps the first value it reads, so this drop-in sorts before every other one.
expect "drop-in" /etc/ssh/sshd_config.d/00-ebooktrivia.conf "$(find /etc/ssh/sshd_config.d -name "*ebooktrivia*" 2>/dev/null | sort | paste -sd " " -)"
if sshd_t=$(sshd -T 2>/dev/null); then
  for kv in "permitrootlogin no" "passwordauthentication no" "kbdinteractiveauthentication no" "pubkeyauthentication yes" \
    "authenticationmethods publickey" "permitemptypasswords no" "x11forwarding no" "allowtcpforwarding no" \
    "allowagentforwarding no" "disableforwarding yes" "maxauthtries 3"; do
    expect "sshd ${kv%% *}" "$kv" "$(grep -m1 "^${kv%% *} " <<<"$sshd_t")"
  done
  expect "sshd allowusers" "$(for c in $CFG_SSH_ALLOWED_CIDRS; do printf 'allowusers %s@%s\n' "$CFG_ADMIN_SSH_USER" "$c"; done)" \
    "$(grep '^allowusers ' <<<"$sshd_t")"
else
  fail "sshd -T"
fi
check "sshd active" systemctl is-active --quiet sshd
# The running daemon, not only its files: a password attempt must be refused before a prompt.
live=$(ssh -o BatchMode=yes -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 "$CFG_ADMIN_SSH_USER@localhost" true 2>&1)
expect "live sshd refuses passwords" "Permission denied (publickey)." "$(grep -o 'Permission denied ([a-z,-]*).' <<<"$live" | head -1)"

section "audit and cockpit"
check "auditd active" systemctl is-active --quiet auditd
if systemctl cat cockpit.socket >/dev/null 2>&1; then
  expect "cockpit.socket" "disabled inactive" "$(systemctl is-enabled cockpit.socket 2>/dev/null) $(systemctl is-active cockpit.socket 2>/dev/null)"
else
  pass "cockpit.socket not installed"
fi

section "fail2ban"
check "fail2ban active" systemctl is-active --quiet fail2ban
check "fail2ban sshd jail" fail2ban-client status sshd

section "dnf-automatic and repositories"
check "dnf-automatic.timer enabled" systemctl is-enabled --quiet dnf-automatic.timer
check "dnf-automatic.timer active" systemctl is-active --quiet dnf-automatic.timer
expect "upgrade_type" "upgrade_type = security" "$(grep -E '^upgrade_type' /etc/dnf/automatic.conf)"
expect "apply_updates" "apply_updates = yes" "$(grep -E '^apply_updates' /etc/dnf/automatic.conf)"
expect "EPEL limited to fail2ban" "includepkgs=fail2ban*" "$(awk '/^\[/{s=$0} s=="[epel]" && /^includepkgs=/' /etc/yum.repos.d/epel.repo 2>/dev/null)"

section "chrony"
check "chronyd enabled" systemctl is-enabled --quiet chronyd
check "chronyd active" systemctl is-active --quiet chronyd
expect "chrony synchronised" "Leap status     : Normal" "$(chronyc tracking 2>/dev/null | grep '^Leap status')"

section "sysctl"
expect "net.ipv4.ip_unprivileged_port_start" 80 "$(sysctl -n net.ipv4.ip_unprivileged_port_start)"
expect "vm.overcommit_memory" 1 "$(sysctl -n vm.overcommit_memory)"
expect "dev.tty.legacy_tiocsti" 0 "$(sysctl -n dev.tty.legacy_tiocsti 2>/dev/null)"

section "app user $APP"
if uid=$(id -u "$APP" 2>/dev/null); then
  pass "user $APP exists (uid $uid)"
  expect "login shell" /sbin/nologin "$(getent passwd "$APP" | cut -d: -f7)"
  check "linger" test -e "/var/lib/systemd/linger/$APP"
  check "user@$uid.service active" systemctl is-active --quiet "user@$uid.service"
  check "memory controller delegated" grep -qw memory "/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/cgroup.controllers"
  check "subuid range" grep -q "^$APP:" /etc/subuid
else
  fail "user $APP exists"
  uid=""
fi

section "egress guard (nftables, app user)"
ruleset=$(nft list table inet ebt_egress 2>/dev/null)
check "table inet ebt_egress loaded" test -n "$ruleset"
# nft prints the user by uid.
skuid="skuid ($APP|\"$APP\"|$(id -u "$APP" 2>/dev/null || printf none))"
check "drops the app user's traffic to 169.254.0.0/16" grep -qE "$skuid ip daddr 169.254.0.0/16 .*drop" <<<"$ruleset"
check "drops the app user's traffic to this host's own addresses" grep -qE "$skuid fib daddr type local .*drop" <<<"$ruleset"
# nft prints set elements in its own order.
v6_rule=$(grep -E "$skuid ip6 daddr \{[^}]*\} .*drop" <<<"$ruleset")
# shellcheck disable=SC2016 # $1 expands in the inner bash
check "drops the app user's traffic to IPv6 link-local and fd00:ec2::254" bash -c '[[ $1 == *fe80::/10* && $1 == *fd00:ec2::254* ]]' _ "$v6_rule"
check "ebt-egress-guard.service enabled" systemctl is-enabled --quiet ebt-egress-guard.service
# Fail closed (SL3): the app user's systemd, and so every container, starts only with the guard.
if uid_guard=$(id -u "$APP" 2>/dev/null); then
  expect "user@$uid_guard.service requires the guard" yes \
    "$(systemctl show -p Requires -p After --value "user@$uid_guard.service" | grep -c ebt-egress-guard.service | awk '{ print ($1 == 2) ? "yes" : "no" }')"
fi
host_ip=$(ip -4 route get 192.0.2.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }')
tcp_open() { timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }
if [[ -n $host_ip ]] && tcp_open "$host_ip" 22; then
  pass "root reaches sshd on $host_ip:22 (control)"
  check "app user cannot reach sshd on this host ($host_ip:22)" bash -c "! runuser -u $APP -- timeout 4 bash -c 'exec 3<>/dev/tcp/$host_ip/22' 2>/dev/null"
else
  fail "control: root cannot reach sshd on ${host_ip:-<no address>}:22"
fi
# send_errno ADDRESS PORT: the errno of one UDP datagram the app user sends, or "sent". A packet
# the egress guard drops on output fails at once with EPERM; a missing route gives ENETUNREACH.
# (UDP, because a dropped TCP SYN only shows as a timeout, like a silent host.)
send_errno() {
  runuser -u "$APP" -- setsid -w python3 -I -c '
import errno, socket, sys
host, port = sys.argv[1], int(sys.argv[2])
s = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.sendto(b"host-check", (host, port))
    print("sent")
except OSError as e:
    print(errno.errorcode.get(e.errno, str(e.errno)))
' "$1" "$2" </dev/null 2>/dev/null
}
expect "app user -> 169.254.169.254 (metadata) dropped by the guard" EPERM "$(send_errno 169.254.169.254 80)"
v6=$(send_errno fd00:ec2::254 80)
case $v6 in
  EPERM) pass "app user -> [fd00:ec2::254]:80 dropped by the guard" ;;
  ENETUNREACH | EHOSTUNREACH) pass "app user -> [fd00:ec2::254]:80 unreachable ($v6: no IPv6 route here; the ruleset check above covers the guard)" ;;
  *) fail "app user -> [fd00:ec2::254]:80: $v6" ;;
esac

section "/etc/ebooktrivia"
expect "$ETC" "750 root $APP" "$(stat -c '%a %U %G' "$ETC")"
for dir in caddy postgres valkey; do expect "$ETC/$dir" "750 root $APP" "$(stat -c '%a %U %G' "$ETC/$dir" 2>/dev/null)"; done
for name in public admin worker internal migrate postgres valkey caddy; do
  file=$ETC/$name.env
  expect "$file mode/owner" "640 root $APP" "$(stat -c '%a %U %G' "$file" 2>/dev/null)"
  if grep -vE '^[[:space:]]*#' "$file" 2>/dev/null | grep -qE '__SET_ME__|@GEN@|@GEN_TOKEN_SHA256@|@DOMAIN@'; then fail "$file has unfilled placeholders"; else pass "$file has no placeholders"; fi
done
# The e2e-only switch that lets the admin console accept a plain-http loopback origin
# (apps/admin/src/lib/config.ts) must never reach a server.
if grep -qE '^[[:space:]]*ADMIN_ALLOW_INSECURE_LOOPBACK=' "$ETC/admin.env" 2>/dev/null; then
  fail "$ETC/admin.env sets ADMIN_ALLOW_INSECURE_LOOPBACK (test-only)"
else
  pass "$ETC/admin.env does not set ADMIN_ALLOW_INSECURE_LOOPBACK"
fi
for file in caddy/Caddyfile valkey/valkey.conf valkey/users.acl postgres/pg_hba.conf postgres/superuser.pass; do
  expect "$ETC/$file mode/owner" "640 root $APP" "$(stat -c '%a %U %G' "$ETC/$file" 2>/dev/null)"
done
# Nothing under /etc/ebooktrivia belongs to the app user: it could otherwise swap entries root writes.
expect "entries owned by $APP under $ETC" "" "$(find "$ETC" -user "$APP" 2>/dev/null | paste -sd " " -)"
if [[ -e $ETC/glitchtip-hook.token ]]; then fail "$ETC/glitchtip-hook.token still exists (copy it to GlitchTip, then delete it)"; else pass "no GlitchTip hook token left on disk"; fi

if [[ -z $uid ]]; then
  printf '\nsummary: %d passed, %d failed\n' "$PASSES" "$FAILS"
  exit 1
fi
qdir="$(app_home)/.config/containers/systemd"
if [[ -e $qdir/public@b.container.d/90-client-ip-probe.conf ]]; then
  fail "the client-ip probe still replaces public@b (run infra/verify/client-ip-probe.sh stop)"
else
  pass "no client-ip probe drop-in"
fi

section "user units"
for unit in "${EBT_SERVICES[@]/%/.service}" caddy.socket; do
  expect "$unit" active "$(as_app systemctl --user is-active "$unit" 2>/dev/null)"
done
expect "caddy.socket enabled" enabled "$(as_app systemctl --user is-enabled caddy.socket 2>/dev/null)"
for name in postgres valkey internal admin public-a public-b; do
  expect "$name health" healthy "$(as_app podman inspect --format '{{.State.Health.Status}}' "$name" 2>/dev/null)"
done
# migrate.service is a oneshot that systemd unloads once it has finished, so its result is checked
# in the database instead: every migration the worker image ships is recorded as applied.
migrations_shipped=$(as_app podman run --rm --pull never --network none localhost/ebooktrivia/worker:current \
  sh -c 'ls packages/db/migrations/*.sql | wc -l' 2>/dev/null)
migrations_applied=$(as_app podman exec -i -u postgres postgres psql -X -At -d ebooktrivia \
  -c 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2>/dev/null)
expect "migrations applied (migrate.service) / shipped in the worker image" "${migrations_shipped:-?}" "${migrations_applied:-none}"

section "memory limits (plan M4.2 budget)"
declare -A budget=([postgres]=2147483648 [valkey]=536870912 [public-a]=734003200 [public-b]=734003200 [admin]=629145600
  [worker]=629145600 [internal]=125829120 [caddy]=157286400)
for name in postgres valkey public-a public-b admin worker internal caddy; do
  expect "$name podman memory limit" "${budget[$name]}" "$(as_app podman inspect --format '{{.HostConfig.Memory}}' "$name" 2>/dev/null)"
  expect "$name cgroup memory.max" "${budget[$name]}" "$(as_app podman exec "$name" cat /sys/fs/cgroup/memory.max 2>/dev/null)"
done
# An exposed but unpublished port shows as "3000/tcp"; a published one has "->".
expect "published ports" "" "$(as_app podman ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -- '->' || true)"

section "network isolation"
# reach FROM TARGET PORT: "open" when a TCP connection from inside container FROM succeeds.
reach() {
  case $1 in
    caddy) as_app podman exec caddy nc -w 3 "$2" "$3" </dev/null >/dev/null 2>&1 && printf open || printf closed ;;
    valkey | postgres) as_app podman exec "$1" bash -c "timeout 4 bash -c 'exec 3<>/dev/tcp/$2/$3'" >/dev/null 2>&1 && printf open || printf closed ;;
    *)
      as_app podman exec "$1" node -e '
const s = require("node:net").connect({ host: process.argv[1], port: Number(process.argv[2]), timeout: 3000 });
s.on("connect", () => { process.stdout.write("open"); process.exit(0); });
s.on("timeout", () => { process.stdout.write("closed"); process.exit(0); });
s.on("error", () => { process.stdout.write("closed"); process.exit(0); });' "$2" "$3" 2>/dev/null || printf closed
      ;;
  esac
}
expect "caddy -> admin:3000 (control)" open "$(reach caddy admin 3000)"
expect "caddy -> internal:9000 (control)" open "$(reach caddy internal 9000)"
expect "caddy -> public-a:3000 (control)" open "$(reach caddy public-a 3000)"
for target in "admin 3000" "10.89.52.13 3000" "10.89.51.13 3000" "internal 9000" "10.89.53.15 9000" "10.89.51.15 9000"; do
  expect "public-a -> ${target/ /:}" closed "$(reach public-a "${target% *}" "${target#* }")"
done
expect "worker -> 10.89.52.13:3000 (admin)" closed "$(reach worker 10.89.52.13 3000)"
expect "caddy -> postgres 10.89.51.2:5432" closed "$(reach caddy 10.89.51.2 5432)"
expect "caddy -> valkey 10.89.51.3:6379" closed "$(reach caddy 10.89.51.3 6379)"
expect "public-a -> postgres 10.89.51.2:5432 (control)" open "$(reach public-a 10.89.51.2 5432)"
acme_ip=$(getent ahostsv4 "$ACME_HOST" | awk 'NR == 1 { print $1 }')
expect "worker -> $ACME_HOST:443 (egress control)" open "$(reach worker "$ACME_HOST" 443)"
expect "valkey (data network only) -> ${acme_ip:-?}:443" closed "$(reach valkey "${acme_ip:-192.0.2.1}" 443)"
expect "postgres (data network only) -> ${acme_ip:-?}:443" closed "$(reach postgres "${acme_ip:-192.0.2.1}" 443)"
if [[ -n $host_ip ]]; then expect "worker -> this host's sshd $host_ip:22" closed "$(reach worker "$host_ip" 22)"; fi

section "Valkey"
# valkey_as USER PASSWORD COMMAND...: the reply to one command, authenticated over stdin (the
# password never appears in a command line).
valkey_as() {
  local user=$1 pw=$2
  shift 2
  # env -u: the container's REDISCLI_AUTH (the ops password, for the health check) would make
  # valkey-cli authenticate as the default user first.
  printf 'AUTH %s %s\n%s\n' "$user" "$pw" "$*" |
    as_app podman exec -i valkey env -u REDISCLI_AUTH valkey-cli --no-auth-warning 2>&1 | tr -d '\r' | sed '1{/^OK$/d}'
}
denied() { [[ $1 == *NOPERM* ]]; }
public_pw=$(env_value "$ETC/public.env" VALKEY_PASSWORD)
worker_pw=$(env_value "$ETC/worker.env" VALKEY_PASSWORD)
admin_pw=$(env_value "$ETC/admin.env" VALKEY_PASSWORD)
ops_pw=$(env_value "$ETC/valkey.env" REDISCLI_AUTH)
expect "default user refused" NOAUTH "$(printf 'PING\n' | as_app podman exec -i valkey env -u REDISCLI_AUTH valkey-cli 2>&1 | grep -o NOAUTH | head -1)"
expect "ops PING" PONG "$(valkey_as ops "$ops_pw" PING)"
check "ops: EXISTS denied" denied "$(valkey_as ops "$ops_pw" EXISTS cache:public:host-check)"
expect "public: EXISTS rl:* allowed" 0 "$(valkey_as public "$public_pw" EXISTS rl:host-check)"
expect "public: EXISTS cache:public:* allowed" 0 "$(valkey_as public "$public_pw" EXISTS cache:public:host-check)"
for cmd in "EXISTS cache:admin:host-check" "EXISTS ebt:host-check" "INFO server" "KEYS host-check-none" "SCAN 0 COUNT 1" "RANDOMKEY" "FUNCTION LIST"; do
  check "public: $cmd denied" denied "$(valkey_as public "$public_pw" "$cmd")"
done
expect "admin: EXISTS cache:admin:* allowed" 0 "$(valkey_as admin "$admin_pw" EXISTS cache:admin:host-check)"
for cmd in "EXISTS cache:public:host-check" "EXISTS rl:host-check" "INFO server" "SCAN 0 COUNT 1" "RANDOMKEY" "FUNCTION LIST"; do
  check "admin: $cmd denied" denied "$(valkey_as admin "$admin_pw" "$cmd")"
done
expect "worker: EXISTS ebt:* allowed" 0 "$(valkey_as worker "$worker_pw" EXISTS ebt:host-check)"
expect "worker: EXISTS cache:worker:* allowed" 0 "$(valkey_as worker "$worker_pw" EXISTS cache:worker:host-check)"
check "worker: EXISTS rl:* denied" denied "$(valkey_as worker "$worker_pw" EXISTS rl:host-check)"
check "worker: EXISTS cache:public:* denied" denied "$(valkey_as worker "$worker_pw" EXISTS cache:public:host-check)"
check "worker: KEYS denied (@dangerous)" denied "$(valkey_as worker "$worker_pw" KEYS host-check-none)"
check "worker: CONFIG GET denied (@admin)" denied "$(valkey_as worker "$worker_pw" CONFIG GET maxmemory)"
info=$(valkey_as worker "$worker_pw" INFO)
expect "worker: INFO allowed" "valkey_version:9.1.3" "$(grep -o '^valkey_version:[0-9.]*' <<<"$info")"
expect "maxmemory_policy" "maxmemory_policy:noeviction" "$(grep -o '^maxmemory_policy:[a-z-]*' <<<"$info")"
expect "aof_enabled" "aof_enabled:1" "$(grep -o '^aof_enabled:[0-9]' <<<"$info")"

section "PostgreSQL"
psql_q() { as_app podman exec -i -u postgres postgres psql -X -At -d postgres -c "$1" 2>&1; }
expect "app logins and their one group" "ebt_admin=admin_rw
ebt_internal=internal_rw
ebt_migrate=migrator
ebt_public=public_rw
ebt_worker=worker_rw" "$(psql_q "SELECT u.rolname || '=' || string_agg(g.rolname, ',' ORDER BY g.rolname)
  FROM pg_roles u JOIN pg_auth_members m ON m.member = u.oid JOIN pg_roles g ON g.oid = m.roleid
 WHERE u.rolname LIKE 'ebt\_%' GROUP BY u.rolname ORDER BY 1")"
expect "app logins: login, inherit, not superuser (except ebt_migrate)" "ebt_admin|true|true|false
ebt_internal|true|true|false
ebt_migrate|true|true|true
ebt_public|true|true|false
ebt_worker|true|true|false" "$(psql_q "SELECT rolname || '|' || rolcanlogin || '|' || rolinherit || '|' || rolsuper FROM pg_roles WHERE rolname LIKE 'ebt\_%' ORDER BY 1")"
expect "PUBLIC CONNECT/TEMP on postgres, template1" "" "$(psql_q "SELECT d.datname || ':' || a.privilege_type FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
 WHERE d.datname IN ('postgres', 'template1') AND a.grantee = 0 AND a.privilege_type IN ('CONNECT', 'TEMPORARY')")"
expect "pg_hba errors" 0 "$(psql_q "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL")"
expect "pg_hba host rules" "ebooktrivia ebt_public 10.89.51.11 scram-sha-256
ebooktrivia ebt_public 10.89.51.12 scram-sha-256
ebooktrivia ebt_admin 10.89.51.13 scram-sha-256
ebooktrivia ebt_worker 10.89.51.14 scram-sha-256
ebooktrivia ebt_internal 10.89.51.15 scram-sha-256
ebooktrivia ebt_migrate 10.89.51.16 scram-sha-256
all all all reject" "$(psql_q "SELECT array_to_string(database, ',') || ' ' || array_to_string(user_name, ',') || ' ' || coalesce(address, '') || ' ' || auth_method
  FROM pg_hba_file_rules WHERE type = 'host' ORDER BY rule_number")"
# Only a file path (POSTGRES_PASSWORD_FILE): no password in the container's configuration, which
# podman inspect and every podman exec session would show.
expect "no superuser password in the container's environment" 0 \
  "$(as_app podman inspect --format '{{range .Config.Env}}{{println .}}{{end}}' postgres 2>/dev/null | grep -c '^POSTGRES_PASSWORD=')"

section "Caddy and the edge"
listeners=$(ss -Hltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/ { print $4, $6 }')
check "port 80 held by the app user's systemd (socket activation)" grep -qE ':80 .*"systemd"' <<<"$listeners"
check "port 443 held by the app user's systemd (socket activation)" grep -qE ':443 .*"systemd"' <<<"$listeners"
expect "http://127.0.0.1/ redirects to HTTPS" 308 "$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H "Host: play.$CFG_DOMAIN" http://127.0.0.1/)"

printf '\nsummary: %d passed, %d failed%s\n' "$PASSES" "$FAILS" "$( ((CONTAINER)) && printf ' (in a container: failures marked [container] are expected there)')"
((FAILS == 0))
