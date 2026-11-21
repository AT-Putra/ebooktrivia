#!/usr/bin/env bash
# Runs the real Caddy 2.11.9 on the LP site block of infra/caddy/Caddyfile (US-023, landing pages
# hosted from a ZIP) and checks what a visitor gets: the fixed Content-Type of every allowed extension,
# nosniff, the default page CSP and the SVG sandbox CSP, 404 for anything not on the allowlist (a .php
# left in a version, a dot file, a directory without index, traversal, POST, an unlinked or upper-case
# host), and that `current` is followed as a symlink and swapped atomically: requests running while the
# link is renamed over (the same rename(2) apps/admin/src/lib/settings/lp-hosting.ts uses) never fail.
# The block is cut out of the Caddyfile, so this tests the file that ships, not a copy; only the TLS
# lines are dropped (plain HTTP on localhost), and the files live in a Docker volume so the symlinks are
# real Linux symlinks (this is the Linux-only half of the US-023 host-link checks; the admin
# integration tests run the same logic on Windows with junctions).
#
#   infra/verify/local/lp-headers.sh        (needs Docker and curl; no network beyond localhost)
#
# Test values only. Not part of `pnpm test` (it needs Docker); the adapted-JSON assertions of
# infra/verify/src/caddyfile.test.ts cover the same block structurally.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$HERE/lib.sh"
IMAGE=docker.io/library/caddy:2.11.9@sha256:e40b94d0a43b5ff69cb20568d73f10c70703df7b0ffc2298eb3d723cdc9d0bd1
NAME=ebt-lp-headers
VOLUME=ebt-lp-headers-srv
PORT=${LP_HEADERS_PORT:-18090}
HOST=shop.example.test
work=$(mktemp -d)
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

caddyfile=$REPO/infra/caddy/Caddyfile
# The LP site: from `https:// {` to the closing brace at column 0; the blocked_paths snippet likewise.
awk '/^https:\/\/ \{$/ { on = 1 } on { print } on && /^\}$/ { exit }' "$caddyfile" >"$work/site.txt"
awk '/^\(blocked_paths\) \{$/ { on = 1 } on { print } on && /^\}$/ { exit }' "$caddyfile" >"$work/blocked.txt"
[[ $(wc -l <"$work/site.txt") -gt 20 && $(wc -l <"$work/blocked.txt") -gt 3 ]] || { printf 'could not find the LP site in infra/caddy/Caddyfile\n' >&2; exit 1; }
{
  printf '{\n\tadmin off\n\tauto_https off\n}\n'
  cat "$work/blocked.txt"
  # :80 instead of https://, without the TLS-only lines (the https bind snippet, on-demand TLS, the log).
  sed -e '1s/.*/:80 {/' -e '/^\timport https$/d' -e '/^\timport access_log$/d' -e '/^\ttls {$/,/^\t}$/d' "$work/site.txt"
} >"$work/Caddyfile"

v1=$work/lp/versions/lp1/1
v2=$work/lp/versions/lp1/2
mkdir -p "$v1/sub" "$v1/emptydir" "$v1/txtonly" "$v2" "$work/lp/hosts/$HOST"
printf '<script>alert(1)</script>\n' >"$v1/txtonly/index.txt"
printf '<!doctype html><html><head></head><body>v1</body></html>\n' >"$v1/index.html"
printf '<!doctype html><html><head></head><body>sub</body></html>\n' >"$v1/sub/index.html"
printf 'body{margin:0}\n' >"$v1/a.css"
printf 'console.log(1)\n' >"$v1/script.js"
printf '{}\n' >"$v1/data.json"
printf 'User-agent: *\n' >"$v1/robots.txt"
printf '<svg xmlns="http://www.w3.org/2000/svg"/>\n' >"$v1/logo.svg"
printf '\211PNG\r\n\032\n' >"$v1/img.png"
printf 'wOF2' >"$v1/font.woff2"
printf '<?php echo 1;\n' >"$v1/notes.php"
printf '<p>hidden</p>\n' >"$v1/.hidden.html"
printf '<!doctype html><html><head></head><body>v2</body></html>\n' >"$v2/index.html"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
docker volume create "$VOLUME" >/dev/null
docker create --name "$NAME" -p "127.0.0.1:$PORT:80" -e DOMAIN=example.test \
  -v "$(host_path "$work")/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$VOLUME:/srv/lp" \
  "$IMAGE" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
docker cp "$(host_path "$work")/lp/." "$NAME:/srv/lp/" >/dev/null
docker start "$NAME" >/dev/null
docker exec "$NAME" ln -s ../../versions/lp1/1 "/srv/lp/hosts/$HOST/current"
for _ in $(seq 1 40); do
  [[ $(curl -s -o /dev/null -w '%{http_code}' -H "Host: $HOST" "http://127.0.0.1:$PORT/" || true) == 200 ]] && break
  sleep 0.5
done

fail=0
pass() { printf 'PASS  %s\n' "$1"; }
bad() {
  printf 'FAIL  %s\n' "$1"
  fail=1
}
# head_of METHOD PATH [curl args...]: status line and headers, lower-cased, CR removed.
head_of() {
  local method=$1 path=$2 verb=(-X "$1")
  shift 2
  [[ $method == HEAD ]] && verb=(-I)
  { curl -s -o /dev/null -D - "${verb[@]}" --path-as-is -H "Host: $HOST" "$@" "http://127.0.0.1:$PORT$path" || true; } | tr -d '\r' | tr '[:upper:]' '[:lower:]'
}
status_of() { head_of "$@" | head -n1 | cut -d' ' -f2; }
header_of() { head_of "$1" "$2" "${@:4}" | grep -i "^$3:" | head -n1 | cut -d' ' -f2- || true; }
body_of() { curl -s --path-as-is -H "Host: $HOST" "http://127.0.0.1:$PORT$1" || true; }
check() { # check DESCRIPTION EXPECTED ACTUAL
  if [[ $3 == "$2" ]]; then pass "$1"; else bad "$1: expected [$2], got [$3]"; fi
}
check_has() {
  if [[ $3 == *"$2"* ]]; then pass "$1"; else bad "$1: [$3] must contain [$2]"; fi
}

for pair in "/:text/html; charset=utf-8" "/index.html:text/html; charset=utf-8" "/sub/:text/html; charset=utf-8" "/a.css:text/css; charset=utf-8" \
  "/script.js:text/javascript; charset=utf-8" "/data.json:application/json" "/robots.txt:text/plain; charset=utf-8" "/logo.svg:image/svg+xml" \
  "/img.png:image/png" "/font.woff2:font/woff2"; do
  path=${pair%%:*}
  type=${pair#*:}
  check "$path: 200" 200 "$(status_of GET "$path")"
  check "$path: $type" "$type" "$(header_of GET "$path" content-type)"
  check "$path: nosniff" nosniff "$(header_of GET "$path" x-content-type-options)"
done
check "HEAD /: 200" 200 "$(status_of HEAD /)"
csp=$(header_of GET / content-security-policy)
check_has "page CSP: SDK and Cap from the API" "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://api.example.test" "$csp"
check_has "page CSP: requests to the API" "connect-src 'self' https://api.example.test" "$csp"
check_has "page CSP: never framed by another origin" "frame-ancestors 'self'" "$csp"
for directive in "object-src 'none'" "base-uri 'self'" "form-action 'self'" "worker-src blob:"; do check_has "page CSP: $directive" "$directive" "$csp"; done
check_has "SVG CSP: sandboxed" "sandbox; default-src 'none'" "$(header_of GET /logo.svg content-security-policy)"
check "HSTS" "max-age=31536000" "$(header_of GET / strict-transport-security)"

check ".php in a version: not served" 404 "$(status_of GET /notes.php)"
check "dot file: not served" 404 "$(status_of GET /.hidden.html)"
check "directory without index: no listing" 404 "$(status_of GET /emptydir/)"
check "folder with only index.txt: 404, never text/html" 404 "$(status_of GET /txtonly/)"
check "missing file: 404" 404 "$(status_of GET /nope.html)"
check "dot-dot: not served" 404 "$(status_of GET /../../../etc/passwd)"
check "encoded dot-dot: not served" 404 "$(status_of GET '/%2e%2e/%2e%2e/versions/lp1/1/index.html')"
check "POST: not served" 404 "$(status_of POST /)"
check "/internal: blocked" 404 "$(status_of GET /internal/x)"
check "folder without slash: redirected" 308 "$(status_of GET /sub)"
check "unlinked host: 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: other.example.test' "http://127.0.0.1:$PORT/" || true)"
check "upper-case host: 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: SHOP.example.test' "http://127.0.0.1:$PORT/" || true)"
check_has "current follows the symlink to version 1" "<body>v1</body>" "$(body_of /)"

# Atomic swap: rename a new symlink over `current` 100 times while 300 requests run; none may fail.
docker exec -d "$NAME" sh -c "i=0; while [ \$i -lt 100 ]; do v=\$((i % 2 + 1)); ln -s ../../versions/lp1/\$v /srv/lp/hosts/$HOST/current.tmp && mv -T /srv/lp/hosts/$HOST/current.tmp /srv/lp/hosts/$HOST/current; i=\$((i + 1)); done; touch /tmp/swapped"
failures=0
for _ in $(seq 1 300); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $HOST" "http://127.0.0.1:$PORT/" || true)
  [[ $code == 200 ]] || failures=$((failures + 1))
done
for _ in $(seq 1 40); do docker exec "$NAME" test -e /tmp/swapped && break; sleep 0.25; done
check "no failed request during 100 atomic swaps" 0 "$failures"
docker exec "$NAME" sh -c "ln -s ../../versions/lp1/2 /srv/lp/hosts/$HOST/current.tmp && mv -T /srv/lp/hosts/$HOST/current.tmp /srv/lp/hosts/$HOST/current"
check_has "after the swap the host serves version 2" "<body>v2</body>" "$(body_of /)"

((fail == 0)) && printf 'lp-headers: all checks passed\n'
exit "$fail"
