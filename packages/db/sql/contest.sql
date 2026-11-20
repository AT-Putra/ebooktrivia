-- contest.sql: the end of a program's contest (US-028; plan M9 items 4-6, §10 items 3, 16, 19, 21;
-- spec AC-Q10, AC-Q11, AC-A9).
--
-- Applied by src/migrate.ts LAST, after override.sql, as the connecting role (a superuser), like
-- override.sql: every function here is owned by contest_results (roles.sql: NOLOGIN, no members,
-- member of nothing), which only a superuser can arrange without making migrator a member of it.
-- Re-runnable: roles.sql drops these functions (every signature) at the start of every run, and
-- this file creates them again with their owner and grants.
--
-- Why a dedicated owner: the winners guard and the program-status guard (triggers.sql) let ONLY
-- current_user = 'contest_results' confirm winners and move a program to awaiting_confirmation or
-- finalized, which holds inside these SECURITY DEFINER functions and nowhere else. No app role holds
-- INSERT, UPDATE or DELETE on leaderboard_snapshots or winners (grants.sql), so these functions are
-- the only way to write the result, and the result is derived here in SQL from the raw facts
-- (picks and server timestamps), never taken from a caller.
--
-- Every function: SET search_path = pg_catalog, pg_temp with every object of ours schema-qualified;
-- EXECUTE revoked from PUBLIC and granted per role at the end; time from clock_timestamp(); READ
-- COMMITTED (ET100), so each statement sees what committed while it waited for the contest lock.
-- The audit row is written here, in the same transaction (no player id, name or contact in it).
--
-- THE contest lock (functions.sql lock_program_contest, EXCLUSIVE) is taken first by all three
-- writers, so they serialise with each other, with the Owner's scoring override and prize tier
-- edits (both exclusive, both refused once the snapshot exists: ET022 / ET072), and with play (the
-- answer, serve and start paths take the SHARED lock, US-027): play in flight commits first, and no
-- play starts until the writer has committed.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

-- ---------------------------------------------------------------------------------------------
-- The grace-end finalize, results snapshot and winners of one program, in ONE transaction (worker
-- grace-end sweeper; EXECUTE worker_rw). The rules are @ebooktrivia/core contest.ts finalizeContest
-- (apps/admin test/contest-oracle.int.test.ts proves the two equal on random play histories):
--   0. lock (security review P1-1): the contest lock (play takes its shared side in the play guards,
--      so no play write runs meanwhile), then the program's whole play data FOR UPDATE: its sets (a
--      new attempt needs a key-share lock on its set; a scoring edit locks its set), the program row
--      (a reschedule cannot move the grace end), its attempts (a new answer row needs a key-share
--      lock on its attempt) and its answer rows. Nothing it reads changes until it commits. Then: an
--      existing snapshot is returned as it is (created false: EXACTLY ONE snapshot per program, also
--      with two workers and repeated sweeps; the UNIQUE program_id backs it up); the program must be
--      published (ET102), its grace end G (sales_end_at + grace_days) at least 60 s past, and no
--      question served before G still running, i.e. before its deadline + 1500 ms (ET103, code
--      review MAJOR-1: every question served before G gets its full time; the worker skips ET103
--      and retries next minute; bounded by G + 600 s timer + 1.5 s, plus an Owner extension);
--   1. closes play: every answer row of the program's attempts still open becomes a timeout,
--      answered_at = deadline_at for a served row (served_at + timer if none was stored) and = G for a
--      row never served; a row served at or after G (only a trusted writer could) counts as never
--      served. Then EVERY answer row is scored with public.score_answer under the current rules (a
--      stored score is never trusted);
--   2. attempts: score / total_ms are sums; finished_at = the last answered_at once every question of
--      the set has a row SERVED before G, else NULL (security review N6: a set started and never
--      served is not "finished", so it cannot beat a set never started on the finish key);
--   3. stats of every player of the program (paid at some point, or holding an attempt): score = sum,
--      total_ms = sum + the summed timers of every question the player has no row for (the sets never
--      started, as ONE aggregate: no per-question rows), sets_completed, finished_at = the last
--      attempt finish once every set is finished, else NULL (NULLS LAST). So skipping never beats
--      playing (§10 item 19);
--   4. the snapshot: the ELIGIBLE players only (AC-Q11), ranked score desc, total_ms asc, finished_at
--      asc NULLS LAST (AC-Q10), then first_paid_at asc and player_id asc as stable final
--      tie-breakers, so ranks are unique; entries = [{rank, player_id, score, total_ms, finished_at
--      (ISO 8601 UTC, ms), sets_completed, unplayed_ms}], frozen_at = G;
--   5. winners: each ranked player whose rank lies in a prize tier, awaiting_confirmation;
--   6. the program moves to awaiting_confirmation (play is closed: the play guards refuse public_rw
--      on a program that is not published), and the system audit row is written.
CREATE OR REPLACE FUNCTION public.create_leaderboard_snapshot(p_program_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_status public.program_status;
  v_grace_end timestamptz;
  v_snapshot uuid;
  v_set_count integer;
  v_program_ms bigint;
  v_finalized integer;
  v_rescored integer;
  v_attempts integer;
  v_stats integer;
  v_ranked integer;
  v_entries jsonb;
  v_winners integer;
  v_summary jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the results snapshot must run under READ COMMITTED' USING ERRCODE = 'ET100';
  END IF;
  IF p_program_id IS NULL THEN
    RAISE EXCEPTION 'create_leaderboard_snapshot: the program is required' USING ERRCODE = 'ET101';
  END IF;

  PERFORM public.lock_program_contest(p_program_id);
  PERFORM 1 FROM public.trivia_sets s WHERE s.program_id = p_program_id ORDER BY s.id FOR UPDATE;
  SELECT p.status, date_trunc('milliseconds', p.sales_end_at + make_interval(days => p.grace_days))
    INTO v_status, v_grace_end
    FROM public.programs p WHERE p.id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_leaderboard_snapshot: unknown program' USING ERRCODE = 'ET101';
  END IF;
  PERFORM 1 FROM public.set_attempts a JOIN public.trivia_sets s ON s.id = a.set_id
   WHERE s.program_id = p_program_id ORDER BY a.id FOR UPDATE OF a;
  PERFORM 1 FROM public.attempt_questions aq JOIN public.set_attempts a ON a.id = aq.attempt_id
    JOIN public.trivia_sets s ON s.id = a.set_id
   WHERE s.program_id = p_program_id ORDER BY aq.id FOR UPDATE OF aq;
  SELECT l.id INTO v_snapshot FROM public.leaderboard_snapshots l WHERE l.program_id = p_program_id;
  IF FOUND THEN
    RETURN jsonb_build_object('program_id', p_program_id, 'snapshot_id', v_snapshot, 'created', false);
  END IF;
  IF v_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'program % is % (not published): no results snapshot', p_program_id, v_status USING ERRCODE = 'ET102';
  END IF;
  IF clock_timestamp() < v_grace_end + interval '60 seconds' THEN
    RAISE EXCEPTION 'program % is still in its grace period (it ends at %)', p_program_id, v_grace_end USING ERRCODE = 'ET103';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.attempt_questions aq
      JOIN public.set_attempts a ON a.id = aq.attempt_id
      JOIN public.trivia_sets s ON s.id = a.set_id AND s.program_id = p_program_id
      JOIN public.questions q ON q.id = aq.question_id
     WHERE aq.answered_at IS NULL AND aq.served_at IS NOT NULL AND aq.served_at < v_grace_end
       AND coalesce(aq.deadline_at, aq.served_at + make_interval(secs => q.timer_seconds)) + interval '1500 milliseconds' > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'program %: a question served before the grace end is still running', p_program_id USING ERRCODE = 'ET103';
  END IF;

  SELECT count(*)::int INTO v_set_count FROM public.trivia_sets s WHERE s.program_id = p_program_id;
  SELECT coalesce(sum(q.timer_seconds::bigint * 1000), 0) INTO v_program_ms
    FROM public.questions q JOIN public.trivia_sets s ON s.id = q.set_id WHERE s.program_id = p_program_id;

  -- 1. Close play: every open or never-served row of a started attempt is a timeout.
  UPDATE public.attempt_questions aq
     SET answered_at = CASE WHEN aq.served_at IS NULL OR aq.served_at >= v_grace_end THEN v_grace_end
                            ELSE coalesce(aq.deadline_at, aq.served_at + make_interval(secs => q.timer_seconds)) END
    FROM public.set_attempts a, public.trivia_sets s, public.questions q
   WHERE a.id = aq.attempt_id AND s.id = a.set_id AND s.program_id = p_program_id AND q.id = aq.question_id
     AND aq.answered_at IS NULL;
  GET DIAGNOSTICS v_finalized = ROW_COUNT;

  WITH scored AS (
    SELECT aq.id, r.correct, r.points, r.elapsed_ms
      FROM public.attempt_questions aq
      JOIN public.set_attempts a ON a.id = aq.attempt_id
      JOIN public.trivia_sets s ON s.id = a.set_id AND s.program_id = p_program_id
      JOIN public.questions q ON q.id = aq.question_id
      CROSS JOIN LATERAL public.score_answer(
        q.points, q.timer_seconds,
        (SELECT o.id FROM public.question_options o WHERE o.question_id = q.id AND o.is_correct),
        aq.option_id, CASE WHEN aq.served_at < v_grace_end THEN aq.served_at END, aq.deadline_at, aq.answered_at,
        aq.deadline_extension_ms) r
  )
  UPDATE public.attempt_questions aq
     SET correct = sc.correct, points = sc.points, elapsed_ms = sc.elapsed_ms
    FROM scored sc
   WHERE aq.id = sc.id AND (aq.correct, aq.points, aq.elapsed_ms) IS DISTINCT FROM (sc.correct, sc.points, sc.elapsed_ms);
  GET DIAGNOSTICS v_rescored = ROW_COUNT;

  -- 2. Attempts.
  WITH sums AS (
    SELECT a.id, coalesce(sum(aq.points), 0) AS score, coalesce(sum(aq.elapsed_ms), 0) AS total_ms,
           count(aq.id) FILTER (WHERE aq.served_at < v_grace_end) AS served_rows, max(aq.answered_at) AS last_answer,
           (SELECT count(*) FROM public.questions q WHERE q.set_id = a.set_id) AS question_count
      FROM public.set_attempts a
      JOIN public.trivia_sets s ON s.id = a.set_id AND s.program_id = p_program_id
      LEFT JOIN public.attempt_questions aq ON aq.attempt_id = a.id
     GROUP BY a.id, a.set_id
  ), derived AS (
    SELECT su.id, su.score, su.total_ms,
           CASE WHEN su.question_count > 0 AND su.served_rows = su.question_count THEN su.last_answer END AS finished_at
      FROM sums su
  )
  UPDATE public.set_attempts a
     SET score = d.score, total_ms = d.total_ms, finished_at = d.finished_at
    FROM derived d
   WHERE a.id = d.id AND (a.score::bigint, a.total_ms, a.finished_at) IS DISTINCT FROM (d.score, d.total_ms, d.finished_at);
  GET DIAGNOSTICS v_attempts = ROW_COUNT;

  -- 3. Stats, with the unplayed aggregate.
  WITH roster AS (
    SELECT pp.player_id FROM public.player_programs pp WHERE pp.program_id = p_program_id AND pp.first_paid_at IS NOT NULL
    UNION
    SELECT a.player_id FROM public.set_attempts a JOIN public.trivia_sets s ON s.id = a.set_id WHERE s.program_id = p_program_id
  ), played AS (
    SELECT a.player_id, sum(a.score) AS score, sum(a.total_ms) AS total_ms, count(a.finished_at)::int AS sets_completed,
           max(a.finished_at) AS last_finish
      FROM public.set_attempts a JOIN public.trivia_sets s ON s.id = a.set_id AND s.program_id = p_program_id
     GROUP BY a.player_id
  ), covered AS (
    SELECT a.player_id, sum(q.timer_seconds::bigint * 1000) AS ms
      FROM public.attempt_questions aq
      JOIN public.set_attempts a ON a.id = aq.attempt_id
      JOIN public.trivia_sets s ON s.id = a.set_id AND s.program_id = p_program_id
      JOIN public.questions q ON q.id = aq.question_id
     GROUP BY a.player_id
  )
  INSERT INTO public.player_program_stats (player_id, program_id, score, total_ms, sets_completed, finished_at, updated_at)
  SELECT r.player_id, p_program_id, coalesce(pl.score, 0), coalesce(pl.total_ms, 0) + (v_program_ms - coalesce(c.ms, 0)),
         coalesce(pl.sets_completed, 0),
         CASE WHEN v_set_count > 0 AND coalesce(pl.sets_completed, 0) = v_set_count THEN pl.last_finish END, clock_timestamp()
    FROM roster r
    LEFT JOIN played pl ON pl.player_id = r.player_id
    LEFT JOIN covered c ON c.player_id = r.player_id
  ON CONFLICT (player_id, program_id) DO UPDATE
     SET score = EXCLUDED.score, total_ms = EXCLUDED.total_ms, sets_completed = EXCLUDED.sets_completed,
         finished_at = EXCLUDED.finished_at, updated_at = EXCLUDED.updated_at
   WHERE (player_program_stats.score, player_program_stats.total_ms, player_program_stats.sets_completed, player_program_stats.finished_at)
         IS DISTINCT FROM (EXCLUDED.score, EXCLUDED.total_ms, EXCLUDED.sets_completed, EXCLUDED.finished_at);
  GET DIAGNOSTICS v_stats = ROW_COUNT;

  -- 4. The ranked, eligible players, frozen.
  WITH attempt_totals AS (
    SELECT a.player_id, sum(a.total_ms) AS total_ms
      FROM public.set_attempts a JOIN public.trivia_sets s ON s.id = a.set_id AND s.program_id = p_program_id
     GROUP BY a.player_id
  ), ranked AS (
    SELECT st.player_id, st.score, st.total_ms, st.finished_at, st.sets_completed,
           st.total_ms - coalesce(t.total_ms, 0) AS unplayed_ms,
           row_number() OVER (ORDER BY st.score DESC, st.total_ms ASC, st.finished_at ASC NULLS LAST,
                                       pp.first_paid_at ASC NULLS LAST, st.player_id ASC)::int AS rank
      FROM public.player_program_stats st
      JOIN public.player_programs pp ON pp.player_id = st.player_id AND pp.program_id = st.program_id AND pp.eligible
      LEFT JOIN attempt_totals t ON t.player_id = st.player_id
     WHERE st.program_id = p_program_id
  )
  SELECT count(*)::int,
         coalesce(jsonb_agg(jsonb_build_object(
           'rank', rk.rank, 'player_id', rk.player_id, 'score', rk.score, 'total_ms', rk.total_ms,
           'finished_at', to_char(rk.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'sets_completed', rk.sets_completed, 'unplayed_ms', rk.unplayed_ms) ORDER BY rk.rank), '[]'::jsonb)
    INTO v_ranked, v_entries
    FROM ranked rk;
  INSERT INTO public.leaderboard_snapshots (program_id, frozen_at, entries)
  VALUES (p_program_id, v_grace_end, v_entries)
  RETURNING id INTO v_snapshot;

  -- 5. Winners.
  INSERT INTO public.winners (program_id, snapshot_id, prize_tier_id, player_id, rank)
  SELECT p_program_id, v_snapshot, t.id, (e.value ->> 'player_id')::uuid, (e.value ->> 'rank')::int
    FROM jsonb_array_elements(v_entries) e
    JOIN public.prize_tiers t ON t.program_id = p_program_id AND (e.value ->> 'rank')::int BETWEEN t.rank_from AND t.rank_to
   ORDER BY (e.value ->> 'rank')::int;
  GET DIAGNOSTICS v_winners = ROW_COUNT;

  -- 6. Play is closed; the audit row.
  UPDATE public.programs SET status = 'awaiting_confirmation', updated_at = clock_timestamp() WHERE id = p_program_id;
  v_summary := jsonb_build_object(
    'program_id', p_program_id, 'snapshot_id', v_snapshot, 'created', true,
    'frozen_at', to_char(v_grace_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'answers_finalized', v_finalized, 'answers_rescored', v_rescored, 'attempts_changed', v_attempts,
    'stats_written', v_stats, 'players_ranked', v_ranked, 'winners', v_winners);
  INSERT INTO public.audit_log (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  VALUES ('system', NULL, 'contest.snapshot', 'program', p_program_id::text, v_summary, '{}'::text[], NULL, NULL);
  RETURN v_summary;
END
$fn$;

-- ---------------------------------------------------------------------------------------------
-- The Owner's winner confirmation (AC-A9; EXECUTE admin_rw, Owner-only in the admin app, policy
-- winners.confirm): confirms every winner of the program's snapshot at once and moves the program
-- to finalized; from then on the banner read path below publishes them, masked. Refused unless the
-- actor is an active Owner (ET101), the snapshot exists and the program awaits confirmation
-- (ET102), and while any winner is no longer eligible (refunded since the snapshot: AC-Q11) or is
-- flagged (a chargeback, US-021) (ET107; resolving that, a revoke and re-award, is US-030's). The
-- winners' player_programs rows are locked FOR SHARE first (security review P2-1), so a refund
-- either commits before the check (and is seen) or waits for the confirmation to commit.
CREATE OR REPLACE FUNCTION public.confirm_program_winners(
  p_program_id uuid,
  p_actor_admin_user_id text,
  p_request_id text,
  p_ip inet
)
  RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_status public.program_status;
  v_snapshot uuid;
  v_confirmed integer;
  v_now timestamptz := clock_timestamp();
  v_summary jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the winner confirmation must run under READ COMMITTED' USING ERRCODE = 'ET100';
  END IF;
  IF p_program_id IS NULL OR p_actor_admin_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.admin_profiles ap
     WHERE ap.auth_user_id = p_actor_admin_user_id AND ap.role = 'owner' AND ap.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'confirm_program_winners: the program is required and the actor must be an active Owner' USING ERRCODE = 'ET101';
  END IF;

  PERFORM public.lock_program_contest(p_program_id);
  SELECT p.status INTO v_status FROM public.programs p WHERE p.id = p_program_id FOR UPDATE;
  SELECT l.id INTO v_snapshot FROM public.leaderboard_snapshots l WHERE l.program_id = p_program_id;
  IF v_snapshot IS NULL OR v_status IS DISTINCT FROM 'awaiting_confirmation' THEN
    RAISE EXCEPTION 'program % has no results awaiting confirmation (status %)', p_program_id, v_status USING ERRCODE = 'ET102';
  END IF;
  PERFORM 1 FROM public.player_programs pp JOIN public.winners w ON w.player_id = pp.player_id AND w.program_id = pp.program_id
   WHERE w.snapshot_id = v_snapshot ORDER BY pp.player_id FOR SHARE OF pp;
  IF EXISTS (
    SELECT 1 FROM public.winners w
      LEFT JOIN public.player_programs pp ON pp.player_id = w.player_id AND pp.program_id = w.program_id
     WHERE w.snapshot_id = v_snapshot AND (pp.eligible IS NOT TRUE OR w.status = 'flagged')
  ) THEN
    RAISE EXCEPTION 'a winner of program % is no longer eligible (refunded) or is flagged: resolve it before confirming', p_program_id
      USING ERRCODE = 'ET107';
  END IF;

  UPDATE public.winners w SET status = 'confirmed', confirmed_at = v_now, updated_at = v_now
   WHERE w.snapshot_id = v_snapshot AND w.status = 'awaiting_confirmation';
  GET DIAGNOSTICS v_confirmed = ROW_COUNT;
  UPDATE public.programs SET status = 'finalized', winners_confirmed_at = v_now, updated_at = v_now WHERE id = p_program_id;

  v_summary := jsonb_build_object('program_id', p_program_id, 'snapshot_id', v_snapshot, 'winners_confirmed', v_confirmed);
  INSERT INTO public.audit_log (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  VALUES ('admin', p_actor_admin_user_id, 'contest.winners_confirm', 'program', p_program_id::text,
          v_summary || jsonb_build_object('status', jsonb_build_object('before', 'awaiting_confirmation', 'after', 'finalized')),
          '{}'::text[], p_request_id, p_ip);
  RETURN v_summary;
END
$fn$;

-- ---------------------------------------------------------------------------------------------
-- The Owner's deadline-extension tool for unplanned outages (§10 item 16; security review P1-4;
-- EXECUTE admin_rw, Owner-only in the admin app, policy contest.extend_deadlines). It gives back
-- ONLY the time an outage took, and at most once per answer:
--   - the outage ran from S to E: S lies within the last trivia.extension_max_minutes
--     (APP_SETTING_BOUNDS) and S <= E <= now (ET101);
--   - the rows: the program's OPEN questions (served, not answered) whose deadline fell inside
--     [S, E] and that were served before E (security review N4: a question abandoned before the
--     outage, served after it, or still running is left alone), never extended
--     (deadline_extension_ms = 0 and no ledger row). A question the play guard already closed as a
--     timeout is answered, so it is not extended;
--   - each gets back what it lost: its deadline - max(served_at, S), at most the question's timer,
--     counted from now: new deadline = now + lost. deadline_extension_ms = new - old deadline, which
--     score_answer reads: a pick counts up to the new deadline (+ 1500 ms) and is charged at most
--     the window the question was served with;
--   - one ledger row per extended answer (deadline_extensions, primary key: at most one extension
--     per answer, for every writer; the play guard lets only contest_results set the extension,
--     once, from 0, ET106), under one extension_id that the audit row names.
-- Also refused for a reason that is not 10-500 characters without contact details or an actor who
-- is not an active Owner (ET101), and once the snapshot exists, the program is not published or
-- grace is over (ET102). Returns and audits the counts (no player id, name or contact).
CREATE OR REPLACE FUNCTION public.extend_open_question_deadlines(
  p_program_id uuid,
  p_outage_started_at timestamptz,
  p_outage_ended_at timestamptz,
  p_reason text,
  p_actor_admin_user_id text,
  p_request_id text,
  p_ip inet
)
  RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_start timestamptz := date_trunc('milliseconds', p_outage_started_at);
  v_end timestamptz := date_trunc('milliseconds', p_outage_ended_at);
  v_extension uuid := gen_random_uuid();
  v_status public.program_status;
  v_grace_end timestamptz;
  v_questions integer;
  v_players integer;
  v_granted bigint;
  v_summary jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the deadline extension must run under READ COMMITTED' USING ERRCODE = 'ET100';
  END IF;
  IF p_program_id IS NULL OR v_start IS NULL OR v_end IS NULL OR v_start > v_end OR v_end > v_now
     OR v_start < v_now - make_interval(mins => public.setting_positive_int('trivia.extension_max_minutes')) THEN
    RAISE EXCEPTION 'extend_open_question_deadlines: the program and an outage start <= end <= now, starting within the last trivia.extension_max_minutes, are required'
      USING ERRCODE = 'ET101';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 10 AND 500
     OR p_reason ~ '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+'
     OR p_reason ~ '(\+?62[[:space:].-]?|\m0)8[0-9[:space:].-]{7,}|[0-9]{10,}' THEN
    RAISE EXCEPTION 'extend_open_question_deadlines: the reason is 10-500 characters without contact details' USING ERRCODE = 'ET101';
  END IF;
  IF p_actor_admin_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.admin_profiles ap
     WHERE ap.auth_user_id = p_actor_admin_user_id AND ap.role = 'owner' AND ap.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'extend_open_question_deadlines: the actor must be an active Owner' USING ERRCODE = 'ET101';
  END IF;

  PERFORM public.lock_program_contest(p_program_id);
  SELECT p.status, date_trunc('milliseconds', p.sales_end_at + make_interval(days => p.grace_days))
    INTO v_status, v_grace_end
    FROM public.programs p WHERE p.id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'extend_open_question_deadlines: unknown program' USING ERRCODE = 'ET101';
  END IF;
  IF v_status IS DISTINCT FROM 'published' OR v_now >= v_grace_end
     OR EXISTS (SELECT 1 FROM public.leaderboard_snapshots l WHERE l.program_id = p_program_id) THEN
    RAISE EXCEPTION 'program % has ended (results snapshot, status or end of grace): deadlines are final', p_program_id
      USING ERRCODE = 'ET102';
  END IF;

  WITH target AS (
    SELECT aq.id, a.player_id, aq.deadline_at AS old_deadline,
           LEAST(aq.deadline_at - GREATEST(aq.served_at, v_start), make_interval(secs => q.timer_seconds)) AS lost
      FROM public.attempt_questions aq
      JOIN public.set_attempts a ON a.id = aq.attempt_id
      JOIN public.trivia_sets s ON s.id = a.set_id AND s.program_id = p_program_id
      JOIN public.questions q ON q.id = aq.question_id
     WHERE aq.served_at IS NOT NULL AND aq.answered_at IS NULL AND aq.deadline_at IS NOT NULL
       AND aq.deadline_at BETWEEN v_start AND v_end AND aq.served_at < v_end
       AND aq.deadline_extension_ms = 0
       AND NOT EXISTS (SELECT 1 FROM public.deadline_extensions e WHERE e.attempt_question_id = aq.id)
       FOR UPDATE OF aq
  ), moved AS (
    UPDATE public.attempt_questions aq
       SET deadline_at = v_now + t.lost,
           deadline_extension_ms = (extract(epoch FROM v_now + t.lost - t.old_deadline) * 1000)::integer
      FROM target t
     WHERE aq.id = t.id AND t.lost > interval '0'
    RETURNING aq.id, t.player_id, t.old_deadline, (extract(epoch FROM t.lost) * 1000)::integer AS granted_ms
  ), ledger AS (
    INSERT INTO public.deadline_extensions (attempt_question_id, extension_id, program_id, original_deadline_at, granted_ms)
    SELECT m.id, v_extension, p_program_id, m.old_deadline, m.granted_ms FROM moved m
    RETURNING attempt_question_id
  )
  SELECT count(*)::int, count(DISTINCT m.player_id)::int, coalesce(sum(m.granted_ms), 0)::bigint
    INTO v_questions, v_players, v_granted
    FROM moved m;

  v_summary := jsonb_build_object(
    'program_id', p_program_id, 'extension_id', v_extension,
    'outage_started_at', to_char(v_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'outage_ended_at', to_char(v_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'questions_extended', v_questions, 'players_affected', v_players, 'granted_ms', v_granted);
  INSERT INTO public.audit_log (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  VALUES ('admin', p_actor_admin_user_id, 'contest.deadline_extension', 'program', p_program_id::text,
          v_summary || jsonb_build_object('reason', btrim(p_reason)), '{}'::text[], p_request_id, p_ip);
  RETURN v_summary;
END
$fn$;

-- ---------------------------------------------------------------------------------------------
-- The banner card's masked winners (AC-Q2, AC-A9; EXECUTE public_rw for the play page, US-027, and
-- admin_rw for its preview): the CONFIRMED winners of a FINALIZED program, by rank, with the prize
-- tier and the name and phone masked in SQL (functions.sql mask_name / mask_phone, the rules of core
-- contest.ts). Nothing before the Owner confirms. Returns no player id, raw name, phone or e-mail.
CREATE OR REPLACE FUNCTION public.program_winners_banner(p_program_id uuid)
  RETURNS TABLE (rank integer, prize_tier_id uuid, prize_name text, masked_name text, masked_phone text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT w.rank, t.id, t.name, public.mask_name(pl.name), public.mask_phone(pl.phone)
    FROM public.programs p
    JOIN public.winners w ON w.program_id = p.id AND w.status = 'confirmed'
    JOIN public.prize_tiers t ON t.id = w.prize_tier_id
    JOIN public.players pl ON pl.id = w.player_id
   WHERE p.id = p_program_id AND p.status = 'finalized' AND p.winners_confirmed_at IS NOT NULL
   ORDER BY w.rank
$fn$;

ALTER FUNCTION public.create_leaderboard_snapshot(uuid) OWNER TO contest_results;
ALTER FUNCTION public.confirm_program_winners(uuid, text, text, inet) OWNER TO contest_results;
ALTER FUNCTION public.extend_open_question_deadlines(uuid, timestamptz, timestamptz, text, text, text, inet) OWNER TO contest_results;
ALTER FUNCTION public.program_winners_banner(uuid) OWNER TO contest_results;

REVOKE ALL ON FUNCTION public.create_leaderboard_snapshot(uuid)
  FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.confirm_program_winners(uuid, text, text, inet)
  FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.extend_open_question_deadlines(uuid, timestamptz, timestamptz, text, text, text, inet)
  FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.program_winners_banner(uuid)
  FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;

GRANT EXECUTE ON FUNCTION public.create_leaderboard_snapshot(uuid) TO worker_rw;
GRANT EXECUTE ON FUNCTION public.confirm_program_winners(uuid, text, text, inet) TO admin_rw;
GRANT EXECUTE ON FUNCTION public.extend_open_question_deadlines(uuid, timestamptz, timestamptz, text, text, text, inet) TO admin_rw;
GRANT EXECUTE ON FUNCTION public.program_winners_banner(uuid) TO public_rw, admin_rw;
