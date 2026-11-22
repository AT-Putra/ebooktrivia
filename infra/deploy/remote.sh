#!/usr/bin/env bash
# The forced command of the CI deploy login (US-015, plan M4.4). Installed by infra/provision/provision.sh as
# /usr/local/sbin/ebt-remote-deploy (root-owned, so a stolen CI key can run what is installed and nothing else) and
# started by sshd through the key's `command=` as `sudo -n /usr/local/sbin/ebt-remote-deploy "$SSH_ORIGINAL_COMMAND"`;
# sudoers allows exactly the three invocations below.
#
#   ebt-remote-deploy deploy     the manifest on stdin: pull, pg_dump, migrate, rolling restart, health check, rollback
#   ebt-remote-deploy rollback   back to the previous manifest's images (they are still on the host); no migration
#   ebt-remote-deploy status     the current and the previous manifest (digests only) and the unit states
#
# THE MANIFEST (stdin, KEY=value lines, at most 8 KiB, nothing else is accepted):
#   version=1, git_sha=<40 hex>, one line per component (public, admin, admin-cli, worker, postgres-walg) holding
#   <registry prefix>/<component>@sha256:<64 hex>, and optionally registry_user / registry_token (pull credentials,
#   never saved) and force_fail=<step> (the failure drill: only when /etc/ebooktrivia/deploy.allow-failure-drill
#   exists, which only staging has). The registry prefix is DEPLOY_REGISTRY_PREFIX of /etc/ebooktrivia/deploy.env, so an
#   image from anywhere else, or by a tag instead of a digest, is refused before anything is pulled.
#
# THE ORDER (every step a failure of which, after the first change, rolls the images back):
#   1 verify the manifest; 2 pull the images by digest; 3 pg_dump -Fc (checked, timestamped, retained); 4 retag the
#   images as the names the quadlets run (localhost/ebooktrivia/<c>:current, Pull=never); 5 run the one-shot migrate
#   (expand phase only, below); 6 restart: WORKER FIRST (it loads the Valkey function library public calls; until it
#   runs a public instance answers 503 on its rate-limited routes), then internal, public@a (wait for /livez, let
#   Caddy see it), public@b, admin; 7 health: /livez of every unit (podman healthcheck), the worker's heartbeat, the
#   deep /healthz of public and admin on their internal addresses, and Caddy answering on this host.
# On ANY failure after step 4 the previous images are tagged back and the units restarted in the same order.
#
# EXPAND / CONTRACT: the schema is never rolled back. A migration of a release may only ADD (tables, nullable or
# defaulted columns, indexes, constraints that hold for existing rows); what it removes or renames is a LATER release's
# migration, once no deployed release uses it (docs/runbooks/deploy.md; CI enforces it:
# infra/verify/src/expand-only.ts and infra/verify/local/migration-compat.sh). That is why a failed deploy rolls the
# images back and not the schema: the previous release runs on the new, expanded schema. A migration that failed half
# way changed nothing (every migration file is one transaction).
#
# A DROPPED SSH CONNECTION must not leave the stack half rolled (US-015 review). `deploy` and `rollback` therefore run in
# their own transient systemd unit (`systemd-run --wait --pipe --collect --unit=ebt-deploy-<id>`): the connection, sudo and
# the session can die, the unit goes on to its end (a success, or its own rollback), and `status` shows it. Inside the unit
# SIGHUP and SIGPIPE are ignored and every log write tolerates a closed pipe; SIGTERM (an operator stopping the unit, a
# shutdown) once the images were changed rolls the images back before the script exits (on_exit), and so does any other
# unexpected end after that point. Exit codes: 0 ok, 10 failed and rolled back, 2 the rollback failed too, 1 refused.
#
# Idempotent: the same manifest again pulls nothing, dumps again, runs the (re-runnable) migrations and restarts
# in order. Logs go to stdout (the CI job) and to the journal (`journalctl -t ebt-deploy`). Previous and current
# manifests, and the last run's result, are kept in /var/lib/ebooktrivia/deploy.
set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C

ETC=/etc/ebooktrivia
STATE=/var/lib/ebooktrivia/deploy
DUMPS=/var/backups/ebooktrivia/predeploy
LOCK=/run/ebt-deploy.lock
CONFIG=$ETC/deploy.env
DRILL_FLAG=$ETC/deploy.allow-failure-drill
MAX_MANIFEST_BYTES=8192
KEEP_DUMPS=7
MAX_DUMP_AGE_DAYS=14

# Component -> the name the quadlets run (infra/verify/src/deploy.test.ts keeps this table equal to the quadlets).
declare -A TAG=(
  [public]=localhost/ebooktrivia/public:current
  [admin]=localhost/ebooktrivia/admin:current
  [admin-cli]=localhost/ebooktrivia/admin-cli:current
  [worker]=localhost/ebooktrivia/worker:current
  [postgres-walg]=localhost/ebooktrivia/postgres-walg:18.6
)
COMPONENTS=(public admin admin-cli worker postgres-walg)
# Rolling restart order (roll): worker, internal (the worker image too), public@a, public@b, admin. Only the units of a
# component whose image changed are restarted; migrate runs the worker image.
FAILURE_STEPS="after_migrate after_worker after_internal after_public_a health"

# A write to a closed pipe (the SSH connection died) must neither kill the script nor fail a step: the journal has the line.
log() {
  printf '%s\n' "$*" 2>/dev/null || true
  logger -t ebt-deploy -- "$*" 2>/dev/null || true
}
die() {
  log "ERROR $*"
  exit 1
}

# ----------------------------------------------------------------------------------------------------------------
# Configuration (parsed, never sourced) and the app user's environment.
APP=ebt
REGISTRY_PREFIX=""
load_config() {
  [[ -f $CONFIG && $(stat -c '%U %a' "$CONFIG") == "root 600" ]] || die "$CONFIG missing, or not owned by root with mode 0600"
  local line key value
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    [[ $line =~ ^([A-Z_]+)=(.*)$ ]] || die "$CONFIG: unparsable line"
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    case $key in
      REGISTRY_PREFIX) REGISTRY_PREFIX=$value ;;
      APP_USER) APP=$value ;;
      *) die "$CONFIG: unknown key $key" ;;
    esac
  done <"$CONFIG"
  local prefix_re='^ghcr\.io/[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)+$'
  [[ $REGISTRY_PREFIX =~ $prefix_re ]] || die "$CONFIG: REGISTRY_PREFIX must be ghcr.io/<owner>/<name>"
  [[ $APP =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "$CONFIG: APP_USER is not a user name"
  id -u "$APP" >/dev/null 2>&1 || die "app user $APP does not exist"
}

app_uid() { id -u "$APP"; }
app_home() { getent passwd "$APP" | cut -d: -f6; }
# as_app CMD...: as the rootless podman user with its systemd user manager's environment (like infra/provision/lib.sh).
as_app() {
  local uid
  uid=$(app_uid)
  (cd / && runuser -u "$APP" -- setsid -w env HOME="$(app_home)" XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@")
}
psql_app() { as_app podman exec -i -u postgres postgres psql -X -q -At -v ON_ERROR_STOP=1 -d ebooktrivia "$@"; }
env_value() { awk -v k="$2" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { if (v != "") print v }' "$1"; }

# ----------------------------------------------------------------------------------------------------------------
# 1. The manifest: strict, whole or nothing.
declare -A MANIFEST=()
REGISTRY_USER=""
REGISTRY_TOKEN=""
FORCE_FAIL=""

# parse_manifest: reads stdin into MANIFEST (and REGISTRY_USER / REGISTRY_TOKEN / FORCE_FAIL); dies on anything odd.
parse_manifest() {
  local raw line key value seen_keys=" " component expected
  raw=$(head -c "$((MAX_MANIFEST_BYTES + 1))"; printf x)
  raw=${raw%x}
  ((${#raw} <= MAX_MANIFEST_BYTES)) || die "manifest: more than $MAX_MANIFEST_BYTES bytes"
  [[ $raw != *$'\r'* ]] || die "manifest: carriage return in the manifest"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line ]] && continue
    [[ $line =~ ^([a-z_-]+)=([^[:space:]]+)$ ]] || die "manifest: line is not key=value without spaces"
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    [[ $seen_keys != *" $key "* ]] || die "manifest: $key twice"
    seen_keys+="$key "
    case $key in
      version) [[ $value == 1 ]] || die "manifest: version must be 1" ;;
      git_sha) [[ $value =~ ^[0-9a-f]{40}$ ]] || die "manifest: git_sha is not 40 hex digits" ;;
      # A GitHub login, or an app's (`github-actions[bot]`, `dependabot[bot]`: GITHUB_ACTOR of a scheduled or bot-started run).
      registry_user) [[ $value =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$ ]] || die "manifest: registry_user is not a user name"; REGISTRY_USER=$value; continue ;;
      registry_token) [[ $value =~ ^[A-Za-z0-9_]{20,255}$ ]] || die "manifest: registry_token has an unexpected shape"; REGISTRY_TOKEN=$value; continue ;;
      force_fail)
        [[ -e $DRILL_FLAG ]] || die "manifest: force_fail is only accepted where $DRILL_FLAG exists (staging)"
        [[ " $FAILURE_STEPS " == *" $value "* ]] || die "manifest: force_fail must be one of: $FAILURE_STEPS"
        FORCE_FAIL=$value
        continue
        ;;
      public | admin | admin-cli | worker | postgres-walg)
        expected="$REGISTRY_PREFIX/$key@sha256:"
        [[ $value == "$expected"* && ${value#"$expected"} =~ ^[0-9a-f]{64}$ ]] || die "manifest: $key must be $expected<64 hex digits>"
        ;;
      *) die "manifest: unknown key $key" ;;
    esac
    MANIFEST[$key]=$value
  done <<<"$raw"
  [[ -n ${MANIFEST[version]:-} && -n ${MANIFEST[git_sha]:-} ]] || die "manifest: version and git_sha are required"
  for component in "${COMPONENTS[@]}"; do
    [[ -n ${MANIFEST[$component]:-} ]] || die "manifest: $component is missing"
  done
  [[ -z $REGISTRY_USER$REGISTRY_TOKEN || -n $REGISTRY_USER && -n $REGISTRY_TOKEN ]] || die "manifest: registry_user and registry_token go together"
}

# manifest_text: the manifest without credentials or drill keys, in a fixed order (what is kept as current / previous).
manifest_text() {
  local component
  printf 'version=%s\ngit_sha=%s\n' "${MANIFEST[version]}" "${MANIFEST[git_sha]}"
  for component in "${COMPONENTS[@]}"; do printf '%s=%s\n' "$component" "${MANIFEST[$component]}"; done
}

# load_manifest_file FILE: a kept manifest back into MANIFEST (same checks).
load_manifest_file() {
  MANIFEST=()
  parse_manifest <"$1"
}

# ----------------------------------------------------------------------------------------------------------------
# Helpers for waiting.
wait_until() { # wait_until SECONDS DESCRIPTION CMD...
  local seconds=$1 what=$2 waited=0
  shift 2
  until "$@"; do
    ((waited < seconds)) || {
      log "timeout after ${seconds}s waiting for: $what"
      return 1
    }
    sleep 2
    waited=$((waited + 2))
  done
}

unit_active() { as_app systemctl --user is-active --quiet "$1.service"; }
container_of() { # public@a -> public-a
  printf '%s' "${1/@/-}"
}
# healthy UNIT: the container's own health command, which for the apps is a GET of /livez on the address it listens on.
healthy() {
  local c
  c=$(container_of "$1")
  as_app podman healthcheck run "$c" >/dev/null 2>&1
}

# edge_sees CONTAINER: what Caddy's own active check does (GET /livez within 1 s, two passes 2 s apart), run from the Caddy container.
edge_sees() {
  local pass
  for pass in 1 2; do
    as_app podman exec caddy wget -q -T 1 -O /dev/null "http://$1:3000/livez" >/dev/null 2>&1 || return 1
    ((pass == 2)) || sleep 2
  done
}

# A step that may be made to fail on purpose (the drill, staging only).
maybe_fail() {
  if [[ $FORCE_FAIL == "$1" ]]; then
    log "DRILL forced failure at step $1"
    return 1
  fi
  return 0
}

# ----------------------------------------------------------------------------------------------------------------
# The health checks.
HEARTBEAT_SINCE=""
db_now() { psql_app -c "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"; }
worker_beat_after() { # worker_beat_after TIMESTAMP: the worker wrote a heartbeat after it
  [[ $(psql_app -c "SELECT count(*) FROM public.heartbeats WHERE component = 'worker' AND beat_at > '$1'::timestamptz" 2>/dev/null) == 1 ]]
}
worker_beat_fresh() { # at most 3 minutes old (the same limit as /healthz)
  [[ $(psql_app -c "SELECT count(*) FROM public.heartbeats WHERE component = 'worker' AND beat_at > now() - interval '3 minutes'" 2>/dev/null) == 1 ]]
}

# http_status CONTAINER ADDRESS PORT HOST PATH: the status line's code of GET PATH, asked from inside CONTAINER (the
# images have bash and no curl; the address is the one the app listens on).
# shellcheck disable=SC2016 # the script runs in the container
http_status() {
  as_app podman exec "$1" bash -c '
    exec 3<>"/dev/tcp/$1/$2" || exit 1
    printf "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n" "$4" "$3" >&3
    read -r _ code _ <&3
    printf "%s" "$code"' deploy-probe "$2" "$3" "$4" "$5" 2>/dev/null || true
}
# shellcheck disable=SC2016 # the script runs in the container
http_body() {
  as_app podman exec "$1" bash -c '
    exec 3<>"/dev/tcp/$1/$2" || exit 1
    printf "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n" "$4" "$3" >&3
    cat <&3' deploy-probe "$2" "$3" "$4" "$5" 2>/dev/null | tr -d '\r' | sed '1,/^$/d' || true
}

# deep_health_of CONTAINER ADDRESS HOST: GET /healthz of one app: 200 and {"status":"ok"}. 404 means the image has no such
# route (a release from before it). Only a ROLLBACK to such a release accepts that, and then makes the checks the route is made of here
# (PostgreSQL, Valkey, heartbeat); a new release without the route is a failed release (it would be unmonitored).
ROLLING_BACK=0
deep_health_of() {
  local code
  code=$(http_status "$1" "$2" 3000 "$3" /healthz)
  case $code in
    200) [[ $(http_body "$1" "$2" 3000 "$3" /healthz) == *'"status":"ok"'* ]] ;;
    404)
      if ((!ROLLING_BACK)); then
        log "health: $1 answers 404 on /healthz: a new release must have the route (only a rollback to an older release may lack it)"
        return 1
      fi
      log "note: $1 has no /healthz (an older release, rolled back to): checking PostgreSQL, Valkey and the heartbeat here"
      as_app podman exec postgres pg_isready -q -h 10.89.51.2 -p 5432 -U postgres &&
        as_app podman exec valkey valkey-cli --user ops --no-auth-warning ping | grep -q PONG &&
        worker_beat_fresh
      ;;
    *) return 1 ;;
  esac
}

DOMAIN=""
health_all() {
  local unit failed=0
  for unit in postgres valkey internal public@a public@b admin; do
    if healthy "$unit"; then log "health: $unit /livez ok"; else
      log "health: $unit is NOT healthy"
      failed=1
    fi
  done
  if worker_beat_fresh; then log "health: worker heartbeat fresh"; else
    log "health: worker heartbeat is stale or missing"
    failed=1
  fi
  if deep_health_of public-a 10.89.50.11 "api.$DOMAIN"; then log "health: public@a /healthz ok"; else
    log "health: public@a /healthz is NOT ok"
    failed=1
  fi
  if deep_health_of public-b 10.89.50.12 "api.$DOMAIN"; then log "health: public@b /healthz ok"; else
    log "health: public@b /healthz is NOT ok"
    failed=1
  fi
  if deep_health_of admin 10.89.52.13 "admin.$DOMAIN"; then log "health: admin /healthz ok"; else
    log "health: admin /healthz is NOT ok"
    failed=1
  fi
  # Caddy, from this host, through the real listener: anything but a connection failure or a 5xx is an answer.
  local edge
  edge=$(curl -sk -o /dev/null -m 10 -w '%{http_code}' --resolve "play.$DOMAIN:443:127.0.0.1" "https://play.$DOMAIN/" || true)
  if [[ $edge =~ ^[1-4][0-9][0-9]$ ]]; then log "health: Caddy answers play.$DOMAIN with $edge"; else
    log "health: Caddy did not answer play.$DOMAIN properly ($edge)"
    failed=1
  fi
  maybe_fail health || failed=1
  return "$failed"
}

# ----------------------------------------------------------------------------------------------------------------
# The roll: restarts (worker first) and waits for each unit; used by a deploy and by a rollback.
restart_unit() {
  local unit=$1
  log "restart: $unit"
  as_app systemctl --user restart "$unit.service" || return 1
}

# roll COMPONENT...: restarts the units of the changed components in the fixed order worker, internal, public@a,
# public@b, admin, waiting for each.
roll() {
  local -A restart_set=()
  local component
  for component in "$@"; do restart_set[$component]=1; done
  if [[ -n ${restart_set[worker]:-} ]]; then
    HEARTBEAT_SINCE=$(db_now) || return 1
    restart_unit worker || return 1
    wait_until 120 "the worker's first heartbeat" worker_beat_after "$HEARTBEAT_SINCE" || return 1
    log "worker: heartbeat after restart seen (the Valkey function library is loaded at its start)"
    maybe_fail after_worker || return 1
    restart_unit internal || return 1
    wait_until 90 "internal healthy" healthy internal || return 1
    maybe_fail after_internal || return 1
  fi
  if [[ -n ${restart_set[public]:-} ]]; then
    restart_unit public@a || return 1
    wait_until 90 "public@a /livez" healthy public@a || return 1
    # Caddy's active check (2 s interval, 1 s timeout, 2 passes) must see public@a up before public@b goes down: first the Caddy container
    # itself reaches /livez within that timeout twice in a row (a freshly started app can answer slowly for a while), then a margin for the
    # checker's own interval.
    wait_until 90 "public@a reachable from Caddy" edge_sees public-a || return 1
    sleep 6
    maybe_fail after_public_a || return 1
    restart_unit public@b || return 1
    wait_until 90 "public@b /livez" healthy public@b || return 1
    wait_until 90 "public@b reachable from Caddy" edge_sees public-b || return 1
    sleep 6
  fi
  if [[ -n ${restart_set[admin]:-} ]]; then
    restart_unit admin || return 1
    wait_until 90 "admin /livez" healthy admin || return 1
  fi
  return 0
}

# ----------------------------------------------------------------------------------------------------------------
# Image handling.
image_id() { as_app podman image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }

REG_AUTH=""
cleanup() {
  if [[ -n $REG_AUTH ]]; then as_app rm -f "$REG_AUTH" || true; fi
}

# finish_run RESULT: the last run's result, which `status` shows (a CI job whose SSH connection died reads it to know how the run ended).
finish_run() {
  { printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${MANIFEST[git_sha]:-unknown}" "$1" >"$STATE/last-deploy.new" && mv "$STATE/last-deploy.new" "$STATE/last-deploy"; } 2>/dev/null || true
}

# Armed once the images were tagged: from there any unexpected end of this script (SIGTERM from an operator or a shutdown, a command outside the
# checked steps failing under errexit) rolls the images back instead of leaving the stack half rolled. Cleared whenever the deploy decides its
# own ending, in either direction. Installed by main (sourcing this file for a test installs nothing).
ROLLBACK_ARMED=0
CHANGED=()
on_exit() {
  local rc=$?
  trap '' TERM INT
  trap - EXIT
  cleanup
  if ((ROLLBACK_ARMED)) && ((rc != 0)); then
    ROLLBACK_ARMED=0
    set +e
    FORCE_FAIL=""
    ROLLING_BACK=1
    log "DEPLOY ENDED UNEXPECTEDLY (status $rc) after the images were changed: rolling the images back to the ones that ran before"
    if rollback_images && roll "${CHANGED[@]}" && health_all; then
      finish_run ROLLED_BACK
      log "DEPLOY STOPPED and ROLLED BACK to the previous images; the schema stays expanded (the previous release runs on it)"
      exit 10
    fi
    finish_run ROLLBACK_FAILED
    log "ROLLBACK FAILED: the stack needs a hand (journalctl -t ebt-deploy; docs/runbooks/deploy.md, when the rollback fails)"
    exit 2
  fi
}

pull_images() {
  local component ref host=${REGISTRY_PREFIX%%/*}
  if [[ -n $REGISTRY_TOKEN ]]; then
    REG_AUTH="/run/user/$(app_uid)/ebt-deploy-auth.$$.json"
    printf '%s' "$REGISTRY_TOKEN" | as_app podman login --authfile "$REG_AUTH" -u "$REGISTRY_USER" --password-stdin "$host" >/dev/null ||
      die "registry login failed"
  fi
  for component in "${COMPONENTS[@]}"; do
    ref=${MANIFEST[$component]}
    if as_app podman image exists "$ref"; then
      log "pull: $component already on this host"
    else
      log "pull: $component"
      if [[ -n $REG_AUTH ]]; then as_app podman pull -q --authfile "$REG_AUTH" "$ref" >/dev/null || die "pull of $component failed"; else
        as_app podman pull -q "$ref" >/dev/null || die "pull of $component failed"
      fi
    fi
    [[ -n $(image_id "$ref") ]] || die "$component is not on this host after the pull"
  done
  cleanup
  REG_AUTH=""
}

declare -A PREV_ID=()
snapshot_current_images() { # the image ids a rollback tags back (in memory: the run that changed them is the run that rolls them back)
  local component
  for component in "${COMPONENTS[@]}"; do
    PREV_ID[$component]=$(image_id "${TAG[$component]}")
  done
}

retag_to_manifest() {
  local component id
  for component in "${COMPONENTS[@]}"; do
    id=$(image_id "${MANIFEST[$component]}")
    [[ -n $id ]] || return 1
    as_app podman tag "$id" "${TAG[$component]}" || return 1
  done
}

# Components whose running image differs from the manifest's.
changed_components() {
  local component
  for component in public admin worker; do
    [[ $(image_id "${MANIFEST[$component]}") == "${PREV_ID[$component]:-}" ]] || printf '%s ' "$component"
  done
}

# ----------------------------------------------------------------------------------------------------------------
# 3. pg_dump before anything changes.
predeploy_dump() {
  local stamp file size avail
  mkdir -p "$DUMPS"
  chmod 700 "$DUMPS"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  file="$DUMPS/ebooktrivia-$stamp-${MANIFEST[git_sha]:0:8}.dump"
  size=$(psql_app -c "SELECT pg_database_size('ebooktrivia')") || die "cannot read the database size"
  avail=$(df -B1 --output=avail "$DUMPS" | tail -n1 | tr -d ' ')
  ((avail > 2 * size + 268435456)) || die "not enough free disk for a dump: $avail bytes free, the database is $size bytes"
  log "dump: pg_dump -Fc of ebooktrivia ($size bytes) to $file"
  if ! as_app podman exec postgres pg_dump -U postgres -Fc ebooktrivia >"$file.partial"; then
    rm -f "$file.partial"
    die "pg_dump failed"
  fi
  # A dump that cannot be listed is not a backup.
  if ! as_app podman exec -i postgres pg_restore -l <"$file.partial" >/dev/null; then
    rm -f "$file.partial"
    die "the dump does not read back (pg_restore -l)"
  fi
  mv "$file.partial" "$file"
  retain_dumps
  DUMP_FILE=$file
}
DUMP_FILE=""

# retain_dumps: the newest KEEP_DUMPS dumps, none older than MAX_DUMP_AGE_DAYS except the newest two.
retain_dumps() {
  local n=0 file now age
  now=$(date +%s)
  while IFS= read -r file; do
    n=$((n + 1))
    age=$(((now - $(stat -c %Y "$file")) / 86400))
    if ((n > KEEP_DUMPS)) || { ((n > 2)) && ((age > MAX_DUMP_AGE_DAYS)); }; then
      rm -f -- "$file"
      log "dump: removed $file"
    fi
  done < <(find "$DUMPS" -maxdepth 1 -name 'ebooktrivia-*.dump' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
}

# ----------------------------------------------------------------------------------------------------------------
# Rollback and the commands.
rollback_images() {
  local component failed=0 id
  log "ROLLBACK: tagging the previous images back"
  for component in "${COMPONENTS[@]}"; do
    id=${PREV_ID[$component]:-}
    [[ -n $id ]] || continue
    as_app podman tag "$id" "${TAG[$component]}" || failed=1
  done
  return "$failed"
}

# apply_release COMPONENT...: the steps after the images are tagged: migrate, the rolling restart, the health check.
# Every step is checked on its own (a list on the left of || runs without errexit).
apply_release() {
  log "migrate: starting migrate.service (expand phase only; the schema is never rolled back)"
  if ! as_app systemctl --user start migrate.service; then
    as_app journalctl --user -u migrate.service -n 30 --no-pager || true
    return 1
  fi
  maybe_fail after_migrate || return 1
  roll "$@" || return 1
  health_all || return 1
}

do_deploy() {
  parse_manifest
  load_domain
  log "deploy: git ${MANIFEST[git_sha]}"
  pull_images
  snapshot_current_images
  predeploy_dump
  read -ra CHANGED <<<"$(changed_components)"
  log "deploy: components with a new image: ${CHANGED[*]:-none (same images as now)}"
  if ((${#CHANGED[@]} == 0)) && [[ -f $STATE/current.manifest && $(manifest_text) == "$(cat "$STATE/current.manifest")" ]]; then
    log "deploy: this manifest is the current one; checking health only"
    health_all || die "unhealthy, and nothing was changed by this run"
    log "DEPLOY OK (already deployed)"
    finish_run OK
    return 0
  fi
  # From here on a failure rolls back, whichever way this script ends (on_exit).
  ROLLBACK_ARMED=1
  retag_to_manifest || {
    ROLLBACK_ARMED=0
    rollback_images || true
    die "could not tag the new images"
  }
  if [[ ${MANIFEST[postgres-walg]} != "$(grep '^postgres-walg=' "$STATE/current.manifest" 2>/dev/null | cut -d= -f2-)" ]]; then
    log "NOTE the postgres-walg image changed: it is tagged, but PostgreSQL is not restarted by a deploy (a restart is downtime); restart postgres.service in a maintenance window"
  fi
  if apply_release "${CHANGED[@]}"; then
    ROLLBACK_ARMED=0
    [[ -f $STATE/current.manifest ]] && cp -p "$STATE/current.manifest" "$STATE/previous.manifest"
    manifest_text >"$STATE/current.manifest.new"
    mv "$STATE/current.manifest.new" "$STATE/current.manifest"
    finish_run OK
    log "DEPLOY OK: ${MANIFEST[git_sha]} (previous manifest kept; pg_dump ${DUMP_FILE})"
    return 0
  fi
  ROLLBACK_ARMED=0
  log "DEPLOY FAILED: rolling the images back to the ones that ran before"
  # The drill is over: the rollback itself must not be made to fail. An older release may lack /healthz.
  FORCE_FAIL=""
  ROLLING_BACK=1
  trap '' TERM INT # a second signal does not interrupt the rollback
  if rollback_images && roll "${CHANGED[@]}" && health_all; then
    manifest_text >"$STATE/last-failed.manifest"
    finish_run ROLLED_BACK
    log "DEPLOY FAILED and ROLLED BACK to the previous images; the schema stays expanded (the previous release runs on it); dump: $DUMP_FILE"
    exit 10
  fi
  finish_run ROLLBACK_FAILED
  log "ROLLBACK FAILED: the stack needs a hand (journalctl -t ebt-deploy; docs/runbooks/deploy.md, when the rollback fails)"
  exit 2
}

do_rollback() {
  [[ -f $STATE/previous.manifest ]] || die "there is no previous manifest to go back to"
  load_domain
  load_manifest_file "$STATE/previous.manifest"
  ROLLING_BACK=1 # the previous release may be one from before /healthz
  log "rollback: to git ${MANIFEST[git_sha]} (no migration: the schema stays as it is)"
  local component
  for component in "${COMPONENTS[@]}"; do
    as_app podman image exists "${MANIFEST[$component]}" || die "the previous $component image is no longer on this host (pull it by deploying the previous manifest)"
  done
  snapshot_current_images
  retag_to_manifest || die "could not tag the previous images"
  local -a changed
  read -ra changed <<<"$(changed_components)"
  ((${#changed[@]})) || changed=(public admin worker)
  if roll "${changed[@]}" && health_all; then
    cp -p "$STATE/current.manifest" "$STATE/failed-current.manifest" 2>/dev/null || true
    manifest_text >"$STATE/current.manifest.new"
    mv "$STATE/current.manifest.new" "$STATE/current.manifest"
    rm -f "$STATE/previous.manifest"
    finish_run ROLLED_BACK
    log "ROLLBACK OK"
    return 0
  fi
  finish_run ROLLBACK_FAILED
  die "the rollback did not come up healthy"
}

do_status() {
  local f unit
  for f in current previous last-failed; do
    if [[ -f $STATE/$f.manifest ]]; then
      printf '== %s manifest\n' "$f"
      grep -v '^registry_' "$STATE/$f.manifest"
    fi
  done
  for unit in postgres valkey worker internal public@a public@b admin caddy; do
    printf '%s: %s\n' "$unit" "$(as_app systemctl --user is-active "$unit.service" 2>/dev/null || true)"
  done
  # A deploy runs in its own unit and outlives its SSH connection: whether one is still running, and how the last one ended.
  local running
  running=$(systemctl list-units 'ebt-deploy-*.service' --state=active,activating,deactivating --no-legend --plain 2>/dev/null | awk '{print $1}' | paste -sd ' ' -)
  printf 'deploy running: %s\n' "${running:-no}"
  if [[ -f $STATE/last-deploy ]]; then printf 'last deploy: %s\n' "$(cat "$STATE/last-deploy")"; fi
}

load_domain() {
  DOMAIN=$(env_value "$ETC/caddy.env" DOMAIN)
  [[ $DOMAIN =~ ^[a-z0-9.-]+$ ]] || die "DOMAIN is not set in $ETC/caddy.env"
}

# run_in_unit COMMAND: the rest of this invocation as a transient systemd unit, so that the SSH connection, sudo and the session can die without
# taking the deploy with them. --pipe hands the manifest (stdin) and the log (stdout) to the unit; --wait returns its exit status.
# KillMode=mixed: a stop signals the script alone, which rolls back before it exits (on_exit), and has TimeoutStopSec to do it.
run_in_unit() {
  local self
  self=$(readlink -f "${BASH_SOURCE[0]}")
  exec systemd-run --quiet --wait --pipe --collect --unit="ebt-deploy-$(date -u +%Y%m%dT%H%M%S)-$$" --description="ebooktrivia $1" \
    --property=KillMode=mixed --property=TimeoutStopSec=1200 --setenv=EBT_DEPLOY_UNIT=1 "$self" "$1"
}

main() {
  [[ $(id -u) -eq 0 ]] || die "must run as root (sudo)"
  (($# == 1)) || die "usage: ebt-remote-deploy deploy|rollback|status"
  case $1 in deploy | rollback | status) ;; *) die "unknown command (deploy, rollback or status)" ;; esac
  trap '' HUP PIPE
  if [[ $1 != status && ${EBT_DEPLOY_UNIT:-} != 1 ]]; then run_in_unit "$1"; fi
  trap on_exit EXIT
  trap 'log "SIGTERM: the deploy is being stopped"; exit 143' TERM INT
  load_config
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  exec 9>"$LOCK"
  flock -n 9 || die "another deploy is running"
  case $1 in
    deploy) do_deploy ;;
    rollback) do_rollback ;;
    status) do_status ;;
    *) die "unknown command (deploy, rollback or status)" ;;
  esac
}

# `source remote.sh` (the tests) defines the functions only.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
