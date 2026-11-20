#!/usr/bin/env bash
# Builds the container images on the VM, as the app user, from this checkout (until the deploy
# story pulls them from a registry by digest):
#
#   sudo infra/provision/build-images.sh [postgres|public|admin|admin-cli|worker|sdk ...]   (default: all)
#
# Tags: localhost/ebooktrivia/postgres-walg:18.6 (infra/images/postgres-walg) and
# localhost/ebooktrivia/{public,admin,admin-cli,worker}:current (infra/images/app/Containerfile),
# the names the quadlets (and the admin CLI runbook, docs/runbooks/admin-access.md) run with
# Pull=never. `sdk` builds no image: it publishes the landing-page SDK files to /srv/sdk (see
# publish_sdk). The checkout must be readable by the app user.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
# shellcheck source=infra/provision/lib.sh
. "$HERE/lib.sh"
require_root
load_config "${EBT_PROVISION_CONFIG:-/etc/ebooktrivia/provision.env}"
as_app test -r "$REPO/pnpm-lock.yaml" || die "$REPO is not readable by $CFG_APP_USER"

# publish_sdk: builds the landing-page SDK (the Containerfile's `sdk` stage, static files and no
# image) and copies it into /srv/sdk, where Caddy serves it at api.<DOMAIN>/sdk/. A versioned file
# (sdk-v1.2.3.js, cap-v0.1.62.js, cap-wasm-v0.0.8.wasm) is immutable: it is written once, and a file
# that exists with other content is an error (bump packages/sdk/package.json's version), never an
# overwrite, because pages and caches hold it for a year. The alias (v1.js) is replaced by a rename,
# so no request sees a half-written file. Older versions stay. The scratch directory (it holds the
# build output) is removed on every way out, including a failed build and a refused overwrite.
sdk_stage=""
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup_sdk_stage() {
  [[ -z $sdk_stage ]] || as_app rm -rf "$sdk_stage" || true
}
publish_sdk() {
  local name file
  trap cleanup_sdk_stage EXIT
  sdk_stage=$(as_app mktemp -d /srv/sdk/.build.XXXXXX)
  as_app podman build --pull=missing -f "$REPO/infra/images/app/Containerfile" --target sdk --output "type=local,dest=$sdk_stage" "$REPO"
  as_app chmod 0644 "$sdk_stage"/*
  for file in "$sdk_stage"/*; do
    name=$(basename "$file")
    if [[ $name =~ ^v[0-9]+\.js$ ]]; then continue; fi
    if as_app test -e "/srv/sdk/$name"; then
      as_app cmp -s "$file" "/srv/sdk/$name" || die "/srv/sdk/$name exists with other content: bump the version in packages/sdk/package.json"
    else
      as_app mv -n "$file" "/srv/sdk/$name"
    fi
  done
  for file in "$sdk_stage"/v*.js; do
    as_app mv -f "$file" "/srv/sdk/$(basename "$file")"
  done
  as_app rm -rf "$sdk_stage"
  sdk_stage=""
}

targets=("$@")
((${#targets[@]})) || targets=(postgres public admin admin-cli worker sdk)
for target in "${targets[@]}"; do
  case $target in
    sdk) publish_sdk ;;
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
    *) die "unknown image $target (postgres, public, admin, admin-cli, worker, sdk)" ;;
  esac
  printf 'built %s\n' "$target"
done
