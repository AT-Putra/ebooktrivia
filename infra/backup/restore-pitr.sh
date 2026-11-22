#!/usr/bin/env bash
# Point-in-time restore of PostgreSQL on a CLEAN VM (US-015, plan M4.5; the drill is docs/restore-drill.md), as the app user:
#
#   sudo infra/provision/as-app.sh bash infra/backup/restore-pitr.sh --drill --source-prefix s3://PRODUCTION/PATH --yes-wipe-database [--target-time '2026-11-22 10:15:00+00']
#   sudo infra/provision/as-app.sh bash infra/backup/restore-pitr.sh --disaster --yes-wipe-database [--target-time '2026-11-22 10:15:00+00']
#
# ONE OF --drill AND --disaster IS REQUIRED, because a restore that promotes ARCHIVES: the promoted server writes its own timeline (and its
# history file) into whatever storage walg.env names, and a later "latest" recovery of production would follow that timeline.
#   --disaster  the production VM is gone and this one takes its place: walg.env holds the PRODUCTION storage, and the new timeline belongs there.
#   --drill     a rehearsal on a VM that is NOT production. walg.env must name a SCRATCH prefix (it is where this server archives), and
#               --source-prefix names production's prefix, which is only READ from: it goes to the backup-fetch and into restore_command
#               (`env WALG_S3_PREFIX=<production> wal-g wal-fetch`), never into the server's own settings. The drill VM carries the marker
#               /etc/ebooktrivia/drill-vm (made by root before provisioning), which keeps the backup timers off (provision.sh) and makes the backup
#               scripts refuse to run: their retention would delete in production's storage. Use read-only keys for the production prefix (E11).
#
# Needs only what docs/escrow.md lists: /etc/ebooktrivia/walg.env, postgres/walg_libsodium.key and postgres/walg_aws_credentials put back
# from the escrow, the image localhost/ebooktrivia/postgres-walg:18.6 (build-images.sh, or pulled by digest), and the provisioned quadlets.
#   1. stops postgres.service and EMPTIES the ebt-pgdata volume (hence the flag: this deletes the database on THIS host);
#   2. wal-g backup-fetch LATEST (decrypts with the libsodium key) into the volume, in a one-shot container on ebt-backup;
#   3. writes recovery.signal, restore_command and the target (infra/backup/recovery-conf.sh, the same lines the local proof runs);
#   4. starts postgres.service: PostgreSQL replays the archived WAL (decrypting each segment) up to the target time, or to the end of the
#      archive without --target-time, and promotes itself;
#   5. waits until it is out of recovery, then prints the timings and the newest row of the audit log.
# Afterwards: `systemctl --user start migrate.service` (nothing to apply), start the stack in the deploy order, host-check.sh.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
IMAGE=${EBT_PG_IMAGE:-localhost/ebooktrivia/postgres-walg:18.6}
ETC=${EBT_ETC:-/etc/ebooktrivia} # the override is for infra/verify/src/backup.test.ts, which runs the refusals
DRILL_MARKER=$ETC/drill-vm
WAIT_SECONDS=${EBT_RESTORE_WAIT_SECONDS:-5400}

usage() {
  printf 'usage: %s (--drill --source-prefix s3://PRODUCTION/PATH | --disaster) --yes-wipe-database [--target-time "YYYY-MM-DD HH:MM:SS+00"]\n' "$0" >&2
  exit 2
}

wipe=0
mode=""
source_prefix=""
target=""
while (($#)); do
  case $1 in
    --yes-wipe-database) wipe=1 ;;
    --drill | --disaster)
      [[ -z $mode ]] || usage
      mode=${1#--}
      ;;
    --source-prefix)
      source_prefix=${2:?--source-prefix needs a value}
      shift
      ;;
    --target-time)
      target=${2:?--target-time needs a value}
      shift
      ;;
    *) usage ;;
  esac
  shift
done
[[ -n $mode ]] || {
  printf 'refusing: say which restore this is, --drill (a rehearsal: production storage is only read) or --disaster (this VM replaces production)\n' >&2
  usage
}
((wipe)) || {
  printf 'refusing: this EMPTIES the database volume ebt-pgdata of this host; pass --yes-wipe-database\n' >&2
  exit 2
}
for file in "$ETC/walg.env" "$ETC/postgres/walg_libsodium.key" "$ETC/postgres/walg_aws_credentials"; do
  [[ -r $file ]] || {
    printf 'missing %s: put it back from the escrow first (docs/escrow.md)\n' "$file" >&2
    exit 1
  }
done
if grep -qE '__SET_ME__' "$ETC/walg.env" "$ETC/postgres/walg_aws_credentials"; then
  printf 'walg.env or walg_aws_credentials still hold __SET_ME__: fill them in from the escrow\n' >&2
  exit 1
fi

# The storage prefix this server will ARCHIVE to (walg.env, read by postgres.service).
own_prefix=$(sed -n 's/^WALG_S3_PREFIX=//p' "$ETC/walg.env" | tail -n 1)
[[ -n $own_prefix ]] || {
  printf 'walg.env has no WALG_S3_PREFIX\n' >&2
  exit 1
}
fetch_assignment="" # what recovery-conf.sh puts in front of wal-fetch; empty: the server's own settings
if [[ $mode == drill ]]; then
  [[ -f $DRILL_MARKER ]] || {
    printf 'refusing: %s does not exist. A drill VM carries it (root: touch %s BEFORE provisioning, docs/restore-drill.md step 3): it keeps the backup timers off and makes the backup scripts refuse\n' "$DRILL_MARKER" "$DRILL_MARKER" >&2
    exit 1
  }
  [[ $source_prefix =~ ^s3://[A-Za-z0-9._-]+(/[A-Za-z0-9._/-]*)?$ ]] || {
    printf -- '--drill needs --source-prefix s3://BUCKET/PATH (production'"'"'s WALG_S3_PREFIX; letters, digits and . _ - / only)\n' >&2
    exit 2
  }
  a=${source_prefix%/}
  b=${own_prefix%/}
  if [[ $a == "$b" || $a == "$b"/* || $b == "$a"/* ]]; then
    printf 'refusing: walg.env archives to %s, which is production'"'"'s storage (%s) or inside it, or the reverse. A promoted drill server would write its timeline there.\nPut a SCRATCH prefix in WALG_S3_PREFIX (docs/restore-drill.md step 3)\n' "$own_prefix" "$source_prefix" >&2
    exit 1
  fi
  fetch_assignment="WALG_S3_PREFIX=$source_prefix"
else
  [[ -z $source_prefix ]] || {
    printf -- '--source-prefix belongs to --drill only: a disaster recovery reads and writes the storage walg.env names\n' >&2
    exit 2
  }
fi

step() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
t0=$(date +%s)

if [[ $mode == drill ]]; then
  step "drill: the backup timers off (provision.sh keeps them off while $DRILL_MARKER exists; this is the belt)"
  systemctl --user disable --now ebt-backup-base.timer ebt-backup-restic.timer 2>/dev/null || true
  printf 'fetching from %s (read only), archiving to %s (scratch)\n' "$source_prefix" "$own_prefix"
else
  printf 'disaster recovery: reading and archiving %s\n' "$own_prefix"
fi

step "stopping postgres.service and emptying the ebt-pgdata volume"
systemctl --user stop postgres.service 2>/dev/null || true
podman volume rm -f ebt-pgdata >/dev/null
podman volume create ebt-pgdata >/dev/null

step "wal-g backup-fetch LATEST into the volume"
t_fetch=$(date +%s)
# The one-shot container is the server image (wal-g inside), as the postgres user, with the quadlet's wal-g settings and key files. In a
# drill the production prefix is set on the wal-g command itself ($2), so it overrides the env file's scratch prefix and reaches nothing else.
# shellcheck disable=SC2016 # $PGDATA, $1 and $2 are expanded by the shell inside the container
podman run --rm --network ebt-backup --user 999:999 --userns keep-id:uid=999,gid=999 --env-file "$ETC/walg.env" \
  -v ebt-pgdata:/var/lib/postgresql:Z \
  -v "$ETC/postgres/walg_libsodium.key:/etc/walg/libsodium.key:ro" \
  -v "$ETC/postgres/walg_aws_credentials:/etc/walg/aws-credentials:ro" \
  -v "$HERE:/backup:ro,z" \
  --entrypoint sh "$IMAGE" -c '
    set -eu
    mkdir -p "$PGDATA" && chmod 700 "$PGDATA"
    if [ -n "$2" ]; then env "$2" wal-g backup-fetch "$PGDATA" LATEST; else wal-g backup-fetch "$PGDATA" LATEST; fi
    sh /backup/recovery-conf.sh "$PGDATA" "$1" "$2"' restore "$target" "$fetch_assignment"
fetched=$(($(date +%s) - t_fetch))

step "starting postgres.service: it replays the archived WAL and promotes itself"
t_replay=$(date +%s)
systemctl --user start --no-block postgres.service
waited=0
until [[ $(podman exec -u postgres postgres psql -X -At -d postgres -c 'SELECT pg_is_in_recovery()' 2>/dev/null || true) == f ]]; do
  ((waited < WAIT_SECONDS)) || {
    printf 'still in recovery after %ss: journalctl --user -u postgres.service\n' "$WAIT_SECONDS" >&2
    exit 1
  }
  sleep 5
  waited=$((waited + 5))
done
replayed=$(($(date +%s) - t_replay))

step "restored"
newest=$(podman exec -u postgres postgres psql -X -At -d ebooktrivia -c 'SELECT coalesce(max(occurred_at)::text, $$none$$) FROM public.audit_log' 2>/dev/null || printf 'unreadable')
printf 'mode: %s\ntarget: %s\nbackup-fetch: %ss\nWAL replay + promote: %ss\ntotal: %ss\nnewest audit_log row: %s\n' "$mode" "${target:-end of the archived WAL}" "$fetched" "$replayed" "$(($(date +%s) - t0))" "$newest"
