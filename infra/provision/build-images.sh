#!/usr/bin/env bash
# Builds the container images on the VM, as the app user, from this checkout (until the deploy
# story pulls them from a registry by digest):
#
#   sudo infra/provision/build-images.sh [postgres|public|admin|worker ...]    (default: all four)
#
# Tags: localhost/ebooktrivia/postgres-walg:18.6 (infra/images/postgres-walg) and
# localhost/ebooktrivia/{public,admin,worker}:current (infra/images/app/Containerfile), the names
# the quadlets run with Pull=never. The checkout must be readable by the app user.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
# shellcheck source=infra/provision/lib.sh
. "$HERE/lib.sh"
require_root
load_config "${EBT_PROVISION_CONFIG:-/etc/ebooktrivia/provision.env}"
as_app test -r "$REPO/pnpm-lock.yaml" || die "$REPO is not readable by $CFG_APP_USER"

targets=("$@")
((${#targets[@]})) || targets=(postgres public admin worker)
for target in "${targets[@]}"; do
  case $target in
    postgres)
      as_app podman build --pull=missing -t localhost/ebooktrivia/postgres-walg:18.6 "$REPO/infra/images/postgres-walg"
      ;;
    public | admin | worker)
      as_app podman build --pull=missing -f "$REPO/infra/images/app/Containerfile" --target "$target" \
        -t "localhost/ebooktrivia/$target:current" "$REPO"
      ;;
    *) die "unknown image $target (postgres, public, admin, worker)" ;;
  esac
  printf 'built %s\n' "$target"
done
