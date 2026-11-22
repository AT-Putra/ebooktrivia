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
--
-- delivery_resend (US-025) is the same kind of role, for deliveries: the Owner's or Staff's explicit resend of a delivery
-- that went out, may have, or failed: it only OWNS the SECURITY DEFINER function public.resend_delivery (sql/delivery-resend.sql), so
-- `current_user = 'delivery_resend'` holds inside it and nowhere else. The deliveries final guard (triggers.sql, ET130) lets exactly
-- that caller move such a row back onto the send path. NOLOGIN, no members, a member of nothing.
--
-- US-030 adds two more of the same kind. prize_fulfillment only OWNS the SECURITY DEFINER functions of sql/fulfillment.sql (the
-- Owner's prize fulfilment steps, notes and proof), so `current_user = 'prize_fulfillment'` holds inside them and nowhere else: the
-- fulfilment guard (triggers.sql, ET175) lets exactly that caller move a fulfilment. pii_eraser only OWNS public.erase_data_subject
-- (sql/privacy.sql), the Owner's UU PDP deletion = anonymization of one data subject in one transaction; the play, fulfilment and
-- anonymized-row guards let exactly that caller blank the personal columns. NOLOGIN, no members, a member of nothing.
--
-- order_review (US-033) is the same kind of role, for the Owner's decision on an order in review ("mark paid" / "not paid"): it only
-- OWNS the SECURITY DEFINER function public.order_review_decide (sql/order-review.sql), so `current_user = 'order_review'` holds inside
-- it and nowhere else. The order status guard (triggers.sql) lets exactly that caller move an order out of `review`, and the decision
-- ledger is written by nobody else. NOLOGIN, no members, a member of nothing.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

DO $roles$
DECLARE
  r text;
  m record;
  p record;
BEGIN
  FOREACH r IN ARRAY ARRAY['migrator', 'public_rw', 'admin_rw', 'worker_rw', 'internal_rw', 'trivia_override', 'contest_results', 'conversion_refire', 'delivery_resend', 'trivia_play', 'prize_fulfillment', 'pii_eraser', 'order_review'] LOOP
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
     WHERE u.rolname IN ('migrator', 'public_rw', 'admin_rw', 'worker_rw', 'internal_rw', 'trivia_override', 'contest_results', 'conversion_refire', 'delivery_resend', 'trivia_play', 'prize_fulfillment', 'pii_eraser', 'order_review')
        -- Nobody may be a member of trivia_override, contest_results, conversion_refire, delivery_resend, trivia_play,
        -- prize_fulfillment, pii_eraser or order_review: a member could SET ROLE to it and pass the content lock's override check, confirm
        -- winners, resend a conversion the sink acknowledged, resend a delivery, write the play rows and scores, move a
        -- prize fulfilment, blank personal data or decide an order in review, outside their functions.
        OR g.rolname IN ('trivia_override', 'contest_results', 'conversion_refire', 'delivery_resend', 'trivia_play', 'prize_fulfillment', 'pii_eraser', 'order_review')
  LOOP
    EXECUTE pg_catalog.format('REVOKE %I FROM %I GRANTED BY %I CASCADE', m.grp, m.member, m.grantor);
  END LOOP;

  -- No parameter privileges (GRANT SET / ALTER SYSTEM ON PARAMETER), e.g. SET on
  -- session_replication_role, which would switch off ENABLE ORIGIN triggers.
  FOR p IN SELECT parname FROM pg_catalog.pg_parameter_acl LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON PARAMETER %I FROM public_rw, admin_rw, worker_rw, internal_rw, migrator, trivia_override, contest_results, conversion_refire, delivery_resend, trivia_play, prize_fulfillment, pii_eraser, order_review CASCADE', p.parname);
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
    'REVOKE ALL ON DATABASE %I FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator, trivia_override, contest_results, conversion_refire, delivery_resend, trivia_play, prize_fulfillment, pii_eraser, order_review',
    pg_catalog.current_database());
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO public_rw, admin_rw, worker_rw, internal_rw',
    pg_catalog.current_database());
  EXECUTE pg_catalog.format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO migrator',
    pg_catalog.current_database());
  EXECUTE pg_catalog.format('ALTER DATABASE %I SET search_path = public', pg_catalog.current_database());
  -- US-029: a session of an app role never stays idle inside a transaction for more than 10 minutes (a row lock or the
  -- report rollup's advisory lock held by a stuck transaction is released). A database default, because a setting on a
  -- NOLOGIN group role is not inherited by its member logins; a login's own setting (infra db-roles.sh: ebt_admin 60 s,
  -- the apps' connection options) overrides it. A default, not a boundary: a session may change its own setting.
  EXECUTE pg_catalog.format('ALTER DATABASE %I SET idle_in_transaction_session_timeout = %L', pg_catalog.current_database(), '10min');
END
$db$;

-- The Owner's scoring override function is owned by trivia_override, not migrator, so migrator
-- could not revoke its privileges in grants.sql and preflight.sql would refuse it as foreign-owned
-- (ET090). It is dropped here on every run and created again, with its owner and grants, by
-- sql/override.sql at the very end (src/migrate.ts). Until then no override can run (fail closed).
-- Every signature it ever had is dropped (it changed in the US-018 review), whoever owns it.
-- The same for the functions contest_results owns (US-028), created again by sql/contest.sql, and the one
-- conversion_refire owns (US-024), created again by sql/conversions.sql, the one delivery_resend owns (US-025), created again by sql/delivery-resend.sql,
-- and those trivia_play owns (US-027), created again by sql/play.sql; US-030: those prize_fulfillment owns (sql/fulfillment.sql), the
-- revoke and reinstatement contest_results owns (sql/contest.sql) and the erasure pii_eraser owns (sql/privacy.sql); US-033: the
-- decision order_review owns (sql/order-review.sql).
DO $override$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::pg_catalog.regprocedure AS sig FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'public'::pg_catalog.regnamespace
       AND p.proname IN ('override_question_scoring', 'create_leaderboard_snapshot', 'confirm_program_winners',
                         'extend_open_question_deadlines', 'program_winners_banner', 'refire_conversion', 'resend_delivery',
                         'play_unlocked_count', 'play_program_ms', 'play_ranking', 'play_settle_answer', 'play_settle_pending',
                         'play_settle', 'play_note_unlocked',
                         'play_start_set', 'play_current', 'play_answer', 'play_reveal', 'play_attempts', 'play_leaderboard',
                         'play_standing',
                         'fulfillment_step', 'fulfillment_set_notes', 'fulfillment_set_proof', 'revoke_winner', 'reinstate_winner',
                         'erase_data_subject', 'order_review_decide')
  LOOP
    EXECUTE pg_catalog.format('DROP FUNCTION %s', f.sig);
  END LOOP;
END
$override$;

-- Schema public: owned by migrator; USAGE only for the app roles (and trivia_override /
-- contest_results / conversion_refire / delivery_resend / trivia_play / prize_fulfillment / pii_eraser / order_review, whose functions name public
-- tables), nothing for PUBLIC.
ALTER SCHEMA public OWNER TO migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, trivia_override, contest_results, conversion_refire, delivery_resend, trivia_play, prize_fulfillment, pii_eraser, order_review;
GRANT USAGE ON SCHEMA public TO public_rw, admin_rw, worker_rw, internal_rw, trivia_override, contest_results, conversion_refire, delivery_resend, trivia_play, prize_fulfillment, pii_eraser, order_review;

-- Objects migrator creates later get no PUBLIC privileges (functions would otherwise get
-- EXECUTE to PUBLIC), and no app-role grants: every grant is explicit in grants.sql.
ALTER DEFAULT PRIVILEGES FOR ROLE migrator REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- US-027 BLOCK BEGIN (security review HIGH-1 residual, defence in depth). What a transaction WROTE must not be
-- measurable by an app login: the WAL position (pg_wal_lsn_diff of two readings gives the bytes a statement wrote)
-- and the statistics counters of the session's transaction (pg_stat_get_xact_*, HOT updates and the like) or of the
-- tables over all sessions (pg_stat_get_tuples_*, the pg_stat_*_tables views, which count rolled-back writes too)
-- would let a session play a pick, measure it and roll it back (sql/play.sql: the pick itself no longer writes
-- anything that depends on correctness; this takes the instruments away as well). EXECUTE / SELECT is revoked from
-- PUBLIC on these pg_catalog objects in this database and granted to pg_monitor only (monitoring logins). Here, in
-- roles.sql, because only the connecting role (the migrate job's superuser login in every environment: production
-- ebt_migrate, SUPERUSER per infra/provision/db-roles.sh, via infra/quadlet/migrate.container; the dev stack and the
-- tests; all through src/migrate.ts) may change pg_catalog's privileges; migrator could not. Re-runnable: a function or view a PostgreSQL version lacks is simply not listed.
DO $instruments$
DECLARE
  f record;
  v record;
BEGIN
  FOR f IN
    SELECT p.oid::pg_catalog.regprocedure AS sig FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace
       AND (p.proname IN ('pg_current_wal_lsn', 'pg_current_wal_insert_lsn', 'pg_current_wal_flush_lsn',
                          'pg_stat_get_wal', 'pg_stat_get_backend_wal', 'pg_stat_get_io', 'pg_stat_get_backend_io',
                          'pg_stat_get_tuples_inserted', 'pg_stat_get_tuples_updated', 'pg_stat_get_tuples_deleted',
                          'pg_stat_get_tuples_hot_updated', 'pg_stat_get_tuples_newpage_updated', 'pg_stat_get_live_tuples',
                          'pg_stat_get_dead_tuples', 'pg_stat_get_mod_since_analyze', 'pg_stat_get_ins_since_vacuum')
            OR p.proname LIKE 'pg\_stat\_get\_xact\_%')
  LOOP
    EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO pg_monitor', f.sig);
  END LOOP;
  FOR v IN
    SELECT c.oid::pg_catalog.regclass AS rel FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'pg_catalog'::pg_catalog.regnamespace AND c.relkind = 'v'
       AND (c.relname IN ('pg_stat_wal', 'pg_stat_io', 'pg_stat_all_tables', 'pg_stat_sys_tables', 'pg_stat_user_tables')
            OR c.relname LIKE 'pg\_stat\_xact\_%')
  LOOP
    EXECUTE pg_catalog.format('REVOKE SELECT ON %s FROM PUBLIC', v.rel);
    EXECUTE pg_catalog.format('GRANT SELECT ON %s TO pg_monitor', v.rel);
  END LOOP;
END
$instruments$;
-- US-027 BLOCK END.
