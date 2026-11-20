-- override.sql: the Owner's locked-field override (US-018, AC-Q10 fairness, plan §10 item 21).
--
-- Applied by src/migrate.ts LAST, after `RESET ROLE`, as the connecting role (a superuser): the
-- function is owned by trivia_override (roles.sql: NOLOGIN, no members, member of nothing), which
-- only a superuser can arrange without making migrator a member of it. Re-runnable: roles.sql drops
-- the function (every signature) at the start of every run, so grants.sql (run as migrator) and
-- preflight.sql never meet an object migrator does not own, and this file creates it again with
-- its owner and grants.
--
-- Why a dedicated owner: the question content lock (triggers.sql) refuses changes to points,
-- timers and the correct option of a set with attempts for EVERY writer, and lets them through
-- only when current_user = 'trivia_override', which holds inside this SECURITY DEFINER function and
-- nowhere else (no session can SET ROLE to it; a GUC could be set by any admin_rw session).
--
-- The function DERIVES every score it writes (security review US-018 H1: it no longer accepts
-- rows from the caller). In the caller's transaction (READ COMMITTED, ET021 otherwise):
--   1. checks the arguments (ET023): a reason of 10-500 characters without an e-mail address or a
--      phone number, an actor who is an active Owner, the set in the program, the question in the
--      set, the new correct option in the question;
--   2. takes the program's EXCLUSIVE contest lock (functions.sql lock_program_contest) and locks
--      the program's sets FOR UPDATE, so no attempt starts on them meanwhile (a new attempt takes a
--      key-share lock on its set);
--   3. refuses (ET022) once the results snapshot exists, the contest has ended (status
--      awaiting_confirmation / finalized) or grace is over (sales_end_at + grace_days);
--   4. applies the change: points, timer, the one correct option;
--   5. re-scores EVERY answer row of the affected players' attempts in the program (the players
--      with an attempt on the set), each with its own question's points, timer and correct option,
--      through public.score_answer (functions.sql), the one SQL copy of @ebooktrivia/core
--      scoreAnswer: a stored score is never trusted, whatever wrote it (public_rw can write
--      attempt_questions.points);
--   6. derives those players' attempts and per-program stats from the re-scored answers exactly
--      as core rescorePlayers does: score / total_ms are sums; an attempt's finished_at is its last
--      answered_at once every question of its set has a finalized answer (else NULL); stats
--      sets_completed counts finished attempts and finished_at is the last finish once every set
--      of the program is finished (else NULL). A missing stats row is created. The oracle,
--      apps/admin test/rescore-oracle.int.test.ts, proves the result equals core row for row;
--   7. writes the audit row itself (the field changes, the reason, the totals before / after over
--      the affected players; no player id, name or contact) and returns the same summary.
-- EXECUTE: admin_rw only.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

CREATE OR REPLACE FUNCTION public.override_question_scoring(
  p_program_id uuid,
  p_set_id uuid,
  p_question_id uuid,
  p_points integer,
  p_timer_seconds integer,
  p_correct_option_id uuid,
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
  v_status public.program_status;
  v_grace_end timestamptz;
  v_set_count integer;
  v_before_points integer;
  v_before_timer integer;
  v_before_correct smallint;
  v_after_correct smallint;
  v_question boolean;
  v_options boolean;
  v_scored integer;
  v_answers integer;
  v_attempts integer;
  v_stats integer;
  b_players integer;
  b_score bigint;
  b_total bigint;
  b_sets bigint;
  b_finished integer;
  a_players integer;
  a_score bigint;
  a_total bigint;
  a_sets bigint;
  a_finished integer;
  v_summary jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the scoring override must run under READ COMMITTED' USING ERRCODE = 'ET021';
  END IF;
  IF p_program_id IS NULL OR p_set_id IS NULL OR p_question_id IS NULL OR p_correct_option_id IS NULL
     OR p_points IS NULL OR p_timer_seconds IS NULL THEN
    RAISE EXCEPTION 'override_question_scoring: every id, the points and the timer are required' USING ERRCODE = 'ET023';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 10 AND 500
     OR p_reason ~ '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+'
     OR p_reason ~ '(\+?62[[:space:].-]?|\m0)8[0-9[:space:].-]{7,}|[0-9]{10,}' THEN
    RAISE EXCEPTION 'override_question_scoring: the reason is 10-500 characters without contact details' USING ERRCODE = 'ET023';
  END IF;
  IF p_actor_admin_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.admin_profiles ap
     WHERE ap.auth_user_id = p_actor_admin_user_id AND ap.role = 'owner' AND ap.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'override_question_scoring: the actor must be an active Owner' USING ERRCODE = 'ET023';
  END IF;

  PERFORM public.lock_program_contest(p_program_id);
  PERFORM 1 FROM public.trivia_sets s WHERE s.program_id = p_program_id ORDER BY s.id FOR UPDATE;

  SELECT p.status, p.sales_end_at + make_interval(days => p.grace_days) INTO v_status, v_grace_end
    FROM public.programs p WHERE p.id = p_program_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'override_question_scoring: unknown program' USING ERRCODE = 'ET023';
  END IF;
  IF v_status NOT IN ('draft', 'published') OR clock_timestamp() >= v_grace_end
     OR EXISTS (SELECT 1 FROM public.leaderboard_snapshots l WHERE l.program_id = p_program_id) THEN
    RAISE EXCEPTION 'program % has ended (results snapshot, status or end of grace): scores are final', p_program_id
      USING ERRCODE = 'ET022';
  END IF;
  SELECT q.points, q.timer_seconds INTO v_before_points, v_before_timer
    FROM public.questions q JOIN public.trivia_sets s ON s.id = q.set_id
   WHERE q.id = p_question_id AND q.set_id = p_set_id AND s.program_id = p_program_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'override_question_scoring: question, set and program do not belong together' USING ERRCODE = 'ET023';
  END IF;
  SELECT o.position INTO v_after_correct FROM public.question_options o WHERE o.id = p_correct_option_id AND o.question_id = p_question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'override_question_scoring: the correct option is not one of the question''s' USING ERRCODE = 'ET023';
  END IF;
  SELECT o.position INTO v_before_correct FROM public.question_options o WHERE o.question_id = p_question_id AND o.is_correct;
  SELECT count(*)::int INTO v_set_count FROM public.trivia_sets s WHERE s.program_id = p_program_id;

  SELECT count(*)::int, coalesce(sum(st.score), 0), coalesce(sum(st.total_ms), 0), coalesce(sum(st.sets_completed), 0), count(st.finished_at)::int
    INTO b_players, b_score, b_total, b_sets, b_finished
    FROM (SELECT DISTINCT a.player_id FROM public.set_attempts a WHERE a.set_id = p_set_id) x
    LEFT JOIN public.player_program_stats st ON st.player_id = x.player_id AND st.program_id = p_program_id;

  -- 4. The change.
  UPDATE public.questions q
     SET points = p_points, timer_seconds = p_timer_seconds, updated_at = clock_timestamp()
   WHERE q.id = p_question_id AND q.set_id = p_set_id
     AND (q.points, q.timer_seconds) IS DISTINCT FROM (p_points, p_timer_seconds);
  v_question := FOUND;
  -- Two statements: question_options_one_correct_idx is checked row by row.
  UPDATE public.question_options o
     SET is_correct = false, updated_at = clock_timestamp()
   WHERE o.question_id = p_question_id AND o.is_correct AND o.id <> p_correct_option_id;
  v_options := FOUND;
  UPDATE public.question_options o
     SET is_correct = true, updated_at = clock_timestamp()
   WHERE o.id = p_correct_option_id AND o.question_id = p_question_id AND NOT o.is_correct;
  v_options := v_options OR FOUND;

  -- 5. Every answer of the affected players' attempts in the program, re-scored.
  WITH scored AS (
    SELECT aq.id, r.correct, r.points, r.elapsed_ms
      FROM public.attempt_questions aq
      JOIN public.set_attempts a ON a.id = aq.attempt_id
      JOIN public.trivia_sets ts ON ts.id = a.set_id AND ts.program_id = p_program_id
      JOIN (SELECT DISTINCT x.player_id FROM public.set_attempts x WHERE x.set_id = p_set_id) pl ON pl.player_id = a.player_id
      JOIN public.questions q ON q.id = aq.question_id
      CROSS JOIN LATERAL public.score_answer(
        q.points, q.timer_seconds,
        (SELECT o.id FROM public.question_options o WHERE o.question_id = q.id AND o.is_correct),
        aq.option_id, aq.served_at, aq.deadline_at, aq.answered_at) r
  )
  UPDATE public.attempt_questions aq
     SET correct = s.correct, points = s.points, elapsed_ms = s.elapsed_ms
    FROM scored s
   WHERE aq.id = s.id AND (aq.correct, aq.points, aq.elapsed_ms) IS DISTINCT FROM (s.correct, s.points, s.elapsed_ms);
  GET DIAGNOSTICS v_answers = ROW_COUNT;
  SELECT count(*)::int INTO v_scored
    FROM public.attempt_questions aq
    JOIN public.set_attempts a ON a.id = aq.attempt_id
    JOIN public.trivia_sets ts ON ts.id = a.set_id AND ts.program_id = p_program_id
    JOIN (SELECT DISTINCT x.player_id FROM public.set_attempts x WHERE x.set_id = p_set_id) pl ON pl.player_id = a.player_id;

  -- 6. Their attempts, then their per-program stats, derived from the answers.
  WITH sums AS (
    SELECT a.id, coalesce(sum(aq.points), 0) AS score, coalesce(sum(aq.elapsed_ms), 0) AS total_ms,
           count(aq.answered_at) AS finalized, max(aq.answered_at) AS last_answer,
           (SELECT count(*) FROM public.questions q WHERE q.set_id = a.set_id) AS question_count
      FROM public.set_attempts a
      JOIN public.trivia_sets ts ON ts.id = a.set_id AND ts.program_id = p_program_id
      JOIN (SELECT DISTINCT x.player_id FROM public.set_attempts x WHERE x.set_id = p_set_id) pl ON pl.player_id = a.player_id
      LEFT JOIN public.attempt_questions aq ON aq.attempt_id = a.id
     GROUP BY a.id, a.set_id
  ), derived AS (
    SELECT id, score, total_ms, CASE WHEN question_count > 0 AND finalized = question_count THEN last_answer END AS finished_at FROM sums
  )
  UPDATE public.set_attempts a
     SET score = d.score, total_ms = d.total_ms, finished_at = d.finished_at
    FROM derived d
   WHERE a.id = d.id AND (a.score::bigint, a.total_ms, a.finished_at) IS DISTINCT FROM (d.score, d.total_ms, d.finished_at);
  GET DIAGNOSTICS v_attempts = ROW_COUNT;

  WITH agg AS (
    SELECT a.player_id, coalesce(sum(a.score), 0) AS score, coalesce(sum(a.total_ms), 0) AS total_ms,
           count(a.finished_at)::int AS sets_completed, max(a.finished_at) AS last_finish
      FROM public.set_attempts a
      JOIN public.trivia_sets ts ON ts.id = a.set_id AND ts.program_id = p_program_id
      JOIN (SELECT DISTINCT x.player_id FROM public.set_attempts x WHERE x.set_id = p_set_id) pl ON pl.player_id = a.player_id
     GROUP BY a.player_id
  )
  INSERT INTO public.player_program_stats (player_id, program_id, score, total_ms, sets_completed, finished_at, updated_at)
  SELECT g.player_id, p_program_id, g.score, g.total_ms, g.sets_completed,
         CASE WHEN v_set_count > 0 AND g.sets_completed = v_set_count THEN g.last_finish END, clock_timestamp()
    FROM agg g
  ON CONFLICT (player_id, program_id) DO UPDATE
     SET score = EXCLUDED.score, total_ms = EXCLUDED.total_ms, sets_completed = EXCLUDED.sets_completed,
         finished_at = EXCLUDED.finished_at, updated_at = EXCLUDED.updated_at
   WHERE (player_program_stats.score, player_program_stats.total_ms, player_program_stats.sets_completed, player_program_stats.finished_at)
         IS DISTINCT FROM (EXCLUDED.score, EXCLUDED.total_ms, EXCLUDED.sets_completed, EXCLUDED.finished_at);
  GET DIAGNOSTICS v_stats = ROW_COUNT;

  SELECT count(*)::int, coalesce(sum(st.score), 0), coalesce(sum(st.total_ms), 0), coalesce(sum(st.sets_completed), 0), count(st.finished_at)::int
    INTO a_players, a_score, a_total, a_sets, a_finished
    FROM (SELECT DISTINCT a.player_id FROM public.set_attempts a WHERE a.set_id = p_set_id) x
    LEFT JOIN public.player_program_stats st ON st.player_id = x.player_id AND st.program_id = p_program_id;

  -- 7. The audit row and the summary (aggregates only: no player id, name or contact).
  v_summary := jsonb_build_object(
    'program_id', p_program_id, 'set_id', p_set_id, 'question_changed', v_question, 'options_changed', v_options,
    'players', a_players, 'answers_scored', v_scored, 'answers_changed', v_answers, 'attempts_changed', v_attempts,
    'stats_changed', v_stats, 'score_before', b_score, 'score_after', a_score, 'total_ms_before', b_total,
    'total_ms_after', a_total, 'sets_completed_before', b_sets, 'sets_completed_after', a_sets,
    'finished_before', b_finished, 'finished_after', a_finished);
  INSERT INTO public.audit_log (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  VALUES ('admin', p_actor_admin_user_id, 'question.rescore_override', 'question', p_question_id::text,
          jsonb_strip_nulls(jsonb_build_object(
            'points', CASE WHEN v_before_points IS DISTINCT FROM p_points THEN jsonb_build_object('before', v_before_points, 'after', p_points) END,
            'timer_seconds', CASE WHEN v_before_timer IS DISTINCT FROM p_timer_seconds THEN jsonb_build_object('before', v_before_timer, 'after', p_timer_seconds) END,
            'correct_option', CASE WHEN v_before_correct IS DISTINCT FROM v_after_correct THEN jsonb_build_object('before', v_before_correct, 'after', v_after_correct) END
          )) || v_summary || jsonb_build_object('reason', btrim(p_reason)),
          '{}'::text[], p_request_id, p_ip);
  RETURN v_summary;
END
$fn$;

ALTER FUNCTION public.override_question_scoring(uuid, uuid, uuid, integer, integer, uuid, text, text, text, inet)
  OWNER TO trivia_override;
REVOKE ALL ON FUNCTION public.override_question_scoring(uuid, uuid, uuid, integer, integer, uuid, text, text, text, inet)
  FROM PUBLIC, public_rw, worker_rw, internal_rw, migrator;
GRANT EXECUTE ON FUNCTION public.override_question_scoring(uuid, uuid, uuid, integer, integer, uuid, text, text, text, inet)
  TO admin_rw;
