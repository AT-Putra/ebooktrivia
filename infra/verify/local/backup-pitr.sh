#!/usr/bin/env bash
# Local proof of the backups (US-015, plan M4.5): the wal-g base backup and point-in-time recovery with libsodium-encrypted WAL, and the
# restic secondary backup, against the real images, with the FILE storage backends (no S3, no MinIO: infra/backup/README in docs/runbooks/backups.md
# lists what only a real bucket can show).
#
#   infra/verify/local/backup-pitr.sh        (needs Docker; no network but the image pulls; no host port is bound)
#
# What it runs, in order, with timings:
#   1. PostgreSQL 18.6 + wal-g (infra/images/postgres-walg) with archive_mode on, the production archive_command, libsodium key FILE
#      (WALG_LIBSODIUM_KEY_PATH, as in the quadlet) and zstd; ~300 000 rows;
#   2. wal-g backup-push; markers inserted after it, a WAL segment switch, a final row that is NOT archived, then the server is killed
#      (a VM lost: no clean shutdown);
#   3. the stored objects are encrypted (no plaintext marker in storage) and a wrong key cannot fetch;
#   4. PITR to a chosen timestamp on a fresh data directory (backup-fetch + infra/backup/recovery-conf.sh, the lines the real restore uses):
#      the row before the target is there, the rows after it are not;
#   5. "latest" (no target): everything that was archived is recovered, the unarchived last row is the data loss (the RPO), measured;
#   5b. a restore DRILL (restore-pitr.sh --drill): production's store is mounted read-only and only read; the promoted drill server archives
#      its new timeline into a SCRATCH store; afterwards production's store is byte for byte what it was (no timeline or history file added,
#      nothing deleted);
#   6. restic: pg_dump -Fc, pg_dumpall --globals-only and a directory backed up into a local repository, retention applied, the dump
#      restored into a database and its rows counted, and /srv/data restored with the drill's command (--no-lock, a read-only repository).
# Test values only (DEV ONLY keys). Everything it creates is removed on exit.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$HERE/lib.sh"
IMAGE=${PITR_IMAGE:-localhost/ebooktrivia/postgres-walg:18.6}
RESTIC_IMAGE=docker.io/restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510
P=ebt-pitr
KEY=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff # DEV ONLY
ROWS=${PITR_ROWS:-300000}
work=$(mktemp -d)
printf '%s\n' "$KEY" >"$work/libsodium.key"
mkdir -p "$work/data/deliverables"
printf 'ebook pdf stand-in\n' >"$work/data/deliverables/book.pdf"

containers=("$P" "$P-restored" "$P-latest" "$P-drill")
volumes=("$P-data" "$P-store" "$P-store-a" "$P-store-b" "$P-scratch" "$P-data2" "$P-data3" "$P-data4" "$P-restic" "$P-srvdata")
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  docker rm -f "${containers[@]}" >/dev/null 2>&1 || true
  docker volume rm -f "${volumes[@]}" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
cleanup_all() { docker rm -f "${containers[@]}" >/dev/null 2>&1 || true; docker volume rm -f "${volumes[@]}" >/dev/null 2>&1 || true; }
cleanup_all

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" "$(host_path "$REPO/infra/images/postgres-walg")" >/dev/null
for volume in "${volumes[@]}"; do docker volume create "$volume" >/dev/null; done
# The storage stand-in is written by the postgres user (uid 999), as the S3 credentials stand in for it on the VM.
docker run --rm -v "$P-store:/store" -v "$P-scratch:/scratch" --entrypoint sh "$IMAGE" -c 'chown 999:999 /store /scratch && chmod 700 /store /scratch'

# The production settings (walg.env, postgres.container), with the FILE backend in place of S3.
walg_env=(-e WALG_FILE_PREFIX=/store -e WALG_LIBSODIUM_KEY_PATH=/etc/walg/libsodium.key -e WALG_LIBSODIUM_KEY_TRANSFORM=hex -e WALG_COMPRESSION_METHOD=zstd)
keymount=(-v "$(host_path "$work")/libsodium.key:/etc/walg/libsodium.key:ro")
mounts=("${keymount[@]}" -v "$P-store:/store")
server_args=(postgres -c wal_level=replica -c archive_mode=on -c "archive_command=wal-g wal-push %p" -c archive_timeout=10)
now() { printf '%s' "$EPOCHREALTIME"; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f", b - a }'; }
pg() { docker exec -u postgres "$1" psql -X -q -At -v ON_ERROR_STOP=1 -d "${DB:-ebooktrivia}" -c "$2"; }
wait_ready() { # wait_ready CONTAINER
  for _ in $(seq 1 120); do
    docker exec "$1" pg_isready -h 127.0.0.1 -q 2>/dev/null && return 0
    sleep 1
  done
  docker logs "$1" 2>&1 | tail -20
  return 1
}
FAILURES=0
pass() { printf 'PASS  %s\n' "$*"; }
bad() {
  FAILURES=$((FAILURES + 1))
  printf 'FAIL  %s\n' "$*"
}
expect() { if [[ $3 == "$2" ]]; then pass "$1: $3"; else bad "$1: want '$2', got '$3'"; fi; }

printf '### 1. the primary: archive_mode on, libsodium, %s rows\n' "$ROWS"
docker run -d --name "$P" -e POSTGRES_PASSWORD=pitr-devonly "${walg_env[@]}" -v "$P-data:/var/lib/postgresql" "${mounts[@]}" "$IMAGE" "${server_args[@]}" >/dev/null
wait_ready "$P"
DB=postgres pg "$P" "CREATE DATABASE ebooktrivia"
pg "$P" "CREATE TABLE marker (id bigserial PRIMARY KEY, label text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp())"
pg "$P" "INSERT INTO marker (label) SELECT 'bulk-' || md5(g::text) FROM generate_series(1, $ROWS) g"
pg "$P" "INSERT INTO marker (label) VALUES ('before-backup')"

printf '\n### 2. wal-g backup-push, markers, a lost server\n'
t=$(now)
docker exec -u postgres "$P" sh -c 'wal-g backup-push "$PGDATA"' >"$work/backup-push.log" 2>&1 || {
  tail -20 "$work/backup-push.log"
  exit 1
}
T_BACKUP=$(secs "$t" "$(now)")
printf 'backup-push: %s s\n' "$T_BACKUP"
pg "$P" "INSERT INTO marker (label) VALUES ('marker-A')"
sleep 2
T_TARGET=$(DB=postgres pg "$P" "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")
sleep 2
pg "$P" "INSERT INTO marker (label) VALUES ('after-target')"
segment=$(pg "$P" "SELECT pg_walfile_name(pg_switch_wal())")
for _ in $(seq 1 60); do
  [[ $(pg "$P" "SELECT coalesce(last_archived_wal >= '$segment', false) FROM pg_stat_archiver") == t ]] && break
  sleep 1
done
expect "the WAL segment after the markers is archived" t "$(pg "$P" "SELECT coalesce(last_archived_wal >= '$segment', false) FROM pg_stat_archiver")"
pg "$P" "INSERT INTO marker (label) VALUES ('tail-not-archived')"
T_KILL=$(pg "$P" "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")
docker kill "$P" >/dev/null
printf 'target time %s, server killed at %s\n' "$T_TARGET" "$T_KILL"

printf '\n### 3. the storage is encrypted; a wrong key cannot restore\n'
plain=$(docker run --rm "${mounts[@]}" --entrypoint sh "$IMAGE" -c 'cd /store && grep -rl -e before-backup -e marker-A -e after-target . 2>/dev/null | wc -l')
expect "stored objects holding a plaintext marker" 0 "$plain"
docker run --rm --entrypoint sh "${walg_env[@]}" -e WALG_LIBSODIUM_KEY_PATH= -e WALG_LIBSODIUM_KEY=ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100 -v "$P-store:/store" "$IMAGE" \
  -c 'mkdir -p /tmp/wrong && timeout -s KILL 45 wal-g backup-fetch /tmp/wrong LATEST >/dev/null 2>&1; if [ -f /tmp/wrong/PG_VERSION ]; then echo fetched; else echo refused; fi' >"$work/wrongkey.txt"
expect "a backup-fetch with another key" refused "$(tr -d '\r' <"$work/wrongkey.txt")"

# A restore that promotes ARCHIVES: it writes its own timeline (and its history file) into the storage it was given. Restored into the production
# prefix, a drill would leave a second timeline there, and a later "latest" recovery would follow it and miss everything the first timeline
# committed after the branch (found by this proof: the "latest" run saw none of the rows after the PITR target). Sections 4 and 5 therefore give each
# restore its OWN COPY of the storage; a real drill (section 5b, restore-pitr.sh --drill) archives to a SCRATCH prefix and only reads production's.
copy_store() { # copy_store FROM_VOLUME TO_VOLUME
  docker run --rm -v "$1:/from:ro" -v "$2:/to" --entrypoint sh "$IMAGE" -c 'cp -a /from/. /to/ && chown -R 999:999 /to && chmod 700 /to'
}
restore() { # restore VOLUME CONTAINER STORE [TARGET [PRODUCTION_VOLUME]]: backup-fetch + recovery config + start; prints "fetch replay" seconds
  # With PRODUCTION_VOLUME this is a DRILL, as restore-pitr.sh --drill runs it: STORE is the scratch storage (the server's own settings, where it
  # archives), PRODUCTION_VOLUME is mounted READ-ONLY at /prod and named only on the backup-fetch and in restore_command (recovery-conf.sh SOURCE).
  local volume=$1 name=$2 store=$3 target=${4:-} production=${5:-} t1 t2 t3
  local prodmount=() fetchenv=""
  if [[ -n $production ]]; then
    prodmount=(-v "$production:/prod:ro")
    fetchenv="WALG_FILE_PREFIX=/prod"
  fi
  t1=$(now)
  docker run --rm --user 999:999 "${walg_env[@]}" -v "$volume:/var/lib/postgresql" "${keymount[@]}" -v "$store:/store" "${prodmount[@]+"${prodmount[@]}"}" -v "$(host_path "$REPO/infra/backup"):/backup:ro" --entrypoint sh "$IMAGE" -c '
    set -eu
    mkdir -p "$PGDATA" && chmod 700 "$PGDATA"
    if [ -n "$2" ]; then env "$2" wal-g backup-fetch "$PGDATA" LATEST; else wal-g backup-fetch "$PGDATA" LATEST; fi
    sh /backup/recovery-conf.sh "$PGDATA" "$1" "$2"' restore "$target" "$fetchenv" >"$work/$name-fetch.log" 2>&1 || {
    tail -20 "$work/$name-fetch.log"
    return 1
  }
  t2=$(now)
  docker run -d --name "$name" -e POSTGRES_PASSWORD=pitr-devonly "${walg_env[@]}" -v "$volume:/var/lib/postgresql" "${keymount[@]}" -v "$store:/store" "${prodmount[@]+"${prodmount[@]}"}" "$IMAGE" "${server_args[@]}" >/dev/null
  for _ in $(seq 1 600); do
    [[ $(docker exec -u postgres "$name" psql -X -q -At -d postgres -c 'SELECT pg_is_in_recovery()' 2>/dev/null || true) == f ]] && break
    sleep 1
  done
  t3=$(now)
  [[ $(docker exec -u postgres "$name" psql -X -q -At -d postgres -c 'SELECT pg_is_in_recovery()' 2>/dev/null || true) == f ]] || {
    docker logs "$name" 2>&1 | tail -30
    return 1
  }
  printf '%s %s' "$(secs "$t1" "$t2")" "$(secs "$t2" "$t3")"
}

printf '\n### 4. point-in-time recovery to %s on a fresh data directory\n' "$T_TARGET"
copy_store "$P-store" "$P-store-a"
result=$(restore "$P-data2" "$P-restored" "$P-store-a" "$T_TARGET") || exit 1
read -r FETCH_A REPLAY_A <<<"$result"
printf 'backup-fetch + config: %s s, WAL replay and promote: %s s\n' "$FETCH_A" "$REPLAY_A"
have() { pg "$1" "SELECT count(*) FROM marker WHERE label = '$2'"; }
expect "PITR: the row before the backup" 1 "$(have "$P-restored" before-backup)"
expect "PITR: marker-A (committed before the target)" 1 "$(have "$P-restored" marker-A)"
expect "PITR: after-target (committed after the target) is NOT there" 0 "$(have "$P-restored" after-target)"
expect "PITR: tail-not-archived is NOT there" 0 "$(have "$P-restored" tail-not-archived)"
expect "PITR: the bulk rows" "$ROWS" "$(pg "$P-restored" "SELECT count(*) FROM marker WHERE label LIKE 'bulk-%'")"
expect "PITR: the server is writable again (promoted)" f "$(DB=postgres pg "$P-restored" "SELECT pg_is_in_recovery()")"
pg "$P-restored" "INSERT INTO marker (label) VALUES ('written-after-restore')"
expect "PITR: a write after the restore" 1 "$(have "$P-restored" written-after-restore)"
docker rm -f "$P-restored" >/dev/null

printf '\n### 5. latest (no target): all archived WAL is recovered, the unarchived tail is the loss\n'
copy_store "$P-store" "$P-store-b"
result=$(restore "$P-data3" "$P-latest" "$P-store-b") || exit 1
read -r FETCH_B REPLAY_B <<<"$result"
printf 'backup-fetch + config: %s s, WAL replay and promote: %s s\n' "$FETCH_B" "$REPLAY_B"
expect "latest: after-target (archived by the segment switch)" 1 "$(have "$P-latest" after-target)"
expect "latest: tail-not-archived (written after the last archive, then the server died)" 0 "$(have "$P-latest" tail-not-archived)"
RPO=$(pg "$P-latest" "SELECT round(extract(epoch FROM '$T_KILL'::timestamptz - max(at))::numeric, 1) FROM marker WHERE label NOT LIKE 'written-%'")
printf 'server killed %s; the newest recovered row is %s s older: data loss (RPO) here (archive_timeout is 10 s in this proof; 60 s in production)\n' "$T_KILL" "$RPO"

printf '\n### 5b. a restore DRILL: production storage is only read (no new timeline, nothing lost)\n'
# What restore-pitr.sh --drill does, with the same files: the server's own storage is a SCRATCH store; production's store (the original: every restore
# above ran on a copy) is mounted READ-ONLY at /prod and named only on the backup-fetch and in restore_command (recovery-conf.sh SOURCE). The promoted
# drill server archives its new timeline: it must land in the scratch store, and production's store must stay byte for byte what it was.
store_sum() { docker run --rm -v "$1:/s:ro" --entrypoint sh "$IMAGE" -c 'cd /s && find . -type f -exec sha256sum {} + | sort -k2' | sha256sum | cut -d' ' -f1; }
store_count() { docker run --rm -v "$1:/s:ro" --entrypoint sh "$IMAGE" -c "find /s -type f -name '$2' | wc -l" | tr -d ' \r\n'; }
prod_before=$(store_sum "$P-store")
prod_files=$(store_count "$P-store" '*')
expect "drill: production's store holds no history file before (timeline 1 only)" 0 "$(store_count "$P-store" '*.history*')"
result=$(restore "$P-data4" "$P-drill" "$P-scratch" "" "$P-store") || exit 1
read -r FETCH_D REPLAY_D <<<"$result"
printf 'drill: backup-fetch + config %s s, WAL replay and promote %s s (production store: %s files)\n' "$FETCH_D" "$REPLAY_D" "$prod_files"
expect "drill: the archived rows were recovered from production's store (after-target)" 1 "$(have "$P-drill" after-target)"
expect "drill: the drill server is promoted" f "$(DB=postgres pg "$P-drill" "SELECT pg_is_in_recovery()")"
pg "$P-drill" "INSERT INTO marker (label) VALUES ('written-in-drill')"
segment=$(pg "$P-drill" "SELECT pg_walfile_name(pg_switch_wal())")
for _ in $(seq 1 60); do
  [[ $(pg "$P-drill" "SELECT coalesce(last_archived_wal >= '$segment', false) FROM pg_stat_archiver") == t ]] && break
  sleep 1
done
expect "drill: the drill server archived its new timeline's WAL" t "$(pg "$P-drill" "SELECT coalesce(last_archived_wal >= '$segment', false) FROM pg_stat_archiver")"
expect "drill: ...and no archive attempt failed (the read-only production mount was never written)" 0 "$(pg "$P-drill" "SELECT failed_count FROM pg_stat_archiver")"
expect "drill: the SCRATCH store holds the new timeline's history file" 1 "$(store_count "$P-scratch" '00000002.history*')"
expect "drill: production's store gained no timeline or history file" 0 "$(store_count "$P-store" '*.history*')"
expect "drill: production's store is byte for byte what it was (nothing added, nothing lost)" "$prod_before" "$(store_sum "$P-store")"
expect "drill: production's store file count" "$prod_files" "$(store_count "$P-store" '*')"
docker rm -f "$P-drill" >/dev/null

printf '\n### 6. restic: dump, globals and a directory into a local repository, retention, restore\n'
rrun() { docker run --rm -i -e RESTIC_PASSWORD=restic-devonly -v "$P-restic:/repo" -v "$(host_path "$work/data"):/srv/data:ro" "$RESTIC_IMAGE" -r /repo "$@"; }
rrun init >/dev/null
t=$(now)
docker exec "$P-latest" pg_dump -U postgres -Fc ebooktrivia | rrun backup --quiet --host ebooktrivia --tag nightly --stdin --stdin-filename db/ebooktrivia.dump
docker exec "$P-latest" pg_dumpall -U postgres --globals-only | rrun backup --quiet --host ebooktrivia --tag nightly --stdin --stdin-filename db/globals.sql
rrun backup --quiet --host ebooktrivia --tag nightly /srv/data
for _ in 1 2 3; do rrun backup --quiet --host ebooktrivia --tag nightly /srv/data; done
T_RESTIC=$(secs "$t" "$(now)")
rrun forget --quiet --host ebooktrivia --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
rrun check --quiet --read-data-subset=1/28
printf 'restic backup of the dump, the globals and /srv/data (+3 more of /srv/data), forget --prune and check: %s s\n' "$T_RESTIC"
expect "restic snapshots of the three streams" "3" "$(rrun snapshots --host ebooktrivia --json | tr '{' '\n' | grep -o '"paths":\["[^"]*"' | sort -u | wc -l | tr -d ' ')"
t=$(now)
rrun dump latest --host ebooktrivia --path /db/ebooktrivia.dump /db/ebooktrivia.dump >"$work/restored.dump"
docker exec -u postgres "$P-latest" psql -X -q -At -d postgres -c "CREATE DATABASE restored_from_restic" >/dev/null
docker exec -i -u postgres "$P-latest" pg_restore -U postgres -d restored_from_restic <"$work/restored.dump"
T_RESTORE=$(secs "$t" "$(now)")
expect "restic: the dump restored into a new database (bulk rows)" "$ROWS" "$(DB=restored_from_restic pg "$P-latest" "SELECT count(*) FROM marker WHERE label LIKE 'bulk-%'")"
expect "restic: the globals snapshot holds the roles" 1 "$(rrun dump latest --host ebooktrivia --path /db/globals.sql /db/globals.sql | grep -c 'CREATE ROLE postgres' || true)"
expect "restic: /srv/data restores byte for byte" "ebook pdf stand-in" "$(rrun dump latest --host ebooktrivia --path /srv/data /srv/data/deliverables/book.pdf | tr -d '\r\n' | sed 's/ *$//' | tr -d '\n' || true)"
printf 'restic restore of the dump into a database: %s s\n' "$T_RESTORE"
# The drill's /srv/data restore (docs/restore-drill.md step 5b): the command as written there, against the repository mounted READ-ONLY (a drill's key
# cannot write, so --no-lock), into an empty /srv/data, as the container's root: the files get the owner and modes the snapshot recorded.
t=$(now)
docker run --rm -i -e RESTIC_PASSWORD=restic-devonly -v "$P-restic:/repo:ro" -v "$P-srvdata:/srv/data" "$RESTIC_IMAGE" -r /repo --no-lock \
  restore latest --host ebooktrivia --path /srv/data --target / >"$work/restore-data.log" 2>&1 || {
  tail -20 "$work/restore-data.log"
  exit 1
}
T_DATA=$(secs "$t" "$(now)")
restored=$(docker run --rm -v "$P-srvdata:/srv/data:ro" --entrypoint sh "$RESTIC_IMAGE" -c 'stat -c "%u:%g" /srv/data/deliverables/book.pdf; cat /srv/data/deliverables/book.pdf' | tr -d '\r' | paste -sd ' ' -)
expect "restic: /srv/data restored with 'restore latest --host ebooktrivia --path /srv/data --target /' (owner, content)" "0:0 ebook pdf stand-in" "$restored"
printf 'restic restore of /srv/data (the tree, read-only repository): %s s\n' "$T_DATA"

printf '\n### timings (rows: %s)\n' "$ROWS"
printf '| step | seconds |\n|---|---|\n| wal-g backup-push | %s |\n| PITR: backup-fetch + config | %s |\n| PITR: WAL replay + promote | %s |\n| latest: backup-fetch + config | %s |\n| latest: WAL replay + promote | %s |\n| data loss, last archived row to the kill (RPO here) | %s |\n| restic: 3 streams + 3 more /srv/data + forget + check | %s |\n| restic: dump restored into a database | %s |\n| restic: /srv/data restored (restore latest --path /srv/data --target /) | %s |\n| drill: backup-fetch + config / replay + promote | %s / %s |\n' \
  "$T_BACKUP" "$FETCH_A" "$REPLAY_A" "$FETCH_B" "$REPLAY_B" "$RPO" "$T_RESTIC" "$T_RESTORE" "$T_DATA" "$FETCH_D" "$REPLAY_D"
printf '\nbackup-pitr: %d failure(s)\n' "$FAILURES"
((FAILURES == 0))
