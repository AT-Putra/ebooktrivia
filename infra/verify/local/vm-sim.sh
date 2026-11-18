#!/usr/bin/env bash
# Local proof of the provisioning on a stand-in for the staging VM: an AlmaLinux 10.2 container
# with systemd as PID 1 (vm-sim/Containerfile), run privileged under Docker.
#
#   infra/verify/local/vm-sim.sh [all|up|provision|host-check|dryrun|down]     (default: all)
#
#   up          build the image, start the container (the repository is mounted read-only at
#               /opt/ebooktrivia), add the operator's SSH key, write a test provision.env
#   provision   run infra/provision/provision.sh twice; the second run must report 0 changed
#   host-check  run infra/verify/host-check.sh; every FAIL must be an expected container-only one
#   dryrun      run the quadlet generator (-dryrun) on the installed units as the app user
#   down        remove the container and its volume
#
# Test values only: example.test names and documentation addresses (RFC 5737 / 3849). Logs go to
# a fresh directory under ${TMPDIR:-/tmp} (printed at the end). Needs Docker with privileged
# containers (Docker Desktop is fine).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$HERE/lib.sh"
# shellcheck source=infra/provision/units.sh
. "$REPO/infra/provision/units.sh"
NAME=${VM_SIM_NAME:-ebt-vm-sim}
IMAGE=localhost/ebt-vm-sim:local
OUT=${VM_SIM_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/ebt-vm-sim.XXXXXX")}
mkdir -p "$OUT"

# EBT_PROVISION_SIM=1 tells the scripts they run in this stand-in, where container-only gaps
# (SELinux, the host clock) are reported and skipped. Without it they refuse to run in a container.
sim() { docker exec -e EBT_PROVISION_SIM=1 "$NAME" "$@"; }
sim_in() { docker exec -i -e EBT_PROVISION_SIM=1 "$NAME" "$@"; }

# host-check failures that are expected here, before the stack runs (extended regular
# expressions): what a container cannot have (SELinux mode, audit log and labels, the host clock),
# the two operator steps (the worker placeholder, the GlitchTip token file), and everything from
# "== user units" on, which needs the running stack: infra/verify/local/stack-sim.sh checks those.
EXPECTED_BEFORE_STACK='^getenforce
^AVC denials
 label:
^chronyd active
^auditd active
^chrony synchronised
^/etc/ebooktrivia/worker.env has unfilled placeholders
^/etc/ebooktrivia/glitchtip-hook.token still exists'

up() {
  docker build -q -t "$IMAGE" -f "$(host_path "$HERE/vm-sim")/Containerfile" "$(host_path "$HERE/vm-sim")" >/dev/null
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$NAME-home" >/dev/null 2>&1 || true
  # /home on a volume: rootless podman's overlay storage cannot sit on Docker's overlayfs.
  docker run -d --name "$NAME" --hostname "$NAME" --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /tmp -v "$NAME-home:/home" -v "$(host_path "$REPO"):/opt/ebooktrivia:ro" "$IMAGE" >/dev/null
  local state=""
  for _ in $(seq 1 60); do
    state=$(sim systemctl is-system-running 2>/dev/null || true)
    [[ $state == running || $state == degraded ]] && break
    sleep 1
  done
  printf 'vm-sim %s: systemd %s\n' "$NAME" "$state"
  sim bash -c 'ssh-keygen -q -t ed25519 -N "" -C opsadmin@vm-sim -f /root/opsadmin-key \
    && install -d -m 700 -o opsadmin -g opsadmin /home/opsadmin/.ssh \
    && install -m 600 -o opsadmin -g opsadmin /root/opsadmin-key.pub /home/opsadmin/.ssh/authorized_keys'
  sim_in bash -c 'install -d -m 755 /etc/ebooktrivia && umask 077 && cat > /etc/ebooktrivia/provision.env' <<'EOF'
# vm-sim test configuration: reserved names and documentation addresses only.
DOMAIN=example.test
ACME_EMAIL=ops@example.test
ADMIN_SSH_USER=opsadmin
SSH_ALLOWED_CIDRS="192.0.2.0/24 2001:db8::/32"
ADMIN_ALLOWED_CIDRS="192.0.2.0/24"
GLITCHTIP_ALLOWED_CIDRS="198.51.100.20/32"
APP_USER=ebt
EOF
}

provision() {
  # Review C-L1: in a container WITHOUT EBT_PROVISION_SIM=1 (an LXC/OpenVZ VPS, say) the script
  # must stop, not skip what it cannot enforce.
  printf '\n### provision without EBT_PROVISION_SIM (must refuse)\n'
  if docker exec "$NAME" /opt/ebooktrivia/infra/provision/provision.sh >"$OUT/provision-0.log" 2>&1; then
    printf 'FAILED: provisioning ran in a container without EBT_PROVISION_SIM=1\n'
    return 1
  fi
  grep -m1 'ERROR' "$OUT/provision-0.log" || true
  printf 'refused as it should\n'
  local run
  for run in 1 2; do
    printf '\n### provision run %s\n' "$run"
    sim /opt/ebooktrivia/infra/provision/provision.sh | tee "$OUT/provision-$run.log"
  done
  local second
  second=$(grep -c '^CHANGED' "$OUT/provision-2.log" || true)
  grep -q '^summary: 0 changed' "$OUT/provision-2.log" && [[ $second == 0 ]] ||
    {
      printf 'IDEMPOTENCE FAILED: the second run changed %s things\n' "$second"
      return 1
    }
  printf '\nIDEMPOTENT: second run reported 0 changed (first run: %s changed)\n' "$(grep -c '^CHANGED' "$OUT/provision-1.log")"
  printf 'skipped in container (both runs):\n'
  grep '^SKIPPED in container' "$OUT/provision-2.log" | sed 's/^/  /'
}

host_check() {
  printf '\n### host-check (read-only; the stack is not running yet)\n'
  sim /opt/ebooktrivia/infra/verify/host-check.sh | tee "$OUT/host-check.log" || true
  local unexpected=0 line expected known
  while IFS= read -r line; do
    known=0
    while IFS= read -r expected; do
      [[ ${line#FAIL  } =~ $expected ]] && known=1
    done <<<"$EXPECTED_BEFORE_STACK"
    if ((!known)); then
      printf 'UNEXPECTED: %s\n' "$line"
      unexpected=$((unexpected + 1))
    fi
  done < <(sed '/^== user units/,$d' "$OUT/host-check.log" | grep '^FAIL' || true)
  if ((unexpected)); then
    printf 'host-check: %d unexpected failure(s)\n' "$unexpected"
    return 1
  fi
  printf '\nhost-check: every failure before the stack sections is an expected one (%s)\n' \
    "$(printf '%s' "$EXPECTED_BEFORE_STACK" | paste -sd ';' -)"
}

dryrun() {
  printf '\n### quadlet generator dry run (installed units, user ebt)\n'
  sim runuser -u ebt -- /usr/libexec/podman/quadlet -dryrun -user >"$OUT/quadlet-dryrun.txt" 2>"$OUT/quadlet-dryrun.err"
  local unit missing=0
  for unit in "${EBT_GENERATED[@]}"; do
    if grep -q "^---$unit.service---$" "$OUT/quadlet-dryrun.txt"; then printf 'generated %s.service\n' "$unit"; else
      printf 'MISSING %s.service\n' "$unit"
      missing=1
    fi
  done
  if grep -iE 'error|unsupported key|unknown key' "$OUT/quadlet-dryrun.err"; then missing=1; fi
  ((!missing)) && printf 'quadlet dry run: all units generated, no errors\n'
  ((!missing))
}

down() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$NAME-home" >/dev/null 2>&1 || true
}

case ${1:-all} in
  all)
    up
    provision
    dryrun
    host_check
    ;;
  up) up ;;
  provision) provision ;;
  host-check) host_check ;;
  dryrun) dryrun ;;
  down) down ;;
  *)
    printf 'usage: %s [all|up|provision|host-check|dryrun|down]\n' "$0" >&2
    exit 2
    ;;
esac
printf '\nlogs: %s\n' "$OUT"
