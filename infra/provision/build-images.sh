#!/usr/bin/env bash
# Builds the container images on the VM, as the app user, from this checkout (until the deploy
# story pulls them from a registry by digest):
#
#   sudo infra/provision/build-images.sh [postgres|public|admin|admin-cli|worker ...]   (default: all)
#
# Tags: localhost/ebooktrivia/postgres-walg:18.6 (infra/images/postgres-walg) and
# localhost/ebooktrivia/{public,admin,admin-cli,worker}:current (infra/images/app/Containerfile),
# the names the quadlets (and the admin CLI runbook, docs/runbooks/admin-access.md) run with
# Pull=never. The checkout must be readable by the app user.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
# shellcheck source=infra/provision/lib.sh
. "$HERE/lib.sh"
require_root
load_config "${EBT_PROVISION_CONFIG:-/etc/ebooktrivia/provision.env}"
as_app test -r "$REPO/pnpm-lock.yaml" || die "$REPO is not readable by $CFG_APP_USER"

targets=("$@")
((${#targets[@]})) || targets=(postgres public admin admin-cli worker)
for target in "${targets[@]}"; do
  case $target in
    postgres)
      as_app podman build --pull=missing -t localhost/ebooktrivia/postgres-walg:18.6 "$REPO/infra/images/postgres-walg"
      ;;
    admin)
      # next.config.ts bakes the console's origin into the server-action allowedOrigins.
      as_app podman build --pull=missing -f "$REPO/infra/images/app/Containerfile" --target admin \
        --build-arg "ADMIN_ORIGIN=https://admin.$CFG_DOMAIN" -t localhost/ebooktrivia/admin:current "$REPO"
      ;;
    public | admin-cli | worker)
      as_app podman build --pull=missing -f "$REPO/infra/images/app/Containerfile" --target "$target" \
        -t "localhost/ebooktrivia/$target:current" "$REPO"
      ;;
    *) die "unknown image $target (postgres, public, admin, admin-cli, worker)" ;;
  esac
  printf 'built %s\n' "$target"
done
