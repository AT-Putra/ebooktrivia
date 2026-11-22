#!/usr/bin/env bash
# Runs the real Caddy 2.11.9 on the `order.{$DOMAIN}` site of infra/caddy/Caddyfile (the payment status
# page origin, US-022) and checks what a browser and the access log get:
#   - exactly ONE Referrer-Policy header, strict-origin (AC-T5: vendor scripts run on this origin), FORCED: the stand-in
#     upstream sends unsafe-url, the site replaces it (US-031);
#   - HSTS, nosniff, frame-ancestors 'none', no Server header, and no Set-Cookie even when the upstream sets one
#     (here a stand-in `respond` sets one, to prove the site removes it);
#   - Next's rewrite headers (x-middleware-rewrite: /order/{publicId}, which proxy.ts's rewrite makes Next send)
#     never reach the client or the access log: the stand-in sends them, the site removes them;
#   - the access log never holds the order's public id (page path, /order/{id}, Midtrans `order_id` query,
#     response rewrite headers) or a Referer.
# The site block and the snippets it imports (app_headers, order_access_log) are cut out of the Caddyfile,
# so this tests the file that ships, not a copy; only the reverse proxy is replaced by a fixed answer.
#
#   infra/verify/local/order-headers.sh        (needs Docker and curl; no network beyond localhost)
#
# Test values only. Not part of `pnpm test` (it needs Docker); the adapted-JSON assertions of
# infra/verify/src/caddyfile.test.ts cover the same settings structurally.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$HERE/lib.sh"
IMAGE=docker.io/library/caddy:2.11.9@sha256:e40b94d0a43b5ff69cb20568d73f10c70703df7b0ffc2298eb3d723cdc9d0bd1
NAME=ebt-order-headers
PORT=${ORDER_HEADERS_PORT:-18090}
work=$(mktemp -d)
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

caddyfile=$REPO/infra/caddy/Caddyfile
id=AbCdEfGhIjKlMnOpQrStUv
# A snippet: from its "(name) {" line to the first line that is exactly "}".
snippet() { awk -v start="($1) {" '$0 == start { on = 1 } on { print } on && /^}$/ { exit }' "$caddyfile"; }
{
  printf '{\n\tadmin off\n\tauto_https off\n}\n'
  snippet app_headers
  snippet referrer_forced
  snippet order_access_log
  snippet blocked_paths
  # The site: its first line becomes :80 (no TLS here), `import https` goes (it binds the TLS socket), and its
  # `handle { ... }` block (the reverse proxy) becomes a fixed answer that also tries to set a cookie.
  awk -v id="$id" '
    /^order\.\{\$DOMAIN\} \{$/ { on = 1; print ":80 {"; next }
    on && /^\timport https$/ { next }
    on && /^\thandle \{$/ { skip = 1; next }
    on && skip && /^\t\}$/ {
      skip = 0
      printf "\thandle {\n\t\theader Set-Cookie \"sid=upstream; Path=/\"\n"
      printf "\t\theader Referrer-Policy \"unsafe-url\"\n"
      printf "\t\theader X-Middleware-Rewrite \"/order/%s\"\n", id
      printf "\t\theader X-Nextjs-Rewritten-Path \"/order/%s\"\n", id
      printf "\t\theader X-Nextjs-Rewritten-Query \"order_id=%s-1\"\n", id
      printf "\t\theader Location \"/order/%s?_rsc=abc\"\n", id
      printf "\t\trespond \"order page\" 200\n\t}\n"
      next
    }
    on && skip { next }
    on { print }
    on && /^\}$/ { exit }
  ' "$caddyfile"
} >"$work/Caddyfile"
grep -q '^:80 {$' "$work/Caddyfile" || { printf 'could not find the order site in infra/caddy/Caddyfile\n' >&2; exit 1; }
# The probe means nothing unless the stand-in really sends what the site must remove.
grep -q "header X-Middleware-Rewrite \"/order/$id\"" "$work/Caddyfile" || { printf 'the stand-in upstream does not send x-middleware-rewrite\n' >&2; exit 1; }
grep -q 'header Referrer-Policy "unsafe-url"' "$work/Caddyfile" || { printf 'the stand-in upstream does not send a weak Referrer-Policy\n' >&2; exit 1; }

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:80" -v "$(host_path "$work")/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "$IMAGE" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
for _ in $(seq 1 40); do
  [[ $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true) == 200 ]] && break
  sleep 0.5
done

fail=0
pass() { printf 'PASS  %s\n' "$1"; }
bad() {
  printf 'FAIL  %s\n' "$1"
  fail=1
}
check() { # check DESCRIPTION EXPECTED ACTUAL
  if [[ $3 == "$2" ]]; then pass "$1"; else bad "$1: expected [$2], got [$3]"; fi
}
contains() { # contains DESCRIPTION NEEDLE ACTUAL
  if [[ $3 == *"$2"* ]]; then pass "$1"; else bad "$1: [$3] does not contain [$2]"; fi
}
check_not() {
  if [[ $3 != *"$2"* ]]; then pass "$1"; else bad "$1: [$3] must not contain [$2]"; fi
}
headers_of() { { curl -s -o /dev/null -D - "$@" || true; } | tr -d '\r' | tr '[:upper:]' '[:lower:]'; }

h=$(headers_of "http://127.0.0.1:$PORT/$id")
check "page: 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/$id")"
check "exactly one Referrer-Policy header" 1 "$(grep -c '^referrer-policy:' <<<"$h")"
check "Referrer-Policy is strict-origin" "referrer-policy: strict-origin" "$(grep '^referrer-policy:' <<<"$h" | head -n1)"
check "HSTS" "strict-transport-security: max-age=31536000; includesubdomains" "$(grep '^strict-transport-security:' <<<"$h" | head -n1)"
check "nosniff" "x-content-type-options: nosniff" "$(grep '^x-content-type-options:' <<<"$h" | head -n1)"
check "the edge's global CSP (frame-ancestors, object-src, base-uri none)" "content-security-policy: frame-ancestors 'none'; object-src 'none'; base-uri 'none'" "$(grep '^content-security-policy:' <<<"$h" | head -n1)"
check_not "no Set-Cookie, whatever the upstream sets" "set-cookie" "$h"
check_not "no x-middleware-rewrite (it would name /order/{publicId})" "x-middleware-rewrite" "$h"
check_not "no x-nextjs-rewritten-path / -query" "x-nextjs-rewritten" "$h"
# Location (the stand-in sends one, as Next's RSC redirect does) is left on the response, the browser needs it;
# it is the LOG that must not hold it (below).
check_not "the public id is in no other response header" "$id" "$(grep -v '^location:' <<<"$h")"
check_not "no Server header" "server:" "$h"

# The access log: the id in a path, the id in the Midtrans query, a Referer from another page.
curl -s -o /dev/null -H 'Cookie: sid=secret' -H "Referer: https://lp.example.test/thanks?order=$id" "http://127.0.0.1:$PORT/$id?order_id=$id-1&status_code=200"
curl -s -o /dev/null "http://127.0.0.1:$PORT/?order_id=$id-2&status_code=407&transaction_status=expire"
curl -s -o /dev/null "http://127.0.0.1:$PORT/api/v1/order/status"
curl -s -o /dev/null "http://127.0.0.1:$PORT/order/$id"
sleep 1
log=$(docker logs "$NAME" 2>&1 | grep '"msg":"handled request"' || true)
[[ -n $log ]] || bad "no access log lines"
check_not "log: the public id is not logged" "$id" "$log"
check_not "log: no Referer" "referer" "$(tr '[:upper:]' '[:lower:]' <<<"$log")"
check_not "log: no Cookie value" "sid=secret" "$log"
check_not "log: no rewrite header" "x-middleware-rewrite" "$(tr '[:upper:]' '[:lower:]' <<<"$log")"
check_not "log: no x-nextjs-rewritten header" "x-nextjs-rewritten" "$(tr '[:upper:]' '[:lower:]' <<<"$log")"
check_not "log: /order/{id} is redacted too" '"uri":"/order/' "$log"
check_not "log: no Location header (it names /order/{id}?_rsc=...)" "location" "$(tr '[:upper:]' '[:lower:]' <<<"$log")"
check_not "log: the id appears nowhere, whatever the field" "$id" "$log"
check_not "log: the page path is /[order]" '"uri":"/AbCd' "$log"
contains "log: a page request is logged as /[order]" '"uri":"/[order]"' "$log"
contains "log: the Midtrans order_id is redacted" '"uri":"/?order_id=[redacted]&status_code=407&transaction_status=expire"' "$log"
contains "log: the API path stays readable" '"uri":"/api/v1/order/status"' "$log"

((fail == 0)) && printf 'order-headers: all checks passed\n'
exit "$fail"
