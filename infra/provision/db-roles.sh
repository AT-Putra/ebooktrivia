#!/usr/bin/env bash
# Idempotent PostgreSQL logins for the ebooktrivia apps (plan M4, packages/db/sql/roles.sql).
#
#   sudo infra/provision/db-roles.sh [CONFIG]      after postgres.service is running, before migrate
#
# Creates or corrects, in the running postgres container (as the superuser, over its local socket):
#   - the NOLOGIN group roles if they do not exist yet (roles.sql, run by migrate, enforces them);
#   - one LOGIN per app, INHERIT, member of exactly ONE group (the apps check this at startup,
#     apps/worker/src/login-role.ts): ebt_public -> public_rw, ebt_admin -> admin_rw,
#     ebt_worker -> worker_rw, ebt_internal -> internal_rw, ebt_migrate -> migrator. ebt_migrate is
#     also SUPERUSER: roles.sql resets cluster-wide role state, which needs one (pg_hba.conf lets it
#     in from the migrate container's address only). Every other attribute is off;
#   - their passwords, from the DATABASE_URL_* lines provisioning generated in /etc/ebooktrivia.
#     Only SCRAM-SHA-256 verifiers computed here are sent, never a plaintext password, and a
#     password is only reset when the stored verifier does not match;
#   - no CONNECT or TEMPORARY for PUBLIC on the `postgres` and `template1` databases (the
#     ebooktrivia database is locked down by roles.sql).
# A second run changes nothing. Each change is printed as a CHANGED line.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/provision/lib.sh
. "$HERE/lib.sh"
require_root
load_config "${1:-/etc/ebooktrivia/provision.env}"
ETC=/etc/ebooktrivia

psql_super() { as_app podman exec -i -u postgres postgres psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }

# login:group:env file:variable
LOGINS="ebt_public:public_rw:public.env:DATABASE_URL_PUBLIC
ebt_admin:admin_rw:admin.env:DATABASE_URL_ADMIN
ebt_worker:worker_rw:worker.env:DATABASE_URL_WORKER
ebt_internal:internal_rw:internal.env:DATABASE_URL_INTERNAL
ebt_migrate:migrator:migrate.env:DATABASE_URL"

as_app podman container exists postgres || die "the postgres container is not running (start postgres.service first)"

# SCRAM-SHA-256 verifier for a password, reusing the stored salt and iteration count when the
# stored verifier already matches (then the output equals the stored value: nothing to change).
# The password goes in the environment (EBT_SCRAM_PASSWORD): a process's environment is readable
# by its owner (root) only, unlike its command line (security review S12).
scram() {
  # shellcheck disable=SC2016 # Python source: its $ signs are literal SCRAM separators
  python3 -I -c '
import base64, hashlib, hmac, os, sys
password, stored = os.environ["EBT_SCRAM_PASSWORD"].encode(), os.environ["EBT_SCRAM_STORED"]
def verifier(salt, iterations):
    salted = hashlib.pbkdf2_hmac("sha256", password, salt, iterations)
    client = hmac.new(salted, b"Client Key", "sha256").digest()
    server = hmac.new(salted, b"Server Key", "sha256").digest()
    b64 = lambda b: base64.b64encode(b).decode()
    return f"SCRAM-SHA-256${iterations}:{b64(salt)}${b64(hashlib.sha256(client).digest())}:{b64(server)}"
try:
    head, keys = stored.split("$", 2)[1:]
    iterations, salt = head.split(":")
    candidate = verifier(base64.b64decode(salt), int(iterations))
    if hmac.compare_digest(candidate, stored):
        print(stored)
        sys.exit(0)
except ValueError:
    pass
print(verifier(os.urandom(16), 4096))
'
}

# The verifiers become psql variables of the SQL below, sent on stdin with it: neither a password
# nor a verifier is ever on a command line.
preamble=""
while IFS=: read -r login group file var; do
  url=$(env_value "$ETC/$file" "$var")
  [[ $url =~ ^postgres://$login:([0-9a-f]{64})@ ]] || die "$ETC/$file: $var is not a postgres://$login:<generated password>@ URL"
  password=${BASH_REMATCH[1]}
  # </dev/null: podman exec -i would otherwise swallow the rest of the loop's input.
  stored=$(psql_super -At -c "SELECT coalesce(rolpassword, '') FROM pg_catalog.pg_authid WHERE rolname = '$login'" </dev/null)
  verifier=$(EBT_SCRAM_PASSWORD=$password EBT_SCRAM_STORED=$stored scram)
  # An unchanged verifier is passed as empty: the SQL below then leaves the password alone.
  [[ $verifier == "$stored" ]] && verifier=""
  # A verifier is SCRAM-SHA-256$<n>:<base64>$<base64>:<base64>: no quote or backslash to escape.
  preamble+=$(printf '\\set v_%s %s' "$login" "'$verifier'")$'\n'
done <<<"$LOGINS"

output=$({
  printf '%s' "$preamble"
  cat <<'SQL'
SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false) \gset ignored_
SET ebt.v_ebt_public = :'v_ebt_public';
SET ebt.v_ebt_admin = :'v_ebt_admin';
SET ebt.v_ebt_worker = :'v_ebt_worker';
SET ebt.v_ebt_internal = :'v_ebt_internal';
SET ebt.v_ebt_migrate = :'v_ebt_migrate';
SET client_min_messages = notice;
DO $roles$
DECLARE
  pairs text[] := ARRAY[['ebt_public', 'public_rw'], ['ebt_admin', 'admin_rw'], ['ebt_worker', 'worker_rw'],
                        ['ebt_internal', 'internal_rw'], ['ebt_migrate', 'migrator']];
  groups text[] := ARRAY['migrator', 'public_rw', 'admin_rw', 'worker_rw', 'internal_rw'];
  pair text[];
  login text;
  grp text;
  verifier text;
  superuser boolean;
  r record;
BEGIN
  FOREACH grp IN ARRAY groups LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grp) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', grp);
      RAISE NOTICE 'CHANGED group role % created', grp;
    END IF;
  END LOOP;
  FOREACH pair SLICE 1 IN ARRAY pairs LOOP
    login := pair[1];
    grp := pair[2];
    superuser := login = 'ebt_migrate';
    verifier := current_setting('ebt.v_' || login);
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = login) THEN
      EXECUTE format('CREATE ROLE %I LOGIN INHERIT %s NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
                     login, CASE WHEN superuser THEN 'SUPERUSER' ELSE 'NOSUPERUSER' END);
      RAISE NOTICE 'CHANGED login % created', login;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = login
                AND (NOT rolcanlogin OR NOT rolinherit OR rolsuper <> superuser OR rolcreatedb OR rolcreaterole
                     OR rolreplication OR rolbypassrls OR rolconnlimit <> -1
                     OR coalesce(rolvaliduntil, 'infinity') <> 'infinity')) THEN
      EXECUTE format('ALTER ROLE %I LOGIN INHERIT %s NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL %L',
                     login, CASE WHEN superuser THEN 'SUPERUSER' ELSE 'NOSUPERUSER' END, 'infinity');
      RAISE NOTICE 'CHANGED login % attributes corrected', login;
    END IF;
    IF verifier <> '' THEN
      EXECUTE format('ALTER ROLE %I PASSWORD %L', login, verifier);
      RAISE NOTICE 'CHANGED login % password set (SCRAM verifier)', login;
    END IF;
    -- Exactly one membership: in grp, with INHERIT and SET.
    FOR r IN
      SELECT g.rolname AS grp, gr.rolname AS grantor, m.inherit_option, m.set_option, m.admin_option
        FROM pg_auth_members m
        JOIN pg_roles g ON g.oid = m.roleid
        JOIN pg_roles gr ON gr.oid = m.grantor
       WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = login)
    LOOP
      IF r.grp <> grp OR NOT r.inherit_option OR NOT r.set_option OR r.admin_option THEN
        EXECUTE format('REVOKE %I FROM %I GRANTED BY %I CASCADE', r.grp, login, r.grantor);
        RAISE NOTICE 'CHANGED login % removed from %', login, r.grp;
      END IF;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m
                    WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = login)
                      AND m.roleid = (SELECT oid FROM pg_roles WHERE rolname = grp)) THEN
      EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET TRUE', grp, login);
      RAISE NOTICE 'CHANGED login % is a member of %', login, grp;
    END IF;
  END LOOP;
  -- No connections or temp tables for PUBLIC outside the app database.
  FOR r IN
    SELECT d.datname FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
     WHERE d.datname IN ('postgres', 'template1') AND a.grantee = 0 AND a.privilege_type IN ('CONNECT', 'TEMPORARY')
     GROUP BY d.datname
  LOOP
    EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', r.datname);
    RAISE NOTICE 'CHANGED PUBLIC may no longer connect to or create temp tables in %', r.datname;
  END LOOP;
END
$roles$;
SQL
} | psql_super 2>&1) || {
  printf '%s\n' "$output" >&2
  die "applying the logins failed"
}
changes=$(grep -o 'CHANGED .*' <<<"$output" || true)
if [[ -n $changes ]]; then
  printf '%s\n' "$changes" | sed 's/^CHANGED /CHANGED  /'
else
  ok "logins, memberships, passwords and database privileges already as wanted"
fi
printf '\nsummary: %d changed\n' "$(grep -c . <<<"$changes" || true)"
