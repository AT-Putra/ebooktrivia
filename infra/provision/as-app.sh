#!/usr/bin/env bash
# Runs a command as the rootless podman app user, with its systemd user manager's environment:
#
#   sudo infra/provision/as-app.sh systemctl --user status caddy.socket
#   sudo infra/provision/as-app.sh podman ps
#   sudo infra/provision/as-app.sh journalctl --user -u public@a -n 50
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/provision/lib.sh
. "$HERE/lib.sh"
require_root
load_config "${EBT_PROVISION_CONFIG:-/etc/ebooktrivia/provision.env}"
(($# > 0)) || die "usage: $0 COMMAND [ARG...]"
as_app "$@"
