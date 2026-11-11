-- preflight.sql: refuse-to-migrate checks. Applied by src/migrate.ts right after roles.sql has
-- committed its reset (as the same connecting role, before `SET ROLE migrator`), so a refused
-- run still leaves the leftover privileges removed. Nothing here changes state.
--
--   ET090  a schema outside the managed set, a managed schema not owned by migrator, or an
--          object in a managed schema not owned by migrator. Only migrator creates objects in
--          this database; anything else is a plant (e.g. a schema named after a login user, or
--          a better-matching function shadowing a pg_catalog one). Inspect, drop, re-run.
--   ET091  a LOGIN role that is a member, directly or indirectly, of more than one of the five
--          group roles; it would pass the guard triggers' pg_has_role checks of both.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

DO $objects$
DECLARE
  v_found text;
BEGIN
  SELECT pg_catalog.string_agg(x.what, ', ' ORDER BY x.what) INTO v_found
  FROM (
    SELECT 'schema ' || n.nspname || ' (' || o.rolname || ')' AS what
      FROM pg_catalog.pg_namespace n
      JOIN pg_catalog.pg_roles o ON o.oid = n.nspowner
     WHERE n.nspname NOT IN ('public', 'player_auth', 'admin_auth', 'drizzle',
                             'pg_catalog', 'information_schema', 'pg_toast')
       AND n.nspname !~ '^pg_temp_[0-9]+$'
       AND n.nspname !~ '^pg_toast_temp_[0-9]+$'
    UNION ALL
    -- public is handed to migrator by roles.sql; the others are created by migrator.
    SELECT 'schema ' || n.nspname || ' (' || o.rolname || ')'
      FROM pg_catalog.pg_namespace n
      JOIN pg_catalog.pg_roles o ON o.oid = n.nspowner
     WHERE n.nspname IN ('public', 'player_auth', 'admin_auth', 'drizzle') AND o.rolname <> 'migrator'
    UNION ALL
    SELECT 'relation ' || n.nspname || '.' || c.relname || ' (' || o.rolname || ')'
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles o ON o.oid = c.relowner
     WHERE n.nspname IN ('public', 'player_auth', 'admin_auth', 'drizzle') AND o.rolname <> 'migrator'
    UNION ALL
    SELECT 'function ' || n.nspname || '.' || p.proname || ' (' || o.rolname || ')'
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
     WHERE n.nspname IN ('public', 'player_auth', 'admin_auth', 'drizzle') AND o.rolname <> 'migrator'
    UNION ALL
    SELECT 'type ' || n.nspname || '.' || t.typname || ' (' || o.rolname || ')'
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_catalog.pg_roles o ON o.oid = t.typowner
     WHERE n.nspname IN ('public', 'player_auth', 'admin_auth', 'drizzle') AND o.rolname <> 'migrator'
    UNION ALL
    SELECT 'operator ' || n.nspname || '.' || op.oprname || ' (' || o.rolname || ')'
      FROM pg_catalog.pg_operator op
      JOIN pg_catalog.pg_namespace n ON n.oid = op.oprnamespace
      JOIN pg_catalog.pg_roles o ON o.oid = op.oprowner
     WHERE n.nspname IN ('public', 'player_auth', 'admin_auth', 'drizzle') AND o.rolname <> 'migrator'
  ) x;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected schemas or objects not owned by migrator: %', v_found
      USING ERRCODE = 'ET090', HINT = 'Only migrator may create schemas and objects here; inspect and drop them, then re-run.';
  END IF;
END
$objects$;

DO $logins$
DECLARE
  v_found text;
BEGIN
  SELECT pg_catalog.string_agg(x.rolname || ' (' || x.groups || ')', ', ' ORDER BY x.rolname) INTO v_found
  FROM (
    SELECT r.rolname, pg_catalog.string_agg(g.grp, ', ' ORDER BY g.grp) AS groups
      FROM pg_catalog.pg_roles r
     CROSS JOIN pg_catalog.unnest(ARRAY['migrator', 'public_rw', 'admin_rw', 'worker_rw', 'internal_rw']) AS g(grp)
     WHERE r.rolcanlogin
       AND NOT r.rolsuper -- a superuser passes every check anyway and is not an app login
       AND pg_catalog.pg_has_role(r.oid, g.grp, 'MEMBER') -- direct or indirect
     GROUP BY r.rolname
    HAVING pg_catalog.count(*) > 1
  ) x;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'login roles in more than one group role: %', v_found
      USING ERRCODE = 'ET091', HINT = 'Each app login must be a member of exactly one of the five group roles.';
  END IF;
END
$logins$;
