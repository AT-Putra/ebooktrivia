# shellcheck shell=bash
# Helpers shared by the provisioning scripts (sourced, never run). Every helper is idempotent and
# reports what it did on one line:
#   ok        already in the desired state
#   CHANGED   changed now (the summary counts these; a second run must report none)
#   SKIPPED in container: ...   cannot work inside a container (kernel / host-wide parts); the
#             same step enforces it on a VM. Only in the local stand-in (EBT_PROVISION_SIM=1),
#             never silently.
#
# Root writes only into root-owned directories (put_file, ensure_dir, ensure_symlink refuse a
# destination with a non-root ancestor). Under a directory the app user owns, the app user writes
# (app_put_file, app_ensure_dir, app_ensure_symlink, app_remove): a root process acting by name
# there could be redirected by the app user to any file on the host (security review S1).

# The app-user scripts (app_sh) are single-quoted on purpose: they expand in the app user's shell.
# shellcheck disable=SC2016

# shellcheck source=infra/provision/units.sh
. "$(dirname "${BASH_SOURCE[0]}")/units.sh"

CHANGES=0
SKIPS=0
# 1 when the last put_file / put_env_file / ensure_* / app_* call changed something.
LAST_CHANGED=0
# Units to restart for a changed file to take effect (printed by restart_summary).
RESTART_NEEDED=()

ok() { printf 'ok       %s\n' "$*"; }
changed() {
  CHANGES=$((CHANGES + 1))
  LAST_CHANGED=1
  printf 'CHANGED  %s\n' "$*"
}
skipped_container() {
  SKIPS=$((SKIPS + 1))
  printf 'SKIPPED in container: %s\n' "$*"
}
note() { printf 'note     %s\n' "$*"; }
die() {
  printf 'ERROR    %s\n' "$*" >&2
  exit 1
}

# restart_needed UNIT...: when the last change needs these units restarted.
restart_needed() {
  ((LAST_CHANGED)) || return 0
  local unit known existing
  for unit in "$@"; do
    known=0
    for existing in "${RESTART_NEEDED[@]}"; do [[ $existing == "$unit" ]] && known=1; done
    ((known)) || RESTART_NEEDED+=("$unit")
  done
}
restart_summary() {
  local unit
  for unit in "${RESTART_NEEDED[@]}"; do printf 'restart needed: %s\n' "$unit"; done
}

# True only in the local stand-in (infra/verify/local/vm-sim.sh): a container AND
# EBT_PROVISION_SIM=1. A container without the flag (an LXC or OpenVZ "VPS") stops the scripts:
# SELinux, firewalld and the clock cannot be enforced there, and they must not pretend to.
in_container() {
  local container=0
  if systemd-detect-virt --container --quiet 2>/dev/null || [[ -e /run/.containerenv || -e /.dockerenv ]]; then container=1; fi
  if [[ ${EBT_PROVISION_SIM:-} == 1 ]]; then
    ((container)) || die "EBT_PROVISION_SIM=1 is for the local container stand-in only, not for a VM"
    return 0
  fi
  ((container)) && die "this host is a container ($(systemd-detect-virt --container 2>/dev/null || printf unknown)): SELinux, firewalld and the clock cannot be enforced here; use a VM"
  return 1
}

require_root() {
  [[ $(id -u) -eq 0 ]] || die "run as root (sudo)"
}

# assert_root_path DEST: every directory above DEST is a real directory owned by root.
assert_root_path() {
  local dir
  dir=$(dirname "$1")
  while :; do
    if [[ -L $dir || ! -d $dir || $(stat -c %u "$dir") != 0 ]]; then
      die "refusing to write $1 as root: $dir is not a root-owned directory ($(stat -c %U "$dir" 2>/dev/null || printf missing))"
    fi
    [[ $dir == / ]] && break
    dir=$(dirname "$dir")
  done
}

# put_file DEST MODE OWNER GROUP < content
# Writes stdin to DEST when content, mode or ownership differ (atomic rename in DEST's directory,
# which must be root's all the way up).
put_file() {
  local dest=$1 mode=$2 owner=$3 group=$4 tmp
  LAST_CHANGED=0
  assert_root_path "$dest"
  tmp=$(mktemp "$(dirname "$dest")/.ebt-provision.XXXXXX")
  cat >"$tmp"
  if [[ -f $dest && ! -L $dest ]] && cmp -s "$tmp" "$dest" && [[ $(stat -c '%a %U %G' "$dest") == "$mode $owner $group" ]]; then
    rm -f "$tmp"
    ok "$dest"
    return 0
  fi
  chmod "$mode" "$tmp"
  chown "$owner:$group" "$tmp"
  mv -f "$tmp" "$dest"
  if command -v restorecon >/dev/null 2>&1; then restorecon -F "$dest" 2>/dev/null || true; fi
  changed "$dest"
}

# ensure_dir PATH MODE OWNER GROUP (PATH's parents must be root's)
ensure_dir() {
  local path=$1 mode=$2 owner=$3 group=$4
  LAST_CHANGED=0
  assert_root_path "$path"
  if [[ -d $path && ! -L $path && $(stat -c '%a %U %G' "$path") == "$mode $owner $group" ]]; then
    ok "$path/"
    return 0
  fi
  [[ -L $path ]] && die "$path is a symlink; refusing to manage it"
  mkdir -p "$path"
  chmod "$mode" "$path"
  chown "$owner:$group" "$path"
  if command -v restorecon >/dev/null 2>&1; then restorecon -F "$path" 2>/dev/null || true; fi
  changed "$path/"
}

# app_sh SCRIPT ARG...: runs a bash script as the app user, with a clean environment.
app_sh() {
  local script=$1
  shift
  # setsid -w: a new session without root's controlling terminal (no TIOCSTI into it, review SL1).
  (cd / && runuser -u "$CFG_APP_USER" -- setsid -w env -i PATH=/usr/bin:/bin HOME="$(app_home)" bash -euo pipefail -c "$script" app_sh "$@")
}
# app_result WHAT RESULT: reports an app-user helper's "ok" / "changed" answer.
app_result() {
  LAST_CHANGED=0
  case $2 in
    ok) ok "$1" ;;
    changed) changed "$1" ;;
    *) die "$1: ${2:-no answer}" ;;
  esac
}

# app_put_file DEST MODE < content: written by the app user (same rules as put_file).
app_put_file() {
  app_result "$1" "$(app_sh '
dest=$1 mode=$2
tmp=$(mktemp "$(dirname "$dest")/.ebt-provision.XXXXXX")
cat >"$tmp"
if [[ -f $dest && ! -L $dest ]] && cmp -s "$tmp" "$dest" && [[ $(stat -c %a "$dest") == "$mode" ]]; then
  rm -f "$tmp"
  echo ok
else
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
  echo changed
fi' "$1" "$2")"
}

# app_ensure_dir PATH MODE: created by the app user.
app_ensure_dir() {
  app_result "$1/" "$(app_sh '
path=$1 mode=$2
if [[ -L $path ]]; then echo "is a symlink"; exit 0; fi
if [[ -d $path && $(stat -c %a "$path") == "$mode" ]]; then echo ok; else mkdir -p "$path" && chmod "$mode" "$path" && echo changed; fi' "$1" "$2")"
}

# app_ensure_symlink LINK TARGET: made by the app user.
app_ensure_symlink() {
  app_result "$1 -> $2" "$(app_sh '
link=$1 target=$2
if [[ -L $link && $(readlink "$link") == "$target" ]]; then echo ok
elif [[ -e $link && ! -L $link ]]; then echo "exists and is not a symlink"
else ln -sfn "$target" "$link" && echo changed; fi' "$1" "$2")"
}

# app_remove PATH: removed by the app user.
app_remove() {
  app_sh 'rm -rf -- "$1"' "$1"
  LAST_CHANGED=0
  changed "removed $1"
}

# ensure_symlink LINK TARGET [OWNER]
ensure_symlink() {
  local link=$1 target=$2 owner=${3:-}
  LAST_CHANGED=0
  assert_root_path "$link"
  if [[ -L $link && $(readlink "$link") == "$target" ]]; then
    ok "$link -> $target"
    return 0
  fi
  [[ -e $link && ! -L $link ]] && die "$link exists and is not a symlink"
  ln -sfn "$target" "$link"
  if [[ -n $owner ]]; then chown -h "$owner:$owner" "$link"; fi
  changed "$link -> $target"
}

ensure_packages() {
  local missing=() pkg
  LAST_CHANGED=0
  for pkg in "$@"; do
    rpm -q --quiet "$pkg" || missing+=("$pkg")
  done
  if ((${#missing[@]} == 0)); then
    ok "packages installed: $*"
    return 0
  fi
  dnf -y -q install "${missing[@]}" >/dev/null
  changed "packages installed: ${missing[*]}"
}

# ensure_unit_enabled UNIT [now]: enabled, and with "now" also running.
ensure_unit_enabled() {
  local unit=$1 now=${2:-}
  LAST_CHANGED=0
  if ! systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    systemctl enable --quiet "$unit"
    changed "$unit enabled"
  fi
  if [[ $now == now ]] && ! systemctl is-active --quiet "$unit"; then
    systemctl start "$unit"
    changed "$unit started"
  fi
  ((LAST_CHANGED)) || ok "$unit enabled${now:+ and active}"
}

random_hex() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
sha256_hex() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

# env_value FILE KEY: the value of KEY in an env file (last occurrence), or nothing.
env_value() {
  [[ -f $1 ]] || return 0
  awk -v k="$2" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { if (v != "") print v }' "$1"
}

# ---------------------------------------------------------------------------------------------
# Configuration (/etc/ebooktrivia/provision.env): parsed line by line, never sourced. The CFG_*
# variables are set by name (printf -v) and read by the sourcing scripts.
CFG_DOMAIN=""
CFG_ACME_EMAIL=""
CFG_ADMIN_SSH_USER=""
# shellcheck disable=SC2034 # used by provision.sh, which sources this file
CFG_SSH_ALLOWED_CIDRS=""
# shellcheck disable=SC2034 # used by provision.sh, which sources this file
CFG_ADMIN_ALLOWED_CIDRS=""
# shellcheck disable=SC2034 # used by provision.sh, which sources this file
CFG_GLITCHTIP_ALLOWED_CIDRS=""
# shellcheck disable=SC2034 # used by provision.sh, which sources this file
CFG_WAHA_ALLOWED_CIDRS=""
CFG_APP_USER="ebt"

valid_cidrs() {
  python3 -I -c '
import ipaddress, sys
items = sys.argv[1].split()
if not items:
    sys.exit(1)
for item in items:
    if "/" not in item:
        sys.exit(1)
    ipaddress.ip_network(item, strict=True)
' "$1" 2>/dev/null
}

load_config() {
  local file=$1 line key value
  [[ -f $file ]] || die "config $file not found (copy infra/provision/provision.env.example and fill it in)"
  [[ $(stat -c '%U %a' "$file") == "root 600" ]] || die "$file must be owned by root with mode 0600"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    [[ $line =~ ^([A-Z_]+)=(.*)$ ]] || die "$file: unparsable line (expected KEY=value)"
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    if [[ $value =~ ^\"(.*)\"$ ]]; then value=${BASH_REMATCH[1]}; fi
    case $key in
      DOMAIN | ACME_EMAIL | ADMIN_SSH_USER | SSH_ALLOWED_CIDRS | ADMIN_ALLOWED_CIDRS | GLITCHTIP_ALLOWED_CIDRS | WAHA_ALLOWED_CIDRS | APP_USER)
        printf -v "CFG_$key" '%s' "$value"
        ;;
      *) die "$file: unknown key $key" ;;
    esac
  done <"$file"
  local label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
  [[ $CFG_DOMAIN =~ ^($label\.)+$label$ ]] || die "DOMAIN must be a lowercase DNS name"
  [[ $CFG_ACME_EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "ACME_EMAIL must be an e-mail address"
  [[ $CFG_ADMIN_SSH_USER =~ ^[a-z_][a-z0-9_-]{0,31}$ && $CFG_ADMIN_SSH_USER != root ]] || die "ADMIN_SSH_USER must be a non-root user name"
  [[ $CFG_APP_USER =~ ^[a-z_][a-z0-9_-]{0,31}$ && $CFG_APP_USER != root && $CFG_APP_USER != "$CFG_ADMIN_SSH_USER" ]] ||
    die "APP_USER must be a user name other than root and ADMIN_SSH_USER"
  local name
  for name in SSH_ALLOWED_CIDRS ADMIN_ALLOWED_CIDRS GLITCHTIP_ALLOWED_CIDRS WAHA_ALLOWED_CIDRS; do
    local var="CFG_$name"
    valid_cidrs "${!var}" || die "$name must be a space-separated list of CIDRs (address/prefix, host bits zero)"
    # Canonical form (2001:DB8::/32 -> 2001:db8::/32), so comparisons with firewalld are exact.
    printf -v "$var" '%s' "$(normalize_cidrs "${!var}")"
  done
}

# normalize_cidrs "LIST": the CIDRs in Python's canonical text form, sorted, space-separated.
normalize_cidrs() {
  python3 -I -c '
import ipaddress, sys
nets = sorted({ipaddress.ip_network(c, strict=False) for c in sys.argv[1].split()}, key=lambda n: (n.version, n))
print(" ".join(str(n) for n in nets))
' "$1"
}

# ssh_rich_rules: the firewalld rich rules that let SSH_ALLOWED_CIDRS (and nobody else) reach SSH,
# one per line, in firewalld's own normalized text form.
ssh_rich_rules() {
  local cidr family
  for cidr in $CFG_SSH_ALLOWED_CIDRS; do
    if [[ $cidr == *:* ]]; then family=ipv6; else family=ipv4; fi
    printf 'rule family="%s" source address="%s" service name="ssh" accept\n' "$family" "$cidr"
  done
}

# shipped_firewalld_policies: the policies the firewalld package ships, sorted, space-separated.
shipped_firewalld_policies() {
  find /usr/lib/firewalld/policies -name '*.xml' -printf '%f\n' 2>/dev/null | sed 's/\.xml$//' | sort | xargs
}

# firewall_view [--permanent]: zone public's settings for comparison, without the interfaces (bound
# at runtime by NetworkManager) and without fail2ban's runtime-only bans (reject rules).
firewall_view() {
  firewall-cmd ${1:+"$1"} --zone=public --list-all | grep -v -E '^public|^ *interfaces:|reject' | sort
}

# normalize_rich_rules: stdin rich rules with their source addresses in canonical form, sorted.
normalize_rich_rules() {
  python3 -I -c '
import ipaddress, re, sys
def canon(m):
    return "source address=\"%s\"" % ipaddress.ip_network(m.group(1), strict=False)
rules = [re.sub(r"source address=\"([^\"]+)\"", canon, line.strip()) for line in sys.stdin if line.strip()]
print("\n".join(sorted(rules)))
'
}

app_uid() { id -u "$CFG_APP_USER"; }
app_home() { getent passwd "$CFG_APP_USER" | cut -d: -f6; }

# as_app CMD...: runs CMD as the app user with its systemd user manager's environment.
as_app() {
  local uid
  uid=$(app_uid)
  # setsid -w: without root's controlling terminal (review SL1); stdin and stdout still pass through.
  (cd / && runuser -u "$CFG_APP_USER" -- setsid -w env HOME="$(app_home)" XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@")
}
