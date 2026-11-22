#!/usr/bin/env bash
# Checks that Uptime Kuma runs every monitor of kuma/monitors.json and what state each is in (US-015). Read-only: it only GETs Kuma's
# Prometheus endpoint /metrics, which Kuma protects with an API key (Settings, API Keys; the key is the password of HTTP basic auth).
#
#   KUMA_API_KEY=<key> infra/monitoring/kuma-check.sh [--kuma http://127.0.0.1:3001] [--expect-down "ebt vm ping,ebt vm https port"] [--name-map '<SESSION>=pool-1']
#
# A monitor name in monitors.json may hold a placeholder (<SESSION>): pass --name-map '<SESSION>=pool-1' (repeatable) so the name matches the
# monitor you created. Prints one line per monitor: UP, DOWN, PENDING, MAINTENANCE or MISSING. Exit 1 when a monitor is MISSING, or when its
# state differs from what is expected (UP, or DOWN for the names in --expect-down: the alert drills use it).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
kuma=http://127.0.0.1:3001
expect_down=""
maps=()
while (($#)); do
  case $1 in
    --kuma) kuma=${2:?}; shift ;;
    --expect-down) expect_down=${2:?}; shift ;;
    --name-map) maps+=("${2:?}"); shift ;;
    *) printf 'unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
[[ $kuma =~ ^https?://[A-Za-z0-9.:_-]+(/[A-Za-z0-9._/-]*)?$ ]] || {
  printf -- '--kuma must be an http(s) URL (letters, digits and . : _ - / only)\n' >&2
  exit 2
}
: "${KUMA_API_KEY:?set KUMA_API_KEY (Kuma: Settings, API Keys)}"
[[ $KUMA_API_KEY =~ ^[A-Za-z0-9_.-]+$ ]] || {
  printf 'KUMA_API_KEY holds characters an API key does not have\n' >&2
  exit 2
}
# The key goes to curl on stdin (-K-), never on its command line, where every user of the box could read it in the process list.
metrics=$(printf 'user = ":%s"\nurl = "%s/metrics"\n' "$KUMA_API_KEY" "$kuma" | curl -fsS -m 15 -K-) || {
  printf 'cannot read %s/metrics (wrong URL, or the API key is wrong or disabled)\n' "$kuma" >&2
  exit 1
}
fail=0
# The names, from the "monitorName" lines of monitors.json (plain text: no JSON tool needed on the box).
while IFS= read -r name; do
  for map in "${maps[@]}"; do name=${name//"${map%%=*}"/${map#*=}}; done
  line=$(grep -F "monitor_name=\"$name\"" <<<"$metrics" | grep '^monitor_status' | head -n1 || true)
  if [[ -z $line ]]; then
    printf 'MISSING  %s\n' "$name"
    fail=1
    continue
  fi
  value=${line##* }
  case $value in
    1) state=UP ;;
    0) state=DOWN ;;
    2) state=PENDING ;;
    3) state=MAINTENANCE ;;
    *) state="UNKNOWN($value)" ;;
  esac
  want=UP
  if [[ ,$expect_down, == *",$name,"* ]]; then want=DOWN; fi
  if [[ $state == "$want" ]]; then printf '%-12s %s\n' "$state" "$name"; else
    printf '%-12s %s (expected %s)\n' "$state" "$name" "$want"
    fail=1
  fi
done < <(sed -n 's/^ *"monitorName": "\(.*\)",$/\1/p' "$HERE/kuma/monitors.json")
exit "$fail"
