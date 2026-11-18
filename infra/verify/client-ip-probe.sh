#!/usr/bin/env bash
# Staging check that the real client address reaches the apps (story US-014, criterion 5).
#
#   sudo infra/verify/client-ip-probe.sh start     public@b runs the probe (client-ip-probe.mjs)
#   sudo infra/verify/client-ip-probe.sh stop      public@b runs the public app again
#
# While started, public@b answers every request with JSON: `clientIp` is the address an app
# would rely on (X-Forwarded-For after the edge listener's rewrite), `peer` the TCP peer (must be
# Caddy, 10.89.50.2). public@a keeps serving the real app, so Caddy alternates between the two.
# From a machine OUTSIDE the VM:
#
#   for i in 1 2 3 4; do curl -s https://play.<DOMAIN>/; echo; done                # some lines are JSON
#   for i in 1 2 3 4; do curl -s -H 'X-Forwarded-For: 203.0.113.9' https://play.<DOMAIN>/; echo; done
#
# Pass: every JSON line has clientIp = that machine's public address (as its ISP shows it), also
# with the spoofed header, and peer = 10.89.50.2. Then run `stop`. Staging only: it replaces one
# production instance for the duration.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/provision/lib.sh
. "$HERE/../provision/lib.sh"
require_root
load_config "${EBT_PROVISION_CONFIG:-/etc/ebooktrivia/provision.env}"
APP=$CFG_APP_USER
probe_dir=/etc/ebooktrivia/probe
dropin_dir="$(app_home)/.config/containers/systemd/public@b.container.d"
dropin=$dropin_dir/90-client-ip-probe.conf

# The probe file is root's (like all of /etc/ebooktrivia, labeled container_file_t by provision.sh),
# the drop-in is written and removed by the app user in its own directory (security review S1).
case ${1:-} in
  start)
    ensure_dir "$probe_dir" 750 root "$APP"
    put_file "$probe_dir/client-ip-probe.mjs" 640 root "$APP" <"$HERE/client-ip-probe.mjs"
    if command -v restorecon >/dev/null 2>&1; then restorecon -R "$probe_dir" 2>/dev/null || true; fi
    app_put_file "$dropin" 644 <<'EOF'
# Temporary: infra/verify/client-ip-probe.sh (remove with `client-ip-probe.sh stop`).
[Container]
Exec=node /probe/client-ip-probe.mjs
Volume=/etc/ebooktrivia/probe/client-ip-probe.mjs:/probe/client-ip-probe.mjs:ro
EOF
    ;;
  stop)
    # shellcheck disable=SC2016 # expands in the app user's shell
    app_sh 'rm -f -- "$1"' "$dropin"
    rm -rf "$probe_dir"
    changed "probe removed"
    ;;
  *)
    printf 'usage: %s start|stop\n' "$0" >&2
    exit 2
    ;;
esac
as_app systemctl --user daemon-reload
as_app systemctl --user restart public@b.service
printf 'public@b: %s (%s)\n' "$(as_app systemctl --user is-active public@b.service)" "${1}"
