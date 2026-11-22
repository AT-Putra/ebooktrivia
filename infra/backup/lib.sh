# shellcheck shell=bash
# Helpers of the backup scripts (sourced, never run; US-015). They run as the rootless podman app user (systemd user timers,
# infra/backup/units), so podman and the user journal are the app user's own.
#
#   backup_log MESSAGE       stdout and the journal (journalctl --user -t ebt-backup)
#   psql_pg [ARGS]           psql as the PostgreSQL superuser over the container's local socket (the one login that needs no password)
#   raise_alert KIND SEV MSG an `alerts` row (source monitor) unless an unresolved one of the same kind is under an hour old: the
#                            worker's alert relay (apps/worker/src/alert-relay.ts) sends it to the Owner. Fixed text only: no PII
#   beat COMPONENT JSON      heartbeats(component, beat_at, info): the worker alerts when it is older than 26 hours (ops-checks.ts)

backup_log() {
  printf '%s\n' "$*"
  logger -t ebt-backup -- "$*" 2>/dev/null || true
}

# A restore-drill VM (the marker /etc/ebooktrivia/drill-vm, restore-pitr.sh --drill, docs/restore-drill.md) holds production's storage settings to READ
# from. A backup run there would write to it and its retention (wal-g delete, restic forget --prune) would delete in it: refuse, whoever started it.
refuse_on_drill_vm() {
  local marker=${EBT_DRILL_MARKER:-/etc/ebooktrivia/drill-vm}
  [[ -e $marker ]] || return 0
  backup_log "refusing to back up: this is a restore-drill VM ($marker exists); a backup here would write to and prune production's storage"
  exit 1
}

psql_pg() {
  podman exec -i -u postgres postgres psql -X -q -At -v ON_ERROR_STOP=1 -d ebooktrivia "$@"
}

raise_alert() {
  [[ $1 =~ ^[a-z_]+$ && $2 =~ ^(info|warning|critical)$ ]] || return 1
  psql_pg -v "kind=$1" -v "severity=$2" -v "message=$3" <<'SQL'
INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload)
SELECT 'monitor', :'kind', :'severity', :'kind', :'message', '{}'::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM public.alerts a WHERE a.dedupe_key = :'kind' AND a.resolved_at IS NULL AND a.created_at > now() - interval '1 hour');
SQL
}

beat() {
  [[ $1 =~ ^[a-z_]+$ ]] || return 1
  psql_pg -v "component=$1" -v "info=$2" <<'SQL'
INSERT INTO public.heartbeats (component, beat_at, info) VALUES (:'component', now(), :'info'::jsonb)
ON CONFLICT (component) DO UPDATE SET beat_at = EXCLUDED.beat_at, info = EXCLUDED.info;
SQL
}
