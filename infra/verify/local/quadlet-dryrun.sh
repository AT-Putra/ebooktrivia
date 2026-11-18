#!/usr/bin/env bash
# Runs podman's quadlet generator (-dryrun -user) over infra/quadlet in a throwaway AlmaLinux 10.2
# container with the distribution's podman, pinned to the build the VM runs, the way the VM's user
# manager will see the units (public@a / public@b are symlinks to the template, as infra/provision
# installs them). Fails when the generator rejects a unit, a service is missing, or the podman
# build differs. vm-sim.sh runs the same check on the installed units.
#
# The pinned build comes from the AlmaLinux 10.2 vault (it stays there after 10.3 replaces 10.2
# in the live repositories); when the vault cannot serve it, the live 10.2 repositories are tried.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$HERE/lib.sh"
# shellcheck source=infra/provision/units.sh
. "$REPO/infra/provision/units.sh"
IMAGE=docker.io/library/almalinux:10.2@sha256:5a4b41a427c9717be8f4ac2a32aa22efbae5f9124fbcb79a6765394f312acfe8
PODMAN_RPM=podman-5.8.2-12.el10_2.alma.1
VAULT=https://vault.almalinux.org/10.2

# shellcheck disable=SC2016 # the script expands its own variables inside the container
docker run --rm -v "$(host_path "$REPO/infra/quadlet"):/src:ro" "$IMAGE" bash -euo pipefail -c '
  rpm=$1 vault=$2
  shift 2
  key=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-AlmaLinux-10
  vault_repos=(--disablerepo="*"
    --repofrompath=ebt-vault-baseos,"$vault/BaseOS/x86_64/os/" --setopt=ebt-vault-baseos.gpgcheck=1 --setopt=ebt-vault-baseos.gpgkey="$key"
    --repofrompath=ebt-vault-appstream,"$vault/AppStream/x86_64/os/" --setopt=ebt-vault-appstream.gpgcheck=1 --setopt=ebt-vault-appstream.gpgkey="$key")
  # dnf errors stay on stderr.
  if ! dnf -y -q "${vault_repos[@]}" install "$rpm" >/dev/null; then
    echo "the AlmaLinux 10.2 vault ($vault) could not serve $rpm; trying the live 10.2 repositories" >&2
    dnf -y -q install "$rpm" >/dev/null || { echo "neither the vault nor the live repositories have $rpm" >&2; exit 1; }
  fi
  installed=$(rpm -q podman)
  [[ $installed == "$rpm".* ]] || { echo "podman build: want $rpm, got $installed"; exit 1; }
  echo "podman build $installed"
  mkdir -p /root/q && cp -r /src/. /root/q/ && cd /root/q
  rm -f caddy.socket
  ln -s public@.container public@a.container
  ln -s public@.container public@b.container
  QUADLET_UNIT_DIRS=/root/q /usr/libexec/podman/quadlet -dryrun -user >/root/out.txt 2>/root/err.txt
  missing=0
  for unit in "$@"; do
    grep -q "^---$unit.service---$" /root/out.txt || { echo "MISSING $unit.service"; missing=1; }
  done
  if grep -iE "error|unsupported|unknown key" /root/err.txt; then missing=1; fi
  grep -E "^ExecStart=/usr/bin/podman run" /root/out.txt | sed -E "s/^ExecStart=//" | cut -c1-150
  ((missing == 0)) && echo "quadlet dry run: $# units generated, no errors"
  exit "$missing"
' quadlet-dryrun "$PODMAN_RPM" "$VAULT" "${EBT_GENERATED[@]}"
