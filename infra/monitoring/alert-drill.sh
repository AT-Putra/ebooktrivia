#!/usr/bin/env bash
# The executable steps of the alert drills of docs/drills.md (US-015; D2 to D7): each subcommand TRIGGERS one failure (or puts it back) and
# prints one timestamped line, so the clock of the drill is the script's, not a stopwatch. What the Owner receives (the WhatsApp message, the
# e-mail) is read off the phone and the mailbox: write those two times into the table of docs/drills.md next to the "start" this prints.
# Run it on STAGING only. Subcommands marked (VM) run on the app VM as root; the others anywhere that reaches the target.
#
#   alert-drill.sh template                           the columns of the drills.md timing tables, tab-separated
#   alert-drill.sh worker-kill | worker-recover       (VM) D2: stop the worker (Restart=always is overridden by a stop) / start it
#   alert-drill.sh vm-down | vm-recover               (VM) D4, HTTP-down case: stop Caddy / start it. The power-off case is the provider console
#   alert-drill.sh waha-session stop|start --waha URL --session NAME [--key-file FILE] [--real]
#                                                     D3: stop / start one WAHA session. Default target is the waha-mock (no key); a REAL WAHA needs
#                                                     --real, because a stopped session stops sending (never "logout": that unpairs the number)
#   alert-drill.sh glitchtip-event --dsn URL          D5: one test event carrying a fake e-mail and a fake phone number, sent to GlitchTip
#   alert-drill.sh glitchtip-check                    (VM) D5: the alerts row the hook wrote holds the masks and none of the fake personal data
#   alert-drill.sh relay-critical | relay-check       (VM) D7: a critical alert with a fixed message, and how long the relay took to send it
#   alert-drill.sh backup-stale | backup-restore      (VM) D6: age the base backup's heartbeat past 26 h (the worker alerts within a minute) / put it back
#   alert-drill.sh wal-break | wal-restore            (VM) D6: make the archive command fail by overwriting the S3 credentials file from a saved copy (the alert
#                                                     follows after 15 minutes; pg_wal grows meanwhile) / put the saved copy back
#   alert-drill.sh kuma-escape down|up --push-url URL D2: a notification whose text holds a double quote, a backslash and a line break (escaping of {{ msg | json }})
#   alert-drill.sh valkey-fill [PERCENT] | valkey-clear   (VM) D6/GL-17: fill Valkey to PERCENT of maxmemory (default 75) with one throwaway key / delete it
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
LOG=${EBT_DRILL_LOG:-}

stamp() { date -u +%H:%M:%S; }
event() { # event DRILL WHAT
  local line
  line=$(printf '%s\t%s\t%s\t%s' "$(date -u +%Y-%m-%d)" "$(stamp)" "$1" "$2")
  printf '%s\n' "$line"
  if [[ -n $LOG ]]; then printf '%s\n' "$line" >>"$LOG"; fi
}
as_app() { "$REPO/infra/provision/as-app.sh" "$@"; }
psql_vm() { as_app podman exec -i -u postgres postgres psql -X -q -At -v ON_ERROR_STOP=1 -d ebooktrivia "$@"; }
need_root() { [[ $(id -u) -eq 0 ]] || { printf 'run as root on the app VM (sudo)\n' >&2; exit 1; }; }

cmd=${1:-}
shift || true
case $cmd in
  template)
    printf 'run\tdate, operator\tstart\tdetected\tWA received\te-mail received\trecovered\tpass/fail\tnote\n'
    ;;
  worker-kill)
    need_root
    as_app systemctl --user stop worker.service
    event D2-worker start "worker.service stopped; Kuma's push monitor should turn red within 120 s, the WhatsApp message and e-mail within 3 minutes"
    ;;
  worker-recover)
    need_root
    as_app systemctl --user start worker.service
    event D2-worker recovered "worker.service started (Kuma green after the next push; the outbox drains)"
    ;;
  vm-down)
    need_root
    as_app systemctl --user stop caddy.service caddy.socket
    event D4-vm start "caddy.service and caddy.socket stopped: every Kuma monitor of the VM turns red (HTTP-down case)"
    ;;
  vm-recover)
    need_root
    as_app systemctl --user start caddy.socket caddy.service
    event D4-vm recovered "caddy.socket and caddy.service started"
    ;;
  waha-session)
    action=${1:?stop or start}
    shift
    waha="" session="" keyfile="" real=0
    while (($#)); do
      case $1 in
        --waha) waha=${2:?}; shift ;;
        --session) session=${2:?}; shift ;;
        --key-file) keyfile=${2:?}; shift ;;
        --real) real=1 ;;
        *) printf 'unknown argument %s\n' "$1" >&2; exit 2 ;;
      esac
      shift
    done
    [[ $action == stop || $action == start ]] || { printf 'waha-session stop|start\n' >&2; exit 2; }
    [[ -n $waha && $session =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { printf 'need --waha URL and --session NAME\n' >&2; exit 2; }
    headers=()
    if [[ -n $keyfile ]]; then headers=(-H "X-Api-Key: $(tr -d '\n' <"$keyfile")"); fi
    # The mock's control plane (infra/waha-mock: /__mock/*) takes a status; a real WAHA takes /api/sessions/<name>/stop|start.
    if ((real)); then
      curl -fsS -m 20 -X POST "${headers[@]}" "$waha/api/sessions/$session/$action" >/dev/null
    else
      status=WORKING
      if [[ $action == stop ]]; then status=STOPPED; fi
      curl -fsS -m 20 -X POST -H 'content-type: application/json' -d "{\"status\":\"$status\"}" "$waha/__mock/sessions/$session/status" >/dev/null
    fi
    if [[ $action == stop ]]; then
      event "D3-waha-$session" start "session $session stopped: the Kuma JSON-query monitor and the worker's session poll see it leave WORKING"
    else
      event "D3-waha-$session" recovered "session $session started"
    fi
    ;;
  glitchtip-event)
    dsn=""
    while (($#)); do
      case $1 in
        --dsn) dsn=${2:?}; shift ;;
        *) printf 'unknown argument %s\n' "$1" >&2; exit 2 ;;
      esac
      shift
    done
    # DSN: https://<public key>@<host>/<project id> (the project's Client Keys page in GlitchTip).
    [[ $dsn =~ ^(https?)://([A-Za-z0-9]+)@([^/]+)/([0-9]+)$ ]] || { printf 'the DSN must look like https://<key>@<host>/<project id>\n' >&2; exit 2; }
    scheme=${BASH_REMATCH[1]} key=${BASH_REMATCH[2]} host=${BASH_REMATCH[3]} project=${BASH_REMATCH[4]}
    # Fake personal data on purpose: the drill proves the masks, so none of it may reach the Owner's phone or the alerts row unmasked.
    body=$(printf '{"event_id":"%s","level":"error","platform":"javascript","message":"drill: order failed for drill.buyer@example.com phone +62 812-3456-7890","logger":"alert-drill"}' "$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')")
    curl -fsS -m 20 -X POST "$scheme://$host/api/$project/store/?sentry_version=7&sentry_key=$key" -H 'content-type: application/json' -d "$body" >/dev/null
    event D5-glitchtip start "test event sent to GlitchTip (fake e-mail drill.buyer@example.com and phone +62 812-3456-7890 in the message): its alert rule fires the hook, the relay sends the masked digest"
    ;;
  glitchtip-check)
    need_root
    row=$(psql_vm -c "SELECT message || ' | ' || payload::text FROM public.alerts WHERE source = 'glitchtip' ORDER BY created_at DESC LIMIT 1")
    printf 'newest GlitchTip alert: %s\n' "$row"
    [[ -n $row ]] || { printf 'FAIL: no alert row from GlitchTip yet\n' >&2; exit 1; }
    for raw in drill.buyer@example.com '812-3456-7890' '812 3456 7890'; do
      if [[ $row == *"$raw"* ]]; then
        printf 'FAIL: the alert row holds %s unmasked\n' "$raw" >&2
        exit 1
      fi
    done
    [[ $row == *'[email]'* ]] && printf 'PASS: the e-mail address is masked ([email])\n'
    [[ $row == *'[number]'* ]] && printf 'PASS: the phone number is masked ([number])\n'
    ;;
  relay-critical)
    need_root
    id=$(psql_vm -c "INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload) VALUES ('admin', 'drill_critical', 'critical', 'drill_critical:' || gen_random_uuid(), 'Alert drill: a critical alert with a fixed message, to time the relay', '{}'::jsonb) RETURNING id")
    event D7-relay start "critical alert $id written; the relay sends within a minute (WhatsApp and e-mail)"
    ;;
  relay-check)
    need_root
    psql_vm -c "SELECT kind, severity, created_at, notified_at, round(extract(epoch FROM notified_at - created_at)::numeric, 1) AS seconds_to_notify FROM public.alerts WHERE kind = 'drill_critical' ORDER BY created_at DESC LIMIT 3"
    ;;
  backup-stale)
    need_root
    psql_vm -c "UPDATE public.heartbeats SET beat_at = now() - interval '27 hours' WHERE component = 'backup_base'" >/dev/null
    event D6-backup start "heartbeat backup_base set 27 hours old: backup_base_stale (critical) within a minute; the next nightly run (or backup-restore) puts it back"
    ;;
  backup-restore)
    need_root
    psql_vm -c "UPDATE public.heartbeats SET beat_at = now() WHERE component = 'backup_base'" >/dev/null
    event D6-backup recovered "heartbeat backup_base set to now; resolve the alert in the console"
    ;;
  wal-break)
    need_root
    # NOT `ALTER SYSTEM SET archive_command`: the quadlet starts the server with `-c archive_command=...`, which wins over postgresql.auto.conf. The
    # credentials file is bind-mounted into the container, so overwriting it IN PLACE (same inode) breaks every wal-push with an access error.
    creds=/etc/ebooktrivia/postgres/walg_aws_credentials
    saved=/root/.ebt-wal-drill/walg_aws_credentials
    [[ ! -e $saved ]] || { printf 'a saved copy exists already (%s): run wal-restore first\n' "$saved" >&2; exit 1; }
    [[ -f $creds ]] || { printf '%s does not exist\n' "$creds" >&2; exit 1; }
    install -d -m 700 /root/.ebt-wal-drill
    install -m 600 "$creds" "$saved"
    printf '[default]\naws_access_key_id = DRILLBROKEN\naws_secret_access_key = DRILLBROKEN\n' >"$creds"
    event D6-wal start "walg_aws_credentials overwritten with invalid keys (the good copy is in $saved): nothing is archived, wal_archive_lag (critical) after 15 minutes, and pg_wal grows (about 16 MB a minute). PUT IT BACK with wal-restore"
    ;;
  wal-restore)
    need_root
    creds=/etc/ebooktrivia/postgres/walg_aws_credentials
    saved=/root/.ebt-wal-drill/walg_aws_credentials
    [[ -f $saved ]] || { printf 'no saved copy (%s): nothing to restore\n' "$saved" >&2; exit 1; }
    cat "$saved" >"$creds" # in place: the container's bind mount follows the inode
    rm -f "$saved"
    rmdir /root/.ebt-wal-drill 2>/dev/null || true
    event D6-wal recovered "walg_aws_credentials restored from the saved copy; the archiver catches up (resolve the alert in the console)"
    ;;
  kuma-escape)
    # D2 (once, any time): a notification whose text holds a double quote and a line break must reach the Owner's phone intact. The text is the
    # message of a Push monitor's heartbeat (Kuma puts it in {{ msg }}); the webhook body escapes it with {{ msg | json }}. Needs a push monitor's URL
    # (the alerts backstop's: https://<kuma>/api/push/<token>) and never prints it. `kuma-escape down --push-url URL` / `kuma-escape up --push-url URL`.
    state=${1:?down or up}
    shift
    push=""
    while (($#)); do
      case $1 in
        --push-url) push=${2:?}; shift ;;
        *) printf 'unknown argument %s\n' "$1" >&2; exit 2 ;;
      esac
      shift
    done
    [[ $state == down || $state == up ]] || { printf 'kuma-escape down|up\n' >&2; exit 2; }
    [[ $push =~ ^https?://[A-Za-z0-9.:_-]+/api/push/[A-Za-z0-9]+$ ]] || { printf -- '--push-url must look like https://<kuma>/api/push/<token> (no query)\n' >&2; exit 2; }
    message='Alert drill: a "quoted" word, a backslash \ and a second line'$'\n''line two, with {{ braces }}'
    [[ $state == up ]] && message='Alert drill over: back to normal'
    # The URL goes to curl on stdin (curl -K-), not argv: the token is a secret.
    printf 'url = "%s"\n' "$push" | curl -fsS -m 20 -K- -G --data-urlencode "status=$state" --data-urlencode "msg=$message" >/dev/null
    event D2-escape "push monitor set $state with a message holding a double quote, a backslash, a line break and braces: the WhatsApp text must show all of it, unbroken, and the e-mail too"
    ;;
  valkey-fill)
    need_root
    percent=${1:-75}
    [[ $percent =~ ^[0-9]{2,3}$ ]] || { printf 'PERCENT must be a number\n' >&2; exit 2; }
    pw=$(awk -F= '$1 == "VALKEY_PASSWORD" { print $2 }' /etc/ebooktrivia/worker.env)
    cli() { printf 'AUTH worker %s\n%s\n' "$pw" "$*" | as_app podman exec -i valkey env -u REDISCLI_AUTH valkey-cli --no-auth-warning 2>&1 | tr -d '\r' | sed '1{/^OK$/d}'; }
    max=$(cli CONFIG GET maxmemory | tail -n1)
    [[ $max =~ ^[0-9]+$ && $max -gt 0 ]] || { printf 'maxmemory is not set (got: %s)\n' "$max" >&2; exit 1; }
    used=$(cli INFO memory | awk -F: '$1 == "used_memory" { print $2 }')
    want=$((max * percent / 100 - used))
    ((want > 0)) || { printf 'Valkey already uses %s of %s bytes\n' "$used" "$max"; exit 0; }
    cli SETRANGE ebt:drill:memory "$want" x >/dev/null
    event D6-valkey start "ebt:drill:memory fills Valkey to about $percent % of maxmemory ($max bytes): valkey_memory_high (warning) within a minute. DELETE IT with valkey-clear"
    ;;
  valkey-clear)
    need_root
    pw=$(awk -F= '$1 == "VALKEY_PASSWORD" { print $2 }' /etc/ebooktrivia/worker.env)
    printf 'AUTH worker %s\nDEL ebt:drill:memory\n' "$pw" | as_app podman exec -i valkey env -u REDISCLI_AUTH valkey-cli --no-auth-warning >/dev/null
    event D6-valkey recovered "ebt:drill:memory deleted"
    ;;
  *)
    sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
