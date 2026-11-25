#!/usr/bin/env bash
# Runs the real Caddy 2.11.9 on the /healthz routing of infra/caddy/Caddyfile (US-015: the deep health of the public
# app belongs to the monitor, Uptime Kuma) and checks who gets an answer:
#   - a source OUTSIDE MONITOR_ALLOWED_CIDRS gets a bare 404 for /healthz on api.<DOMAIN> in every spelling (trailing
#     slash, upper case, a path under it, a query, doubled and dot segments, a percent-encoded letter), and the
#     stand-in upstream is never reached;
#   - a source INSIDE it reaches the upstream (a fixed answer stands in for the public app), for the path and anything
#     under it, while the rest of api.<DOMAIN> goes to the catch-all as before;
#   - on play.<DOMAIN> and order.<DOMAIN> /healthz is a 404 for everyone, whatever MONITOR_ALLOWED_CIDRS says.
# The snippets blocked_paths and blocked_healthz and the api site's /healthz block are cut out of the Caddyfile, so this
# tests the text that ships, not a copy; the sites around them are minimal stand-ins (no TLS, fixed answers instead of the
# reverse proxy). The adapted-JSON assertions of infra/verify/src/caddyfile.test.ts pin the order of the routes in the
# real sites.
#
#   infra/verify/local/healthz-routing.sh        (needs Docker and curl; binds 127.0.0.1:$HEALTHZ_ROUTING_PORT only)
#
# Test values only. Not part of `pnpm test` (it needs Docker); CI job `infra` runs it.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$HERE/lib.sh"
IMAGE=docker.io/library/caddy:2.11.9@sha256:e40b94d0a43b5ff69cb20568d73f10c70703df7b0ffc2298eb3d723cdc9d0bd1
NAME=ebt-healthz-routing
PORT=${HEALTHZ_ROUTING_PORT:-18091}
work=$(mktemp -d)
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

caddyfile=$REPO/infra/caddy/Caddyfile
# A snippet: from its "(name) {" line to the first line that is exactly "}".
snippet() { awk -v start="($1) {" '$0 == start { on = 1 } on { print } on && /^}$/ { exit }' "$caddyfile"; }
# The api site's /healthz block: from its matcher to the tab-indented "}" that closes the handle.
api_healthz_block() {
  awk '
    /^api\.\{\$DOMAIN\} \{$/ { in_site = 1; next }
    in_site && /^\t@healthz path / { on = 1 }
    on { print }
    on && /^\t\}$/ { exit }
  ' "$caddyfile"
}
block=$(api_healthz_block)
[[ $block == *"remote_ip {\$MONITOR_ALLOWED_CIDRS}"* && $block == *"not remote_ip 10.90.55.0/24"* && $block == *"import public_upstreams"* && $block == *"respond 404"* ]] ||
  {
    printf 'could not cut the /healthz block out of the api site of infra/caddy/Caddyfile\n' >&2
    exit 1
  }
{
  printf '{\n\tadmin off\n\tauto_https off\n}\n'
  snippet blocked_paths
  snippet blocked_healthz
  printf '(public_upstreams) {\n\trespond "public upstream" 200\n}\n'
  printf 'http://api.example.test {\n\timport blocked_paths\n%s\n\thandle {\n\t\trespond "api catch-all" 200\n\t}\n}\n' "$block"
  printf 'http://play.example.test {\n\timport blocked_paths\n\timport blocked_healthz\n\thandle {\n\t\timport public_upstreams\n\t}\n}\n'
  printf 'http://order.example.test {\n\timport blocked_paths\n\timport blocked_healthz\n\thandle {\n\t\timport public_upstreams\n\t}\n}\n'
} >"$work/Caddyfile"

fail=0
pass() { printf 'PASS  %s\n' "$1"; }
bad() {
  printf 'FAIL  %s\n' "$1"
  fail=1
}
check() { # check DESCRIPTION EXPECTED ACTUAL
  if [[ $3 == "$2" ]]; then pass "$1"; else bad "$1: expected [$2], got [$3]"; fi
}
# get HOST PATH: "STATUS BODY" of a GET with the path exactly as written.
get() {
  local raw
  raw=$(curl -s --path-as-is -H "Host: $1" -w '\n%{http_code}' "http://127.0.0.1:$PORT$2" || true)
  printf '%s %s' "${raw##*$'\n'}" "${raw%$'\n'*}"
}

# start MONITOR_ALLOWED_CIDRS: Caddy with that allowlist. The curl below reaches it from Docker's bridge gateway.
start() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:80" -e "MONITOR_ALLOWED_CIDRS=$1" -e DOMAIN=example.test \
    -v "$(host_path "$work")/Caddyfile:/etc/caddy/Caddyfile:ro" "$IMAGE" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  local ready=0
  for _ in $(seq 1 40); do
    if [[ $(curl -s -o /dev/null -w '%{http_code}' -H 'Host: api.example.test' "http://127.0.0.1:$PORT/" || true) == 200 ]]; then
      ready=1
      break
    fi
    sleep 0.5
  done
  ((ready)) || {
    docker logs "$NAME" 2>&1 | tail -20
    printf 'Caddy did not start\n' >&2
    exit 1
  }
}

SPELLINGS=(/healthz /healthz/ /HEALTHZ /Healthz/x /healthz/x/y '/healthz?x=1' //healthz /./healthz /a/../healthz /%68ealthz /healthz%2F)

printf '### a source outside MONITOR_ALLOWED_CIDRS (192.0.2.1/32 is not Docker'\''s gateway)\n'
start 192.0.2.1/32
for p in "${SPELLINGS[@]}"; do
  check "api $p: 404, no body" "404 " "$(get api.example.test "$p")"
done
check "api /: still the catch-all" "200 api catch-all" "$(get api.example.test /)"
check "api /healthzx: not the health path, the catch-all" "200 api catch-all" "$(get api.example.test /healthzx)"
for host in play.example.test order.example.test; do
  for p in "${SPELLINGS[@]}"; do
    check "$host $p: 404" "404 " "$(get "$host" "$p")"
  done
  check "$host /: the proxy" "200 public upstream" "$(get "$host" /)"
  check "$host /livez: 404 (the load balancer's, blocked everywhere)" "404 " "$(get "$host" /livez)"
done
check "api /livez: 404" "404 " "$(get api.example.test /livez)"

printf '### a source inside MONITOR_ALLOWED_CIDRS (0.0.0.0/0 ::/0 stands for the monitor'\''s address)\n'
start "0.0.0.0/0 ::/0"
for p in /healthz /healthz/ /HEALTHZ /healthz/x '/healthz?x=1' //healthz /./healthz /a/../healthz /%68ealthz; do
  check "api $p: the public upstream" "200 public upstream" "$(get api.example.test "$p")"
done
check "api /: the catch-all" "200 api catch-all" "$(get api.example.test /)"
for host in play.example.test order.example.test; do
  for p in /healthz /healthz/ /HEALTHZ /healthz/x //healthz /%68ealthz; do
    check "$host $p: 404 even for the monitor" "404 " "$(get "$host" "$p")"
  done
done

((fail == 0)) && printf 'healthz-routing: all checks passed\n'
exit "$fail"
