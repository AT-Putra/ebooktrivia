#!/usr/bin/env bash
# Idempotent host provisioning for the ebooktrivia VM (AlmaLinux 10.2; plan M4.1, story US-014).
#
#   sudo infra/provision/provision.sh [CONFIG]        CONFIG defaults to /etc/ebooktrivia/provision.env
#
# Run it from a checkout of the repository on the VM (docs/runbooks/staging-provision.md). It
# configures, in order: packages (EPEL limited to fail2ban), the rootless podman app user (nologin,
# linger, subuids, cgroup delegation), sysctl (ip_unprivileged_port_start=80), SELinux enforcing
# (and container_file_t for the provisioned config), firewalld (exactly http, https and SSH from
# SSH_ALLOWED_CIDRS), key-only sshd (AllowUsers per SSH CIDR), fail2ban, dnf-automatic (security
# updates), chrony, the egress guard (nftables), /etc/ebooktrivia (root-owned; env files 0640 with
# secrets generated here, Valkey ACL, pg_hba, Caddyfile) and the quadlets (written by the app
# user). It starts no container: see the runbook for the order; "restart needed" lines name the
# units a change applies to. A second run changes nothing. In the local stand-in
# (EBT_PROVISION_SIM=1) the parts that need a kernel or host of their own are reported as
# "SKIPPED in container: ..."; in any other container the script stops.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
FILES=$HERE/files
ETC=/etc/ebooktrivia
# shellcheck source=infra/provision/lib.sh
. "$HERE/lib.sh"

require_root
load_config "${1:-$ETC/provision.env}"
APP=$CFG_APP_USER
SIM=0
if in_container; then SIM=1; fi

step() { printf '\n== %s\n' "$*"; }

step_packages() {
  step "packages"
  ensure_packages epel-release
  # EPEL serves fail2ban and nothing else (security review S16).
  put_file /etc/yum.repos.d/epel.repo 644 root root < <(awk '
    /^\[/ { if (in_epel && !done) { print "includepkgs=fail2ban*"; done = 1 } in_epel = ($0 == "[epel]") }
    in_epel && /^includepkgs=/ { next }
    { print }
    END { if (in_epel && !done) print "includepkgs=fail2ban*" }' /etc/yum.repos.d/epel.repo)
  ensure_packages podman passt container-selinux policycoreutils-python-utils firewalld nftables audit \
    fail2ban-server fail2ban-firewalld fail2ban-selinux dnf-automatic dnf-plugins-core chrony \
    openssh-server openssh-clients python3 shadow-utils procps-ng iproute sudo
  local version
  version=$(podman --version | awk '{print $3}')
  # Quadlets need podman >= 4.4; Notify=healthy and template drop-ins need 5.x.
  [[ ${version%%.*} -ge 5 ]] || die "podman $version is too old (need 5.x for the quadlets)"
  ok "podman $version"
}

step_app_user() {
  step "app user $APP (rootless podman)"
  if id -u "$APP" >/dev/null 2>&1; then
    ok "user $APP exists"
  else
    useradd --create-home --shell /sbin/nologin --comment "ebooktrivia containers" "$APP"
    changed "user $APP created"
  fi
  # No login at all: the account is reached with runuser (as-app.sh) only.
  if [[ $(getent passwd "$APP" | cut -d: -f7) == /sbin/nologin ]]; then
    ok "user $APP has no login shell"
  else
    usermod --shell /sbin/nologin "$APP"
    changed "user $APP login shell /sbin/nologin"
  fi
  if [[ $(passwd -S "$APP" | awk '{print $2}') =~ ^(L|LK)$ ]]; then
    ok "user $APP password locked"
  else
    usermod -L "$APP"
    changed "user $APP password locked"
  fi
  local file
  for file in /etc/subuid /etc/subgid; do
    if grep -q "^$APP:" "$file"; then
      ok "$file has a range for $APP"
    else
      local start
      start=$(awk -F: 'BEGIN { m = 524288 } { e = $2 + $3; if (e > m) m = e } END { print m }' "$file")
      printf '%s:%s:65536\n' "$APP" "$start" >>"$file"
      changed "$file: $APP:$start:65536"
    fi
  done
  ensure_dir /etc/systemd/system/user@.service.d 755 root root
  put_file /etc/systemd/system/user@.service.d/90-ebooktrivia-delegate.conf 644 root root <"$FILES/user-delegate.conf"
  local delegate_changed=$LAST_CHANGED
  if ((delegate_changed)); then systemctl daemon-reload; fi
  if [[ -e /var/lib/systemd/linger/$APP ]]; then
    ok "linger enabled for $APP"
  else
    loginctl enable-linger "$APP"
    changed "linger enabled for $APP"
  fi
  local uid
  uid=$(app_uid)
  if ((delegate_changed)) && systemctl is-active --quiet "user@$uid.service"; then
    # The user manager reads Delegate= at start. Only ever true on the first run, before any
    # container exists.
    systemctl restart "user@$uid.service"
    changed "user@$uid.service restarted (cgroup delegation)"
  fi
  local _
  for _ in $(seq 1 30); do
    [[ -S /run/user/$uid/bus ]] && break
    sleep 1
  done
  [[ -S /run/user/$uid/bus ]] || die "the systemd user manager of $APP did not start"
  local controllers
  controllers=$(cat "/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/cgroup.controllers" 2>/dev/null || true)
  if [[ " $controllers " == *" memory "* ]]; then
    ok "memory controller delegated to $APP"
  else
    die "the memory controller is not delegated to user@$uid.service (quadlet Memory= limits would not apply); run systemctl restart user@$uid.service, or reboot, and try again"
  fi
}

step_sysctl() {
  step "sysctl"
  ensure_dir /etc/sysctl.d 755 root root
  put_file /etc/sysctl.d/90-ebooktrivia.conf 644 root root <"$FILES/sysctl-90-ebooktrivia.conf"
  local key value current
  while read -r key _ value; do
    [[ -z $key || $key == \#* ]] && continue
    current=$(sysctl -n "$key")
    if [[ $current == "$value" ]]; then
      ok "sysctl $key = $value"
    elif ((SIM)) && [[ $key != net.* ]]; then
      # Not namespaced: writing it would change the container host's kernel.
      skipped_container "sysctl $key = $value (kernel-wide; set on the VM from /etc/sysctl.d at boot and here)"
    else
      sysctl -q -w "$key=$value"
      changed "sysctl $key = $value"
    fi
  done <"$FILES/sysctl-90-ebooktrivia.conf"
}

# Provisioned config the containers read (mounted read-only, never relabeled by podman: rootless
# podman cannot relabel root-owned files).
FCONTEXT_SPEC='/etc/ebooktrivia/(caddy|postgres|valkey|probe)(/.*)?'

step_selinux() {
  step "SELinux"
  if [[ -f /etc/selinux/config ]]; then
    put_file /etc/selinux/config 644 root root < <(sed -E 's/^SELINUX=.*/SELINUX=enforcing/' /etc/selinux/config)
  fi
  if ((SIM)); then
    skipped_container "SELinux enforcing and the container_file_t context for $FCONTEXT_SPEC (a container has no SELinux of its own); on the VM this step runs setenforce 1, semanage fcontext and refuses a disabled SELinux"
    return 0
  fi
  case $(getenforce) in
    Enforcing) ok "SELinux Enforcing" ;;
    Permissive)
      setenforce 1
      changed "SELinux Enforcing (was Permissive)"
      ;;
    *)
      touch /.autorelabel
      die "SELinux is disabled: /etc/selinux/config now says enforcing and /.autorelabel exists; reboot (relabel) and run this again"
      ;;
  esac
  if semanage fcontext -l -C | awk '{ print $1, $NF }' | grep -qxF "$FCONTEXT_SPEC system_u:object_r:container_file_t:s0"; then
    ok "file context container_file_t for $FCONTEXT_SPEC"
  else
    semanage fcontext -a -t container_file_t "$FCONTEXT_SPEC"
    changed "file context container_file_t for $FCONTEXT_SPEC"
  fi
}

# Fails when there are SSH sessions and none of them comes from SSH_ALLOWED_CIDRS: applying the
# firewall would cut the operator off.
check_ssh_session_allowed() {
  local peers
  peers=$(ss -Htn state established '( sport = :22 )' 2>/dev/null | awk '{print $4}' | sed -E 's/^\[?(.*)\]?:[0-9]+$/\1/; s/^::ffff://; s/\]$//' || true)
  [[ -z $peers ]] && return 0
  python3 -I -c '
import ipaddress, sys
nets = [ipaddress.ip_network(c) for c in sys.argv[1].split()]
peers = [ipaddress.ip_address(p) for p in sys.argv[2].split()]
sys.exit(0 if any(p in n for p in peers for n in nets if p.version == n.version) else 1)
' "$CFG_SSH_ALLOWED_CIDRS" "$peers" || die "no current SSH session comes from SSH_ALLOWED_CIDRS; refusing to restrict SSH (you would be locked out)"
}

step_firewalld() {
  step "firewalld"
  ensure_unit_enabled firewalld now
  firewall-cmd --state >/dev/null 2>&1 || die "firewalld is not running"
  check_ssh_session_allowed
  local zone=public p=(--permanent --zone=public) item value
  # Only zone public may be in use: an interface or source bound to another zone would bypass it.
  local other
  for other in $(firewall-cmd --get-zones); do
    [[ $other == "$zone" ]] && continue
    value="$(firewall-cmd --zone="$other" --list-interfaces) $(firewall-cmd --zone="$other" --list-sources) $(firewall-cmd --permanent --zone="$other" --list-interfaces) $(firewall-cmd --permanent --zone="$other" --list-sources)"
    [[ -z ${value// /} ]] || die "firewalld zone $other has interfaces or sources ($value): move them to zone public, then run this again"
  done
  # Policies and direct rules act outside the zones (review SL4): refuse anything not shipped.
  [[ $(firewall-cmd --get-policies | tr ' ' '\n' | sort | xargs) == "$(shipped_firewalld_policies)" ]] ||
    die "firewalld has policies beyond the shipped ones ($(firewall-cmd --get-policies)): remove them, then run this again"
  [[ -z $(find /etc/firewalld/policies -name '*.xml' 2>/dev/null) ]] || die "/etc/firewalld/policies has local policy files: remove them, then run this again"
  [[ -z $(firewall-cmd --direct --get-all-rules)$(firewall-cmd --direct --get-all-passthroughs) ]] ||
    die "firewalld has direct rules or passthroughs (firewall-cmd --direct --get-all-rules): remove them, then run this again"
  ok "firewalld: shipped policies only, no direct rules"
  if [[ $(firewall-cmd --get-default-zone) != "$zone" ]]; then
    firewall-cmd --quiet --set-default-zone="$zone"
    changed "firewalld default zone $zone"
  fi
  if [[ $(firewall-cmd "${p[@]}" --get-target) != default ]]; then
    firewall-cmd --quiet "${p[@]}" --set-target=default
    changed "firewalld $zone target default"
  fi
  # SSH from SSH_ALLOWED_CIDRS: allow rules first, then drop the open ssh service, so SSH from the
  # allowed sources never stops. Rules are compared with their addresses in canonical form.
  local want rule
  want=$(ssh_rich_rules)
  while IFS= read -r rule; do
    [[ -z $rule ]] && continue
    if ! firewall-cmd "${p[@]}" --query-rich-rule="$rule" >/dev/null 2>&1; then
      firewall-cmd --quiet "${p[@]}" --add-rich-rule="$rule"
      changed "firewalld: $rule"
    fi
  done <<<"$want"
  local normalized_want
  normalized_want=$(normalize_rich_rules <<<"$want")
  while IFS= read -r rule; do
    [[ -z $rule ]] && continue
    if ! grep -qxF "$(normalize_rich_rules <<<"$rule")" <<<"$normalized_want"; then
      firewall-cmd --quiet "${p[@]}" --remove-rich-rule="$rule"
      changed "firewalld: removed $rule"
    fi
  done < <(firewall-cmd "${p[@]}" --list-rich-rules)
  # Exactly these services; dhcpv6-client is the link-local DHCPv6 lease renewal.
  local service
  for service in dhcpv6-client http https; do
    if ! firewall-cmd "${p[@]}" --query-service="$service" >/dev/null 2>&1; then
      firewall-cmd --quiet "${p[@]}" --add-service="$service"
      changed "firewalld: service $service"
    fi
  done
  for service in $(firewall-cmd "${p[@]}" --list-services); do
    case $service in dhcpv6-client | http | https) ;; *)
      firewall-cmd --quiet "${p[@]}" --remove-service="$service"
      changed "firewalld: removed service $service"
      ;;
    esac
  done
  for item in port protocol source-port forward-port icmp-block source; do
    for value in $(firewall-cmd "${p[@]}" --list-"${item}s"); do
      firewall-cmd --quiet "${p[@]}" --remove-"$item"="$value"
      changed "firewalld: removed $item $value"
    done
  done
  if firewall-cmd "${p[@]}" --query-masquerade >/dev/null 2>&1; then
    firewall-cmd --quiet "${p[@]}" --remove-masquerade
    changed "firewalld: masquerade off"
  fi
  # Reload whenever the running rules differ from the permanent ones (not only after a change in
  # this run): a hand-made runtime rule would otherwise survive.
  if [[ $(firewall_view --permanent) != "$(firewall_view "")" ]]; then
    firewall-cmd --quiet --reload
    changed "firewalld reloaded (runtime differed from the permanent config)"
  else
    ok "firewalld zone $zone: dhcpv6-client, http, https; ssh from $CFG_SSH_ALLOWED_CIDRS; runtime = permanent"
  fi
}

SSHD_DROPIN=/etc/ssh/sshd_config.d/00-ebooktrivia.conf

step_sshd() {
  step "sshd (key-only, no root login, AllowUsers per SSH CIDR)"
  local home keys
  id -u "$CFG_ADMIN_SSH_USER" >/dev/null 2>&1 || die "ADMIN_SSH_USER $CFG_ADMIN_SSH_USER does not exist"
  id -nG "$CFG_ADMIN_SSH_USER" | tr ' ' '\n' | grep -qx wheel || die "ADMIN_SSH_USER $CFG_ADMIN_SSH_USER is not in group wheel"
  home=$(getent passwd "$CFG_ADMIN_SSH_USER" | cut -d: -f6)
  keys="$home/.ssh/authorized_keys"
  if ! { [[ -s $keys ]] && grep -qE '^(ssh-|ecdsa-|sk-)' "$keys"; }; then
    die "$keys has no public key: refusing to turn off password and root login"
  fi
  # sshd keeps the FIRST value it reads for a keyword, and AllowUsers / AllowGroups accumulate
  # across files. Refuse what could weaken this drop-in: a drop-in sorted before it that sets one
  # of its keywords, any other AllowUsers / AllowGroups, any Match block.
  local keywords file other
  keywords=$(awk '/^[A-Za-z]/ { print tolower($1) }' "$FILES/sshd-00-ebooktrivia.conf" | sort -u)
  for file in /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf; do
    [[ -f $file && $file != "$SSHD_DROPIN" ]] || continue
    if grep -qiE '^[[:space:]]*match[[:space:]]' "$file"; then die "$file has a Match block; refusing to rely on the sshd drop-in (remove it, then run this again)"; fi
    if grep -qiE '^[[:space:]]*allow(users|groups)[[:space:]]' "$file"; then die "$file sets AllowUsers/AllowGroups, which would add to $SSHD_DROPIN's list"; fi
    if [[ $file == /etc/ssh/sshd_config.d/* && $(basename "$file") < $(basename "$SSHD_DROPIN") ]]; then
      other=$(awk '/^[A-Za-z]/ { print tolower($1) }' "$file" | sort -u | comm -12 - <(printf '%s\n' "$keywords"))
      [[ -z $other ]] || die "$file sorts before $SSHD_DROPIN and sets $other"
    fi
  done
  local allow
  allow=$(sshd_allow_users | xargs)
  ensure_dir /etc/ssh/sshd_config.d 755 root root
  put_file "$SSHD_DROPIN" 600 root root < <(sed "s|@ALLOW_USERS@|$allow|" "$FILES/sshd-00-ebooktrivia.conf")
  if [[ -e /etc/ssh/sshd_config.d/10-ebooktrivia.conf ]]; then
    rm -f /etc/ssh/sshd_config.d/10-ebooktrivia.conf
    changed "removed the old drop-in 10-ebooktrivia.conf"
  fi
  if ! sshd -t; then
    rm -f "$SSHD_DROPIN"
    die "sshd -t rejected the configuration; the drop-in was removed again"
  fi
  # The effective configuration must be the drop-in's.
  local line effective
  effective=$(sshd -T)
  while read -r line; do
    [[ -z $line || $line == \#* ]] && continue
    [[ ${line,,} == allowusers* ]] && continue
    grep -qxiF "$line" <<<"$effective" || die "sshd -T does not show \"$line\" from $SSHD_DROPIN"
  done <"$FILES/sshd-00-ebooktrivia.conf"
  ensure_unit_enabled sshd now
  # Reload on every run: cheap, keeps sessions, and the daemon cannot keep a stale configuration.
  systemctl reload sshd
  ok "sshd configuration valid (sshd -t) and reloaded"
}

step_audit_cockpit() {
  step "auditd and cockpit"
  # ausearch (host-check's AVC check) reads what auditd writes.
  if ((SIM)); then
    ensure_unit_enabled auditd
    skipped_container "starting auditd (the kernel audit log is host-wide); enabled, and started on the VM"
  else
    ensure_unit_enabled auditd now
  fi
  # Cloud images often ship cockpit.socket (port 9090): host-check allows no such listener.
  if systemctl cat cockpit.socket >/dev/null 2>&1 &&
    { systemctl is-enabled --quiet cockpit.socket 2>/dev/null || systemctl is-active --quiet cockpit.socket; }; then
    systemctl disable --now --quiet cockpit.socket
    changed "cockpit.socket disabled and stopped"
  else
    ok "cockpit.socket not installed or off"
  fi
}

step_fail2ban() {
  step "fail2ban"
  put_file /etc/fail2ban/jail.d/90-ebooktrivia.local 644 root root <"$FILES/fail2ban-90-ebooktrivia.local"
  local conf_changed=$LAST_CHANGED was_active=0
  systemctl is-active --quiet fail2ban && was_active=1
  ensure_unit_enabled fail2ban now
  if ((conf_changed && was_active)); then
    systemctl restart fail2ban
    changed "fail2ban restarted"
  fi
}

step_dnf_automatic() {
  step "dnf-automatic (security updates)"
  put_file /etc/dnf/automatic.conf 644 root root <"$FILES/dnf-automatic.conf"
  ensure_unit_enabled dnf-automatic.timer now
}

step_chrony() {
  step "chrony"
  if ((SIM)); then
    ensure_unit_enabled chronyd
    skipped_container "starting chronyd (it would steer the container host's clock); enabled, and started on the VM"
  else
    ensure_unit_enabled chronyd now
  fi
}

# The app user (every container's traffic leaves through its pasta process) may not reach the
# provider's metadata service (169.254.0.0/16) or this host's own addresses, except DNS; replies on
# connections others opened (Caddy's socket) pass. The rules: files/ebt-egress.nft.
step_egress_guard() {
  step "egress guard (nftables, app user)"
  local was_active=0
  systemctl is-active --quiet ebt-egress-guard.service && was_active=1
  # Checked by nft before it is installed: a broken file on disk would fail the guard at the next
  # boot, and with it the app user's systemd (Requires=) and every container.
  local rendered
  assert_root_path /etc/nftables/ebt-egress.nft
  rendered=$(mktemp -p /etc/nftables .ebt-egress-check.XXXXXX)
  # shellcheck disable=SC2064 # the path is fixed now, on purpose
  trap "rm -f '$rendered'" EXIT
  sed "s/@APP@/$APP/g" "$FILES/ebt-egress.nft" >"$rendered"
  local check_errors
  if ! check_errors=$(nft -c -f "$rendered" 2>&1); then
    die "the egress guard's rules ($FILES/ebt-egress.nft) do not load: ${check_errors//$'\n'/ }; the installed /etc/nftables/ebt-egress.nft is unchanged"
  fi
  put_file /etc/nftables/ebt-egress.nft 644 root root <"$rendered"
  local rules_changed=$LAST_CHANGED
  rm -f "$rendered"
  trap - EXIT
  put_file /etc/systemd/system/ebt-egress-guard.service 644 root root <"$FILES/ebt-egress-guard.service"
  local unit_changed=$LAST_CHANGED
  if ((unit_changed)); then systemctl daemon-reload; fi
  # Starts the guard when it is not running; never restarts it.
  ensure_unit_enabled ebt-egress-guard.service now
  if ((was_active)); then
    # The app user's systemd Requires= the guard, and systemd passes a restart on to Requires=
    # dependents: restarting the guard would restart that manager and every container. New rules
    # are loaded with a reload instead (ExecReload runs nft -f, one atomic transaction), which
    # does not propagate.
    if ((rules_changed)); then
      systemctl reload ebt-egress-guard.service
      changed "ebt-egress-guard.service reloaded the rules (no restart)"
    fi
    LAST_CHANGED=$unit_changed
    restart_needed "ebt-egress-guard.service (restarts the whole stack: the app user's systemd and every container)"
  fi
  nft list table inet ebt_egress >/dev/null 2>&1 || die "table inet ebt_egress is not loaded"
  # Fail closed (review SL3): the app user's systemd, which starts every container, needs the
  # guard. Scoped to that user's manager, so other users' sessions do not depend on it.
  local uid
  uid=$(app_uid)
  ensure_dir "/etc/systemd/system/user@$uid.service.d" 755 root root
  put_file "/etc/systemd/system/user@$uid.service.d/90-ebooktrivia-egress-guard.conf" 644 root root < <(printf '%s\n' \
    "# Managed by infra/provision: the app user's manager (and its containers) start only with the egress guard." \
    "[Unit]" "Requires=ebt-egress-guard.service" "After=ebt-egress-guard.service")
  if ((LAST_CHANGED)); then systemctl daemon-reload; fi
}

# put_env_file DEST TEMPLATE [DROPPED_KEY...]: see infra/provision/files/env/*.env for the rules.
put_env_file() {
  local dest=$1 template=$2 rendered
  shift 2
  rendered=$(mktemp)
  render_env "$dest" "$template" "$@" >"$rendered"
  if [[ $dest == "$ETC/worker.env" && -e $ETC/drill-vm ]]; then
    # A restore-drill VM's worker must not push to the real Kuma monitors or hold the keys that open a real send (lib.sh drill_scrub_worker_env).
    drill_scrub_worker_env <"$rendered" >"$rendered.drill" && mv "$rendered.drill" "$rendered"
  fi
  put_file "$dest" 640 root "$APP" <"$rendered"
  rm -f "$rendered"
}

# render_env DEST TEMPLATE [DROPPED_KEY...]: the content DEST should have, on stdout. A key
# already in DEST keeps its value, even an empty one. Otherwise @GEN@ becomes 64 random hex
# characters, @DOMAIN@ the configured DOMAIN, and @GEN_TOKEN_SHA256@ the SHA-256 of a new random
# token, which is written to $ETC/glitchtip-hook.token (root, 0600) for the operator. Keys the operator added to DEST stay,
# except the DROPPED_KEYs (moved elsewhere by this version). Log lines go to stderr. Runs in this
# shell (only its output is redirected), so the change counter is kept.
render_env() {
  local dest=$1 template=$2 line key spec value token
  shift 2
  local -A seen=()
  for key in "$@"; do seen[$key]=1; done
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      key=${BASH_REMATCH[1]}
      spec=${BASH_REMATCH[2]}
      seen[$key]=1
      if [[ -f $dest ]] && grep -q "^$key=" "$dest"; then
        # Present, even empty (an operator's "off"): kept as it is.
        value=$(env_value "$dest" "$key")
      elif [[ $spec == "@GEN_TOKEN_SHA256@" ]]; then
        token=$(random_hex)
        assert_root_path "$ETC/glitchtip-hook.token"
        (umask 077 && printf '%s\n' "$token" >"$ETC/glitchtip-hook.token")
        changed "$ETC/glitchtip-hook.token: new GlitchTip hook token; put it in GlitchTip's webhook URL, then delete the file" >&2
        value=$(sha256_hex "$token")
      else
        value=${spec//@GEN@/$(random_hex)}
        value=${value//@DOMAIN@/$CFG_DOMAIN}
      fi
      printf '%s=%s\n' "$key" "$value"
    else
      printf '%s\n' "$line"
    fi
  done <"$template"
  if [[ -f $dest ]]; then
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line =~ ^([A-Z_][A-Z0-9_]*)= ]] && [[ -z ${seen[${BASH_REMATCH[1]}]:-} ]]; then
        printf '%s\n' "$line"
      fi
    done <"$dest"
  fi
}

step_config_files() {
  step "/etc/ebooktrivia (root-owned) and data directories"
  ensure_dir "$ETC" 750 root "$APP"
  local dir
  for dir in caddy postgres valkey; do ensure_dir "$ETC/$dir" 750 root "$APP"; done
  ensure_dir /srv/lp 750 "$APP" "$APP"
  # The SDK files (build-images.sh sdk) Caddy serves at api.<DOMAIN>/sdk/; the app user writes them.
  ensure_dir /srv/sdk 750 "$APP" "$APP"
  ensure_dir /srv/data 750 "$APP" "$APP"
  # Inside the app user's directories the app user creates the rest.
  app_ensure_dir /srv/lp/hosts 750
  app_ensure_dir /srv/data/deliverables 750

  step "env files (0640 root:$APP, secrets generated here)"
  # The superuser password lives in a file the postgres image reads at first start
  # (POSTGRES_PASSWORD_FILE), not in the container's environment (security review S13).
  local superuser
  superuser=$(env_value "$ETC/postgres.env" POSTGRES_PASSWORD)
  if [[ ! -f $ETC/postgres/superuser.pass ]]; then
    put_file "$ETC/postgres/superuser.pass" 640 root "$APP" < <(printf '%s\n' "${superuser:-$(random_hex)}")
  else
    local current
    current=$(cat "$ETC/postgres/superuser.pass")
    put_file "$ETC/postgres/superuser.pass" 640 root "$APP" < <(printf '%s\n' "$current")
  fi
  local name
  for name in public admin worker internal migrate valkey walg restic; do
    put_env_file "$ETC/$name.env" "$FILES/env/$name.env"
    case $name in
      public) restart_needed public@a.service public@b.service ;;
      migrate | restic) ;; # a one-shot job's settings: read at its next run
      walg) restart_needed postgres.service ;;
      *) restart_needed "$name.service" ;;
    esac
  done
  put_env_file "$ETC/postgres.env" "$FILES/env/postgres.env" POSTGRES_PASSWORD
  restart_needed postgres.service
  if [[ -e $ETC/drill-vm ]]; then note "$ETC/drill-vm: worker.env has both Kuma push URLs blank and no messaging or conversions private key (a restore drill acts on nothing real)"; fi

  step "wal-g key files (mounted read-only into the postgres container, never environment)"
  # The libsodium key encrypts every backup and WAL segment: generated ONCE (a present key is kept, and rewritten only to enforce its
  # mode and owner), and the Owner must escrow it the day it is made (docs/escrow.md): backups cannot be read without it.
  local walg_key walg_creds
  walg_key=$(cat "$ETC/postgres/walg_libsodium.key" 2>/dev/null || true)
  put_file "$ETC/postgres/walg_libsodium.key" 640 root "$APP" < <(printf '%s\n' "${walg_key:-$(random_hex)}")
  if [[ -z $walg_key ]]; then note "NEW wal-g libsodium key in $ETC/postgres/walg_libsodium.key: put a copy in the escrow NOW (docs/escrow.md); never change it afterwards"; fi
  restart_needed postgres.service
  # The S3 credentials are the operator's (an AWS shared-credentials file): placeholders until filled in, which host-check.sh reports.
  walg_creds=$(cat "$ETC/postgres/walg_aws_credentials" 2>/dev/null || true)
  put_file "$ETC/postgres/walg_aws_credentials" 640 root "$APP" < <(printf '%s\n' "${walg_creds:-[default]
aws_access_key_id = __SET_ME__
aws_secret_access_key = __SET_ME__}")
  restart_needed postgres.service

  step "Caddy"
  put_file "$ETC/caddy/Caddyfile" 640 root "$APP" <"$REPO/infra/caddy/Caddyfile"
  restart_needed caddy.service
  put_file "$ETC/caddy.env" 640 root "$APP" < <(printf 'DOMAIN=%s\nACME_EMAIL=%s\nADMIN_ALLOWED_CIDRS=%s\nGLITCHTIP_ALLOWED_CIDRS=%s\nWAHA_ALLOWED_CIDRS=%s\nMONITOR_ALLOWED_CIDRS=%s\n' \
    "$CFG_DOMAIN" "$CFG_ACME_EMAIL" "$CFG_ADMIN_ALLOWED_CIDRS" "$CFG_GLITCHTIP_ALLOWED_CIDRS" "$CFG_WAHA_ALLOWED_CIDRS" "$CFG_MONITOR_ALLOWED_CIDRS")
  restart_needed caddy.service

  step "Valkey (ACL users with password hashes, noeviction, AOF)"
  put_file "$ETC/valkey/valkey.conf" 640 root "$APP" <"$FILES/valkey/valkey.conf"
  restart_needed valkey.service
  # users.acl.template: default off; public ~rl:* ~cache:public:* with an explicit command
  # allowlist (-@all +ping +fcall +incr +pttl +pexpire +set: the worker-loaded rate-limit function, US-031, and the single-use
  # marks of Cap tokens; Cap itself is stateless; no INFO, no reads, no deletes; US-020); admin ~cache:admin:*;
  # worker ~ebt:* (BullMQ prefix) ~cache:worker:* plus +info (BullMQ and ioredis run INFO on
  # connect); admin and worker +@all -@dangerous -@admin; no pub/sub channels for any of them;
  # admin also no SCAN, RANDOMKEY, SCRIPT FLUSH or FUNCTION; ops +ping only (health check). Passwords are stored as
  # SHA-256 hashes; the plaintext is only in the clients' env files.
  local public_pw worker_pw admin_pw ops_pw
  public_pw=$(env_value "$ETC/public.env" VALKEY_PASSWORD)
  worker_pw=$(env_value "$ETC/worker.env" VALKEY_PASSWORD)
  admin_pw=$(env_value "$ETC/admin.env" VALKEY_PASSWORD)
  ops_pw=$(env_value "$ETC/valkey.env" REDISCLI_AUTH)
  [[ -n $public_pw && -n $worker_pw && -n $admin_pw && -n $ops_pw ]] || die "a Valkey password is missing from the env files"
  put_file "$ETC/valkey/users.acl" 640 root "$APP" < <(sed -e "s/@PUBLIC_SHA256@/$(sha256_hex "$public_pw")/" \
    -e "s/@WORKER_SHA256@/$(sha256_hex "$worker_pw")/" -e "s/@ADMIN_SHA256@/$(sha256_hex "$admin_pw")/" \
    -e "s/@OPS_SHA256@/$(sha256_hex "$ops_pw")/" "$FILES/valkey/users.acl.template")
  restart_needed valkey.service

  step "PostgreSQL client authentication"
  put_file "$ETC/postgres/pg_hba.conf" 640 root "$APP" <"$FILES/postgres/pg_hba.conf"
  restart_needed postgres.service

  step "SELinux labels of the provisioned config"
  if ((SIM)); then
    skipped_container "restorecon of $ETC/{caddy,postgres,valkey} (no SELinux in a container)"
  else
    # Every run (review CL7): a label changed by hand is put back; each relabeled file counts.
    local relabeled line
    relabeled=$(restorecon -RFv "$ETC/caddy" "$ETC/postgres" "$ETC/valkey")
    while IFS= read -r line; do
      [[ -n $line ]] && changed "relabeled: $line"
    done <<<"$relabeled"
    [[ -n $relabeled ]] || ok "$ETC/{caddy,postgres,valkey} labeled container_file_t"
  fi
}

# unit_of FILE: the service a quadlet file becomes (template instances for public@).
unit_of() {
  case $1 in
    public@.container | public@?.container | public@?.container.d) printf 'public@a.service public@b.service' ;;
    migrate.container) ;; # a one-shot: the next deploy runs it
    *.container) printf '%s.service' "${1%.container}" ;;
    caddy.socket) printf 'caddy.socket' ;;
  esac
}

step_quadlets() {
  step "quadlets (written by the app user $APP)"
  local home qdir udir any=0 file name
  home=$(app_home)
  qdir="$home/.config/containers/systemd"
  udir="$home/.config/systemd/user"
  for dir in "$home/.config" "$home/.config/containers" "$qdir" "$home/.config/systemd" "$udir"; do
    app_ensure_dir "$dir" 700
  done
  local -A managed=()
  for file in "$REPO"/infra/quadlet/*.container "$REPO"/infra/quadlet/*.network "$REPO"/infra/quadlet/*.volume; do
    name=$(basename "$file")
    managed[$name]=1
    app_put_file "$qdir/$name" 644 <"$file"
    ((LAST_CHANGED)) && any=1
    # shellcheck disable=SC2046 # unit_of prints a list of units
    restart_needed $(unit_of "$name")
  done
  local instance
  for instance in a b; do
    managed["public@$instance.container"]=1
    managed["public@$instance.container.d"]=1
    app_ensure_symlink "$qdir/public@$instance.container" public@.container
    ((LAST_CHANGED)) && any=1
    app_ensure_dir "$qdir/public@$instance.container.d" 700
    app_put_file "$qdir/public@$instance.container.d/10-network.conf" 644 <"$REPO/infra/quadlet/public@$instance.container.d/10-network.conf"
    ((LAST_CHANGED)) && any=1
    restart_needed "public@$instance.service"
  done
  # Units removed from the repository are removed here too (by the app user).
  # shellcheck disable=SC2016 # the ls argument expands in the app user's shell
  while IFS= read -r name; do
    [[ -n $name && -z ${managed[$name]:-} ]] || continue
    app_remove "$qdir/$name"
    any=1
  done < <(app_sh 'ls -A "$1"' "$qdir")
  app_put_file "$udir/caddy.socket" 644 <"$REPO/infra/quadlet/caddy.socket"
  ((LAST_CHANGED)) && any=1
  restart_needed caddy.socket
  if ((any)); then
    as_app systemctl --user daemon-reload
    changed "systemd --user daemon-reload ($APP)"
  fi
  # Generated units must exist: a quadlet the generator rejects produces no service.
  local unit
  for unit in "${EBT_SERVICES[@]}" "${EBT_ONESHOTS[@]}"; do
    as_app systemctl --user cat "$unit.service" >/dev/null 2>&1 || die "quadlet generator produced no $unit.service (check: /usr/libexec/podman/quadlet -dryrun -user)"
  done
  ok "quadlet units generated"
  if as_app systemctl --user is-enabled --quiet caddy.socket 2>/dev/null; then
    ok "caddy.socket enabled"
  else
    as_app systemctl --user enable --quiet caddy.socket
    changed "caddy.socket enabled"
  fi
}

# The CI deploy login (US-015, plan M4.4): a key whose ONLY power is the forced command infra/deploy/remote.sh, which takes a manifest
# of image digests of this repository's registry prefix and nothing else. Installed root-owned in /usr/local/sbin (a stolen key can run
# what is installed, not change it); started as `sudo -n` by the key's command=, and sudoers allows exactly its three invocations; the
# login has a shell only because the forced command needs one, no password, no group, and a home that only root can write (it cannot
# change its own authorized_keys). Without DEPLOY_* in provision.env no login exists, and an earlier one is revoked.
DEPLOY_SCRIPT=/usr/local/sbin/ebt-remote-deploy
DEPLOY_SUDOERS=/etc/sudoers.d/90-ebooktrivia-deploy

step_deploy_access() {
  step "CI deploy access (forced command $DEPLOY_SCRIPT)"
  local user=$CFG_DEPLOY_USER dhome=/home/$CFG_DEPLOY_USER
  put_file "$DEPLOY_SCRIPT" 755 root root <"$REPO/infra/deploy/remote.sh"
  ensure_dir /var/lib/ebooktrivia 755 root root
  ensure_dir /var/lib/ebooktrivia/deploy 700 root root
  ensure_dir /var/backups 755 root root # absent on a cloud image
  ensure_dir /var/backups/ebooktrivia 700 root root
  ensure_dir /var/backups/ebooktrivia/predeploy 700 root root
  if [[ -z $CFG_DEPLOY_PUBLIC_KEY ]]; then
    note "DEPLOY_* is not set in provision.env: no deploy login (an earlier one is revoked)"
    rm -f "$DEPLOY_SUDOERS" "$ETC/deploy.env" "$dhome/.ssh/authorized_keys" 2>/dev/null || true
    return 0
  fi
  if id -u "$user" >/dev/null 2>&1; then
    ok "user $user exists"
  else
    useradd --create-home --home-dir "$dhome" --shell /bin/bash --comment "ebooktrivia CI deploy (forced command)" "$user"
    changed "user $user created"
  fi
  if [[ $(getent passwd "$user" | cut -d: -f7) != /bin/bash ]]; then
    usermod --shell /bin/bash "$user"
    changed "user $user shell /bin/bash"
  fi
  if [[ $(passwd -S "$user" | awk '{print $2}') =~ ^(L|LK)$ ]]; then ok "user $user password locked"; else
    usermod -L "$user"
    changed "user $user password locked"
  fi
  if id -nG "$user" | tr ' ' '\n' | grep -qx wheel; then die "$user is in group wheel: the deploy login must not be an administrator"; fi
  # Root owns the home and .ssh (sshd's StrictModes accepts that), so the login cannot add a key or an option to its own authorized_keys.
  ensure_dir "$dhome" 755 root root
  ensure_dir "$dhome/.ssh" 755 root root
  # shellcheck disable=SC2016 # the key line holds the literal text $SSH_ORIGINAL_COMMAND, which sshd's shell expands
  put_file "$dhome/.ssh/authorized_keys" 644 root root < <(printf 'restrict,command="sudo -n %s \\"$SSH_ORIGINAL_COMMAND\\"" %s\n' "$DEPLOY_SCRIPT" "$CFG_DEPLOY_PUBLIC_KEY")
  put_file "$ETC/deploy.env" 600 root root < <(printf '# Managed by infra/provision: read by %s (never sourced).\nREGISTRY_PREFIX=%s\nAPP_USER=%s\n' "$DEPLOY_SCRIPT" "$CFG_DEPLOY_REGISTRY_PREFIX" "$APP")
  local rendered
  rendered=$(mktemp)
  printf '%s\n' "# Managed by infra/provision: the CI deploy login may run the forced command's three invocations as root, and nothing else." \
    "Defaults:$user !requiretty" \
    "$user ALL=(root) NOPASSWD: $DEPLOY_SCRIPT deploy, $DEPLOY_SCRIPT rollback, $DEPLOY_SCRIPT status" >"$rendered"
  # A broken sudoers file locks everyone out of sudo: checked before it is installed.
  if ! visudo -cf "$rendered" >/dev/null; then
    rm -f "$rendered"
    die "visudo rejected the deploy sudoers rule; nothing was installed"
  fi
  put_file "$DEPLOY_SUDOERS" 440 root root <"$rendered"
  rm -f "$rendered"
}

# The nightly backups (US-015): the wal-g base backup 20:30 UTC and restic 21:30 UTC, as systemd user timers of the app user (every container
# is its own). The units name this checkout (@REPO@), so it must stay readable by the app user, like the quadlets' source.
step_backup_timers() {
  step "backup timers (wal-g base backup, restic; units in $REPO/infra/backup/units)"
  local udir name any=0
  udir="$(app_home)/.config/systemd/user"
  for name in ebt-backup-base.service ebt-backup-base.timer ebt-backup-restic.service ebt-backup-restic.timer ebt-ops-check.service ebt-ops-check.timer; do
    app_put_file "$udir/$name" 644 < <(sed "s|@REPO@|$REPO|g" "$REPO/infra/backup/units/$name")
    if ((LAST_CHANGED)); then any=1; fi
  done
  if ((any)); then
    as_app systemctl --user daemon-reload
    changed "systemd --user daemon-reload ($APP)"
  fi
  for name in ebt-backup-base.timer ebt-backup-restic.timer; do
    if [[ -e $ETC/drill-vm ]]; then
      # A restore-drill VM (docs/restore-drill.md step 3: root made the marker BEFORE provisioning) reads production's storage and must never
      # back up to it: its retention would delete there. The timers stay off, and the backup scripts refuse to run (infra/backup/lib.sh).
      if as_app systemctl --user is-enabled --quiet "$name" 2>/dev/null; then
        as_app systemctl --user disable --now --quiet "$name"
        changed "$name disabled ($ETC/drill-vm: a restore-drill VM)"
      else
        ok "$name off ($ETC/drill-vm: a restore-drill VM)"
      fi
    elif as_app systemctl --user is-enabled --quiet "$name" 2>/dev/null; then ok "$name enabled"; else
      as_app systemctl --user enable --now --quiet "$name"
      changed "$name enabled and started"
    fi
  done
  # The disk and pg_wal check runs on every VM, a drill VM included (it only reads, and raises alerts in its own database).
  if as_app systemctl --user is-enabled --quiet ebt-ops-check.timer 2>/dev/null; then ok "ebt-ops-check.timer enabled"; else
    as_app systemctl --user enable --now --quiet ebt-ops-check.timer
    changed "ebt-ops-check.timer enabled and started"
  fi
}

printf 'ebooktrivia provisioning: domain %s, app user %s%s\n' "$CFG_DOMAIN" "$APP" "$( ((SIM)) && printf ' (local container stand-in)')"
step_packages
step_app_user
step_sysctl
step_selinux
step_firewalld
step_sshd
step_deploy_access
step_audit_cockpit
step_fail2ban
step_dnf_automatic
step_chrony
step_egress_guard
step_config_files
step_quadlets
step_backup_timers
printf '\n'
restart_summary
printf 'summary: %d changed, %d skipped in container\n' "$CHANGES" "$SKIPS"
