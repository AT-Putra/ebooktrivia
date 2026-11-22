#!/usr/bin/env bash
# ZAP baseline scans (US-031, plan M11.1): the packaged zap-baseline.py (spider + passive rules, no attack) of every
# public entry point. STAGING ONLY for the evidence: run it from the operator machine against the staging hosts
# (docs/runbooks/security-scans.md). It fails on any High alert and on any alert of a rule marked FAIL in
# infra/verify/staging/zap/rules.tsv (the gate: infra/verify/src/zap-report.ts); every other alert is listed for triage.
#
#   ZAP_DOMAIN=<staging domain> ZAP_LP_HOST=<an active ZIP-hosted LP domain> infra/verify/staging/zap-baseline.sh [--out DIR]
#   infra/verify/staging/zap-baseline.sh --local [--out DIR]      a dry run against infra/verify/local/security-headers.sh
#       --serve (the real Caddyfile in front of the production builds, no database), started first in another shell
#
# Targets: admin.<domain>/login (the runner's address must be in ADMIN_ALLOWED_CIDRS), play.<domain>/login,
# order.<domain>/, api.<domain>/ and /sdk/v1.js, and the LP host's page. Reports (JSON + HTML per target) go to --out
# (default: a new temporary directory, printed). Needs Docker and node; ZAP 2.17.0, the latest stable release
# (2025-12-15), pinned by digest. Nothing is installed on the host; the scan sends requests to the targets only.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$REPO/infra/verify/local/lib.sh"
ZAP_IMAGE=ghcr.io/zaproxy/zaproxy:2.17.0@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af

local_run=0
out=""
while (($#)); do
  case $1 in
    --local) local_run=1 ;;
    --out)
      out=${2:?--out needs a directory}
      shift
      ;;
    *)
      printf 'usage: %s [--local] [--out DIR]\n' "$0" >&2
      exit 2
      ;;
  esac
  shift
done
out=${out:-$(mktemp -d "${TMPDIR:-/tmp}/ebt-zap-baseline.XXXXXX")}
mkdir -p "$out"
# ZAP runs as the operator's own user (below), so only the operator can read the reports (security review M1).
chmod 0700 "$out"
cp "$HERE/zap/rules.tsv" "$out/rules.tsv"

network=()
if ((local_run)); then
  DOMAIN=example.test
  LP_HOST=lp-ok.example.test
  port=${SECURITY_HEADERS_PORT:-18480}
  scheme=http
  docker inspect ebt-security-headers >/dev/null 2>&1 || { printf 'start infra/verify/local/security-headers.sh --serve first\n' >&2; exit 1; }
  if [[ $(uname -s) == Linux ]]; then
    # Caddy shares the host network there.
    network=(--network host)
    for host in admin play order api; do network+=(--add-host "$host.$DOMAIN:127.0.0.1"); done
    network+=(--add-host "$LP_HOST:127.0.0.1")
  else
    # Docker Desktop: a network of its own, on which the Caddy container answers to every test host name. Removed on
    # any exit (code review 10); the security-headers.sh --serve container stays up for the next run.
    # shellcheck disable=SC2329 # invoked by the EXIT trap
    drop_network() {
      docker network disconnect ebt-zap-local ebt-security-headers >/dev/null 2>&1 || true
      docker network rm ebt-zap-local >/dev/null 2>&1 || true
    }
    trap drop_network EXIT
    trap 'exit 130' INT TERM
    docker network create ebt-zap-local >/dev/null 2>&1 || true
    aliases=()
    for host in admin play order api; do aliases+=(--alias "$host.$DOMAIN"); done
    docker network connect "${aliases[@]}" --alias "$LP_HOST" ebt-zap-local ebt-security-headers 2>/dev/null || true
    network=(--network ebt-zap-local)
  fi
  base() { printf '%s://%s:%s' "$scheme" "$1" "$port"; }
else
  DOMAIN=${ZAP_DOMAIN:?set ZAP_DOMAIN to the staging domain}
  LP_HOST=${ZAP_LP_HOST:?set ZAP_LP_HOST to an active ZIP-hosted landing-page domain}
  base() { printf 'https://%s' "$1"; }
fi

status=0
# scan NAME URL: one packaged baseline scan; its exit status 1 / 2 (FAIL / WARN alerts) is the gate's to judge, 3 is an error.
scan() {
  local name=$1 url=$2 code=0
  printf '### %s: %s\n' "$name" "$url"
  # ZAP's home (its session database) is /tmp inside the container, and goes with it (--rm).
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp "${network[@]}" -v "$(host_path "$out"):/zap/wrk:rw" "$ZAP_IMAGE" \
    zap-baseline.py -t "$url" -c rules.tsv -J "$name.json" -r "$name.html" -I -m 2 -T 15 || code=$?
  if ((code > 2)) || [[ ! -s $out/$name.json ]]; then
    printf 'ZAP did not finish the %s scan (exit %s)\n' "$name" "$code" >&2
    status=1
  fi
}
scan admin "$(base "admin.$DOMAIN")/login"
scan play "$(base "play.$DOMAIN")/login"
scan order "$(base "order.$DOMAIN")/"
scan api-root "$(base "api.$DOMAIN")/"
scan api "$(base "api.$DOMAIN")/sdk/v1.js"
scan lp "$(base "$LP_HOST")/"

reports=()
for name in admin play order api-root api lp; do [[ -s $out/$name.json ]] && reports+=("$(host_path "$out")/$name.json"); done
((${#reports[@]} > 0)) || { printf 'no report to judge\n' >&2; exit 1; }
node "$(host_path "$REPO")/infra/verify/src/zap-report-cli.ts" "$(host_path "$out")/rules.tsv" "${reports[@]}" || status=1
printf 'reports: %s\n' "$out"
exit "$status"
