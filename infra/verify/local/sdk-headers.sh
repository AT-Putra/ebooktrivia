#!/usr/bin/env bash
# Runs the real Caddy 2.11.9 on the `handle_path /sdk/*` block of infra/caddy/Caddyfile (the SDK
# route of api.<DOMAIN>, US-019) and checks what a landing page's browser gets: the cache headers of
# an immutable versioned file (one year, immutable), of the alias (5 minutes) and of everything
# else (nothing long-lived), that a 404 is never cached as immutable, that hidden files and path
# tricks are refused, and that the SDK is compressed. The block is cut out of the Caddyfile, so
# this tests the file that ships, not a copy.
#
#   infra/verify/local/sdk-headers.sh        (needs Docker and curl; no network beyond localhost)
#
# Test values only. Not part of `pnpm test` (it needs Docker); the adapted-JSON assertions of
# infra/verify/src/caddyfile.test.ts cover the same route structurally.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$HERE/lib.sh"
IMAGE=docker.io/library/caddy:2.11.9@sha256:e40b94d0a43b5ff69cb20568d73f10c70703df7b0ffc2298eb3d723cdc9d0bd1
NAME=ebt-sdk-headers
PORT=${SDK_HEADERS_PORT:-18089}
work=$(mktemp -d)
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# The route block: from its first line to the first line that is exactly one tab and a "}".
awk '/^\thandle_path \/sdk\/\* \{$/ { on = 1 } on { print } on && /^\t\}$/ { exit }' "$REPO/infra/caddy/Caddyfile" >"$work/route.txt"
[[ $(wc -l <"$work/route.txt") -gt 5 ]] || { printf 'could not find the /sdk/* route in infra/caddy/Caddyfile\n' >&2; exit 1; }
{
  printf '{\n\tadmin off\n\tauto_https off\n}\n:80 {\n'
  cat "$work/route.txt"
  # Every other path of api.<DOMAIN> is another route there (the public app); here it is a 404.
  printf '\thandle {\n\t\trespond 404\n\t}\n}\n'
} >"$work/Caddyfile"

mkdir "$work/sdk"
# Over Caddy's 512 byte minimum for compression.
js=$(printf 'console.log("sdk test file %s");' "$(printf 'a%.0s' $(seq 1 700))")
for f in sdk-v1.2.3.js cap-v0.1.62.js v1.js v2.js; do printf '%s\n' "$js" >"$work/sdk/$f"; done
# The Cap widget's WebAssembly solvers: a wasm header (magic and version).
for f in cap-wasm-v0.0.8.wasm cap-hashwx-v0.0.8.wasm; do printf '\000asm\001\000\000\000' >"$work/sdk/$f"; done
printf 'plain notes\n' >"$work/sdk/notes.txt"
printf '%s\n' "$js" >"$work/sdk/.hidden.js"
printf '%s\n' "$js" >"$work/sdk/sdk-v1.2.js"
mkdir "$work/sdk/dir"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:80" \
  -v "$(host_path "$work")/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$(host_path "$work")/sdk:/srv/sdk:ro" \
  "$IMAGE" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
for _ in $(seq 1 40); do
  [[ $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/sdk/v1.js" || true) == 200 ]] && break
  sleep 0.5
done

fail=0
pass() { printf 'PASS  %s\n' "$1"; }
bad() {
  printf 'FAIL  %s\n' "$1"
  fail=1
}
# head METHOD PATH [curl args...]: status line and headers, lower-cased, CR removed.
head_of() {
  local method=$1 path=$2 verb=(-X "$1")
  shift 2
  # curl -X HEAD would wait for a body that never comes; -I sends a HEAD properly.
  [[ $method == HEAD ]] && verb=(-I)
  { curl -s -o /dev/null -D - "${verb[@]}" --path-as-is "$@" "http://127.0.0.1:$PORT$path" || true; } | tr -d '\r' | tr '[:upper:]' '[:lower:]'
}
status_of() { head_of "$@" | head -n1 | cut -d' ' -f2; }
header_of() { head_of "$1" "$2" "${@:4}" | grep -i "^$3:" | head -n1 | cut -d' ' -f2- || true; }
check() { # check DESCRIPTION EXPECTED ACTUAL
  if [[ $3 == "$2" ]]; then pass "$1"; else bad "$1: expected [$2], got [$3]"; fi
}
check_not() {
  if [[ $3 != *"$2"* ]]; then pass "$1"; else bad "$1: [$3] must not contain [$2]"; fi
}

for f in sdk-v1.2.3.js cap-v0.1.62.js; do
  check "$f: 200" 200 "$(status_of GET "/sdk/$f")"
  check "$f: immutable for a year" "public, max-age=31536000, immutable" "$(header_of GET "/sdk/$f" cache-control)"
  check "$f: JavaScript" "text/javascript; charset=utf-8" "$(header_of GET "/sdk/$f" content-type)"
done
for f in cap-wasm-v0.0.8.wasm cap-hashwx-v0.0.8.wasm; do
  check "$f: 200" 200 "$(status_of GET "/sdk/$f")"
  check "$f: immutable for a year" "public, max-age=31536000, immutable" "$(header_of GET "/sdk/$f" cache-control)"
  check "$f: served as WebAssembly" "application/wasm" "$(header_of GET "/sdk/$f" content-type)"
done
check "missing wasm version: 404" 404 "$(status_of GET /sdk/cap-wasm-v9.9.9.wasm)"
check_not "missing wasm version: not cached as immutable" immutable "$(header_of GET /sdk/cap-wasm-v9.9.9.wasm cache-control)"
# A landing page on another origin reads these files: fetch() of the wasm needs CORS, a COEP page needs CORP.
for f in sdk-v1.2.3.js cap-v0.1.62.js cap-wasm-v0.0.8.wasm v1.js; do
  check "$f: readable from any origin (CORS)" "*" "$(header_of GET "/sdk/$f" access-control-allow-origin -H 'Origin: https://lp.example.test')"
  check "$f: embeddable cross-origin (CORP)" "cross-origin" "$(header_of GET "/sdk/$f" cross-origin-resource-policy)"
done
check "alias v1.js: 200" 200 "$(status_of GET /sdk/v1.js)"
check "alias v1.js: 5 minutes" "public, max-age=300" "$(header_of GET /sdk/v1.js cache-control)"
check "HEAD of the alias: 5 minutes" "public, max-age=300" "$(header_of HEAD /sdk/v1.js cache-control)"
check "gzip: sent when asked for" gzip "$(header_of GET /sdk/sdk-v1.2.3.js content-encoding -H 'Accept-Encoding: gzip')"
check "gzip: varies on Accept-Encoding" accept-encoding "$(header_of GET /sdk/sdk-v1.2.3.js vary -H 'Accept-Encoding: gzip')"

# Anything that is not a deployed, exactly named file gets no long-lived caching.
check "missing version: 404" 404 "$(status_of GET /sdk/sdk-v9.9.9.js)"
check_not "missing version: not cached as immutable" immutable "$(header_of GET /sdk/sdk-v9.9.9.js cache-control)"
check "missing alias: 404" 404 "$(status_of GET /sdk/v3.js)"
check_not "missing alias: no max-age" max-age "$(header_of GET /sdk/v3.js cache-control)"
check_not "other alias v2.js: not given the 5 minute cache" "max-age=300" "$(header_of GET /sdk/v2.js cache-control)"
check_not "a file that is not a version: not immutable" immutable "$(header_of GET /sdk/sdk-v1.2.js cache-control)"
check_not "notes.txt: not immutable" immutable "$(header_of GET /sdk/notes.txt cache-control)"

# Refusals.
check "hidden file: 404" 404 "$(status_of GET /sdk/.hidden.js)"
check "directory: no listing" 404 "$(status_of GET /sdk/dir/)"
check "root of /sdk/: no listing" 404 "$(status_of GET /sdk/)"
check "dot-dot: not served" 404 "$(status_of GET /sdk/../Caddyfile)"
check "encoded dot-dot: not served" 404 "$(status_of GET '/sdk/%2e%2e/Caddyfile')"
check "POST: not served" 405 "$(status_of POST /sdk/v1.js)"

((fail == 0)) && printf 'sdk-headers: all checks passed\n'
exit "$fail"
