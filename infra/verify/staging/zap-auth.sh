#!/usr/bin/env bash
# Authenticated ZAP scans (US-031, plan M11.1), STAGING ONLY: the console as the staging test Owner and the trivia as the
# staging test player, with the ZAP 2.17.0 Automation Framework plans in infra/verify/staging/zap/. Fails on any High
# alert and on any alert of a rule marked FAIL in zap/rules.tsv (infra/verify/src/zap-report.ts).
#
#   infra/verify/staging/zap-auth.sh [admin|play|all] [--active] [--out DIR]          (default: all)
#
# Environment (secrets come from the operator's environment only: never in a file, a command line or the repository):
#   ZAP_DOMAIN               the staging base domain (admin. and play. are scanned)
#   ZAP_ADMIN_EMAIL          admin: the staging test Owner's e-mail
#   ZAP_ADMIN_PASSWORD       admin: its password
#   ZAP_ADMIN_TOTP_SECRET    admin: its TOTP secret (base32, the text key shown at enrolment)
#   ZAP_PLAY_SESSION_COOKIE  play: the value of __Host-play_session after logging in with the staging test phone's OTP
#
# Passive by default (spider + passive rules; the spiders never post a form, so the console and the trivia are only
# read). --active adds ZAP's active scan of what the spider found (GET pages and their parameters; 30 min at most per
# target): staging only, never production. After the play scan the player's sessions are signed out everywhere.
# A scan fails when it did not stay signed in: each plan exports the URLs it reached, and one must be a signed-in-only
# page (infra/verify/src/zap-signed-in-cli.ts); the play session must still be signed in after the scan.
# docs/runbooks/security-scans.md has the preparation (the runner's address in ADMIN_ALLOWED_CIDRS, the test accounts)
# and how to read the reports.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$REPO/infra/verify/local/lib.sh"
ZAP_IMAGE=ghcr.io/zaproxy/zaproxy:2.17.0@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af

targets=(admin play)
active=0
out=""
while (($#)); do
  case $1 in
    admin | play) targets=("$1") ;;
    all) targets=(admin play) ;;
    --active) active=1 ;;
    --out)
      out=${2:?--out needs a directory}
      shift
      ;;
    *)
      printf 'usage: %s [admin|play|all] [--active] [--out DIR]\n' "$0" >&2
      exit 2
      ;;
  esac
  shift
done
: "${ZAP_DOMAIN:?set ZAP_DOMAIN to the staging domain}"
# The context regexes need the domain with its dots escaped.
ZAP_DOMAIN_REGEX=${ZAP_DOMAIN//./\\.}
export ZAP_DOMAIN ZAP_DOMAIN_REGEX
out=${out:-$(mktemp -d "${TMPDIR:-/tmp}/ebt-zap-auth.XXXXXX")}
mkdir -p "$out"
# Only the operator reads the reports (security review M1): ZAP runs as the operator's own user, so 0700 is enough.
chmod 0700 "$out"
cp "$HERE/zap/rules.tsv" "$out/rules.tsv"
secret=$(mktemp -d)
chmod 0700 "$secret"
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() { rm -rf "$secret"; }
trap cleanup EXIT

# plan TARGET CONTEXT USER: the plan in the report directory, with the active scan job when --active.
plan() {
  local target=$1 context=$2 user=$3
  local job=""
  if ((active)); then
    job="  - type: activeScan\n    parameters:\n      context: $context\n${user:+      user: $user\n}      maxScanDurationInMins: 30\n      maxRuleDurationInMins: 5"
  fi
  awk -v job="$job" '/^  # ACTIVE_SCAN/ { if (job != "") { gsub(/\\n/, "\n", job); print job } next } { print }' "$HERE/zap/$target-auth.yaml" >"$out/$target-auth.yaml"
}

status=0
run_plan() { # TARGET ENV_NAME...: the plan, with only these variables passed into the container (by name, not value)
  local target=$1 code=0
  shift
  local env=(-e ZAP_DOMAIN -e ZAP_DOMAIN_REGEX)
  for name in "$@"; do env+=(-e "$name"); done
  printf '### %s (authenticated%s)\n' "$target" "$( ((active)) && printf ', active' || true)"
  # As the operator's user (the reports are theirs, under the 0700 directory). ZAP's home, with its session database
  # (the signed-in traffic), is /tmp inside the container and goes with it (--rm).
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp "${env[@]}" -v "$(host_path "$out"):/zap/wrk:rw" "$ZAP_IMAGE" \
    zap.sh -cmd -autorun "/zap/wrk/$target-auth.yaml" || code=$?
  if ((code != 0)) || [[ ! -s $out/$target-auth.json ]]; then
    printf 'ZAP did not finish the %s plan (exit %s)\n' "$target" "$code" >&2
    status=1
  fi
  # A scan that never signed in crawled the login page only, and its clean report proves nothing (security review M2).
  if [[ ! -s $out/$target-urls.txt ]]; then
    printf '%s: ZAP exported no URL list: cannot tell whether the scan was signed in\n' "$target" >&2
    status=1
  else
    node "$(host_path "$REPO")/infra/verify/src/zap-signed-in-cli.ts" "$target" "$ZAP_DOMAIN" "$(host_path "$out")/$target-urls.txt" || status=1
  fi
}

for target in "${targets[@]}"; do
  case $target in
    admin)
      : "${ZAP_ADMIN_EMAIL:?admin: set ZAP_ADMIN_EMAIL}" "${ZAP_ADMIN_PASSWORD:?admin: set ZAP_ADMIN_PASSWORD}" "${ZAP_ADMIN_TOTP_SECRET:?admin: set ZAP_ADMIN_TOTP_SECRET}"
      export ZAP_ADMIN_EMAIL ZAP_ADMIN_PASSWORD ZAP_ADMIN_TOTP_SECRET
      plan admin admin owner
      run_plan admin ZAP_ADMIN_EMAIL ZAP_ADMIN_PASSWORD ZAP_ADMIN_TOTP_SECRET
      ;;
    play)
      : "${ZAP_PLAY_SESSION_COOKIE:?play: set ZAP_PLAY_SESSION_COOKIE (the __Host-play_session value of the staging test player)}"
      export ZAP_PLAY_SESSION_COOKIE
      # The cookie reaches curl through a 0600 header file, never its command line.
      printf 'Cookie: __Host-play_session=%s\n' "$ZAP_PLAY_SESSION_COOKIE" >"$secret/cookie"
      chmod 0600 "$secret/cookie"
      session=$(curl -s -m 15 -H "@$secret/cookie" "https://play.$ZAP_DOMAIN/api/v1/play/auth/session" || true)
      [[ $session == *'"authenticated":true'* ]] || {
        printf 'play: the session cookie is not signed in (log in again with the test phone, then rerun)\n' >&2
        exit 1
      }
      plan play play ""
      run_plan play ZAP_PLAY_SESSION_COOKIE
      after=$(curl -s -m 15 -H "@$secret/cookie" "https://play.$ZAP_DOMAIN/api/v1/play/auth/session" || true)
      [[ $after == *'"authenticated":true'* ]] || {
        printf 'play: FAIL the session ended during the scan: the report does not cover the signed-in pages (rerun with a fresh login)\n' >&2
        status=1
      }
      # Sign the test player out everywhere: the cookie handed to ZAP is dead after the scan.
      curl -s -o /dev/null -m 15 -X POST -H "@$secret/cookie" -H "Origin: https://play.$ZAP_DOMAIN" -H 'Content-Type: application/json' \
        --data '{}' "https://play.$ZAP_DOMAIN/api/v1/play/auth/logout-all" || printf 'play: sign the test player out everywhere by hand\n' >&2
      ;;
  esac
done

reports=()
for target in "${targets[@]}"; do [[ -s $out/$target-auth.json ]] && reports+=("$(host_path "$out")/$target-auth.json"); done
((${#reports[@]} > 0)) || { printf 'no report to judge\n' >&2; exit 1; }
node "$(host_path "$REPO")/infra/verify/src/zap-report-cli.ts" "$(host_path "$out")/rules.tsv" "${reports[@]}" || status=1
printf 'reports: %s (the plans in it hold no secret: ZAP read them from the environment)\n' "$out"
exit "$status"
