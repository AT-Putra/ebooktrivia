-- play.sql: the trivia question flow and the live leaderboard (US-027; plan M9 items 2-3, §10 items 5, 19;
-- spec AC-Q2, AC-Q4, AC-Q6 to AC-Q10; Owner decision D8).
--
-- Applied by src/migrate.ts LAST, after conversions.sql, as the connecting role (a superuser), like
-- override.sql and contest.sql: every function here is owned by trivia_play (roles.sql: NOLOGIN, no members,
-- member of nothing), which only a superuser can arrange without making migrator a member of it. Re-runnable:
-- roles.sql drops these functions (every signature) at the start of every run, and this file creates them
-- again with their owner and grants.
--
-- Why a dedicated owner: public_rw holds NO write on any play row (grants.sql, US-027 block) and reads no
-- question text, option text, explanation, correctness, answer row or score. The public app plays only through
-- the SECURITY DEFINER entry points below (EXECUTE public_rw), which take the player id from the app's session
-- (lib/play/handlers.ts withPlayer, never from the client) and check every other id against it. Unlike
-- trivia_override and contest_results, trivia_play is NOT exempt from the play guards (triggers.sql): every
-- start, serve and pick it writes is checked exactly as US-028 checked public_rw's, so the DATABASE still sets
-- every play timestamp (clock_timestamp() at the guard's entry, after the row lock and before the shared
-- contest lock), refuses a pick after the deadline + 1500 ms (ET109) and play at or after the grace end (ET110),
-- and takes the program's SHARED contest lock for every write (the play side of the US-027 lock contract; the
-- functions here never take it themselves).
--
-- NOTHING SECRET COMES OUT OF A TRANSACTION THAT PLAYED (security review HIGH-1, the rollback probe, and its
-- residual side channel): a caller that could learn a question's text, a pick's correctness or a score inside
-- the transaction that served the question or recorded the pick, by reading it OR by measuring what the
-- transaction wrote (its WAL bytes, its HOT-update counters), could roll that transaction back, keep what it
-- learned, and play the question again knowing it. So per pick there are three calls, each its own transaction:
--   1. play_answer, THE pick: it writes only answered_at, option_id, ip and ua_hash of the answer row, the same
--      bytes whichever option is picked (no score, no correct flag, no totals, no stats), and returns nothing;
--   2. play_settle, the scoring of a COMMITTED pick: correct, points, elapsed, the attempt's totals and the
--      player's stats. What it writes does depend on correctness, but only for a pick that can no longer be
--      undone; it refuses to run in a transaction that has already written (ET147), so it never shares one with
--      its pick;
--   3. play_reveal, the read: correctness, the correct option and the explanation of the committed pick.
-- The other WRITES (play_start_set, play_current when it serves or closes, play_note_unlocked) return nothing
-- secret either: no question text, no option, no correctness, no score. Every READ of a secret (play_current when
-- it shows a question or the attempt's end, play_reveal, play_attempts, play_standing, play_leaderboard) starts by
-- refusing a transaction that has already written anything (pg_current_xact_id_if_assigned() IS NOT NULL: ET147),
-- so what it shows was committed by an earlier transaction and can no longer be undone. One simple-query string is
-- one transaction too, so "answer; reveal" in one string is refused the same way. play_current and play_reveal
-- first settle a committed pick of the attempt that is not scored yet (a crash between the app's calls), which
-- again only scores what is committed. Defence in depth: a public_rw session cannot read the WAL position or the
-- transaction's statistics counters at all (roles.sql, US-027 block: revoked from PUBLIC).
-- The app (lib/play/trivia.ts) makes each call right after the one before, in a statement of its own.
--
-- The flow (per player, per set):
--   play_start_set   the attempt: the set must be unlocked for the player (core unlock.ts, max rule:
--                    play_unlocked_count), the player eligible on a published program, before the grace end;
--                    ONE attempt per player and set (the UNIQUE key; a parallel start returns the same
--                    attempt). ALL the set's answer rows are inserted at once, before G, in an order shuffled
--                    for this attempt, each with its options shuffled (attempt_questions.permutation, so the
--                    order is stable on refresh). Nothing is served yet.
--   play_current     the attempt's current question: the first row (by position) without an answer. A row
--                    served earlier whose deadline + 1500 ms has passed is closed as a TIMEOUT first (0 points,
--                    elapsed = the timer it was served with; the play guard records answered_at = deadline_at)
--                    and the next one is taken; an unserved row is served now (served_at only goes from NULL to
--                    the database's clock: a refresh or a second tab never resets or extends the timer). A call
--                    that served or closed a row returns {state: "served"} and nothing of the question, nor of
--                    the attempt's end; the next call (a new transaction, which writes nothing of the kind)
--                    returns the question's text and its options in this attempt's order, as opaque ids (the
--                    random v4 question_options.id, which encode neither correctness nor order) with their
--                    labels, and the time left by the database's clock, or the finished attempt's score. NOTHING
--                    about correctness: no is_correct, no explanation, no points of the options.
--   play_answer      the pick: ONE write per answer, and the only thing it does is the answering UPDATE (no lock
--                    wait before it in the statement: the row lock, then the play guard's clock, then the
--                    guard's shared contest lock), conditional on the row being the player's, served by an
--                    earlier statement and not answered yet, so of two concurrent answers exactly one is recorded
--                    and the other gets ET144. It returns {state: "answered"} and nothing else.
--   play_settle      the second write, after the pick committed: scores the attempt's committed, unscored picks
--                    with public.score_answer (elapsed = min(answered - served, the timer it was served with),
--                    points only for the correct option within the deadline + 1500 ms) and derives the attempt's
--                    totals and the player's program stats again from the scored rows (play_settle_answer).
--                    Idempotent: a scored row is never scored again. Returns {state: "settled"}.
--   play_reveal      the read after it: for a COMMITTED pick of the player (an answer row with a pick), the pick,
--                    whether it was correct, its points and time, the correct option's id, the explanation and
--                    the attempt's totals. A timeout has no pick and reveals nothing (ET148).
--   play_attempts    the player's attempts of a program with their scores (the trivia page's grid).
--   play_leaderboard the top N of a program, by THE final order of the results snapshot (core contest.ts
--                    compareFinal, D4): score desc, total_ms asc, finished_at asc NULLS LAST, first_paid_at asc,
--                    player id asc, so ranks are unique and a player never sees a shared rank live that the
--                    snapshot then breaks. EVERY eligible player, and the SAME total time as the snapshot (Owner
--                    decision D8): the answered questions' time plus the summed timers of every question not
--                    answered yet (sets not started included), the term contest.sql create_leaderboard_snapshot
--                    adds for the sets never played; a player without a stats row is score 0 with the whole
--                    program's timers. Names masked in SQL (public.mask_name); no player id leaves the database.
--   play_standing    the player's own rank by the same order, always fresh (the app caches only the top N):
--                    1 + the players ahead, counted by the same tuple comparison on the ranking index.
--   play_note_unlocked  raises the player's unlock floor (player_programs.unlock_floor, core unlock.ts's
--                    floor contract) to what the schedule formula unlocks now, so an extend-only reschedule
--                    never locks a set the player has seen open.
--
-- Deadlocks: the play guard takes the shared contest lock AFTER the row lock of the row it writes, and an
-- exclusive holder (the results snapshot, a re-score, a deadline extension) takes the contest lock BEFORE the
-- row locks, so the two can deadlock; PostgreSQL then aborts one (40P01). The app retries a play call ONCE on
-- 40P01 (lib/play/trivia.ts); a retried pick is charged its real arrival (the deadlock wait included).
--
-- Timeouts (US-028 contract item): a timeout reveals NOTHING (no correct option, no explanation), so a timed-out
-- question could in principle be reopened fairly. The Owner's extension tool (contest.sql
-- extend_open_question_deadlines) still extends OPEN questions only: a question whose deadline fell in an outage
-- and that play_current already closed as a timeout (the player came back before the Owner ran the tool) is
-- not extended. That is the documented limit.
--
-- D8 and the stats: player_program_stats.total_ms is derived on every settle as the program's summed timers
-- minus the timers of the scored questions plus their time (a pick not scored yet still counts its timer, as an
-- unanswered question). So it moves only when the player answers; a
-- question added to a set nobody has started yet (the content lock allows it) counts for a player from their
-- next answer on (and in the snapshot, which derives everything again). Between G and the snapshot a question
-- served before G and never closed still counts its timer, exactly what the snapshot gives it.
--
-- SQLSTATEs (US-027, ET140-ET159):
--   ET140 the attempt, answer row or set is not the player's, or does not exist (one answer for both: 403)
--   ET141 the player is not eligible for the program (refunded, never paid) or the program is not published
--   ET142 the set is still locked for the player (the unlock schedule)
--   ET143 the set has no question
--   ET144 the question has already been answered (or closed as a timeout)
--   ET145 the question has not been served yet (play_current serves it)
--   ET146 not READ COMMITTED (each statement must see what committed while it waited for a lock)
--   ET147 a read of a secret in a transaction that has already written (the rollback probe, above)
--   ET148 nothing to reveal: the question was closed as a timeout, or is not answered yet
-- and from the play guards: ET050 not eligible / program not published, ET051 an option of another question,
-- ET108 a play timestamp the database owns, ET109 a pick after the deadline + 1500 ms, ET110 a start or serve at
-- or after the grace end.
--
-- Every function: SET search_path = pg_catalog, pg_temp with every object of ours schema-qualified; time from
-- clock_timestamp(); EXECUTE revoked from PUBLIC and granted per role at the end.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

-- ---------------------------------------------------------------------------------------------
-- THE SQL copy of core unlock.ts unlockedCount (apps/public/test/play-trivia.int.test.ts checks the two against
-- each other on random schedules): the number of sets (by position, 1..S) unlocked for a player at p_now,
-- max(formula, attempted, floor). WIB days: floor((epoch + 7 h) / 1 day); D_end = the WIB day of
-- sales_end - 1 ms, plus grace_days; A = max(1, D_end - p + 1) with p the WIB day of the first payment; i = the
-- WIB day of p_now - p. Nothing before the payment instant (and nothing without one). SECURITY INVOKER.
CREATE OR REPLACE FUNCTION public.play_unlocked_count(
  p_sales_end timestamptz,
  p_grace_days integer,
  p_set_count integer,
  p_first_paid_at timestamptz,
  p_now timestamptz,
  p_attempted integer,
  p_floor integer
)
  RETURNS integer
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT GREATEST(
    CASE
      WHEN p_first_paid_at IS NULL OR p_now < p_first_paid_at OR coalesce(p_set_count, 0) <= 0 THEN 0
      ELSE (
        SELECT CASE
                 WHEN y.i < 0 THEN 0
                 WHEN y.a >= p_set_count THEN LEAST(p_set_count::bigint, y.i + 1)
                 WHEN y.a = 1 OR y.i >= y.a - 1 THEN p_set_count
                 ELSE 1 + (y.i * (p_set_count - 1)) / (y.a - 1)
               END
          FROM (
            SELECT x.now_day - x.paid_day AS i, GREATEST(1, x.end_day - x.paid_day + 1) AS a
              FROM (
                SELECT floor((extract(epoch FROM p_now) + 25200) / 86400)::bigint AS now_day,
                       floor((extract(epoch FROM p_first_paid_at) + 25200) / 86400)::bigint AS paid_day,
                       floor((extract(epoch FROM p_sales_end - interval '1 millisecond') + 25200) / 86400)::bigint
                         + p_grace_days AS end_day
              ) x
          ) y
      )
    END,
    coalesce(p_attempted, 0),
    coalesce(p_floor, 0)
  )::integer
$fn$;

-- The summed timers of every question of a program, in ms (the D8 total of a player who has answered nothing).
-- Internal (EXECUTE admin_rw only, for play_ranking in the console's contest report). SECURITY INVOKER.
CREATE OR REPLACE FUNCTION public.play_program_ms(p_program_id uuid)
  RETURNS bigint
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT coalesce(sum(q.timer_seconds::bigint * 1000), 0)::bigint
    FROM public.questions q JOIN public.trivia_sets s ON s.id = q.set_id
   WHERE s.program_id = p_program_id
$fn$;

-- The full live ranking of a program (play_leaderboard and play_standing call it as their owner; EXECUTE admin_rw
-- only, for the console's contest report). EVERY eligible player in THE final order (see the top of the file, D4 and
-- D8). SECURITY INVOKER.
CREATE OR REPLACE FUNCTION public.play_ranking(p_program_id uuid)
  RETURNS TABLE (player_id uuid, rank integer, score integer, total_ms bigint, sets_completed integer, finished_at timestamptz)
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT r.player_id,
         (row_number() OVER (ORDER BY r.score DESC, r.total_ms ASC, r.finished_at ASC NULLS LAST,
                                      r.first_paid_at ASC NULLS LAST, r.player_id ASC))::integer,
         r.score, r.total_ms, r.sets_completed, r.finished_at
    FROM (
      -- The program's timers: an uncorrelated scalar subquery, so an InitPlan computed once per call, not per player.
      SELECT pp.player_id, pp.first_paid_at, coalesce(st.score, 0) AS score,
             coalesce(st.total_ms, (SELECT public.play_program_ms(p_program_id))) AS total_ms,
             coalesce(st.sets_completed, 0) AS sets_completed, st.finished_at
        FROM public.player_programs pp
        LEFT JOIN public.player_program_stats st ON st.player_id = pp.player_id AND st.program_id = pp.program_id
       WHERE pp.program_id = p_program_id AND pp.eligible
    ) r
$fn$;

-- Scores one answer row and derives its attempt's totals and the player's program stats again from the rows
-- (internal: called by play_settle_pending for a committed pick and by play_current for a timeout it closes;
-- EXECUTE granted to nobody). A stored score is never trusted: the row is scored with public.score_answer under
-- the current rules; the attempt's score / total_ms are sums, its finished_at the last answer once every question
-- of the set has a served, answered row; the stats: score = the sum over the player's attempts in the program,
-- total_ms = D8's total (the program's timers - the scored questions' timers + their time), sets_completed the
-- finished attempts, finished_at the last finish once every set is finished (else NULL: NULLS LAST). The attempt row and
-- then the stats row are locked FIRST, each in a statement of its own, so the sums are read after a concurrent
-- answer of the same player has committed (READ COMMITTED: each statement sees what committed before it
-- started). SECURITY INVOKER.
CREATE OR REPLACE FUNCTION public.play_settle_answer(p_answer_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  VOLATILE
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_attempt uuid;
  v_player uuid;
  v_set uuid;
  v_program uuid;
  v_points integer;
  v_timer integer;
  v_correct_option uuid;
  v_option uuid;
  v_served timestamptz;
  v_deadline timestamptz;
  v_answered timestamptz;
  v_extension integer;
  v_score record;
  v_attempt_score integer;
  v_attempt_total bigint;
  v_attempt_finished timestamptz;
BEGIN
  SELECT aq.attempt_id, a.player_id, a.set_id, s.program_id, q.points, q.timer_seconds,
         (SELECT o.id FROM public.question_options o WHERE o.question_id = q.id AND o.is_correct),
         aq.option_id, aq.served_at, aq.deadline_at, aq.answered_at, aq.deadline_extension_ms
    INTO v_attempt, v_player, v_set, v_program, v_points, v_timer, v_correct_option,
         v_option, v_served, v_deadline, v_answered, v_extension
    FROM public.attempt_questions aq
    JOIN public.set_attempts a ON a.id = aq.attempt_id
    JOIN public.trivia_sets s ON s.id = a.set_id
    JOIN public.questions q ON q.id = aq.question_id
   WHERE aq.id = p_answer_id;
  SELECT r.correct, r.points, r.elapsed_ms INTO v_score
    FROM public.score_answer(v_points, v_timer, v_correct_option, v_option, v_served, v_deadline, v_answered, v_extension) r;
  UPDATE public.attempt_questions
     SET correct = v_score.correct, points = v_score.points, elapsed_ms = v_score.elapsed_ms
   WHERE id = p_answer_id;

  PERFORM 1 FROM public.set_attempts a WHERE a.id = v_attempt FOR UPDATE;
  SELECT coalesce(sum(aq.points), 0)::integer, coalesce(sum(aq.elapsed_ms), 0)::bigint,
         CASE WHEN count(*) FILTER (WHERE aq.served_at IS NOT NULL AND aq.answered_at IS NOT NULL)
                   = (SELECT count(*) FROM public.questions q WHERE q.set_id = v_set)
              THEN max(aq.answered_at) END
    INTO v_attempt_score, v_attempt_total, v_attempt_finished
    FROM public.attempt_questions aq WHERE aq.attempt_id = v_attempt;
  UPDATE public.set_attempts
     SET score = v_attempt_score, total_ms = v_attempt_total, finished_at = v_attempt_finished
   WHERE id = v_attempt AND (score, total_ms, finished_at) IS DISTINCT FROM (v_attempt_score, v_attempt_total, v_attempt_finished);

  INSERT INTO public.player_program_stats (player_id, program_id) VALUES (v_player, v_program) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.player_program_stats st WHERE st.player_id = v_player AND st.program_id = v_program FOR UPDATE;
  WITH attempts AS (
    SELECT coalesce(sum(a.score), 0)::integer AS score, count(a.finished_at)::integer AS sets_completed,
           max(a.finished_at) AS last_finish,
           (SELECT count(*) FROM public.trivia_sets s WHERE s.program_id = v_program)::integer AS set_count
      FROM public.set_attempts a JOIN public.trivia_sets s ON s.id = a.set_id AND s.program_id = v_program
     WHERE a.player_id = v_player
  ), answered AS (
    SELECT coalesce(sum(aq.elapsed_ms), 0)::bigint AS elapsed, coalesce(sum(q.timer_seconds::bigint * 1000), 0)::bigint AS timers
      FROM public.attempt_questions aq
      JOIN public.set_attempts a ON a.id = aq.attempt_id AND a.player_id = v_player
      JOIN public.trivia_sets s ON s.id = a.set_id AND s.program_id = v_program
      JOIN public.questions q ON q.id = aq.question_id
     WHERE aq.answered_at IS NOT NULL AND aq.correct IS NOT NULL
  )
  UPDATE public.player_program_stats st
     SET score = at.score, total_ms = public.play_program_ms(v_program) - an.timers + an.elapsed,
         sets_completed = at.sets_completed,
         finished_at = CASE WHEN at.set_count > 0 AND at.sets_completed = at.set_count THEN at.last_finish END,
         updated_at = clock_timestamp()
    FROM attempts at, answered an
   WHERE st.player_id = v_player AND st.program_id = v_program;
END
$fn$;

-- Scores the committed picks of one attempt that are not scored yet (correct IS NULL), in position order, and
-- returns how many it scored (internal: play_settle, play_current and play_reveal call it first; EXECUTE granted to
-- nobody). Only a COMMITTED pick is visible here: a pick of this very transaction cannot exist, since every
-- caller has refused a transaction that already wrote (ET147). SECURITY INVOKER.
CREATE OR REPLACE FUNCTION public.play_settle_pending(p_attempt_id uuid)
  RETURNS integer
  LANGUAGE plpgsql
  VOLATILE
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_answer uuid;
  v_scored integer := 0;
BEGIN
  FOR v_answer IN
    SELECT aq.id FROM public.attempt_questions aq
     WHERE aq.attempt_id = p_attempt_id AND aq.answered_at IS NOT NULL AND aq.correct IS NULL
     ORDER BY aq.position
  LOOP
    PERFORM public.play_settle_answer(v_answer);
    v_scored := v_scored + 1;
  END LOOP;
  RETURN v_scored;
END
$fn$;

-- The unlock floor (EXECUTE public_rw; the trivia page calls it on every view of a program): raises
-- player_programs.unlock_floor to the formula's count NOW (never lowers it) and returns the floor. Only for an
-- eligible player of a published program (else 0, nothing written). A write: it returns nothing secret.
CREATE OR REPLACE FUNCTION public.play_note_unlocked(p_player_id uuid, p_program_id uuid)
  RETURNS integer
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_formula integer;
  v_floor integer;
BEGIN
  SELECT public.play_unlocked_count(p.sales_end_at, p.grace_days,
           (SELECT count(*) FROM public.trivia_sets s WHERE s.program_id = p.id)::integer,
           pp.first_paid_at, clock_timestamp(), 0, 0),
         pp.unlock_floor
    INTO v_formula, v_floor
    FROM public.player_programs pp JOIN public.programs p ON p.id = pp.program_id
   WHERE pp.player_id = p_player_id AND pp.program_id = p_program_id AND pp.eligible AND p.status = 'published';
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  IF v_formula > v_floor THEN
    UPDATE public.player_programs SET unlock_floor = GREATEST(unlock_floor, v_formula)
     WHERE player_id = p_player_id AND program_id = p_program_id
    RETURNING unlock_floor INTO v_floor;
  END IF;
  RETURN v_floor;
END
$fn$;

-- Start a set (EXECUTE public_rw). Returns the attempt id: the new one, or the player's existing attempt on
-- the set (a second tab, a retry, a parallel start: ONE attempt, UNIQUE (player_id, set_id)). A write.
CREATE OR REPLACE FUNCTION public.play_start_set(p_player_id uuid, p_set_id uuid)
  RETURNS uuid
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_program uuid;
  v_status public.program_status;
  v_sales_end timestamptz;
  v_grace_days integer;
  v_eligible boolean;
  v_first_paid timestamptz;
  v_floor integer;
  v_rank integer;
  v_set_count integer;
  v_attempted integer;
  v_attempt uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'play must run under READ COMMITTED' USING ERRCODE = 'ET146';
  END IF;
  SELECT s.program_id, p.status, p.sales_end_at, p.grace_days, pp.eligible, pp.first_paid_at, pp.unlock_floor
    INTO v_program, v_status, v_sales_end, v_grace_days, v_eligible, v_first_paid, v_floor
    FROM public.trivia_sets s
    JOIN public.programs p ON p.id = s.program_id
    LEFT JOIN public.player_programs pp ON pp.program_id = s.program_id AND pp.player_id = p_player_id
   WHERE s.id = p_set_id;
  IF NOT FOUND OR p_player_id IS NULL THEN
    RAISE EXCEPTION 'unknown set' USING ERRCODE = 'ET140';
  END IF;
  IF v_eligible IS NOT TRUE OR v_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'the player is not eligible for this program' USING ERRCODE = 'ET141';
  END IF;
  SELECT a.id INTO v_attempt FROM public.set_attempts a WHERE a.player_id = p_player_id AND a.set_id = p_set_id;
  IF FOUND THEN
    RETURN v_attempt;
  END IF;

  SELECT count(*) FILTER (WHERE s.position <= (SELECT t.position FROM public.trivia_sets t WHERE t.id = p_set_id))::integer,
         count(*)::integer
    INTO v_rank, v_set_count
    FROM public.trivia_sets s WHERE s.program_id = v_program;
  SELECT count(*)::integer INTO v_attempted
    FROM public.set_attempts a JOIN public.trivia_sets s ON s.id = a.set_id AND s.program_id = v_program
   WHERE a.player_id = p_player_id;
  IF v_rank > public.play_unlocked_count(v_sales_end, v_grace_days, v_set_count, v_first_paid, clock_timestamp(), v_attempted, v_floor) THEN
    RAISE EXCEPTION 'the set is still locked for this player' USING ERRCODE = 'ET142';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.questions q WHERE q.set_id = p_set_id) THEN
    RAISE EXCEPTION 'the set has no question' USING ERRCODE = 'ET143';
  END IF;

  -- The play guard checks eligibility and the grace end again, with the database's clock (ET050, ET110).
  INSERT INTO public.set_attempts (player_id, set_id) VALUES (p_player_id, p_set_id)
  ON CONFLICT (player_id, set_id) DO NOTHING
  RETURNING id INTO v_attempt;
  IF v_attempt IS NULL THEN
    SELECT a.id INTO v_attempt FROM public.set_attempts a WHERE a.player_id = p_player_id AND a.set_id = p_set_id;
    RETURN v_attempt;
  END IF;
  -- Every answer row now, unserved, in an order shuffled for this attempt (gen_random_uuid: a strong random
  -- source), each with its options shuffled; the order never changes afterwards.
  INSERT INTO public.attempt_questions (attempt_id, question_id, position, permutation)
  SELECT v_attempt, sh.id, (row_number() OVER (ORDER BY sh.k))::integer,
         coalesce((SELECT array_agg(o.id ORDER BY gen_random_uuid()) FROM public.question_options o WHERE o.question_id = sh.id), '{}'::uuid[])
    FROM (SELECT q.id, gen_random_uuid() AS k FROM public.questions q WHERE q.set_id = p_set_id) sh;
  RETURN v_attempt;
END
$fn$;

-- The attempt's current question (EXECUTE public_rw; POST current). See the top of the file. Returns one of:
--   {state: "served", timed_out}      this call served the next question or closed expired ones: ask again;
--   {state: "question", answer_id, position, total, prompt, options: [{id, label}], remaining_ms, window_ms,
--    timed_out: 0}                    only from a call that served and closed nothing; remaining_ms by the
--                                     database's clock (0 while the latency grace runs);
--   {state: "finished", total, score, total_ms, timed_out: 0}  likewise;
--   {state: "closed", timed_out}      the grace period has ended before the next question could be served.
-- timed_out = how many questions this call closed as timeouts (the player was away). It first scores a committed
-- pick of the attempt not scored yet (play_settle_pending: the app's play_settle never ran), which only writes the
-- score of what can no longer be undone.
CREATE OR REPLACE FUNCTION public.play_current(p_player_id uuid, p_attempt_id uuid, p_ip inet, p_ua_hash bytea)
  RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_set uuid;
  v_grace_end timestamptz;
  v_total integer;
  v_closed integer := 0;
  v_wrote boolean := false;
  v_row record;
  v_done record;
BEGIN
  IF pg_catalog.pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'play_current runs in a transaction that has written nothing' USING ERRCODE = 'ET147';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'play must run under READ COMMITTED' USING ERRCODE = 'ET146';
  END IF;
  SELECT a.set_id, p.sales_end_at + make_interval(days => p.grace_days)
    INTO v_set, v_grace_end
    FROM public.set_attempts a
    JOIN public.trivia_sets s ON s.id = a.set_id
    JOIN public.programs p ON p.id = s.program_id
   WHERE a.id = p_attempt_id AND a.player_id = p_player_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown attempt' USING ERRCODE = 'ET140';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.player_programs pp JOIN public.trivia_sets s ON s.program_id = pp.program_id
      JOIN public.programs p ON p.id = pp.program_id
     WHERE s.id = v_set AND pp.player_id = p_player_id AND pp.eligible AND p.status = 'published'
  ) THEN
    RAISE EXCEPTION 'the player is not eligible for this program' USING ERRCODE = 'ET141';
  END IF;
  SELECT count(*)::integer INTO v_total FROM public.attempt_questions aq WHERE aq.attempt_id = p_attempt_id;
  PERFORM public.play_settle_pending(p_attempt_id);

  -- Bounded: each pass serves the row (and returns), closes it, or returns.
  LOOP
    SELECT aq.id, aq.position, aq.question_id, aq.permutation, aq.served_at, aq.deadline_at
      INTO v_row
      FROM public.attempt_questions aq
     WHERE aq.attempt_id = p_attempt_id AND aq.answered_at IS NULL
     ORDER BY aq.position
     LIMIT 1;
    IF NOT FOUND THEN
      IF v_wrote THEN
        -- This call closed the last question: the attempt's end (its score) is shown by the next call.
        RETURN jsonb_build_object('state', 'served', 'timed_out', v_closed);
      END IF;
      SELECT a.score, a.total_ms INTO v_done FROM public.set_attempts a WHERE a.id = p_attempt_id;
      RETURN jsonb_build_object('state', 'finished', 'total', v_total, 'score', v_done.score, 'total_ms', v_done.total_ms,
                                'timed_out', 0);
    END IF;
    IF v_row.served_at IS NULL THEN
      IF clock_timestamp() >= v_grace_end THEN
        RETURN jsonb_build_object('state', 'closed', 'timed_out', v_closed);
      END IF;
      -- The guard sets served_at and deadline_at from its clock (ET110 at or after G). A concurrent serve that won
      -- the row has committed by the time this UPDATE finds it served (it waited for that row lock), so its
      -- question may be shown by this call, which then wrote nothing.
      UPDATE public.attempt_questions SET served_at = clock_timestamp(), ip = p_ip, ua_hash = p_ua_hash
       WHERE id = v_row.id AND served_at IS NULL;
      IF FOUND THEN
        RETURN jsonb_build_object('state', 'served', 'timed_out', v_closed);
      END IF;
      CONTINUE;
    END IF;
    IF clock_timestamp() > v_row.deadline_at + interval '1500 milliseconds' THEN
      -- A timeout: the guard records answered_at = deadline_at for a close without a pick.
      UPDATE public.attempt_questions SET answered_at = clock_timestamp() WHERE id = v_row.id AND answered_at IS NULL;
      IF FOUND THEN
        PERFORM public.play_settle_answer(v_row.id);
        v_closed := v_closed + 1;
        v_wrote := true;
      END IF;
      CONTINUE;
    END IF;
    IF v_wrote THEN
      -- A row closed by this call and the next one already served (a concurrent call served it): this
      -- transaction wrote, so the question is shown by the next call.
      RETURN jsonb_build_object('state', 'served', 'timed_out', v_closed);
    END IF;
    RETURN jsonb_build_object(
      'state', 'question',
      'answer_id', v_row.id,
      'position', v_row.position,
      'total', v_total,
      'prompt', (SELECT q.prompt FROM public.questions q WHERE q.id = v_row.question_id),
      'options', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label) ORDER BY p.ord), '[]'::jsonb)
                    FROM unnest(v_row.permutation) WITH ORDINALITY AS p(id, ord)
                    JOIN public.question_options o ON o.id = p.id AND o.question_id = v_row.question_id),
      'remaining_ms', GREATEST(0, floor(extract(epoch FROM v_row.deadline_at - clock_timestamp()) * 1000))::bigint,
      'window_ms', (extract(epoch FROM v_row.deadline_at - v_row.served_at) * 1000)::bigint,
      'timed_out', 0);
  END LOOP;
END
$fn$;

-- The pick (EXECUTE public_rw; POST answer). See the top of the file. It writes ONLY the pick (answered_at,
-- option_id, ip, ua_hash: the same bytes for every option) and returns {state: "answered", answer_id}: scoring is
-- play_settle's and the reveal play_reveal's, each in a transaction of its own after this one has committed.
CREATE OR REPLACE FUNCTION public.play_answer(p_player_id uuid, p_answer_id uuid, p_option_id uuid, p_ip inet, p_ua_hash bytea)
  RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_attempt uuid;
  v_answered timestamptz;
  v_served timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'play must run under READ COMMITTED' USING ERRCODE = 'ET146';
  END IF;
  -- THE answering statement, first: nothing waits before it but its own row lock.
  UPDATE public.attempt_questions aq
     SET answered_at = clock_timestamp(), option_id = p_option_id, ip = p_ip, ua_hash = p_ua_hash
    FROM public.set_attempts a
   WHERE aq.id = p_answer_id AND a.id = aq.attempt_id AND a.player_id = p_player_id
     AND aq.answered_at IS NULL AND aq.served_at IS NOT NULL AND p_option_id IS NOT NULL
  RETURNING aq.attempt_id INTO v_attempt;
  IF v_attempt IS NULL THEN
    SELECT aq.answered_at, aq.served_at INTO v_answered, v_served
      FROM public.attempt_questions aq JOIN public.set_attempts a ON a.id = aq.attempt_id
     WHERE aq.id = p_answer_id AND a.player_id = p_player_id;
    IF NOT FOUND OR p_option_id IS NULL THEN
      RAISE EXCEPTION 'unknown answer' USING ERRCODE = 'ET140';
    ELSIF v_answered IS NOT NULL THEN
      RAISE EXCEPTION 'the question has already been answered' USING ERRCODE = 'ET144';
    END IF;
    RAISE EXCEPTION 'the question has not been served yet' USING ERRCODE = 'ET145';
  END IF;
  RETURN jsonb_build_object('state', 'answered', 'answer_id', p_answer_id);
END
$fn$;

-- The scoring of a COMMITTED pick (EXECUTE public_rw; the app calls it right after play_answer has committed, in a
-- statement of its own). Scores the attempt's committed picks that are not scored yet and derives the attempt's
-- totals and the player's stats (play_settle_pending); a second call scores nothing (idempotent). Refused in a
-- transaction that has already written (ET147): it never shares a transaction with its pick. ET140 for another
-- player's or an unknown row. Returns {state: "settled", answer_id}.
CREATE OR REPLACE FUNCTION public.play_settle(p_player_id uuid, p_answer_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_attempt uuid;
BEGIN
  IF pg_catalog.pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'play_settle runs in a transaction that has written nothing' USING ERRCODE = 'ET147';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'play must run under READ COMMITTED' USING ERRCODE = 'ET146';
  END IF;
  SELECT aq.attempt_id INTO v_attempt
    FROM public.attempt_questions aq JOIN public.set_attempts a ON a.id = aq.attempt_id
   WHERE aq.id = p_answer_id AND a.player_id = p_player_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown answer' USING ERRCODE = 'ET140';
  END IF;
  PERFORM public.play_settle_pending(v_attempt);
  RETURN jsonb_build_object('state', 'settled', 'answer_id', p_answer_id);
END
$fn$;

-- The reveal of a COMMITTED pick (EXECUTE public_rw; the app calls it right after play_settle, in a statement of its
-- own). Returns {state: "revealed", answer_id, option_id (the recorded pick), correct, points, elapsed_ms,
-- correct_option_id, explanation, attempt: {score, total_ms, finished}}. ET140 for another player's or an unknown
-- row, ET148 for a row without a pick (a timeout, or not answered yet): a timeout reveals nothing. A committed pick
-- not scored yet (play_settle never ran) is scored first.
CREATE OR REPLACE FUNCTION public.play_reveal(p_player_id uuid, p_answer_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_row record;
  v_attempt uuid;
BEGIN
  IF pg_catalog.pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'play_reveal runs in a transaction that has written nothing' USING ERRCODE = 'ET147';
  END IF;
  SELECT aq.attempt_id INTO v_attempt
    FROM public.attempt_questions aq JOIN public.set_attempts a ON a.id = aq.attempt_id
   WHERE aq.id = p_answer_id AND a.player_id = p_player_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown answer' USING ERRCODE = 'ET140';
  END IF;
  PERFORM public.play_settle_pending(v_attempt);
  SELECT aq.option_id, aq.answered_at, aq.correct, aq.points, aq.elapsed_ms, q.explanation,
         (SELECT o.id FROM public.question_options o WHERE o.question_id = q.id AND o.is_correct) AS correct_option_id,
         a.score AS attempt_score, a.total_ms AS attempt_total_ms, a.finished_at IS NOT NULL AS attempt_finished
    INTO v_row
    FROM public.attempt_questions aq
    JOIN public.set_attempts a ON a.id = aq.attempt_id
    JOIN public.questions q ON q.id = aq.question_id
   WHERE aq.id = p_answer_id AND a.player_id = p_player_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown answer' USING ERRCODE = 'ET140';
  END IF;
  IF v_row.answered_at IS NULL OR v_row.option_id IS NULL THEN
    RAISE EXCEPTION 'nothing to reveal' USING ERRCODE = 'ET148';
  END IF;
  RETURN jsonb_build_object(
    'state', 'revealed',
    'answer_id', p_answer_id,
    'option_id', v_row.option_id,
    'correct', v_row.correct,
    'points', v_row.points,
    'elapsed_ms', v_row.elapsed_ms,
    'correct_option_id', v_row.correct_option_id,
    'explanation', v_row.explanation,
    'attempt', jsonb_build_object('score', v_row.attempt_score, 'total_ms', v_row.attempt_total_ms, 'finished', v_row.attempt_finished));
END
$fn$;

-- The player's attempts of a program (EXECUTE public_rw; the trivia page's grid): set, attempt, score, finished.
-- ET147 in a transaction that has written (a score shows whether a pick was right).
CREATE OR REPLACE FUNCTION public.play_attempts(p_player_id uuid, p_program_id uuid)
  RETURNS TABLE (set_id uuid, attempt_id uuid, score integer, finished boolean)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  IF pg_catalog.pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'play_attempts runs in a transaction that has written nothing' USING ERRCODE = 'ET147';
  END IF;
  RETURN QUERY
    SELECT a.set_id, a.id, a.score, a.finished_at IS NOT NULL
      FROM public.set_attempts a JOIN public.trivia_sets s ON s.id = a.set_id AND s.program_id = p_program_id
     WHERE a.player_id = p_player_id;
END
$fn$;

-- The top N of a program's live leaderboard (EXECUTE public_rw; the app caches it for 5 s per program). Masked
-- names only (public.mask_name, the one masking rule), no player id. ET147 in a transaction that has written.
CREATE OR REPLACE FUNCTION public.play_leaderboard(p_program_id uuid, p_limit integer)
  RETURNS TABLE (rank integer, masked_name text, score integer, total_ms bigint, sets_completed integer, finished boolean)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  IF pg_catalog.pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'play_leaderboard runs in a transaction that has written nothing' USING ERRCODE = 'ET147';
  END IF;
  RETURN QUERY
    SELECT r.rank, public.mask_name(pl.name), r.score, r.total_ms, r.sets_completed, r.finished_at IS NOT NULL
      FROM public.play_ranking(p_program_id) r
      JOIN public.players pl ON pl.id = r.player_id
     WHERE r.rank <= LEAST(GREATEST(coalesce(p_limit, 10), 1), 100)
     ORDER BY r.rank;
END
$fn$;

-- The player's own standing in a program (EXECUTE public_rw), fresh on every call, with ET147 in a transaction
-- that has written. rank = 1 + the eligible players ahead in THE order (play_ranking's), counted, not sorted: the
-- players with a stats row and a score at least the player's own (a range of the ranking index
-- player_program_stats_ranking_idx), compared as one tuple (score desc, total_ms, finished_at NULLS LAST,
-- first_paid_at, player id; NULLs as +infinity sort last), plus the players without a stats row (score 0, the
-- program's whole timer total, not finished), who can only be ahead of a player who has scored 0 in that same
-- total. `ranked` = the eligible players. ET141 unless the player is eligible for the program (the leaderboard
-- route's IDOR check).
CREATE OR REPLACE FUNCTION public.play_standing(p_player_id uuid, p_program_id uuid)
  RETURNS TABLE (rank integer, masked_name text, score integer, total_ms bigint, sets_completed integer, finished boolean, ranked integer)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_program_ms bigint;
  v_first_paid timestamptz;
  v_score integer;
  v_total bigint;
  v_sets integer;
  v_finished timestamptz;
  v_ahead integer;
  v_unplayed_ahead integer := 0;
BEGIN
  IF pg_catalog.pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'play_standing runs in a transaction that has written nothing' USING ERRCODE = 'ET147';
  END IF;
  SELECT pp.first_paid_at INTO v_first_paid
    FROM public.player_programs pp
   WHERE pp.player_id = p_player_id AND pp.program_id = p_program_id AND pp.eligible;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the player is not eligible for this program' USING ERRCODE = 'ET141';
  END IF;
  v_program_ms := public.play_program_ms(p_program_id);
  SELECT st.score, st.total_ms, st.sets_completed, st.finished_at INTO v_score, v_total, v_sets, v_finished
    FROM public.player_program_stats st WHERE st.player_id = p_player_id AND st.program_id = p_program_id;
  IF NOT FOUND THEN
    v_score := 0;
    v_total := v_program_ms;
    v_sets := 0;
    v_finished := NULL;
  END IF;
  SELECT count(*)::integer INTO v_ahead
    FROM public.player_program_stats st
    JOIN public.player_programs pp ON pp.player_id = st.player_id AND pp.program_id = st.program_id AND pp.eligible
   WHERE st.program_id = p_program_id AND st.score >= v_score
     AND (-st.score, st.total_ms, coalesce(st.finished_at, 'infinity'::timestamptz), coalesce(pp.first_paid_at, 'infinity'::timestamptz), st.player_id)
         < (-v_score, v_total, coalesce(v_finished, 'infinity'::timestamptz), coalesce(v_first_paid, 'infinity'::timestamptz), p_player_id);
  IF v_score = 0 AND v_total >= v_program_ms AND v_finished IS NULL THEN
    SELECT count(*)::integer INTO v_unplayed_ahead
      FROM public.player_programs pp
     WHERE pp.program_id = p_program_id AND pp.eligible
       AND NOT EXISTS (SELECT 1 FROM public.player_program_stats st WHERE st.player_id = pp.player_id AND st.program_id = pp.program_id)
       AND (0::integer, v_program_ms, coalesce(pp.first_paid_at, 'infinity'::timestamptz), pp.player_id)
           < (-v_score, v_total, coalesce(v_first_paid, 'infinity'::timestamptz), p_player_id);
  END IF;
  RETURN QUERY
    SELECT 1 + v_ahead + v_unplayed_ahead, public.mask_name(pl.name), v_score, v_total, v_sets, v_finished IS NOT NULL,
           (SELECT count(*)::integer FROM public.player_programs pp WHERE pp.program_id = p_program_id AND pp.eligible)
      FROM public.players pl
     WHERE pl.id = p_player_id;
END
$fn$;

ALTER FUNCTION public.play_unlocked_count(timestamptz, integer, integer, timestamptz, timestamptz, integer, integer) OWNER TO trivia_play;
ALTER FUNCTION public.play_program_ms(uuid) OWNER TO trivia_play;
ALTER FUNCTION public.play_ranking(uuid) OWNER TO trivia_play;
ALTER FUNCTION public.play_settle_answer(uuid) OWNER TO trivia_play;
ALTER FUNCTION public.play_settle_pending(uuid) OWNER TO trivia_play;
ALTER FUNCTION public.play_settle(uuid, uuid) OWNER TO trivia_play;
ALTER FUNCTION public.play_note_unlocked(uuid, uuid) OWNER TO trivia_play;
ALTER FUNCTION public.play_start_set(uuid, uuid) OWNER TO trivia_play;
ALTER FUNCTION public.play_current(uuid, uuid, inet, bytea) OWNER TO trivia_play;
ALTER FUNCTION public.play_answer(uuid, uuid, uuid, inet, bytea) OWNER TO trivia_play;
ALTER FUNCTION public.play_reveal(uuid, uuid) OWNER TO trivia_play;
ALTER FUNCTION public.play_attempts(uuid, uuid) OWNER TO trivia_play;
ALTER FUNCTION public.play_leaderboard(uuid, integer) OWNER TO trivia_play;
ALTER FUNCTION public.play_standing(uuid, uuid) OWNER TO trivia_play;

REVOKE ALL ON FUNCTION public.play_unlocked_count(timestamptz, integer, integer, timestamptz, timestamptz, integer, integer)
  FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.play_program_ms(uuid) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.play_ranking(uuid) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.play_settle_answer(uuid) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.play_settle_pending(uuid) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.play_settle(uuid, uuid) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.play_note_unlocked(uuid, uuid) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.play_start_set(uuid, uuid) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.play_current(uuid, uuid, inet, bytea) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.play_answer(uuid, uuid, uuid, inet, bytea) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.play_reveal(uuid, uuid) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.play_attempts(uuid, uuid) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.play_leaderboard(uuid, integer) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.play_standing(uuid, uuid) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;

GRANT EXECUTE ON FUNCTION
  public.play_note_unlocked(uuid, uuid),
  public.play_start_set(uuid, uuid),
  public.play_current(uuid, uuid, inet, bytea),
  public.play_answer(uuid, uuid, uuid, inet, bytea),
  public.play_settle(uuid, uuid),
  public.play_reveal(uuid, uuid),
  public.play_attempts(uuid, uuid),
  public.play_leaderboard(uuid, integer),
  public.play_standing(uuid, uuid)
  TO public_rw;
-- The console's contest report (US-029, apps/admin lib/reports/contest-report.ts) ranks the live board and counts the
-- players who finished with THE ranking (D4, D8), not a copy of it. SECURITY INVOKER: admin_rw reads the play tables
-- itself (it holds every table by design); this grants the SQL, not more data.
GRANT EXECUTE ON FUNCTION public.play_ranking(uuid), public.play_program_ms(uuid) TO admin_rw;
