#!/bin/sh
# Turns a restored (wal-g backup-fetch) data directory into a point-in-time recovery (US-015). POSIX sh, run INSIDE the PostgreSQL
# image as the postgres user, by infra/backup/restore-pitr.sh (podman, a clean VM) and by infra/verify/local/backup-pitr.sh (docker,
# the local proof): the same lines in both, so the proof tests the restore.
#
#   recovery-conf.sh PGDATA [TARGET_TIME [SOURCE]]
#
# recovery.signal makes the server recover from the archive on its next start; restore_command fetches (and decrypts) each WAL segment
# with wal-g; recovery_target_time stops at that instant (inclusive; without it the recovery runs to the end of the archived WAL);
# recovery_target_action = promote opens the database for writes when it gets there. TARGET_TIME is a timestamptz literal such as
# 2026-11-22 10:15:00+00 (UTC); anything else is refused.
# SOURCE (a restore DRILL) is NAME=VALUE, the wal-g setting that names the PRODUCTION storage (WALG_S3_PREFIX=s3://..., or WALG_FILE_PREFIX=/path
# in the local proof): restore_command then reads from it with `env SOURCE wal-g wal-fetch`, while the server's own settings (and so its
# archive_command) keep pointing at the scratch storage: a drill that promotes writes its timeline to the scratch storage, never to production's.
set -eu
pgdata=${1:?usage: recovery-conf.sh PGDATA [TARGET_TIME [SOURCE]]}
target=${2:-}
source_setting=${3:-}
case $source_setting in
  '') fetch="wal-g wal-fetch %f %p" ;;
  WALG_S3_PREFIX=s3://[A-Za-z0-9._-]* | WALG_FILE_PREFIX=/[A-Za-z0-9._/-]*)
    case $source_setting in
      *[!A-Za-z0-9._:/=-]*)
        echo "SOURCE may hold letters, digits and . _ : / = - only" >&2
        exit 2
        ;;
    esac
    fetch="env $source_setting wal-g wal-fetch %f %p"
    ;;
  *)
    echo "SOURCE must be WALG_S3_PREFIX=s3://BUCKET/PATH or WALG_FILE_PREFIX=/PATH" >&2
    exit 2
    ;;
esac
case $target in
  '' | [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*) ;;
  *)
    echo "TARGET_TIME must look like '2026-11-22 10:15:00+00'" >&2
    exit 2
    ;;
esac
case $target in
  *[!0-9:.+' '-]*)
    echo "TARGET_TIME may hold digits, space, colon, dot, plus and minus only" >&2
    exit 2
    ;;
esac
[ -d "$pgdata" ] || {
  echo "$pgdata is not a directory" >&2
  exit 2
}
touch "$pgdata/recovery.signal"
{
  echo "restore_command = '$fetch'"
  echo "recovery_target_action = 'promote'"
  if [ -n "$target" ]; then
    echo "recovery_target_time = '$target'"
    echo "recovery_target_inclusive = true"
  fi
} >>"$pgdata/postgresql.auto.conf"
echo "recovery configured in $pgdata${target:+ to $target}"
