#!/usr/bin/env bash
# The VM's free disk and PostgreSQL's pg_wal (US-015 review), run every 5 minutes by ebt-ops-check.timer as the app user:
#
#   bash infra/backup/ops-check.sh
#
# Why a host job and not a worker sweeper: only the host sees its disks (the worker runs in a container), and only a superuser may list pg_wal
# (pg_ls_waldir), which the postgres container's local socket gives the app user's `podman exec`. The alerts are `alerts` rows (source monitor)
# that the relay sends to the Owner, with fixed text and numbers only:
#   disk_free_low (warning)    less than 20 % free on a filesystem that holds PostgreSQL's data, the backups or the ebook files;
#   disk_free_critical         less than 10 % free: a full disk stops PostgreSQL's writes;
#   pg_wal_large (critical)    pg_wal over 2 GiB. A failing archive command keeps EVERY WAL segment on the disk: with archive_timeout = 60 s and a
#                              heartbeat that keeps WAL moving that is a 16 MB segment a minute, about 23 GB a day (docs/runbooks/backups.md).
# After every run it writes the heartbeat `ops_check`; the worker raises ops_check_stale when it is an hour old (apps/worker/src/ops-checks.ts), so a
# dead timer is not silence.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/backup/lib.sh
. "$HERE/lib.sh"
WAL_LIMIT_BYTES=${EBT_WAL_LIMIT_BYTES:-$((2 * 1024 * 1024 * 1024))}
WARN_PERCENT=20
CRITICAL_PERCENT=10

# The least free filesystem of the places that can fill: PostgreSQL's data volume, the pre-deploy dumps and the files.
worst=100
for path in "$(podman volume inspect ebt-pgdata --format '{{.Mountpoint}}' 2>/dev/null || true)" /var/backups /srv/data; do
  [[ -n $path && -e $path ]] || continue
  read -r size avail < <(df -B1 --output=size,avail "$path" | tail -n 1)
  ((size > 0)) || continue
  percent=$((avail * 100 / size))
  if ((percent < worst)); then worst=$percent; fi
done

wal=$(psql_pg -c "SELECT coalesce(sum(size), 0)::bigint FROM pg_ls_waldir()") || {
  backup_log "ops check: cannot read pg_wal (is postgres.service up?)"
  exit 1
}

if ((worst < CRITICAL_PERCENT)); then
  raise_alert disk_free_critical critical "The VM's disk has ${worst} % free (limit ${CRITICAL_PERCENT} %): a full disk stops PostgreSQL's writes. Check pg_wal (a failing WAL archive fills it), /var/backups and /srv/data; see docs/runbooks/backups.md" || true
elif ((worst < WARN_PERCENT)); then
  raise_alert disk_free_low warning "The VM's disk has ${worst} % free (limit ${WARN_PERCENT} %): check pg_wal (a failing WAL archive fills it), /var/backups and /srv/data before it is full; see docs/runbooks/backups.md" || true
fi
if ((wal > WAL_LIMIT_BYTES)); then
  raise_alert pg_wal_large critical "pg_wal holds $((wal / 1024 / 1024 / 1024)) GB (limit $((WAL_LIMIT_BYTES / 1024 / 1024 / 1024)) GB): the WAL archive is failing or far behind and every segment stays on the disk (about 16 MB a minute); fix the archive (credentials, endpoint), docs/runbooks/backups.md" || true
fi

beat ops_check "{\"free_percent\": $worst, \"pg_wal_bytes\": $wal}" || {
  backup_log "ops check: could not write the heartbeat"
  exit 1
}
if ((worst < WARN_PERCENT || wal > WAL_LIMIT_BYTES)); then backup_log "ops check: ${worst} % free at worst, pg_wal $((wal / 1024 / 1024)) MB: alert raised"; fi
