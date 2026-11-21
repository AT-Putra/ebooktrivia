#!/usr/bin/env bash
# Runs the whole stack in the vm-sim container (vm-sim.sh up + provision first) with the real
# quadlets, rootless podman, socket-activated Caddy, and the real images, then checks it from
# client containers on two "internet" networks (documentation ranges):
#
#   192.0.2.0/24     the sim is 192.0.2.10, a client 192.0.2.100 (inside ADMIN_ALLOWED_CIDRS),
#                    a Pebble ACME test CA 192.0.2.53
#   198.51.100.0/24  the sim is 198.51.100.10, the "GlitchTip host" 198.51.100.20
#
#   infra/verify/local/stack-sim.sh [all|up|check|guard-reload|down]      (default: all = up + check)
#
# Images: localhost/ebooktrivia/{public,admin,worker}:current and
# localhost/ebooktrivia/postgres-walg:18.6 must exist in Docker (infra/images); they are copied
# into the sim's podman. Caddy and Valkey are pulled by digest, Pebble 2.10.2 from ghcr.io.
#
# Test-only changes inside the sim, all outside the repository: the operator steps (the worker's
# Uptime Kuma placeholder line removed, the GlitchTip token file read and deleted), a caddy drop-in
# and two Caddyfile lines that point the ACME issuer at Pebble (the TLS-ALPN challenge still goes
# through caddy.socket), seed rows for one LP domain, and the client-ip probe on public@b.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$HERE/lib.sh"

NAME=${VM_SIM_NAME:-ebt-vm-sim}
CLIENT=ebt-sim-client
GLITCHTIP=ebt-sim-glitchtip
PEBBLE=ebt-sim-pebble
PEBBLE_IMAGE=ghcr.io/letsencrypt/pebble:2.10.2
CURL_IMAGE=docker.io/curlimages/curl:8.17.0
NET_A=ebt-sim-internet-a
NET_B=ebt-sim-internet-b
HOSTS="admin.example.test play.example.test order.example.test api.example.test lp-ok.example.test lp-no.example.test"
OUT=${VM_SIM_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/ebt-stack-sim.XXXXXX")}
mkdir -p "$OUT"

# EBT_PROVISION_SIM=1: the scripts may treat container-only gaps as expected (lib.sh in_container).
sim() { docker exec -e EBT_PROVISION_SIM=1 "$NAME" "$@"; }
sim_in() { docker exec -i -e EBT_PROVISION_SIM=1 "$NAME" "$@"; }
# as_ebt CMD...: a command as the app user inside the sim (its own trees are never touched as root).
as_ebt() { sim runuser -u ebt -- "$@"; }
app() { sim /opt/ebooktrivia/infra/provision/as-app.sh "$@"; }
psql_app_db() { sim_in /opt/ebooktrivia/infra/provision/as-app.sh podman exec -i -u postgres postgres psql -X -q -At -v ON_ERROR_STOP=1 -d ebooktrivia "$@"; }

FAILURES=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() {
  FAILURES=$((FAILURES + 1))
  printf 'FAIL  %s\n' "$*"
}
expect() { if [[ $3 == "$2" ]]; then pass "$1: $3"; else fail "$1: want '$2', got '${3:-<none>}'"; fi; }
expect_match() { if [[ $3 =~ $2 ]]; then pass "$1"; else fail "$1: '${3:0:300}' does not match /$2/"; fi; }

# curl from a client container: curl_from CONTAINER ARGS...
curl_from() {
  local who=$1
  shift
  local args=() host
  for host in $HOSTS; do args+=(--resolve "$host:443:$SIM_IP" --resolve "$host:80:$SIM_IP"); done
  docker exec "$who" curl -sk -m 15 "${args[@]}" "$@"
}

wait_active() {
  local unit=$1 state=""
  for _ in $(seq 1 90); do
    state=$(app systemctl --user is-active "$unit" 2>/dev/null || true)
    [[ $state == active ]] && return 0
    sleep 1
  done
  printf 'unit %s is %s\n' "$unit" "$state"
  app journalctl --user -u "$unit" -n 40 --no-pager || true
  return 1
}

up() {
  sim test -e /etc/ebooktrivia/public.env || {
    printf 'run vm-sim.sh up and provision first\n'
    exit 1
  }
  printf '### images into the sim (podman load)\n'
  local image
  for image in localhost/ebooktrivia/postgres-walg:18.6 localhost/ebooktrivia/public:current localhost/ebooktrivia/admin:current \
    localhost/ebooktrivia/worker:current; do
    docker save "$image" | sim_in /opt/ebooktrivia/infra/provision/as-app.sh podman load -q
  done

  printf '\n### operator steps\n'
  sim sed -i 's/^UPTIME_KUMA_PUSH_URL=.*/UPTIME_KUMA_PUSH_URL=/' /etc/ebooktrivia/worker.env
  if sim test -e /etc/ebooktrivia/glitchtip-hook.token; then
    sim cat /etc/ebooktrivia/glitchtip-hook.token >"$OUT/glitchtip-hook.token"
    sim rm -f /etc/ebooktrivia/glitchtip-hook.token
  fi
  [[ -s $OUT/glitchtip-hook.token ]] || {
    printf 'the GlitchTip token is gone (taken by an earlier run with another VM_SIM_OUT)\n'
    exit 1
  }
  printf 'worker.env Uptime Kuma placeholder emptied; GlitchTip token taken and deleted\n'

  printf '\n### networks, Pebble, clients\n'
  docker network create --subnet 192.0.2.0/24 "$NET_A" >/dev/null 2>&1 || true
  docker network create --subnet 198.51.100.0/24 "$NET_B" >/dev/null 2>&1 || true
  local aliases=() host
  for host in $HOSTS; do aliases+=(--alias "$host"); done
  docker network connect --ip 192.0.2.10 "${aliases[@]}" "$NET_A" "$NAME" 2>/dev/null || true
  docker network connect --ip 198.51.100.10 --alias api.example.test "$NET_B" "$NAME" 2>/dev/null || true
  local pebble_dir
  pebble_dir=$(mktemp -d)
  local id
  id=$(docker create "$PEBBLE_IMAGE")
  docker cp "$id:/test" "$(host_path "$pebble_dir")/" >/dev/null
  docker rm "$id" >/dev/null
  # TLS-ALPN-01 on 443 (Caddy's only challenge), no OCSP; validation goes to the sim's aliases.
  sed -e 's/"httpPort": 5002/"httpPort": 80/' -e 's/"tlsPort": 5001/"tlsPort": 443/' \
    "$pebble_dir/test/config/pebble-config.json" >"$pebble_dir/test/config/sim.json"
  docker rm -f "$PEBBLE" "$CLIENT" "$GLITCHTIP" >/dev/null 2>&1 || true
  docker run -d --name "$PEBBLE" --network "$NET_A" --ip 192.0.2.53 -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 \
    -v "$(host_path "$pebble_dir/test"):/test:ro" "$PEBBLE_IMAGE" \
    -config /test/config/sim.json >/dev/null
  docker run -d --name "$CLIENT" --network "$NET_A" --ip 192.0.2.100 --entrypoint sleep "$CURL_IMAGE" infinity >/dev/null
  docker run -d --name "$GLITCHTIP" --network "$NET_B" --ip 198.51.100.20 --entrypoint sleep "$CURL_IMAGE" infinity >/dev/null
  sim_in install -m 640 -o root -g ebt /dev/stdin /etc/ebooktrivia/caddy/pebble.minica.pem <"$pebble_dir/test/certs/pebble.minica.pem"
  rm -rf "$pebble_dir"

  printf '\n### data stores, logins, migrations\n'
  app systemctl --user start postgres.service valkey.service
  wait_active postgres.service
  wait_active valkey.service
  sim /opt/ebooktrivia/infra/provision/db-roles.sh | tee "$OUT/db-roles-1.log"
  sim /opt/ebooktrivia/infra/provision/db-roles.sh | tee "$OUT/db-roles-2.log"
  app systemctl --user start migrate.service
  psql_app_db <<'SQL'
DO $seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lp_domains WHERE host = 'lp-ok.example.test') THEN
    WITH p AS (INSERT INTO products (title, price_idr) VALUES ('vm-sim ebook', 49000) RETURNING id),
         g AS (INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
               SELECT id, 'vm-sim', 'vm-sim', 'published', now() - interval '1 day', now() + interval '30 days', 30 FROM p RETURNING id),
         l AS (INSERT INTO landing_pages (id, lp_key, name, program_id, hosting)
               SELECT '00000000-0000-4000-8000-00000000a001', 'lp_vmsim0001', 'vm-sim LP', id, 'zip' FROM g RETURNING id)
    INSERT INTO lp_domains (landing_page_id, host) SELECT id, 'lp-ok.example.test' FROM l;
    -- US-023: only an active zip-hosted page with a live version is served (public.lp_served_hosts()).
    INSERT INTO uploads (id, kind, storage_path, content_type, size_bytes, sha256) VALUES
      ('00000000-0000-4000-8000-00000000b001', 'lp_zip', 'lp-zips/00000000-0000-4000-8000-00000000b001.zip', 'application/zip', 1, sha256('1'::bytea)),
      ('00000000-0000-4000-8000-00000000b002', 'lp_zip', 'lp-zips/00000000-0000-4000-8000-00000000b002.zip', 'application/zip', 1, sha256('2'::bytea));
    INSERT INTO lp_versions (id, landing_page_id, version, upload_id, file_count, uncompressed_bytes) VALUES
      ('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000a001', 1, '00000000-0000-4000-8000-00000000b001', 1, 1),
      ('00000000-0000-4000-8000-00000000c002', '00000000-0000-4000-8000-00000000a001', 2, '00000000-0000-4000-8000-00000000b002', 1, 1);
    UPDATE landing_pages SET current_version_id = '00000000-0000-4000-8000-00000000c001' WHERE id = '00000000-0000-4000-8000-00000000a001';
  END IF;
END
$seed$;
SQL
  # shellcheck disable=SC2016 # expanded by the shell inside the sim
  as_ebt bash -c 'set -e; v=/srv/lp/versions/00000000-0000-4000-8000-00000000a001; d=/srv/lp/hosts/lp-ok.example.test
    mkdir -p $v/1 $v/2 $d; printf "<p>release one</p>\n" > $v/1/index.html; printf "<p>release two</p>\n" > $v/2/index.html
    ln -sfn ../../versions/00000000-0000-4000-8000-00000000a001/1 $d/current'

  printf '\n### Caddy against Pebble (test-only drop-in and issuer lines)\n'
  sim grep -q 'pebble:14000' /etc/ebooktrivia/caddy/Caddyfile ||
    sim sed -i 's|^\tcert_issuer acme {$|\tcert_issuer acme {\n\t\tdir https://pebble:14000/dir\n\t\ttrusted_roots /etc/caddy/pebble.minica.pem|' \
      /etc/ebooktrivia/caddy/Caddyfile
  # shellcheck disable=SC2016 # expanded by the shell inside the sim
  sim_in runuser -u ebt -- bash -c 'd=/home/ebt/.config/containers/systemd/caddy.container.d; mkdir -p $d && cat > $d/90-sim-pebble.conf' <<'EOF'
[Container]
AddHost=pebble:192.0.2.53
Volume=/etc/ebooktrivia/caddy/pebble.minica.pem:/etc/caddy/pebble.minica.pem:ro
EOF
  app systemctl --user daemon-reload

  printf '\n### apps and Caddy\n'
  # As the runbook does it: the socket AND the service (Caddy orders its certificates at start).
  app systemctl --user start internal.service worker.service admin.service public@a.service public@b.service
  app systemctl --user start caddy.socket caddy.service
  local unit
  for unit in internal worker admin public@a public@b caddy; do wait_active "$unit.service"; done
  for _ in $(seq 1 60); do
    [[ $(curl_from "$CLIENT" -o /dev/null -w '%{http_code}' https://admin.example.test/login || true) == 200 ]] && break
    sleep 2
  done
}

# What a container cannot show: SELinux (mode, audit log, labels), auditd and the clock (chronyd).
CONTAINER_ONLY='getenforce|AVC denials|/[^ ]+ label: |chronyd active|chrony synchronised|auditd active'

# drain_check positive|negative: public@b (the probe) is restarted while a slow GET and a POST are
# in flight; it must answer /livez 503 at once, keep serving for EDGE_DRAIN_MS, finish the slow
# request, and log "draining" then "drained" at least 5 s apart. "negative" runs the same checks
# against a probe that exits at once on SIGTERM (PROBE_EXIT_ON_SIGTERM=1): they must fail there.
drain_check() {
  local mode=$1 since slow_file livez post slow lines t_drain t_done
  local -a out=()
  verdict() { if [[ $2 == ok ]]; then out+=("PASS  drain ($mode): $1"); else out+=("FAIL  drain ($mode): $1"); fi; }
  local dropin=.config/containers/systemd/public@b.container.d/92-sim-exit-at-once.conf
  if [[ $mode == negative ]]; then
    printf '[Container]\nEnvironment=PROBE_EXIT_ON_SIGTERM=1\n' | sim_in runuser -u ebt -- bash -c "cat > /home/ebt/$dropin"
  fi
  app systemctl --user daemon-reload
  app systemctl --user restart public@b.service
  app systemctl --user stop public@a.service
  sleep 5 # Caddy marks public@a down (health_interval 2 s, fails 1) and public@b up (passes 2)
  since=$(sim date +%s)
  slow_file=$(mktemp)
  (curl_from "$CLIENT" -o /dev/null -w '%{http_code}' "https://play.example.test/__probe/slow?ms=4000" >"$slow_file" 2>/dev/null || true) &
  local slow_pid=$!
  sleep 1
  app systemctl --user restart --no-block public@b.service
  sleep 1
  livez=$(app podman exec caddy wget -q -T 2 -O - http://10.89.50.12:3000/livez 2>&1 || true)
  post=$(curl_from "$CLIENT" -o /dev/null -w '%{http_code}' -X POST -d 'drain=1' https://play.example.test/__probe/echo || true)
  wait "$slow_pid" || true
  slow=$(cat "$slow_file")
  rm -f "$slow_file"
  wait_active public@b.service >/dev/null || true
  lines=$(sim journalctl CONTAINER_NAME=public-b --since "@$since" -o short-unix --no-pager 2>/dev/null)
  t_drain=$(awk '/SIGTERM: draining/ { print $1; exit }' <<<"$lines")
  t_done=$(awk '/"drained"/ { print $1; exit }' <<<"$lines")
  if [[ $livez == *503* ]]; then verdict "/livez answers 503 at once" ok; else verdict "/livez answers 503 at once (got: ${livez:0:80})" fail; fi
  if [[ $post == 200 ]]; then verdict "a POST during the drain is served" ok; else verdict "a POST during the drain is served (got: $post)" fail; fi
  if [[ $slow == 200 ]]; then verdict "the in-flight slow request completes" ok; else verdict "the in-flight slow request completes (got: ${slow:-none})" fail; fi
  if [[ -n $t_drain && -n $t_done ]]; then verdict "draining and drained lines in the journal" ok; else verdict "draining and drained lines in the journal" fail; fi
  if [[ -n $t_drain && -n $t_done ]] && awk -v a="$t_drain" -v b="$t_done" 'BEGIN { exit !(b - a >= 5.0) }'; then
    verdict "stop took at least EDGE_DRAIN_MS (5 s): $(awk -v a="$t_drain" -v b="$t_done" 'BEGIN { printf "%.1f s", b - a }')" ok
  else
    verdict "stop took at least EDGE_DRAIN_MS (5 s)" fail
  fi
  if [[ $mode == negative ]]; then
    sim_in runuser -u ebt -- bash -c "rm -f /home/ebt/$dropin"
    app systemctl --user daemon-reload
    app systemctl --user restart public@b.service
  fi
  app systemctl --user start public@a.service
  wait_active public@a.service >/dev/null || true
  local line
  for line in "${out[@]}"; do
    if [[ $mode == negative ]]; then
      printf '%s\n' "$line"
    elif [[ $line == PASS* ]]; then
      pass "${line#PASS  }"
    else
      fail "${line#FAIL  }"
    fi
  done
}

# guard_reload_check: a change of the egress guard's rules, provisioned while the stack runs, must
# reach the kernel without restarting the app user's systemd or any container (the manager
# Requires= the guard, so a guard restart would restart everything). Uses a copy of infra/ in the
# sim with one extra harmless drop (TEST-NET-3), then puts the repository's rules back.
guard_reload_check() {
  printf '\n### egress guard: a rules change while the stack runs\n'
  local uid copy=/root/ebt-guard-test before_user after_user before_ct after_ct log
  uid=$(sim id -u ebt)
  user_started() { sim systemctl show -p ActiveEnterTimestamp --value "user@$uid.service"; }
  # shellcheck disable=SC2016 # the command substitution runs in the app user's bash
  containers_started() { app bash -c 'podman inspect --format "{{.Name}} {{.State.StartedAt}}" $(podman ps -q) | sort'; }
  before_user=$(user_started)
  before_ct=$(containers_started)
  # nft -f applies a file as one transaction: a file that fails half-way changes nothing.
  local rules_before
  rules_before=$(sim nft list table inet ebt_egress | grep -c 'drop' || true)
  sim bash -c 'printf "table inet ebt_egress\ndelete table inet ebt_egress\ntable inet ebt_egress { chain output { type filter hook output priority filter; this is not nft; } }\n" > /root/ebt-broken.nft'
  if sim nft -f /root/ebt-broken.nft >/dev/null 2>&1; then fail "a broken rules file was accepted"; else pass "a broken rules file is refused as a whole"; fi
  expect "the guard's rules after the refused file" "$rules_before" "$(sim nft list table inet ebt_egress | grep -c 'drop' || true)"
  sim rm -rf "$copy" /root/ebt-broken.nft
  sim mkdir -p "$copy"
  sim cp -a /opt/ebooktrivia/infra "$copy/"
  sim sed -i 's|^\(\t\tmeta skuid "@APP@" ip daddr 169.254.0.0/16 counter drop\)$|\1\n\t\tmeta skuid "@APP@" ip daddr 203.0.113.254 counter drop|' \
    "$copy/infra/provision/files/ebt-egress.nft"
  log=$(sim "$copy/infra/provision/provision.sh" 2>&1)
  printf '%s\n' "$log" >"$OUT/guard-reload-1.log"
  expect_match "provision updated the rules file" 'CHANGED  /etc/nftables/ebt-egress.nft' "$log"
  expect_match "the new rule is live" '203\.0\.113\.254' "$(sim nft list table inet ebt_egress)"
  after_user=$(user_started)
  after_ct=$(containers_started)
  expect "user@$uid.service not restarted (ActiveEnterTimestamp)" "$before_user" "$after_user"
  expect "no container restarted (StartedAt of all $(wc -l <<<"$before_ct"))" "$before_ct" "$after_ct"
  log=$(sim "$copy/infra/provision/provision.sh" 2>&1)
  printf '%s\n' "$log" >"$OUT/guard-reload-2.log"
  expect "one more run with the same rules" "summary: 0 changed, 4 skipped in container" "$(tail -1 <<<"$log")"
  # A broken rules file must stop provisioning before it is installed: on disk it would fail the
  # guard at the next boot, and with it the app user's systemd (Requires=) and the whole stack.
  local sha_before drops_before
  sha_before=$(sim sha256sum /etc/nftables/ebt-egress.nft)
  drops_before=$(sim nft list table inet ebt_egress | grep -c 'drop' || true)
  sim sed -i 's|^\t\tmeta skuid "@APP@" ip daddr 203.0.113.254 counter drop$|\t\tmeta skuid "@APP@" ip daddr 203.0.113.254 this is not nft|' \
    "$copy/infra/provision/files/ebt-egress.nft"
  if log=$(sim "$copy/infra/provision/provision.sh" 2>&1); then
    fail "provisioning accepted a broken rules file"
  else
    pass "provisioning stops on a broken rules file ($(grep -m1 -o 'ERROR .*' <<<"$log" | cut -c1-90))"
  fi
  printf '%s\n' "$log" >"$OUT/guard-reload-broken.log"
  expect "installed rules file unchanged (sha256)" "$sha_before" "$(sim sha256sum /etc/nftables/ebt-egress.nft)"
  expect "live table keeps its drops" "$drops_before" "$(sim nft list table inet ebt_egress | grep -c 'drop' || true)"
  # Back to the repository's rules, the same way.
  log=$(sim /opt/ebooktrivia/infra/provision/provision.sh 2>&1)
  printf '%s\n' "$log" >"$OUT/guard-reload-3.log"
  if sim nft list table inet ebt_egress | grep -q '203\.0\.113\.254'; then fail "the extra rule is still live after the revert"; else pass "the repository's rules are live again"; fi
  expect "still no restart after the revert" "$before_user|$before_ct" "$(user_started)|$(containers_started)"
  sim rm -rf "$copy"
}

check() {
  printf '\n### checks\n'
  sim /opt/ebooktrivia/infra/verify/client-ip-probe.sh start
  wait_active public@b.service
  psql_app_db <<<"UPDATE landing_pages SET current_version_id = '00000000-0000-4000-8000-00000000c001' WHERE id = '00000000-0000-4000-8000-00000000a001';" >/dev/null
  as_ebt ln -sfn ../../versions/00000000-0000-4000-8000-00000000a001/1 /srv/lp/hosts/lp-ok.example.test/current
  expect "db-roles second run" "summary: 0 changed" "$(tail -1 "$OUT/db-roles-2.log")"

  # Real client address (criterion 5): the probe on public@b reports what an app sees.
  local i body probes=0
  # Caddy marks the restarted public@b healthy after health_passes (2 x 2 s); give it the time.
  sleep 6
  for i in 1 2 3 4 5 6 7 8; do
    body=$(curl_from "$CLIENT" -H 'X-Forwarded-For: 203.0.113.9' -H 'X-Real-IP: 203.0.113.10' https://play.example.test/ || true)
    if [[ $body == *'"probe":"client-ip"'* ]]; then
      probes=$((probes + 1))
      printf '%s\n' "$body" >>"$OUT/probe-replies.json"
      expect_match "app sees the real client 192.0.2.100, not the spoofed headers (reply $i)" '"clientIp":"192.0.2.100","peer":"10.89.50.2"' "$body"
    else
      expect_match "public@a serves the real app through Caddy (reply $i)" '<html' "$body"
    fi
  done
  if ((probes > 0)); then pass "load balancer reached both instances ($probes probe replies of 8)"; else fail "no reply came from public@b"; fi
  body=$(app podman run --rm --network ebt-edge:ip=10.89.50.66 "$CURL_IMAGE" -s -m 5 -H 'X-Forwarded-For: 203.0.113.9' http://10.89.50.12:3000/ || true)
  expect_match "a non-Caddy peer on the edge network cannot spoof X-Forwarded-For" '"clientIp":"10.89.50.66","peer":"10.89.50.66"' "$body"
  expect_match "Caddy access log has the real client address" '"remote_ip":"192.0.2.100"' "$(sim journalctl CONTAINER_NAME=caddy --no-pager -o cat 2>&1 | grep -m1 -o '"remote_ip":"192.0.2.100"')"

  # TLS: certificates from the ACME CA through socket activation (TLS-ALPN-01 on fd/4).
  expect_match "admin.example.test certificate issued by the ACME CA (Pebble)" 'issuer: CN ?= ?Pebble Intermediate CA' "$(curl_from "$CLIENT" -v -o /dev/null https://admin.example.test/ 2>&1)"
  expect "strict_sni_host: Host differs from SNI -> 421" 421 "$(curl_from "$CLIENT" -o /dev/null -w '%{http_code}' -H 'Host: admin.example.test' https://play.example.test/)"
  expect "http:// redirects to https" "308 https://play.example.test/x" "$(curl_from "$CLIENT" -o /dev/null -w '%{http_code} %{redirect_url}' http://play.example.test/x)"
  local headers
  headers=$(curl_from "$CLIENT" -D - -o /dev/null https://play.example.test/)
  expect_match "app hosts: HSTS" 'strict-transport-security: max-age=31536000; includesubdomains' "${headers,,}"
  expect_match "app hosts: frame-ancestors 'none'" "content-security-policy: frame-ancestors 'none'" "${headers,,}"
  expect_match "app hosts: nosniff" 'x-content-type-options: nosniff' "${headers,,}"

  # Blocked paths, on every host, including encodings.
  local path
  for path in /internal /internal/x /INTERNAL/x //internal/x /%69nternal/x /./internal/x /a/../internal/x /livez /LIVEZ; do
    expect "play.example.test$path blocked" 404 "$(curl_from "$CLIENT" --path-as-is -o /dev/null -w '%{http_code}' "https://play.example.test$path")"
  done
  expect "lp-ok.example.test/internal blocked" 404 "$(curl_from "$CLIENT" -o /dev/null -w '%{http_code}' https://lp-ok.example.test/internal/x)"

  # Admin allowlist.
  # The console's / needs a session: an anonymous client is sent to /login (Next redirect, 307), which is
  # a page anyone allowed may load.
  expect "admin from 192.0.2.100 (allowed): /login" 200 "$(curl_from "$CLIENT" -o /dev/null -w '%{http_code}' https://admin.example.test/login)"
  expect_match "admin from 192.0.2.100 (allowed): / sends an anonymous client to /login" '^307 https://admin\.example\.test/login$' "$(curl_from "$CLIENT" -o /dev/null -w '%{http_code} %{redirect_url}' https://admin.example.test/)"
  SIM_IP=198.51.100.10 expect "admin from 198.51.100.20 (not allowed)" 404 \
    "$(SIM_IP=198.51.100.10 curl_from "$GLITCHTIP" -o /dev/null -w '%{http_code}' --resolve admin.example.test:443:198.51.100.10 https://admin.example.test/)"

  # order.<domain>: no cookies either way.
  expect "order: Set-Cookie stripped" "" "$(curl_from "$CLIENT" -D - -o /dev/null https://order.example.test/ | grep -i '^set-cookie' || true)"

  # LP domains: on-demand TLS gated by the internal process; symlink-swapped roots.
  expect_match "LP host in lp_domains: certificate on demand, content served" 'release one' "$(curl_from "$CLIENT" https://lp-ok.example.test/)"
  expect_match "LP headers: the default page CSP" "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'" "$(curl_from "$CLIENT" -D - -o /dev/null https://lp-ok.example.test/)"
  # What the admin app does on Make live: the version in the database, then the link by rename.
  psql_app_db <<<"UPDATE landing_pages SET current_version_id = '00000000-0000-4000-8000-00000000c002' WHERE id = '00000000-0000-4000-8000-00000000a001';" >/dev/null
  as_ebt bash -c 'cd /srv/lp/hosts/lp-ok.example.test && ln -s ../../versions/00000000-0000-4000-8000-00000000a001/2 current.new && mv -T current.new current'
  expect_match "LP symlink swap serves the new release" 'release two' "$(curl_from "$CLIENT" https://lp-ok.example.test/)"
  local code
  code=$(curl_from "$CLIENT" -o /dev/null -w '%{http_code}' https://lp-no.example.test/ 2>&1 || true)
  expect "LP host not in lp_domains: no certificate (TLS handshake fails)" 000 "$code"

  # GlitchTip hook: allowlisted source, exact path, token checked by internal; URI redacted in logs.
  local token
  token=$(tr -d '\n' <"$OUT/glitchtip-hook.token")
  local hook_body='{"alert":"vm-sim","title":"vm-sim test","text":"vm-sim","attachments":[]}'
  expect "hook from a non-allowlisted source" 404 "$(curl_from "$CLIENT" -o /dev/null -w '%{http_code}' -X POST -d "$hook_body" "https://api.example.test/hooks/glitchtip/$token")"
  code=$(SIM_IP=198.51.100.10 curl_from "$GLITCHTIP" -o /dev/null -w '%{http_code}' --resolve api.example.test:443:198.51.100.10 \
    -X POST -H 'Content-Type: application/json' -d "$hook_body" "https://api.example.test/hooks/glitchtip/$token")
  expect "hook from the GlitchTip host reaches internal, which stores the alert" 204 "$code"
  expect "alerts row stored by the internal process" t "$(psql_app_db -c "SELECT count(*) > 0 FROM alerts WHERE source = 'glitchtip' AND message = 'vm-sim'" </dev/null)"
  expect "hook with a wrong token" 404 "$(SIM_IP=198.51.100.10 curl_from "$GLITCHTIP" -o /dev/null -w '%{http_code}' -X POST -d "$hook_body" "https://api.example.test/hooks/glitchtip/0000000000000000000000000000000000000000000000000000000000000000")"
  local logs
  logs=$(sim journalctl CONTAINER_NAME=caddy --no-pager -o cat 2>&1)
  if grep -q "$token" <<<"$logs"; then fail "the hook token appears in Caddy's logs"; else pass "the hook token never appears in Caddy's logs"; fi
  expect_match "Caddy logs the hook URI redacted" '/hooks/glitchtip/\[redacted\]' "$logs"
  # Signed-file URIs (token in the path, signature in the query) and odd spellings of the hook path.
  curl_from "$CLIENT" -o /dev/null "https://api.example.test/files/d/sim-file-token-1234?sig=sim-signature-5678&exp=1" || true
  curl_from "$CLIENT" --path-as-is -o /dev/null -X POST -d '{}' "https://api.example.test//HOOKS/glitchtip/sim-odd-hook-token-0000" || true
  sleep 1
  logs=$(sim journalctl CONTAINER_NAME=caddy --no-pager -o cat 2>&1)
  local secret
  for secret in sim-file-token-1234 sim-signature-5678 sim-odd-hook-token-0000; do
    if grep -q "$secret" <<<"$logs"; then fail "$secret appears in Caddy's logs"; else pass "$secret never appears in Caddy's logs"; fi
  done
  expect_match "Caddy logs /files URIs as /files/[redacted]" '"uri":"/files/\[redacted\]"' "$logs"

  # Drain (review C-M4), on the probe instance with public@a stopped, so every request reaches it.
  drain_check positive
  local negative
  negative=$(drain_check negative)
  printf '%s\n' "$negative" | sed 's/^/    (negative run) /'
  if grep -q '^FAIL' <<<"$negative"; then
    pass "the drain check fails for an instance that exits at once on SIGTERM ($(grep -c '^FAIL' <<<"$negative") failed checks)"
  else
    fail "the drain check did not notice an instance that exits at once on SIGTERM"
  fi

  # Drain: restart public@a while requests flow; none may fail.
  local errors=0 n=0
  app systemctl --user restart --no-block public@a.service
  for n in $(seq 1 40); do
    code=$(curl_from "$CLIENT" -o /dev/null -w '%{http_code}' https://play.example.test/ || true)
    [[ $code == 200 ]] || errors=$((errors + 1))
    sleep 0.25
  done
  expect "requests failing while public@a restarts (drain + lb_try_duration), of $n" 0 "$errors"
  wait_active public@a.service

  guard_reload_check

  printf '\n### host-check with the stack running\n'
  sim /opt/ebooktrivia/infra/verify/client-ip-probe.sh stop
  wait_active public@b.service
  sim /opt/ebooktrivia/infra/verify/host-check.sh | tee "$OUT/host-check-stack.log" || true
  local unexpected
  unexpected=$(grep '^FAIL' "$OUT/host-check-stack.log" | grep -v -E "^FAIL  ($CONTAINER_ONLY).* \[container\]$" || true)
  if [[ -n $unexpected ]]; then
    fail "host-check failures beyond the container-only ones:"
    printf '%s\n' "$unexpected"
  else
    pass "host-check: only the container-only checks fail ($(grep -c '^FAIL' "$OUT/host-check-stack.log" || true): SELinux mode, AVC log, labels, auditd, chrony)"
  fi

  printf '\nstack-sim: %d failure(s); logs in %s\n' "$FAILURES" "$OUT"
  ((FAILURES == 0))
}

down() {
  docker rm -f "$PEBBLE" "$CLIENT" "$GLITCHTIP" >/dev/null 2>&1 || true
  docker network disconnect "$NET_A" "$NAME" >/dev/null 2>&1 || true
  docker network disconnect "$NET_B" "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NET_A" "$NET_B" >/dev/null 2>&1 || true
}

SIM_IP=192.0.2.10
case ${1:-all} in
  all)
    up
    check
    ;;
  up) up ;;
  check) check ;;
  guard-reload) guard_reload_check ;;
  down) down ;;
  *)
    printf 'usage: %s [all|up|check|guard-reload|down]\n' "$0" >&2
    exit 2
    ;;
esac
