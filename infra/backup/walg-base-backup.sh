#!/usr/bin/env bash
# The nightly wal-g base backup (US-015, plan M4.5), run by ebt-backup-base.timer as the app user:
#
#   bash infra/backup/walg-base-backup.sh
#
# wal-g runs INSIDE the postgres container (podman exec), so it has the container's wal-g settings (walg.env, the libsodium key and the
# S3 credentials as files) and its egress on ebt-backup. In order:
#   1. wal-g backup-push of the data directory (encrypted client-side with libsodium, zstd, to S3-compatible storage);
#   2. a WAL segment switch, then wait until PostgreSQL's archiver has shipped it: the new backup is restorable to "now" and the WAL
#      chain after it is whole (the archive_command is the other half of the point-in-time recovery, RPO about a minute);
#   3. wal-g wal-verify integrity: every WAL segment from the oldest backup on is in storage, no gap;
#   4. retention: the newest 14 full backups (nightly = 14 days) and the WAL they need, nothing older (wal-g delete retain FULL 14);
#   5. heartbeats `backup_base` is written (the worker alerts when it is older than 26 hours).
# On ANY failure: an `alerts` row (backup_base_failed, critical, once an hour while it lasts), a journal line, exit 1. A failed night leaves the
# earlier backups and the WAL archive untouched.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/backup/lib.sh
. "$HERE/lib.sh"
refuse_on_drill_vm
RETAIN=14
ARCHIVE_WAIT_SECONDS=300

walg() { podman exec -u postgres postgres wal-g "$@"; }

fail() {
  backup_log "BASE BACKUP FAILED: $1"
  raise_alert backup_base_failed critical "The nightly wal-g base backup failed at: $1. The earlier backups are untouched; see journalctl --user -t ebt-backup and docs/runbooks/backups.md" || true
  exit 1
}

started=$(date +%s)
backup_log "base backup: wal-g backup-push"
# shellcheck disable=SC2016 # $PGDATA is expanded by the shell inside the container
podman exec -u postgres postgres sh -c 'wal-g backup-push "$PGDATA"' || fail "backup-push"

backup_log "base backup: switching the WAL segment and waiting for the archiver"
segment=$(psql_pg -c "SELECT pg_walfile_name(pg_switch_wal())") || fail "pg_switch_wal"
waited=0
until [[ $(psql_pg -c "SELECT coalesce(last_archived_wal >= '$segment', false) FROM pg_stat_archiver") == t ]]; do
  ((waited < ARCHIVE_WAIT_SECONDS)) || fail "the archiver did not ship $segment within ${ARCHIVE_WAIT_SECONDS}s"
  sleep 5
  waited=$((waited + 5))
done

backup_log "base backup: wal-verify integrity"
verify=$(walg wal-verify integrity 2>&1) || fail "wal-verify (command failed)"
grep -qE 'integrity check status: OK' <<<"$verify" || fail "wal-verify integrity: $(grep -m1 -i 'status' <<<"$verify" || printf 'no status line')"

backup_log "base backup: retention, the newest $RETAIN full backups"
walg delete retain FULL "$RETAIN" --confirm || fail "retention (delete retain)"

count=$(walg backup-list 2>/dev/null | tail -n +2 | grep -c . || true)
seconds=$(($(date +%s) - started))
beat backup_base "{\"seconds\": $seconds, \"backups\": $count}" || fail "writing the heartbeat"
backup_log "BASE BACKUP OK: $count backups in storage, $seconds s"
