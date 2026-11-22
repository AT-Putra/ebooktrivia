#!/usr/bin/env bash
# The full security header set per host (US-031): admin, play, order, api, the SDK files on api and an LP host, as a
# browser gets them, checked against ONE policy (infra/verify/src/security-headers.ts; its unit tests prove each rule
# fails on a bad header). Two modes:
#
#   infra/verify/local/security-headers.sh                         local (CI job edge-smoke): the real Caddy 2.11.9 with
#       the real infra/caddy/Caddyfile in front of the real production builds of apps/public and apps/admin
#       (node src/server.ts behind packages/edge, NODE_ENV=production), no database and no Valkey: the pages and
#       answers that need neither, and the fail-closed 503s of those that do. Needs Docker, curl, node and both
#       `next build` outputs. Test values only (example.test); listens on 127.0.0.1 only.
#   infra/verify/local/security-headers.sh --staging <domain> <lp-host>      the same probes and policy against the
#       deployed hosts over HTTPS (docs/runbooks/security-scans.md); any status is accepted there.
#   infra/verify/local/security-headers.sh --serve      the local stack only, kept up until interrupted (the target of
#       infra/verify/staging/zap-baseline.sh --local, a dry run of the staging scan).
#
# What the edge adds (HSTS, nosniff, frame-ancestors, the removal of Server / X-Powered-By and of the order site's
# cookies) and what the apps add (the nonce CSPs, no-store, COOP, CORP, Permissions-Policy) are only both present in a
# real response, so this checks those, not a copy. The Caddyfile changes for the local run are mechanical: plain HTTP
# on one local port instead of the TLS socket and on-demand certificates, the app upstreams on loopback, and no global
# options (the admin endpoint stays off). Cookie attributes of real sessions come from logins, which need a database:
# e2e/tests/admin-auth.spec.ts and play-login.spec.ts assert them, and the policy here fails any cookie it sees that
# breaks the rules.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$HERE/lib.sh"
IMAGE=docker.io/library/caddy:2.11.9@sha256:e40b94d0a43b5ff69cb20568d73f10c70703df7b0ffc2298eb3d723cdc9d0bd1
# --serve keeps the fixed name and ports zap-baseline.sh --local looks for; every other run gets a container name and
# ports of its own (code review 10), so two runs on one machine never take each other's container or ports.
if [[ ${1:-} == --serve ]]; then
  NAME=ebt-security-headers
  base_port=18480
else
  NAME=ebt-security-headers-$$
  base_port=$((18500 + (RANDOM % 300) * 3))
fi
CADDY_PORT=${SECURITY_HEADERS_PORT:-$base_port}
PUBLIC_PORT=${SECURITY_HEADERS_PUBLIC_PORT:-$((base_port + 1))}
ADMIN_PORT=${SECURITY_HEADERS_ADMIN_PORT:-$((base_port + 2))}
ID=AbCdEfGhIjKlMnOpQrStUv
work=$(mktemp -d)
pids=()
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  for pid in "${pids[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$work/dumps"

staging=0
serve=0
if [[ ${1:-} == --serve ]]; then
  serve=1
  DOMAIN=example.test
  LP_HOST=lp-ok.example.test
elif [[ ${1:-} == --staging ]]; then
  [[ $# -eq 3 ]] || { printf 'usage: %s --staging <domain> <lp-host>\n' "$0" >&2; exit 2; }
  staging=1
  DOMAIN=$2
  LP_HOST=$3
else
  DOMAIN=example.test
  LP_HOST=lp-ok.example.test
fi

n=0
# probe KIND LABEL STATUS HOST PATH [curl args...]: one response's headers into the index (status * = any).
# PROBE_REFERRER=<policy> probe ...: the route sets its own, stricter Referrer-Policy, which must reach the browser.
probe() {
  local kind=$1 label=$2 status=$3 host=$4 path=$5
  shift 5
  n=$((n + 1))
  local url
  if ((staging)); then url="https://$host$path"; else url="http://127.0.0.1:$CADDY_PORT$path"; fi
  local args=(-s -o /dev/null -D - -m 15 "$@")
  ((staging)) || args+=(-H "Host: $host")
  { curl "${args[@]}" "$url" || true; } >"$work/dumps/$n.http"
  ((staging)) && status='*'
  printf '%s\t%s\t%s\t%s\t%s\n' "$kind" "$label" "$status" "dumps/$n.http" "${PROBE_REFERRER:-}" >>"$work/index.tsv"
}

if ((!staging)); then
  for app in public admin; do
    [[ -f $REPO/apps/$app/.next/required-server-files.json ]] || {
      printf 'apps/%s has no build: run pnpm --filter @ebooktrivia/%s build first\n' "$app" "$app" >&2
      exit 1
    }
  done
  # The apps on loopback only. Linux (CI): Caddy shares the host network, so it binds 127.0.0.1 itself (default_bind;
  # code review 11). Docker Desktop: the port is published on 127.0.0.1 only, and Caddy reaches the host's loopback
  # through host.docker.internal.
  if [[ $(uname -s) == Linux ]]; then
    upstream=127.0.0.1
    network=(--network host)
    bind="\tdefault_bind 127.0.0.1\n"
  else
    upstream=host.docker.internal
    network=(-p "127.0.0.1:$CADDY_PORT:$CADDY_PORT")
    bind=""
  fi
  (cd "$REPO/apps/public" && NODE_ENV=production EDGE_HOST=127.0.0.1 EDGE_PORT=$PUBLIC_PORT TRUSTED_PROXY_IP=192.0.2.1 DOMAIN=$DOMAIN \
    exec node src/server.ts >"$work/public.log" 2>&1) &
  pids+=($!)
  (cd "$REPO/apps/admin" && NODE_ENV=production EDGE_HOST=127.0.0.1 EDGE_PORT=$ADMIN_PORT TRUSTED_PROXY_IP=192.0.2.1 ADMIN_ORIGIN=https://admin.$DOMAIN \
    exec node src/server.ts >"$work/admin.log" 2>&1) &
  pids+=($!)

  caddyfile=$REPO/infra/caddy/Caddyfile
  # Global options and the :80 redirect site go; every site listens on $CADDY_PORT over plain HTTP; the TLS socket
  # import and the on-demand certificates of the LP site go; the apps are on loopback.
  awk -v port="$CADDY_PORT" -v bind="$bind" '
    !global_done && /^\{$/ { skip = 1; next }
    skip { if (/^\}$/) { skip = 0; global_done = 1; printf "{\n\tadmin off\n\tauto_https off\n%s}\n", bind } next }
    /^http:\/\/ \{$/ { drop = 1; next }
    drop { if (/^\}$/) drop = 0; next }
    /^(admin|play|order|api)\.\{\$DOMAIN\} \{$/ { sub(/ \{$/, ""); printf "http://%s:%s {\n", $0, port; next }
    /^https:\/\/ \{$/ { printf "http://:%s {\n", port; next }
    /^\timport https$/ { next }
    /^\ttls \{$/ { tls = 1; next }
    tls { if (/^\t\}$/) tls = 0; next }
    { print }
  ' "$caddyfile" |
    sed -e "s|reverse_proxy admin:3000 {|reverse_proxy $upstream:$ADMIN_PORT {|" \
      -e "s|reverse_proxy public-a:3000 public-b:3000 {|reverse_proxy $upstream:$PUBLIC_PORT {|" >"$work/Caddyfile"
  for site in "http://admin.{\$DOMAIN}:$CADDY_PORT {" "http://order.{\$DOMAIN}:$CADDY_PORT {" "http://:$CADDY_PORT {" "reverse_proxy $upstream:$PUBLIC_PORT {"; do
    grep -qF "$site" "$work/Caddyfile" || { printf 'could not adapt infra/caddy/Caddyfile (%s)\n' "$site" >&2; exit 1; }
  done
  ! grep -qE '^\s*(import https|on_demand)$' "$work/Caddyfile" || { printf 'the TLS socket or on-demand TLS is still in the local Caddyfile\n' >&2; exit 1; }

  # The SDK files and one LP page, the way build-images.sh sdk and the admin's ZIP hosting lay them out.
  mkdir -p "$work/sdk" "$work/lp/hosts/$LP_HOST/current"
  printf '(function(){var x="ebooktrivia sdk test file";})();\n' >"$work/sdk/sdk-v1.0.0.js"
  cp "$work/sdk/sdk-v1.0.0.js" "$work/sdk/v1.js"
  printf '<!doctype html><html><head><title>LP</title></head><body><p>landing page</p></body></html>\n' >"$work/lp/hosts/$LP_HOST/current/index.html"

  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" "${network[@]}" \
    -e DOMAIN="$DOMAIN" -e ACME_EMAIL=ops@example.test -e "ADMIN_ALLOWED_CIDRS=0.0.0.0/0 ::/0" \
    -e GLITCHTIP_ALLOWED_CIDRS=192.0.2.1/32 -e WAHA_ALLOWED_CIDRS=192.0.2.1/32 -e MONITOR_ALLOWED_CIDRS=192.0.2.1/32 \
    -v "$(host_path "$work")/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$(host_path "$work")/sdk:/srv/sdk:ro" -v "$(host_path "$work")/lp:/srv/lp:ro" \
    "$IMAGE" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  ready=0
  for _ in $(seq 1 120); do
    if [[ $(curl -s -o /dev/null -w '%{http_code}' -H "Host: play.$DOMAIN" "http://127.0.0.1:$CADDY_PORT/login" || true) == 200 &&
      $(curl -s -o /dev/null -w '%{http_code}' -H "Host: admin.$DOMAIN" "http://127.0.0.1:$CADDY_PORT/login" || true) == 200 ]]; then
      ready=1
      break
    fi
    sleep 0.5
  done
  if ((!ready)); then
    printf 'the stack did not answer: caddy, public and admin logs follow\n' >&2
    docker logs "$NAME" 2>&1 | tail -n 20 >&2
    tail -n 20 "$work/public.log" "$work/admin.log" >&2
    exit 1
  fi
fi

if ((serve)); then
  printf 'security-headers: serving admin. play. order. api.%s and %s on 127.0.0.1:%s (container %s); interrupt to stop\n' "$DOMAIN" "$LP_HOST" "$CADDY_PORT" "$NAME"
  while :; do sleep 3600; done
fi

lp_origin="https://$LP_HOST"
# admin.<DOMAIN>: the login page (twice: a fresh nonce each time), a refused cross-origin POST, an edge 404.
PROBE_REFERRER=same-origin probe admin "login page" 200 "admin.$DOMAIN" /login
PROBE_REFERRER=same-origin probe admin "login page#2" 200 "admin.$DOMAIN" /login
probe admin "POST without Origin (refused)" 403 "admin.$DOMAIN" /login -X POST -H 'Content-Type: text/plain' --data x
probe admin "/internal (blocked at the edge)" 404 "admin.$DOMAIN" /internal
probe admin "TRACE (refused at the edge)" 405 "admin.$DOMAIN" /login -X TRACE
# play.<DOMAIN>: the WhatsApp login page and the magic link's confirm page, the play API (no runtime here: 503).
PROBE_REFERRER=no-referrer probe play "login page" 200 "play.$DOMAIN" /login
PROBE_REFERRER=no-referrer probe play "login page#2" 200 "play.$DOMAIN" /login
PROBE_REFERRER=no-referrer probe play "magic-link confirm page" 200 "play.$DOMAIN" /masuk
probe play "session API" 503 "play.$DOMAIN" /api/v1/play/auth/session
# A path no route serves: the 404 page (the ZAP baseline found it without a script policy; US-031 proxy.ts defaultPage).
PROBE_REFERRER=no-referrer probe play "404 page (robots.txt)" 404 "play.$DOMAIN" /robots.txt
# order.<DOMAIN>: the page's shell, an order page (its lookup needs the database: the fail-closed 503), the status API.
probe order "page shell" 200 "order.$DOMAIN" /
probe order "page shell#2" 200 "order.$DOMAIN" /
probe order "order page (no database: 503)" 503 "order.$DOMAIN" "/$ID"
probe order "status API" 503 "order.$DOMAIN" /api/v1/order/status -X POST -H 'Content-Type: application/json' --data "{\"id\":\"$ID\"}"
# api.<DOMAIN>: the checkout from a landing page (no runtime here: 503), the SDK files.
probe api "checkout POST" 503 "api.$DOMAIN" /api/v1/checkout/lp_Abcdefgh12345678abcdefgh -X POST -H "Origin: $lp_origin" -H 'Content-Type: application/json' --data '{}'
probe api "/livez (blocked at the edge)" 404 "api.$DOMAIN" /livez
PROBE_REFERRER=no-referrer probe api "the origin's / page" 200 "api.$DOMAIN" /
probe api "TRACE (refused at the edge)" 405 "api.$DOMAIN" /api/v1/checkout/lp_Abcdefgh12345678abcdefgh -X TRACE
PROBE_REFERRER=no-referrer probe api "404 page (/sdk without a file)" 404 "api.$DOMAIN" /sdk
if ((staging)); then
  probe sdk "SDK alias v1.js" 200 "api.$DOMAIN" /sdk/v1.js
else
  probe sdk "SDK sdk-v1.0.0.js" 200 "api.$DOMAIN" /sdk/sdk-v1.0.0.js
  probe sdk "SDK alias v1.js" 200 "api.$DOMAIN" /sdk/v1.js
fi
# An LP host: its page and a refused path.
probe lp "page" 200 "$LP_HOST" /
probe lp "a .php path (refused)" 404 "$LP_HOST" /x.php

# SECURITY_HEADERS_OUT=<dir> keeps the dumps and the index (evidence of a staging run).
if [[ -n ${SECURITY_HEADERS_OUT:-} ]]; then mkdir -p "$SECURITY_HEADERS_OUT" && cp -r "$work/dumps" "$work/index.tsv" "$SECURITY_HEADERS_OUT/"; fi
# Windows paths for node.exe (lib.sh turns off MSYS path conversion).
node "$(host_path "$REPO")/infra/verify/src/security-headers-cli.ts" "$(host_path "$work")"
