#!/usr/bin/env bash
# Runs a load test with the OFFICIAL k6 Docker image, pinned by digest (nothing is installed on the load machine but Docker or
# Podman, and Node for the tools). Run it from a machine OTHER than the VM, against staging.
#
#   infra/load/run.sh trivia     500 players answering (trivia-500.js): needs work/sessions.json (seed.ts trivia + login.ts)
#   infra/load/run.sh orders     50 orders a minute for 10 minutes (orders-50pm.js): needs work/orders-config.json (seed.ts orders),
#                                makes the Cap token pool first (cap-pool.ts), then runs k6 right away
#   infra/load/run.sh version    prints the pinned k6 version and digest
#
# k6 exits 99 when a threshold of the script is missed (AC-Q13 for trivia; the checkout and pacing guards for orders); this script
# exits with k6's code. The JSON summary lands in work/results/<test>-summary.json (kept for the run log of infra/load/README.md);
# `orders` also writes work/results/orders-50pm-run.json with the run's start time, which verify-p8.ts takes (--run-file) so that
# only this run's orders count. work/ and work/results/ are 0700: they hold session cookies, login links and Cap tokens.
#
# Environment (see infra/load/README.md for the whole procedure):
#   trivia   VUS=500 RAMP_SECONDS=60 HOLD_SECONDS=300 THINK_MIN_MS=1000 THINK_MAX_MS=3000
#            PLAY_ORIGIN (default: from sessions.json)  BASE_URL / HOST_HEADER (local dry runs only)
#   orders   API_ORIGIN (required, https://api.<DOMAIN>)  EMAIL_DOMAIN (required)  RATE_PER_MIN=50  DURATION=10m  CAP_THREADS=<cores>
#            CAP_MAX_RPS=8  LP_ORIGIN  BASE_URL / CAP_BASE_URL / HOST_HEADER (local dry runs only)
#   both     WORK_DIR (default infra/load/work, gitignored)  CONTAINER_RUNTIME=docker|podman  K6_DOCKER_ARGS (extra `run` arguments, e.g.
#            --add-host=host.docker.internal:host-gateway for a local dry run on Linux)
set -euo pipefail

# k6 v2.3.0, released 2026-09-21: the newest release of the v2 line that is at least 14 days old (v2.4.0, 2026-11-12, was too new).
K6_VERSION="v2.3.0"
K6_IMAGE="docker.io/grafana/k6@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8"

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK_DIR=${WORK_DIR:-$HERE/work}
RUNTIME=${CONTAINER_RUNTIME:-docker}
# Git Bash on Windows rewrites /work-style arguments and wants Windows paths for mounts.
export MSYS_NO_PATHCONV=1
host_path() { (cd "$1" && pwd -W 2>/dev/null) || printf '%s' "$1"; }

die() { printf 'run.sh: %s\n' "$*" >&2; exit 2; }
need_file() { [ -f "$1" ] || die "missing $1 (README: $2)"; }

# The work directory holds login links, session cookies and Cap tokens: only its owner may enter it, and so for the results beside them.
private_dirs() {
  mkdir -p "$WORK_DIR/results"
  chmod 700 "$WORK_DIR" "$WORK_DIR/results"
}

# Prints `-e` and `NAME=value`, one per line, for every listed variable that is set (read back with `while read`, bash 3.2 has no mapfile).
env_args() {
  local name
  for name in "$@"; do
    if [ -n "${!name:-}" ]; then printf -- '-e\n%s=%s\n' "$name" "${!name}"; fi
  done
}

# Fills the global array `envs` from env_args.
collect_envs() {
  local line
  envs=()
  while IFS= read -r line; do envs+=("$line"); done < <(env_args "$@")
}

run_k6() {
  local script=$1 summary=$2
  shift 2
  private_dirs
  local extra=() # K6_DOCKER_ARGS is split on purpose: it holds extra `docker run` arguments
  if [ -n "${K6_DOCKER_ARGS:-}" ]; then read -r -a extra <<<"$K6_DOCKER_ARGS"; fi
  # The results directory is 0700 (session cookies and tokens are next to it): k6 runs as the invoking user, not as the image's own user.
  "$RUNTIME" run --rm --user "$(id -u):$(id -g)" ${extra[@]+"${extra[@]}"} \
    -v "$(host_path "$HERE/k6"):/k6:ro" -v "$(host_path "$WORK_DIR"):/work:ro" -v "$(host_path "$WORK_DIR/results"):/results" \
    "$K6_IMAGE" run --no-usage-report --summary-export "/results/$summary" "$@" "/k6/$script"
}

case "${1:-}" in
  version)
    printf 'k6 %s  %s\n' "$K6_VERSION" "$K6_IMAGE"
    ;;
  trivia)
    need_file "$WORK_DIR/sessions.json" "seed.ts trivia, then login.ts"
    collect_envs VUS RAMP_SECONDS HOLD_SECONDS THINK_MIN_MS THINK_MAX_MS PLAY_ORIGIN BASE_URL HOST_HEADER
    run_k6 trivia-500.js trivia-500-summary.json ${envs[@]+"${envs[@]}"}
    ;;
  orders)
    need_file "$WORK_DIR/orders-config.json" "seed.ts orders"
    [ -n "${API_ORIGIN:-}" ] || die "API_ORIGIN is required (https://api.<DOMAIN>)"
    [ -n "${EMAIL_DOMAIN:-}" ] || die "EMAIL_DOMAIN is required (a domain you control: the buyers' e-mail goes there)"
    command -v node >/dev/null || die "node is required for the Cap token pool"
    private_dirs
    started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    # Node on Windows needs Windows paths (Git Bash prints /c/...); on Linux host_path is the identity.
    work_host=$(host_path "$WORK_DIR")
    here_host=$(host_path "$HERE")
    RATE_PER_MIN=${RATE_PER_MIN:-50}
    DURATION=${DURATION:-10m}
    case "$DURATION" in *m) minutes=${DURATION%m} ;; *) die "DURATION must be whole minutes, like 10m" ;; esac
    # One token per planned order and 10 % more, valid about 20 minutes: the pool is made right before the run.
    count=$((RATE_PER_MIN * minutes * 11 / 10 + 5))
    lp_key=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).lp_key)' "$work_host/orders-config.json")
    lp_host=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).lp_host)' "$work_host/orders-config.json")
    printf 'run.sh: making %s Cap tokens for %s (this takes minutes: it is the real proof of work)\n' "$count" "$lp_key" >&2
    # The Cap routes are called from this machine (not from the k6 container): CAP_BASE_URL differs from BASE_URL in local dry runs only.
    node_args=(--api "${CAP_BASE_URL:-${BASE_URL:-$API_ORIGIN}}" --lp-key "$lp_key" --origin "${LP_ORIGIN:-https://$lp_host}" --count "$count" --out "$work_host/cap-pool.json" --max-rps "${CAP_MAX_RPS:-8}")
    if [ -n "${CAP_THREADS:-}" ]; then node_args+=(--threads "$CAP_THREADS"); fi
    node "$here_host/src/cap-pool.ts" "${node_args[@]}"
    RUN_SEED=${RUN_SEED:-$(node -e 'process.stdout.write(String(10_000_000 + Math.floor(Math.random() * 70_000_000)))')}
    export RUN_SEED RATE_PER_MIN DURATION
    printf 'run.sh: RUN_SEED=%s (the buyers of this run; keep it with the results)\n' "$RUN_SEED" >&2
    # The run's own orders are the ones created from here on: verify-p8.ts takes this start (--run-file), so a 5-order trial that came
    # before on the same landing page cannot count as a lost or an extra order.
    printf '{"started_at":"%s","run_seed":%s,"rate_per_min":%s,"duration":"%s"}\n' "$started_at" "$RUN_SEED" "$RATE_PER_MIN" "$DURATION" >"$work_host/results/orders-50pm-run.json"
    collect_envs API_ORIGIN EMAIL_DOMAIN RUN_SEED RATE_PER_MIN DURATION PRE_VUS MAX_VUS LP_ORIGIN BASE_URL HOST_HEADER
    run_k6 orders-50pm.js orders-50pm-summary.json ${envs[@]+"${envs[@]}"}
    ;;
  *)
    die "usage: run.sh trivia | orders | version"
    ;;
esac
