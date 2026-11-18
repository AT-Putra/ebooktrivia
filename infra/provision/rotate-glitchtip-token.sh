#!/usr/bin/env bash
# Rotates the GlitchTip alert hook token (POST https://api.<DOMAIN>/hooks/glitchtip/<token>).
#
#   sudo infra/provision/rotate-glitchtip-token.sh
#
# 1. generates a new random token and writes it to /etc/ebooktrivia/glitchtip-hook.token (root,
#    0600) for you to copy;
# 2. puts its SHA-256 in /etc/ebooktrivia/internal.env (GLITCHTIP_HOOK_TOKEN_SHA256; the internal
#    process never sees the token itself);
# 3. restarts internal.service, after which the old token answers 404.
# Then set the new URL in GlitchTip's webhook alert and delete the token file. Caddy's logs never
# hold a token: the URI of /hooks/glitchtip/* is redacted before a log line is written.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/provision/lib.sh
. "$HERE/lib.sh"
require_root
load_config "${EBT_PROVISION_CONFIG:-/etc/ebooktrivia/provision.env}"
ETC=/etc/ebooktrivia
file=$ETC/internal.env
[[ -f $file ]] || die "$file does not exist (run provision.sh first)"

token=$(random_hex)
(umask 077 && printf '%s\n' "$token" >"$ETC/glitchtip-hook.token")
hash=$(sha256_hex "$token")
put_file "$file" 640 root "$CFG_APP_USER" < <(awk -v h="$hash" '
  index($0, "GLITCHTIP_HOOK_TOKEN_SHA256=") == 1 { print "GLITCHTIP_HOOK_TOKEN_SHA256=" h; done = 1; next }
  { print }
  END { if (!done) print "GLITCHTIP_HOOK_TOKEN_SHA256=" h }' "$file")
if as_app systemctl --user is-active --quiet internal.service; then
  as_app systemctl --user restart internal.service
  changed "internal.service restarted"
fi
printf 'new token in %s: set https://api.%s/hooks/glitchtip/<token> in GlitchTip, then delete the file\n' \
  "$ETC/glitchtip-hook.token" "$CFG_DOMAIN"
