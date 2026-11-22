#!/usr/bin/env bash
# The nightly secondary backup with restic (US-015, plan M4.5), run by ebt-backup-restic.timer as the app user:
#
#   bash infra/backup/restic-backup.sh
#
# Three snapshots a night into one restic repository on S3-compatible storage (a second location than wal-g's, encrypted with
# RESTIC_PASSWORD from /etc/ebooktrivia/restic.env), each its own stream so each keeps its own history:
#   db/ebooktrivia.dump   pg_dump -Fc of the ebooktrivia database (a logical copy that restores into any PostgreSQL 18)
#   db/globals.sql        pg_dumpall --globals-only (roles and their password hashes: the logins the env files' passwords belong to)
#   /srv/data             the ebook PDFs, imports and proofs (read-only mount)
# Retention: 7 daily, 4 weekly and 6 monthly snapshots (restic forget --prune), a structure check every night and a read of a rotating 1/28
# slice of the data (by the day of the year, so every pack is read within 28 days). Refuses to run on a restore-drill VM (lib.sh). restic runs in its official image (pinned by digest, docs/versions.md) as a one-shot container
# on ebt-backup (egress; the only other container there is PostgreSQL), --env-file restic.env, nothing installed on the host.
# On ANY failure: an `alerts` row (backup_restic_failed, critical), a journal line, exit 1. On success: heartbeats `backup_restic`.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/backup/lib.sh
. "$HERE/lib.sh"
refuse_on_drill_vm
RESTIC_IMAGE=${EBT_RESTIC_IMAGE:-docker.io/restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510}
ENV_FILE=${EBT_RESTIC_ENV:-/etc/ebooktrivia/restic.env}
DATA_DIR=${EBT_RESTIC_DATA_DIR:-/srv/data}
# A fixed host name: a rebuilt VM keeps appending to the same snapshot series.
HOST=ebooktrivia

# restic ARGS...: one container run; -i so a stream can be piped in.
restic() {
  podman run --rm -i --network ebt-backup --env-file "$ENV_FILE" -v "$DATA_DIR:/srv/data:ro,z" "$RESTIC_IMAGE" "$@"
}

fail() {
  backup_log "RESTIC BACKUP FAILED: $1"
  raise_alert backup_restic_failed critical "The nightly restic backup failed at: $1. The earlier snapshots are untouched; see journalctl --user -t ebt-backup and docs/runbooks/backups.md" || true
  exit 1
}

started=$(date +%s)
if ! restic cat config >/dev/null 2>&1; then
  backup_log "restic: no repository yet: init"
  restic init >/dev/null || fail "restic init (RESTIC_REPOSITORY, the S3 credentials)"
fi

backup_log "restic: pg_dump -Fc of ebooktrivia"
podman exec postgres pg_dump -U postgres -Fc ebooktrivia | restic backup --quiet --host "$HOST" --tag nightly --stdin --stdin-filename db/ebooktrivia.dump || fail "pg_dump | restic backup"
backup_log "restic: pg_dumpall --globals-only"
podman exec postgres pg_dumpall -U postgres --globals-only | restic backup --quiet --host "$HOST" --tag nightly --stdin --stdin-filename db/globals.sql || fail "pg_dumpall | restic backup"
backup_log "restic: $DATA_DIR"
restic backup --quiet --host "$HOST" --tag nightly /srv/data || fail "restic backup of $DATA_DIR"

backup_log "restic: retention 7 daily, 4 weekly, 6 monthly"
restic forget --quiet --host "$HOST" --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune || fail "restic forget --prune"
# The slice of the data read back rotates by the day of the year (1/28 ... 28/28, then again), so every pack is read within 28 days.
subset="$((10#$(date +%j) % 28 + 1))/28"
backup_log "restic: check (structure, and the data slice $subset)"
restic check --quiet --read-data-subset="$subset" || fail "restic check"

seconds=$(($(date +%s) - started))
snapshots=$(restic snapshots --host "$HOST" --compact 2>/dev/null | grep -c '^[0-9a-f]\{8\} ' || true)
beat backup_restic "{\"seconds\": $seconds, \"snapshots\": $snapshots}" || fail "writing the heartbeat"
backup_log "RESTIC BACKUP OK: $snapshots snapshots, $seconds s"
