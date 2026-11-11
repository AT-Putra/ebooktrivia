-- triggers.sql: integrity triggers (applied as migrator). Re-runnable (CREATE OR REPLACE).
-- Same function rules as functions.sql (search_path = pg_catalog, pg_temp; our objects
-- qualified; time from clock_timestamp()).
--
-- Caller checks: a trigger that must know WHO writes is SECURITY INVOKER and tests current_user
-- with pg_has_role(). "Trusted writer" = a member of worker_rw, admin_rw or migrator (superusers
-- pass every pg_has_role check). roles.sql guarantees the group roles are members of nothing, so
-- public_rw cannot pass as another group.
--
-- Every trigger here is ENABLE ALWAYS (end of file), so it also fires under
-- session_replication_role = replica; roles.sql revokes any SET privilege on that parameter.
--
-- SQLSTATEs: ET020 content locked, ET021 content-lock edit outside READ COMMITTED,
-- ET030 audit_log append-only, ET031 worker audit entry not actor_kind 'system' / names an admin,
-- ET040 order status change, ET041 order amount != product price, ET042 order LP / program /
-- product mismatch, ET043 program not on sale, ET044 order expiry too far out,
-- ET045 winner confirmation reserved for admin, ET046 program status change reserved for admin,
-- ET050 play row for a player not eligible on a published program, ET051 question/option not in
-- the attempt's set/question.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

-- ---------------------------------------------------------------------------------------------
-- audit_log is append-only. grants.sql gives no role UPDATE/DELETE/TRUNCATE; this trigger also
-- stops the owner and superusers (belt and braces).
CREATE OR REPLACE FUNCTION public.audit_log_append_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % rejected', TG_OP USING ERRCODE = 'ET030';
END
$fn$;

CREATE OR REPLACE TRIGGER audit_log_append_only_row
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_append_only();

CREATE OR REPLACE TRIGGER audit_log_append_only_truncate
  BEFORE TRUNCATE ON public.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_log_append_only();

-- Entries cannot be backdated (occurred_at always from the clock; app roles also lack the INSERT
-- privilege on id and occurred_at, so no OVERRIDING SYSTEM VALUE either), and the worker cannot
-- write entries that claim or name an admin actor: worker entries are actor_kind 'system' with
-- actor_admin_user_id NULL. An Owner-requested job (e.g. re-score) gets its own admin_rw entry,
-- written by the admin app when the Owner requests it.
CREATE OR REPLACE FUNCTION public.audit_log_stamp()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  NEW.occurred_at := clock_timestamp();
  IF pg_has_role(current_user, 'worker_rw', 'USAGE')
     AND NOT pg_has_role(current_user, 'admin_rw', 'USAGE')
     AND NOT pg_has_role(current_user, 'migrator', 'USAGE')
     AND (NEW.actor_kind IS DISTINCT FROM 'system' OR NEW.actor_admin_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'worker audit entries must use actor_kind system with no admin actor' USING ERRCODE = 'ET031';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER audit_log_stamp
  BEFORE INSERT ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_stamp();

-- ---------------------------------------------------------------------------------------------
-- Question content lock (AC-Q10 fairness, M5b). Once a trivia set has any set_attempts row:
-- no INSERT/DELETE of its questions or options, and no change to points, timer, which option
-- is correct, positions, or moving a question/option to another set/question. Text stays
-- editable (prompt, explanation, image, option label) for typo fixes.
CREATE OR REPLACE FUNCTION public.assert_trivia_set_unlocked(p_set_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- Under REPEATABLE READ / SERIALIZABLE the EXISTS below reads the transaction's old snapshot
  -- and the FOR UPDATE does not conflict with an attempt's already released KEY SHARE lock, so
  -- an attempt committed after the snapshot would go unseen. Locked-field edits need READ COMMITTED.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'question content edits must run under READ COMMITTED' USING ERRCODE = 'ET021';
  END IF;
  IF p_set_id IS NULL THEN
    RETURN; -- parent question already gone in this statement (cascade); it was checked itself
  END IF;
  -- FOR UPDATE conflicts with the FOR KEY SHARE lock that inserting a set_attempts row takes on
  -- its trivia_sets row, so a content edit and a first attempt cannot interleave.
  PERFORM 1 FROM public.trivia_sets s WHERE s.id = p_set_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.set_attempts a WHERE a.set_id = p_set_id) THEN
    RAISE EXCEPTION 'trivia set % has attempts: its questions, options, points and timers are locked', p_set_id
      USING ERRCODE = 'ET020';
  END IF;
END
$fn$;

-- SECURITY DEFINER so the lock check runs with owner rights whoever edits; trigger functions are
-- never called directly (EXECUTE is revoked from PUBLIC in grants.sql).
CREATE OR REPLACE FUNCTION public.questions_content_lock()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.assert_trivia_set_unlocked(NEW.set_id);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.assert_trivia_set_unlocked(OLD.set_id);
    RETURN OLD;
  END IF;
  IF NEW.set_id IS DISTINCT FROM OLD.set_id
     OR NEW.points IS DISTINCT FROM OLD.points
     OR NEW.timer_seconds IS DISTINCT FROM OLD.timer_seconds
     OR NEW.position IS DISTINCT FROM OLD.position THEN
    PERFORM public.assert_trivia_set_unlocked(OLD.set_id);
    IF NEW.set_id IS DISTINCT FROM OLD.set_id THEN
      PERFORM public.assert_trivia_set_unlocked(NEW.set_id);
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER questions_content_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.questions
  FOR EACH ROW EXECUTE FUNCTION public.questions_content_lock();

CREATE OR REPLACE FUNCTION public.question_options_content_lock()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_old_set uuid;
  v_new_set uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT q.set_id INTO v_old_set FROM public.questions q WHERE q.id = OLD.question_id;
  END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') THEN
    SELECT q.set_id INTO v_new_set FROM public.questions q WHERE q.id = NEW.question_id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM public.assert_trivia_set_unlocked(v_new_set);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.assert_trivia_set_unlocked(v_old_set);
    RETURN OLD;
  END IF;
  IF NEW.question_id IS DISTINCT FROM OLD.question_id
     OR NEW.is_correct IS DISTINCT FROM OLD.is_correct
     OR NEW.position IS DISTINCT FROM OLD.position THEN
    PERFORM public.assert_trivia_set_unlocked(v_old_set);
    IF v_new_set IS DISTINCT FROM v_old_set THEN
      PERFORM public.assert_trivia_set_unlocked(v_new_set);
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER question_options_content_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.question_options
  FOR EACH ROW EXECUTE FUNCTION public.question_options_content_lock();

-- ---------------------------------------------------------------------------------------------
-- Order status guard. public_rw writes orders at checkout but may only use the checkout
-- states: INSERT as `pending`, and move between `pending` and `snap_create_failed`. Every other
-- transition (paid, review, expired, refunded, ...) belongs to worker_rw (re-query confirmed)
-- or admin_rw. SECURITY INVOKER on purpose: current_user must be the caller.
CREATE OR REPLACE FUNCTION public.orders_status_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF pg_has_role(current_user, 'worker_rw', 'USAGE')
     OR pg_has_role(current_user, 'admin_rw', 'USAGE')
     OR pg_has_role(current_user, 'migrator', 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('pending', 'snap_create_failed')
     OR (TG_OP = 'UPDATE' AND OLD.status NOT IN ('pending', 'snap_create_failed')) THEN
    RAISE EXCEPTION 'order status change to % not allowed for role %', NEW.status, current_user
      USING ERRCODE = 'ET040';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER orders_status_guard
  BEFORE INSERT OR UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_status_guard();

-- Order checkout guard. The worker confirms PAID when the re-queried gross_amount matches
-- orders.amount_idr, so for any caller that is not a trusted writer the order must be priced and
-- combined exactly as the catalog says: LP -> program -> product, amount = products.price_idr
-- (gateway fees are absorbed by the seller and deducted in the ROI report, so the buyer pays
-- the price; a future discount feature must change this check), program published and inside
-- its sales window, and expires_at no later than now + `orders.expiry_seconds`.
-- SECURITY INVOKER: current_user must be the caller (public_rw reads these tables and may
-- execute setting_positive_int).
CREATE OR REPLACE FUNCTION public.orders_checkout_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_lp_program uuid;
  v_lp_active boolean;
  v_program_product uuid;
  v_program_status public.program_status;
  v_sales_start timestamptz;
  v_sales_end timestamptz;
  v_price bigint;
  v_product_active boolean;
BEGIN
  IF pg_has_role(current_user, 'worker_rw', 'USAGE')
     OR pg_has_role(current_user, 'admin_rw', 'USAGE')
     OR pg_has_role(current_user, 'migrator', 'USAGE') THEN
    RETURN NEW;
  END IF;

  SELECT lp.program_id, lp.active INTO v_lp_program, v_lp_active
    FROM public.landing_pages lp WHERE lp.id = NEW.landing_page_id;
  SELECT p.product_id, p.status, p.sales_start_at, p.sales_end_at
    INTO v_program_product, v_program_status, v_sales_start, v_sales_end
    FROM public.programs p WHERE p.id = NEW.program_id;
  SELECT pr.price_idr, pr.active INTO v_price, v_product_active
    FROM public.products pr WHERE pr.id = NEW.product_id;

  IF v_lp_program IS DISTINCT FROM NEW.program_id OR v_program_product IS DISTINCT FROM NEW.product_id THEN
    RAISE EXCEPTION 'order landing page, program and product do not belong together' USING ERRCODE = 'ET042';
  END IF;
  IF NOT v_lp_active OR NOT v_product_active
     OR v_program_status IS DISTINCT FROM 'published'
     OR v_now < v_sales_start OR v_now >= v_sales_end THEN
    RAISE EXCEPTION 'program is not on sale' USING ERRCODE = 'ET043';
  END IF;
  IF NEW.amount_idr IS DISTINCT FROM v_price THEN
    RAISE EXCEPTION 'order amount % does not equal the product price %', NEW.amount_idr, v_price
      USING ERRCODE = 'ET041';
  END IF;
  IF NEW.expires_at > v_now + make_interval(secs => public.setting_positive_int('orders.expiry_seconds')) THEN
    RAISE EXCEPTION 'order expires_at is beyond orders.expiry_seconds' USING ERRCODE = 'ET044';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER orders_checkout_guard
  BEFORE INSERT OR UPDATE OF landing_page_id, program_id, product_id, amount_idr, currency, expires_at
  ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_checkout_guard();

-- ---------------------------------------------------------------------------------------------
-- player_otps: created_at from the clock and expires_at clamped to `otp.code_ttl_seconds`, so the
-- caller cannot backdate a row or mint a long-lived code. SECURITY DEFINER: no caller check
-- needed, and it reads the setting with owner rights for every writer.
CREATE OR REPLACE FUNCTION public.player_otps_stamp()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  NEW.created_at := clock_timestamp();
  NEW.expires_at := LEAST(
    NEW.expires_at,
    NEW.created_at + make_interval(secs => public.setting_positive_int('otp.code_ttl_seconds'))
  );
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER player_otps_stamp
  BEFORE INSERT ON public.player_otps
  FOR EACH ROW EXECUTE FUNCTION public.player_otps_stamp();

-- ---------------------------------------------------------------------------------------------
-- Owner approvals. The worker writes winners as awaiting_confirmation and may flag one (a
-- chargeback after confirmation); only admin_rw (the Owner, enforced by the admin app's
-- policy) confirms or revokes. The worker may move a program only from published to
-- awaiting_confirmation (grace-end sweeper); finalizing is the Owner's.
CREATE OR REPLACE FUNCTION public.winners_status_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF pg_has_role(current_user, 'admin_rw', 'USAGE') OR pg_has_role(current_user, 'migrator', 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'awaiting_confirmation' OR NEW.confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'only admin_rw confirms winners' USING ERRCODE = 'ET045';
    END IF;
  ELSIF NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR (NEW.status IS DISTINCT FROM OLD.status
         AND NOT (NEW.status = 'flagged' AND OLD.status IN ('awaiting_confirmation', 'confirmed'))) THEN
    RAISE EXCEPTION 'winner status change to % is reserved for admin_rw', NEW.status USING ERRCODE = 'ET045';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER winners_status_guard
  BEFORE INSERT OR UPDATE ON public.winners
  FOR EACH ROW EXECUTE FUNCTION public.winners_status_guard();

CREATE OR REPLACE FUNCTION public.programs_status_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF pg_has_role(current_user, 'admin_rw', 'USAGE') OR pg_has_role(current_user, 'migrator', 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'published' AND NEW.status = 'awaiting_confirmation') THEN
    RAISE EXCEPTION 'program status change % -> % is reserved for admin_rw', OLD.status, NEW.status
      USING ERRCODE = 'ET046';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER programs_status_guard
  BEFORE UPDATE OF status ON public.programs
  FOR EACH ROW EXECUTE FUNCTION public.programs_status_guard();

-- ---------------------------------------------------------------------------------------------
-- Play rows written by the public app: only for a player eligible (paid, not refunded) for the
-- set's program, on a published program; questions/options must belong to the attempt's set.
-- Trusted writers are exempt (the worker finalizes attempts of players refunded meanwhile).
-- These checks bound WHO may write play rows, not WHAT score: finalize and re-score must
-- recompute from attempt_questions.option_id joined to question_options.is_correct and
-- questions.points, never trust set_attempts.score / player_program_stats.score.
CREATE OR REPLACE FUNCTION public.set_attempts_play_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF pg_has_role(current_user, 'worker_rw', 'USAGE')
     OR pg_has_role(current_user, 'admin_rw', 'USAGE')
     OR pg_has_role(current_user, 'migrator', 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.trivia_sets s
      JOIN public.programs p ON p.id = s.program_id
      JOIN public.player_programs pp ON pp.program_id = s.program_id
     WHERE s.id = NEW.set_id AND pp.player_id = NEW.player_id AND pp.eligible AND p.status = 'published'
  ) THEN
    RAISE EXCEPTION 'player is not eligible to play this set' USING ERRCODE = 'ET050';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER set_attempts_play_guard
  BEFORE INSERT OR UPDATE ON public.set_attempts
  FOR EACH ROW EXECUTE FUNCTION public.set_attempts_play_guard();

CREATE OR REPLACE FUNCTION public.attempt_questions_play_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_player uuid;
  v_set uuid;
BEGIN
  IF pg_has_role(current_user, 'worker_rw', 'USAGE')
     OR pg_has_role(current_user, 'admin_rw', 'USAGE')
     OR pg_has_role(current_user, 'migrator', 'USAGE') THEN
    RETURN NEW;
  END IF;
  SELECT a.player_id, a.set_id INTO v_player, v_set FROM public.set_attempts a WHERE a.id = NEW.attempt_id;
  IF NOT EXISTS (
    SELECT 1
      FROM public.trivia_sets s
      JOIN public.programs p ON p.id = s.program_id
      JOIN public.player_programs pp ON pp.program_id = s.program_id
     WHERE s.id = v_set AND pp.player_id = v_player AND pp.eligible AND p.status = 'published'
  ) THEN
    RAISE EXCEPTION 'player is not eligible to play this set' USING ERRCODE = 'ET050';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.questions q WHERE q.id = NEW.question_id AND q.set_id = v_set)
     OR (NEW.option_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.question_options o WHERE o.id = NEW.option_id AND o.question_id = NEW.question_id)) THEN
    RAISE EXCEPTION 'question or option does not belong to the attempt''s set' USING ERRCODE = 'ET051';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER attempt_questions_play_guard
  BEFORE INSERT OR UPDATE ON public.attempt_questions
  FOR EACH ROW EXECUTE FUNCTION public.attempt_questions_play_guard();

CREATE OR REPLACE FUNCTION public.player_program_stats_play_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF pg_has_role(current_user, 'worker_rw', 'USAGE')
     OR pg_has_role(current_user, 'admin_rw', 'USAGE')
     OR pg_has_role(current_user, 'migrator', 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.player_programs pp
      JOIN public.programs p ON p.id = pp.program_id
     WHERE pp.player_id = NEW.player_id AND pp.program_id = NEW.program_id AND pp.eligible
       AND p.status = 'published'
  ) THEN
    RAISE EXCEPTION 'player is not eligible for this program' USING ERRCODE = 'ET050';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER player_program_stats_play_guard
  BEFORE INSERT OR UPDATE ON public.player_program_stats
  FOR EACH ROW EXECUTE FUNCTION public.player_program_stats_play_guard();

-- ---------------------------------------------------------------------------------------------
-- Fire every trigger on our tables in ALL session_replication_role modes. The default (ENABLE,
-- mode 'O') skips triggers under `replica`, which a role holding SET on that parameter (or a
-- superuser) could use to bypass every guard above. Covers triggers added later too.
DO $always$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.oid::pg_catalog.regclass AS tbl, tg.tgname
      FROM pg_catalog.pg_trigger tg
      JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
     WHERE c.relnamespace = 'public'::pg_catalog.regnamespace
       AND NOT tg.tgisinternal
       AND tg.tgenabled <> 'A'
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ALWAYS TRIGGER %I', t.tbl, t.tgname);
  END LOOP;
END
$always$;
