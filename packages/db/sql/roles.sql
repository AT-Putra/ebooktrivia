-- roles.sql: group roles (cluster-global) and per-database hardening.
--
-- Applied FIRST by src/migrate.ts, as the connecting role (a superuser, or a role with
-- CREATEROLE and ADMIN on these roles), before `SET ROLE migrator`. Re-runnable, and every run
-- RESETS the state: leftovers (privileges granted to an app role by hand, memberships, per-role
-- settings, parameter privileges) are removed, not just the PUBLIC defaults. This file only
-- resets and commits on its own; the refuse-to-migrate checks are in preflight.sql, which runs
-- next, so a refused run still leaves the reset in place.
--
-- search_path first: with `public` on the path, an operator or function planted there with a
-- better-matching signature would run here as superuser. Every SQL file starts with this line.
--
-- Roles are NOLOGIN groups. Per-app LOGIN users are created at deploy time (M4) as members of
-- exactly one group: public@a/b -> public_rw, admin -> admin_rw, worker -> worker_rw,
-- internal -> internal_rw, the migrate job -> migrator (preflight.sql refuses a login in two).
-- Object privileges live in grants.sql.
--
-- trivia_override (US-018) is not a group: it only OWNS the SECURITY DEFINER function
-- public.override_question_scoring (sql/override.sql), so `current_user = 'trivia_override'` holds
-- inside that function and nowhere else. The question content lock triggers let exactly that
-- caller change points, timers and the correct option of a set with attempts. It is NOLOGIN, has
-- no members (every membership in it is revoked below on every run) and is a member of nothing.
--
-- contest_results (US-028) is the same kind of role: it only OWNS the SECURITY DEFINER functions of
-- sql/contest.sql (the grace-end finalize and results snapshot, the Owner's winner confirmation and
-- deadline extension, the masked-winners banner read), so `current_user = 'contest_results'` holds
-- inside them and nowhere else. The winners and program-status guards (triggers.sql) let exactly that
-- caller confirm winners and move a program to awaiting_confirmation / finalized. NOLOGIN, no
-- members, a member of nothing.
--
-- conversion_refire (US-024) is the same kind of role: it only OWNS the SECURITY DEFINER function
-- public.refire_conversion (sql/conversions.sql), the Owner's explicit re-fire of a failed or resent
-- conversion, so `current_user = 'conversion_refire'` holds inside it and nowhere else. The sent-final guard
-- (triggers.sql) lets exactly that caller move a conversion the sink acknowledged out of `sent`. NOLOGIN, no
-- members, a member of nothing.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

DO $roles$
DECLARE
  r text;
  m record;
  p record;
BEGIN
  FOREACH r IN ARRAY ARRAY['migrator', 'public_rw', 'admin_rw', 'worker_rw', 'internal_rw', 'trivia_override', 'contest_results', 'conversion_refire'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      BEGIN
        EXECUTE pg_catalog.format('CREATE ROLE %I NOLOGIN', r);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL; -- created concurrently by a migration of another database in this cluster
      END;
    END IF;
    -- Enforce the attributes on every run, so a drifted role is corrected.
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = r
        AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    ) THEN
      EXECUTE pg_catalog.format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
    END IF;
    -- No per-role settings (e.g. a search_path override), in any database or in this one.
    EXECUTE pg_catalog.format('ALTER ROLE %I RESET ALL', r);
    EXECUTE pg_catalog.format('ALTER ROLE %I IN DATABASE %I RESET ALL', r, pg_catalog.current_database());
  END LOOP;

  -- The group roles are members of NO role: not of each other (the guard triggers check
  -- membership with pg_has_role) and not of predefined roles such as pg_read_all_data.
  -- Memberships OF the groups (login users) are deploy-time; preflight.sql checks them.
  FOR m IN
    SELECT g.rolname AS grp, u.rolname AS member, gr.rolname AS grantor
      FROM pg_catalog.pg_auth_members am
      JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
      JOIN pg_catalog.pg_roles u ON u.oid = am.member
      JOIN pg_catalog.pg_roles gr ON gr.oid = am.grantor
     WHERE u.rolname IN ('migrator', 'public_rw', 'admin_rw', 'worker_rw', 'internal_rw', 'trivia_override', 'contest_results', 'conversion_refire')
        -- Nobody may be a member of trivia_override, contest_results or conversion_refire: a member could SET ROLE
        -- to it and pass the content lock's override check, confirm winners or resend a conversion the sink
        -- acknowledged, outside their functions.
        OR g.rolname IN ('trivia_override', 'contest_results', 'conversion_refire')
  LOOP
    EXECUTE pg_catalog.format('REVOKE %I FROM %I GRANTED BY %I CASCADE', m.grp, m.member, m.grantor);
  END LOOP;

  -- No parameter privileges (GRANT SET / ALTER SYSTEM ON PARAMETER), e.g. SET on
  -- session_replication_role, which would switch off ENABLE ORIGIN triggers.
  FOR p IN SELECT parname FROM pg_catalog.pg_parameter_acl LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON PARAMETER %I FROM public_rw, admin_rw, worker_rw, internal_rw, migrator, trivia_override, contest_results, conversion_refire CASCADE', p.parname);
  END LOOP;
END
$roles$;

-- Database: nobody connects or creates temp tables by default, and every privilege an app role
-- may have picked up is revoked before the intended ones are granted again. The default
-- search_path drops "$user": a schema named after a login user would otherwise shadow our
-- unqualified tables for every session of that user (apps also pin it, PG_CONNECTION_OPTIONS).
DO $db$
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON DATABASE %I FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator, trivia_override, contest_results, conversion_refire',
    pg_catalog.current_database());
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO public_rw, admin_rw, worker_rw, internal_rw',
    pg_catalog.current_database());
  EXECUTE pg_catalog.format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO migrator',
    pg_catalog.current_database());
  EXECUTE pg_catalog.format('ALTER DATABASE %I SET search_path = public', pg_catalog.current_database());
END
$db$;

-- The Owner's scoring override function is owned by trivia_override, not migrator, so migrator
-- could not revoke its privileges in grants.sql and preflight.sql would refuse it as foreign-owned
-- (ET090). It is dropped here on every run and created again, with its owner and grants, by
-- sql/override.sql at the very end (src/migrate.ts). Until then no override can run (fail closed).
-- Every signature it ever had is dropped (it changed in the US-018 review), whoever owns it.
-- The same for the functions contest_results owns (US-028), created again by sql/contest.sql, and the one
-- conversion_refire owns (US-024), created again by sql/conversions.sql.
DO $override$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::pg_catalog.regprocedure AS sig FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'public'::pg_catalog.regnamespace
       AND p.proname IN ('override_question_scoring', 'create_leaderboard_snapshot', 'confirm_program_winners',
                         'extend_open_question_deadlines', 'program_winners_banner', 'refire_conversion')
  LOOP
    EXECUTE pg_catalog.format('DROP FUNCTION %s', f.sig);
  END LOOP;
END
$override$;

-- Schema public: owned by migrator; USAGE only for the app roles (and trivia_override /
-- contest_results / conversion_refire, whose functions name public tables), nothing for PUBLIC.
ALTER SCHEMA public OWNER TO migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, trivia_override, contest_results, conversion_refire;
GRANT USAGE ON SCHEMA public TO public_rw, admin_rw, worker_rw, internal_rw, trivia_override, contest_results, conversion_refire;

-- Objects migrator creates later get no PUBLIC privileges (functions would otherwise get
-- EXECUTE to PUBLIC), and no app-role grants: every grant is explicit in grants.sql.
ALTER DEFAULT PRIVILEGES FOR ROLE migrator REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator REVOKE ALL ON FUNCTIONS FROM PUBLIC;
