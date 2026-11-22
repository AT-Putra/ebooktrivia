#!/usr/bin/env bash
# Local proof of the deploy (US-015, plan M4.4): infra/deploy/remote.sh in the vm-sim container, on the running stack-sim stack, with the real images and a
# throwaway registry (the Owner-approved CNCF distribution registry v3.1.2, digest-pinned, on a Docker network with NO host port, removed by `down`).
#
#   infra/verify/local/vm-sim.sh all        # provisions the sim (with the deploy login, the backup timers)
#   infra/verify/local/stack-sim.sh up      # images, the real stack
#   infra/verify/local/deploy-sim.sh [all|up|run|down]       (default: all = up + run)
#
#   up    the registry, podman's registries.conf in the sim (ghcr.io/example/... is served by it), and four releases pushed by digest:
#         rel1 (the images the stack runs), rel2 (children with a new label: a new digest per image), rel3 (the same, for the failure drill),
#         bad (a public image whose entrypoint exits at once: a natural failure)
#   run   the checks below, each printed PASS or FAIL, with timings
#   down  removes the registry and its network
#
# What `run` proves: (1) the forced command and sudo refuse everything but a digest manifest of the configured prefix and the three invocations;
# (2) a normal deploy: manifest checked, images pulled by digest, pg_dump (checked), migrate, restarts in the order worker, internal, public@a,
# public@b, admin, the running containers on the new images, health checked, and the requests that went through Caddy meanwhile all answered;
# (3) the same manifest again changes nothing; (4) a FORCED failure after public@a rolls back to the previous images automatically (exit 10);
# (5) a NATURAL failure (a public image that cannot start) rolls back too; (6) a manifest naming an image the registry does not have changes nothing.
# Test values only (example.test, throwaway digests); the registry is HTTP on a private Docker network, the production path is GHCR over TLS.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$HERE/lib.sh"
NAME=${VM_SIM_NAME:-ebt-vm-sim}
CLIENT=ebt-sim-client
REG=ebt-sim-registry
REG_NET=ebt-sim-registry-net
REG_IMAGE=docker.io/library/registry:3.1.2@sha256:82f6ff4a7f982960c8aa51617fea3aabc485df6e55cce80d22deb1de36f1bc3c
PREFIX=ghcr.io/example/ebooktrivia
LOCAL=registry.sim:5000/example/ebooktrivia
OUT=${VM_SIM_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/ebt-deploy-sim.XXXXXX")}
mkdir -p "$OUT"
COMPONENTS=(public admin admin-cli worker postgres-walg)
declare -A DIGEST=()

sim() { docker exec -e EBT_PROVISION_SIM=1 "$NAME" "$@"; }
sim_in() { docker exec -i -e EBT_PROVISION_SIM=1 "$NAME" "$@"; }
app() { sim /opt/ebooktrivia/infra/provision/as-app.sh "$@"; }
app_in() { sim_in /opt/ebooktrivia/infra/provision/as-app.sh "$@"; }

FAILURES=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() {
  FAILURES=$((FAILURES + 1))
  printf 'FAIL  %s\n' "$*"
}
expect() { if [[ $3 == "$2" ]]; then pass "$1: $3"; else fail "$1: want '$2', got '${3:-<none>}'"; fi; }
expect_match() { if [[ $3 =~ $2 ]]; then pass "$1"; else fail "$1: '${3:0:300}' does not match /$2/"; fi; }

# ---------------------------------------------------------------------------------------------------------------------
up() {
  printf '### registry fixture (Owner-approved, test only): %s\n' "$REG_IMAGE"
  docker network create "$REG_NET" >/dev/null 2>&1 || true
  docker rm -f "$REG" >/dev/null 2>&1 || true
  docker run -d --name "$REG" --network "$REG_NET" --network-alias registry.sim "$REG_IMAGE" >/dev/null
  docker network connect "$REG_NET" "$NAME" >/dev/null 2>&1 || true
  # ghcr.io/... is served by the fixture: the production names and digests are used unchanged by the deploy script.
  sim_in tee /etc/containers/registries.conf.d/99-ebt-sim.conf >/dev/null <<'EOF'
[[registry]]
prefix = "ghcr.io"
location = "registry.sim:5000"
insecure = true
EOF
  local _
  for _ in $(seq 1 30); do
    sim curl -fsS -m 3 http://registry.sim:5000/v2/ >/dev/null 2>&1 && break
    sleep 1
  done
  sim curl -fsS -m 3 http://registry.sim:5000/v2/ >/dev/null || {
    printf 'the registry fixture is not reachable from the sim\n'
    return 1
  }

  printf '\n### the running images become the "base" every release is made from\n'
  local c
  for c in public admin worker postgres-walg; do
    local tag=current
    [[ $c == postgres-walg ]] && tag=18.6
    app podman tag "localhost/ebooktrivia/$c:$tag" "localhost/ebooktrivia-sim/$c:base"
  done
  app podman tag localhost/ebooktrivia/public:current localhost/ebooktrivia-sim/admin-cli:base # the admin CLI is a one-off container: a stand-in image, never run here

  printf '\n### releases pushed by digest\n'
  for c in "${COMPONENTS[@]}"; do push rel1 "$c" ""; done
  for c in public admin worker admin-cli; do push rel2 "$c" ""; done
  push rel2 postgres-walg "" # unchanged: the database is never restarted by a deploy
  for c in public admin worker admin-cli; do push rel3 "$c" ""; done
  push rel3 postgres-walg ""
  # A natural failure: a public image whose entrypoint exits at once (the container cannot become healthy).
  push bad public 'ENTRYPOINT ["false"]'
  : >"$OUT/digests.env"
  for key in "${!DIGEST[@]}"; do printf '%s=%s\n' "$key" "${DIGEST[$key]}" >>"$OUT/digests.env"; done
}

# push REL COMPONENT [DOCKERFILE_LINES]: a child of the base image with a new label (so a new digest), or the base itself for rel1, pushed to the fixture.
push() {
  local rel=$1 c=$2 extra=${3:-}
  local ref=$LOCAL/$c:$rel
  if [[ $rel == rel1 ]]; then
    app podman tag "localhost/ebooktrivia-sim/$c:base" "$ref"
  elif [[ $rel == rel2 && $c == postgres-walg ]]; then
    app podman tag "localhost/ebooktrivia-sim/$c:base" "$ref"
  else
    # A child image by `podman commit` (rootless buildah cannot overlay a build context in this nested sim): a new label, and for the broken
    # image a new entrypoint, on top of the base: a new digest.
    local cid
    cid=$(app podman create "localhost/ebooktrivia-sim/$c:base" | tr -d '\r\n')
    if [[ -n $extra ]]; then
      app podman commit -q --change "LABEL ebt.sim.release=$rel" --change "$extra" "$cid" "$ref" >/dev/null
    else
      app podman commit -q --change "LABEL ebt.sim.release=$rel" "$cid" "$ref" >/dev/null
    fi
    app podman rm "$cid" >/dev/null
  fi
  app podman push -q --tls-verify=false --digestfile "/tmp/digest-$c-$rel" "$ref" >/dev/null
  DIGEST["$rel-$c"]=$(sim cat "/tmp/digest-$c-$rel" 2>/dev/null || app cat "/tmp/digest-$c-$rel")
  printf '%s %s %s\n' "$rel" "$c" "${DIGEST["$rel-$c"]}"
}

load_digests() {
  [[ ${#DIGEST[@]} -gt 0 ]] && return 0
  [[ -f $OUT/digests.env ]] || {
    printf 'run deploy-sim.sh up first\n'
    exit 1
  }
  while IFS='=' read -r key value; do DIGEST[$key]=$value; done <"$OUT/digests.env"
}

# manifest REL [component=REL ...]: the manifest of a release; components may come from other releases (public=bad).
manifest() {
  local rel=$1 c from
  shift
  declare -A pick=()
  for c in "${COMPONENTS[@]}"; do pick[$c]=$rel; done
  for c in "$@"; do pick[${c%%=*}]=${c#*=}; done
  printf 'version=1\ngit_sha=%s\n' "$(printf '%s' "$rel$*" | sha1sum | cut -c1-40)"
  for c in "${COMPONENTS[@]}"; do
    from=${pick[$c]}
    printf '%s=%s/%s@%s\n' "$c" "$PREFIX" "$c" "${DIGEST["$from-$c"]}"
  done
}

# remote CMD [STDIN_FILE]: the forced command as sshd runs it for the deploy login: a shell that runs `sudo -n <script> "$SSH_ORIGINAL_COMMAND"`.
# shellcheck disable=SC2016 # the script runs in the sim's shell
remote() {
  local cmd=$1 input=${2:-/dev/null}
  sim_in runuser -u ebtdeploy -- bash -c 'SSH_ORIGINAL_COMMAND=$0; sudo -n /usr/local/sbin/ebt-remote-deploy "$SSH_ORIGINAL_COMMAND"' "$cmd" <"$input"
}
image_id() { app podman image inspect --format '{{.Id}}' "$1" 2>/dev/null | tr -d '\r\n'; }
running_image() { app podman inspect --format '{{.Image}}' "$1" 2>/dev/null | tr -d '\r\n'; }
started() { app podman inspect --format '{{.State.StartedAt}}' "$1" 2>/dev/null | tr -d '\r\n'; }

# on_images REL [component=REL ...]: every long-running container runs the image of the manifest ("ok" or what differs).
on_images() {
  local rel=$1 c bad="" want have
  shift
  declare -A pick=()
  for c in public admin worker; do pick[$c]=$rel; done
  for c in "$@"; do pick[${c%%=*}]=${c#*=}; done
  for pair in "public-a public" "public-b public" "admin admin" "worker worker" "internal worker"; do
    read -r container component <<<"$pair"
    want=$(image_id "$PREFIX/$component@${DIGEST["${pick[$component]}-$component"]}")
    have=$(running_image "$container")
    [[ -n $want && $want == "$have" ]] || bad+=" $container"
  done
  printf '%s' "${bad:-ok}"
}

# A request loop through the real Caddy from the client container, for as long as the flag file exists: how many answered (200 or 307), how many did not.
start_traffic() {
  : >"$OUT/traffic.codes"
  touch "$OUT/traffic.on"
  (
    while [[ -e $OUT/traffic.on ]]; do
      docker exec "$CLIENT" curl -sk -m 8 --resolve play.example.test:443:192.0.2.10 -o /dev/null -w '%{http_code}\n' https://play.example.test/ >>"$OUT/traffic.codes" 2>/dev/null || printf '000\n' >>"$OUT/traffic.codes"
      sleep 0.2
    done
  ) &
  TRAFFIC_PID=$!
}
stop_traffic() {
  rm -f "$OUT/traffic.on"
  wait "$TRAFFIC_PID" 2>/dev/null || true
}
traffic_report() { # prints "TOTAL OK"
  printf '%s %s' "$(grep -c . "$OUT/traffic.codes" || true)" "$(grep -cE '^(200|307)$' "$OUT/traffic.codes" || true)"
}

# ---------------------------------------------------------------------------------------------------------------------
run() {
  load_digests
  sim test -x /usr/local/sbin/ebt-remote-deploy || {
    printf 'the sim has no /usr/local/sbin/ebt-remote-deploy: run vm-sim.sh all again\n'
    exit 1
  }
  app systemctl --user is-active public@a.service >/dev/null || {
    printf 'the stack is not running: run stack-sim.sh up first\n'
    exit 1
  }
  sim rm -f /etc/ebooktrivia/deploy.allow-failure-drill
  local rc log start end

  printf '\n### 1. what the forced command and sudo refuse\n'
  manifest rel1 >"$OUT/m-rel1"
  refuse() { # refuse WHAT EXPECTED_TEXT FILE
    log=$OUT/refuse.log
    rc=0
    remote deploy "$3" >"$log" 2>&1 || rc=$?
    if [[ $rc -eq 1 ]] && grep -q "$2" "$log"; then pass "refused: $1"; else fail "refused: $1 (exit $rc: $(grep -m1 ERROR "$log" || head -c 200 "$log"))"; fi
  }
  sed 's|@sha256:\([0-9a-f]\{64\}\)$|:latest|' "$OUT/m-rel1" >"$OUT/m-tag"
  refuse "a tag instead of a digest" "manifest: .* must be" "$OUT/m-tag"
  sed "s|$PREFIX|ghcr.io/other/ebooktrivia|" "$OUT/m-rel1" >"$OUT/m-other"
  refuse "another registry prefix" "manifest: .* must be" "$OUT/m-other"
  { cat "$OUT/m-rel1"; printf 'extra=1\n'; } >"$OUT/m-extra"
  refuse "an unknown key" "manifest: unknown key extra" "$OUT/m-extra"
  grep -v '^worker=' "$OUT/m-rel1" >"$OUT/m-missing"
  refuse "a missing component" "manifest: worker is missing" "$OUT/m-missing"
  { cat "$OUT/m-rel1"; printf 'git_sha=%s\n' "$(printf 'x%.0s' $(seq 1 40))"; } >"$OUT/m-twice"
  refuse "a key twice" "manifest: git_sha twice" "$OUT/m-twice"
  head -c 9000 /dev/zero | tr '\0' 'a' >"$OUT/m-big"
  refuse "a manifest over 8 KiB" "more than 8192 bytes" "$OUT/m-big"
  { cat "$OUT/m-rel1"; printf 'force_fail=health\n'; } >"$OUT/m-force"
  refuse "force_fail where the staging drill file does not exist" "only accepted where /etc/ebooktrivia/deploy.allow-failure-drill exists" "$OUT/m-force"
  rc=0
  sim_in runuser -u ebtdeploy -- sudo -n /usr/local/sbin/ebt-remote-deploy bogus </dev/null >"$OUT/sudo1.log" 2>&1 || rc=$?
  if ((rc != 0)) && grep -qiE 'not allowed|may not run|password' "$OUT/sudo1.log"; then pass "sudo refuses any other argument of the script"; else fail "sudo accepted another argument (exit $rc)"; fi
  rc=0
  sim_in runuser -u ebtdeploy -- sudo -n /bin/true </dev/null >"$OUT/sudo2.log" 2>&1 || rc=$?
  if ((rc != 0)); then pass "sudo refuses any other command"; else fail "sudo ran /bin/true for the deploy login"; fi
  rc=0
  # shellcheck disable=SC2016 # the script runs in the sim's shell
  sim_in runuser -u ebtdeploy -- bash -c 'SSH_ORIGINAL_COMMAND="deploy; id"; sudo -n /usr/local/sbin/ebt-remote-deploy "$SSH_ORIGINAL_COMMAND"' </dev/null >"$OUT/inject.log" 2>&1 || rc=$?
  if ((rc != 0)) && ! grep -q 'uid=' "$OUT/inject.log"; then pass "a client command with a shell injection runs nothing"; else fail "the injected command ran"; fi
  before=$(image_id localhost/ebooktrivia/public:current)
  manifest rel1 | sed "s|^public=.*|public=$PREFIX/public@sha256:$(printf '0%.0s' $(seq 1 64))|" >"$OUT/m-absent"
  rc=0
  remote deploy "$OUT/m-absent" >"$OUT/absent.log" 2>&1 || rc=$?
  expect "a digest the registry does not have: exit" 1 "$rc"
  expect "...and the running image is unchanged" "$before" "$(image_id localhost/ebooktrivia/public:current)"

  printf '\n### 2. first deploy of rel1 (the images already running): through the forced-command path\n'
  start=$(date +%s)
  rc=0
  remote deploy "$OUT/m-rel1" >"$OUT/deploy-rel1.log" 2>&1 || rc=$?
  end=$(date +%s)
  expect "rel1 deploy exit status" 0 "$rc"
  expect_match "rel1: DEPLOY OK" "DEPLOY OK" "$(cat "$OUT/deploy-rel1.log")"
  printf 'rel1 first deploy: %s s\n' "$((end - start))"
  expect_match "rel1: the pre-deploy dump exists and reads back" "^ebooktrivia-.*\.dump$" "$(sim ls /var/backups/ebooktrivia/predeploy | tail -n1)"

  printf '\n### 3. a normal deploy (rel2), with requests flowing through Caddy\n'
  manifest rel2 >"$OUT/m-rel2"
  start_traffic
  start=$(date +%s)
  rc=0
  remote deploy "$OUT/m-rel2" >"$OUT/deploy-rel2.log" 2>&1 || rc=$?
  end=$(date +%s)
  stop_traffic
  read -r total ok <<<"$(traffic_report)"
  expect "rel2 deploy exit status" 0 "$rc"
  expect_match "rel2: DEPLOY OK" "DEPLOY OK" "$(cat "$OUT/deploy-rel2.log")"
  printf 'rel2 deploy (pull, dump, migrate, rolling restart, health): %s s\n' "$((end - start))"
  expect "rel2: every container runs the manifest's images" ok "$(on_images rel2)"
  order=$(grep -o 'restart: [a-z@]*' "$OUT/deploy-rel2.log" | sed 's/restart: //' | paste -sd ' ' -)
  expect "rel2: restart order (worker first)" "worker internal public@a public@b admin" "$order"
  expect_match "rel2: the worker's heartbeat was awaited before public" "worker: heartbeat after restart seen" "$(cat "$OUT/deploy-rel2.log")"
  expect_match "rel2: the deep /healthz of public and admin answered" "health: public@a /healthz ok" "$(cat "$OUT/deploy-rel2.log")"
  expect "rel2: requests through Caddy during the deploy (total / answered 200 or 307: the play page redirects to the login)" "$total / $total" "$total / $ok"
  printf 'requests during the rel2 deploy: %s, answered 200 or 307: %s\n' "$total" "$ok"
  expect_match "rel2: the previous manifest was kept" "git_sha=" "$(sim cat /var/lib/ebooktrivia/deploy/previous.manifest)"
  expect "rel2: no registry token on disk" 0 "$(sim grep -rl registry_token /var/lib/ebooktrivia/deploy /etc/ebooktrivia 2>/dev/null | wc -l | tr -d ' ')"

  printf '\n### 4. the same manifest again: nothing is restarted\n'
  s1=$(started public-a)
  s2=$(started worker)
  rc=0
  remote deploy "$OUT/m-rel2" >"$OUT/deploy-rel2b.log" 2>&1 || rc=$?
  expect "rel2 again: exit status" 0 "$rc"
  expect_match "rel2 again: already deployed" "already deployed" "$(cat "$OUT/deploy-rel2b.log")"
  expect "rel2 again: public-a not restarted" "$s1" "$(started public-a)"
  expect "rel2 again: worker not restarted" "$s2" "$(started worker)"

  printf '\n### 5. a FORCED failure after public@a rolls back automatically (the staging drill)\n'
  sim touch /etc/ebooktrivia/deploy.allow-failure-drill
  { manifest rel3; printf 'force_fail=after_public_a\n'; } >"$OUT/m-rel3-fail"
  start=$(date +%s)
  rc=0
  remote deploy "$OUT/m-rel3-fail" >"$OUT/deploy-forced.log" 2>&1 || rc=$?
  end=$(date +%s)
  expect "forced failure: exit status 10 (failed and rolled back)" 10 "$rc"
  expect_match "forced failure: the drill failure was logged" "DRILL forced failure at step after_public_a" "$(cat "$OUT/deploy-forced.log")"
  expect_match "forced failure: rolled back" "ROLLED BACK to the previous images" "$(cat "$OUT/deploy-forced.log")"
  printf 'forced failure + automatic rollback: %s s\n' "$((end - start))"
  expect "forced failure: every container is back on the rel2 images" ok "$(on_images rel2)"
  expect_match "forced failure: the stack is healthy after the rollback" "health: public@b /healthz ok" "$(cat "$OUT/deploy-forced.log")"
  expect_match "forced failure: the current manifest is still rel2's" "$(sed -n 's/^git_sha=//p' "$OUT/m-rel2")" "$(sim cat /var/lib/ebooktrivia/deploy/current.manifest)"
  expect_match "forced failure: the failed manifest is kept for inspection" "$(sed -n 's/^git_sha=//p' "$OUT/m-rel3-fail")" "$(sim cat /var/lib/ebooktrivia/deploy/last-failed.manifest)"

  printf '\n### 6. a NATURAL failure: a public image that cannot start\n'
  sim rm -f /etc/ebooktrivia/deploy.allow-failure-drill
  manifest rel3 public=bad >"$OUT/m-bad"
  start=$(date +%s)
  rc=0
  remote deploy "$OUT/m-bad" >"$OUT/deploy-bad.log" 2>&1 || rc=$?
  end=$(date +%s)
  expect "natural failure: exit status 10 (failed and rolled back)" 10 "$rc"
  expect_match "natural failure: public@a did not come up" "timeout after|FAILED|NOT healthy|restart: public@a" "$(cat "$OUT/deploy-bad.log")"
  expect_match "natural failure: rolled back" "ROLLED BACK to the previous images" "$(cat "$OUT/deploy-bad.log")"
  printf 'natural failure + automatic rollback: %s s\n' "$((end - start))"
  expect "natural failure: every container is back on the rel2 images" ok "$(on_images rel2)"
  expect_match "natural failure: the stack answers through Caddy" '^(200|307)$' "$(docker exec "$CLIENT" curl -sk -m 8 --resolve play.example.test:443:192.0.2.10 -o /dev/null -w '%{http_code}' https://play.example.test/)"

  printf '\n### 7. a good deploy after the failures (rel3), and the manual rollback\n'
  manifest rel3 >"$OUT/m-rel3"
  rc=0
  remote deploy "$OUT/m-rel3" >"$OUT/deploy-rel3.log" 2>&1 || rc=$?
  expect "rel3 deploy exit status" 0 "$rc"
  expect "rel3: every container runs the manifest's images" ok "$(on_images rel3)"
  rc=0
  remote rollback >"$OUT/rollback.log" 2>&1 || rc=$?
  expect "manual rollback exit status" 0 "$rc"
  expect "manual rollback: back on rel2" ok "$(on_images rel2)"
  remote status >"$OUT/status.log" 2>&1 || true
  expect_match "status shows the manifests and the units" "== current manifest" "$(cat "$OUT/status.log")"
  expect "status shows no token" 0 "$(grep -c registry_ "$OUT/status.log" || true)"

  printf '\n### 8. a dropped SSH connection and a stopped deploy: the deploy outlives the connection and never leaves the stack half rolled\n'
  deploy_units() { sim systemctl list-units 'ebt-deploy-*.service' --state=active,activating,deactivating --no-legend --plain | awk '{print $1}' | tr -d '\r' | paste -sd ' ' -; }
  wait_log() { # wait_log SINCE PATTERN SECONDS: the deploy's journal has a line matching PATTERN
    local n
    for ((n = 0; n < $3; n += 3)); do
      if sim journalctl -t ebt-deploy --since "$1" -o cat 2>/dev/null | grep -q "$2"; then return 0; fi
      sleep 3
    done
    return 1
  }
  wait_unit_gone() { # wait_unit_gone SECONDS
    local n
    for ((n = 0; n < $1; n += 3)); do
      [[ -z $(deploy_units) ]] && return 0
      sleep 3
    done
    return 1
  }
  local since
  # 8a: the connection is killed while public@a rolls. The release carries the drill's failure after public@a, so the right end is that failure's own rollback:
  # a script killed by the closed pipe would leave public@a on rel3 and public@b on rel2.
  sim touch /etc/ebooktrivia/deploy.allow-failure-drill
  { manifest rel3; printf 'force_fail=after_public_a\n'; } >"$OUT/m-rel3-drop"
  since=$(sim date -u '+%Y-%m-%d %H:%M:%S' | tr -d '\r')
  remote deploy "$OUT/m-rel3-drop" >"$OUT/deploy-drop.log" 2>&1 &
  local client=$!
  if wait_log "$since" 'restart: public@a' 300; then
    sim pkill -KILL -f 'systemd-run.*ebt-deploy-' || true
    sim pkill -KILL -U ebtdeploy || true
    pass "the SSH session (sudo, systemd-run) was killed while public@a was rolling"
  else
    fail "the deploy never reached public@a"
  fi
  wait "$client" || true
  if wait_unit_gone 900; then pass "the deploy unit ran to its end after the connection died"; else fail "the deploy unit is still running after 15 minutes"; fi
  expect_match "dropped connection: the deploy ended in its own rollback (the drill's failure point)" "ROLLED_BACK" "$(sim cat /var/lib/ebooktrivia/deploy/last-deploy)"
  expect_match "dropped connection: the journal has the failure and the rollback" "DEPLOY FAILED and ROLLED BACK" "$(sim journalctl -t ebt-deploy --since "$since" -o cat)"
  expect "dropped connection: every container is back on the rel2 images" ok "$(on_images rel2)"
  sim rm -f /etc/ebooktrivia/deploy.allow-failure-drill

  # 8b: the deploy is stopped (SIGTERM, as an operator or a shutdown would) while public@a rolls: the images go back before the script exits.
  since=$(sim date -u '+%Y-%m-%d %H:%M:%S' | tr -d '\r')
  remote deploy "$OUT/m-rel3" >"$OUT/deploy-stop.log" 2>&1 &
  client=$!
  if wait_log "$since" 'restart: public@a' 300; then
    local unit
    unit=$(deploy_units)
    sim systemctl stop "$unit" || true
    pass "the deploy unit $unit was stopped while public@a was rolling"
  else
    fail "the second deploy never reached public@a"
  fi
  rc=0
  wait "$client" || rc=$?
  printf 'stopped deploy: the client saw exit status %s\n' "$rc"
  wait_unit_gone 120 || fail "the stopped deploy unit is still active"
  expect_match "stopped deploy: SIGTERM was logged" "SIGTERM: the deploy is being stopped" "$(sim journalctl -t ebt-deploy --since "$since" -o cat)"
  expect_match "stopped deploy: the images were rolled back before the script exited" "DEPLOY STOPPED and ROLLED BACK" "$(sim journalctl -t ebt-deploy --since "$since" -o cat)"
  expect_match "stopped deploy: the last run says so" "ROLLED_BACK" "$(sim cat /var/lib/ebooktrivia/deploy/last-deploy)"
  expect "stopped deploy: every container is back on the rel2 images" ok "$(on_images rel2)"
  remote status >"$OUT/status2.log" 2>&1 || true
  expect_match "status shows no deploy running and the last result" "deploy running: no" "$(cat "$OUT/status2.log")"
  expect_match "status shows how the last deploy ended" "last deploy: .* ROLLED_BACK" "$(cat "$OUT/status2.log")"

  printf '\nlogs: %s\n' "$OUT"
  printf 'deploy-sim: %d failure(s)\n' "$FAILURES"
  ((FAILURES == 0))
}

down() {
  docker rm -f "$REG" >/dev/null 2>&1 || true
  docker network disconnect "$REG_NET" "$NAME" >/dev/null 2>&1 || true
  docker network rm "$REG_NET" >/dev/null 2>&1 || true
}

case ${1:-all} in
  all)
    up
    run
    ;;
  up) up ;;
  run) run ;;
  down) down ;;
  *)
    printf 'usage: %s [all|up|run|down]\n' "$0" >&2
    exit 2
    ;;
esac
