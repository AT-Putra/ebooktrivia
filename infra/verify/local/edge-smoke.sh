#!/usr/bin/env bash
# Smoke test of the production server entry (apps/<app>/src/server.ts: Next.js behind the edge
# listener) on a `next build` output, run the way the image runs it (NODE_ENV=production, explicit
# EDGE_HOST and TRUSTED_PROXY_IP). Checks /livez (200), / (200, HTML), the listener address, then
# the drain on SIGTERM: "draining" in the log, /livez 503 during the drain window, "drained", exit
# 0. (The client-address rewrite is not visible from outside the real app: packages/edge's tests
# and infra/verify/local/stack-sim.sh's client-ip probe check it.) Linux only (signals); used by CI
# (job edge-smoke).
#
#   infra/verify/local/edge-smoke.sh [public|admin]      (default: public; run after its build)
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
app=${1:-public}
port=${EDGE_SMOKE_PORT:-3990}
[[ -f $REPO/apps/$app/.next/required-server-files.json ]] || {
  printf 'apps/%s has no build: run pnpm --filter @ebooktrivia/%s build first\n' "$app" "$app" >&2
  exit 1
}
log=$(mktemp)
# The trusted proxy is an address that never connects here: every request below is "anyone else".
(cd "$REPO/apps/$app" && NODE_ENV=production EDGE_HOST=127.0.0.1 EDGE_PORT=$port TRUSTED_PROXY_IP=192.0.2.1 \
  EDGE_DRAIN_MS=3000 exec node src/server.ts >"$log" 2>&1) &
pid=$!
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$log"
}
trap cleanup EXIT
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$port/livez" && break
  kill -0 "$pid" 2>/dev/null || {
    cat "$log"
    exit 1
  }
  sleep 0.5
done
fail=0
check() {
  if [[ $3 == "$2" ]]; then printf 'PASS  %s: %s\n' "$1" "$3"; else
    printf 'FAIL  %s: want %s, got %s\n' "$1" "$2" "$3"
    fail=1
  fi
}
yes_no() { if "$@"; then printf yes; else printf no; fi; }
check "/livez" 200 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/livez")"
check "/ (Next.js page)" 200 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")"
check "/ is HTML" yes "$(yes_no bash -c "curl -s http://127.0.0.1:$port/ | grep -qi '<html'")"
check "listener on EDGE_HOST" yes "$(yes_no grep -q '"msg":"listening on 127.0.0.1' "$log")"

# Drain: SIGTERM, then /livez must turn 503 while the server still answers, then the process exits 0.
kill -TERM "$pid"
livez=none
for _ in $(seq 1 20); do
  livez=$(curl -s -o /dev/null -m 1 -w '%{http_code}' "http://127.0.0.1:$port/livez" || true)
  [[ $livez == 503 ]] && break
  sleep 0.1
done
check "/livez during the drain" 503 "$livez"
status=0
wait "$pid" || status=$?
check "exit status after SIGTERM" 0 "$status"
check "log: draining" yes "$(yes_no grep -q 'SIGTERM: draining' "$log")"
check "log: drained" yes "$(yes_no grep -q '"msg":"drained"' "$log")"
exit "$fail"
