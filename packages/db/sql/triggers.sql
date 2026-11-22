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
-- SQLSTATEs: ET020 content locked, ET021 content-lock or prize-tier edit outside READ COMMITTED,
-- ET071 prize tier ranks overlap another tier of the program (or the tier moves to another program),
-- ET072 prize tiers of a program with its results snapshot, ET073 legal page version changed
-- (published versions are immutable; a draft only gets published), ET074 legal page deleted,
-- ET030 audit_log append-only, ET031 worker audit entry not actor_kind 'system' / names an admin,
-- ET040 order status change, ET041 order amount != product price, ET042 order LP / program /
-- product mismatch, ET043 program not on sale, ET044 order expiry too far out,
-- ET045 (unused since US-028), ET046 program status change not allowed for the caller,
-- ET050 play row for a player not eligible on a published program, ET051 question/option not in
-- the attempt's set/question, ET060 settings_secrets relabelled without re-encryption,
-- ET061 settings_secrets id change, ET047 program field locked after its first PAID order
-- (product, slug, sales start, trivia set count / order), ET048 reschedule of a locked program
-- that is not an extension, or of an ended program, ET062 SMTP / WAHA secret bound to another host than its endpoint,
-- ET049 a Midtrans attempt whose midtrans_order_id is not {public_id}-{n} of its order.
-- ET080 a delivery / MT conversion row of an unpaid order, ET081 orders.paid_at / refunded_at changed
-- once set, ET082 a fulfillment change of a flagged or revoked winner (US-021),
-- ET083 a conversion that the sink acknowledged (sent) moved out of sent (US-024),
-- ET130 a delivery that went out (or may have: unknown, failed) put back on the send path (US-025),
-- ET131 an opener that went out (or may have) sent again (US-025, D7).
-- ET104 results snapshot changed (immutable), ET105 winner deleted, changed or inconsistent with its snapshot,
-- ET106 deadline extension written outside the Owner's tool, ET108 play timestamp or answer changed by the
-- caller, ET109 a pick after the deadline + 1500 ms, ET110 a start or serve at or after the grace end,
-- ET111 deadline extension ledger changed (US-028).
-- ET160 a landing page's current version that is not one of its own versions (US-023).
-- US-030: ET175 a fulfilment written outside the fulfilment functions, or off its machine (one step at a time, done is
-- final, a proof upload of kind proof), ET176 a deletion request changed once decided (or completed outside the erasure),
-- ET179 an anonymized player or order given personal data again, or anonymized outside the erasure.
-- US-033: ET187 the Owner's decision ledger (order_owner_decisions) changed, or written outside order_review_decide;
-- ET189 an outbox topic the console (admin_rw) does not enqueue.

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
--
-- The one exception (US-018, plan §10 item 21): the Owner's override, public.override_question_scoring
-- (sql/override.sql), may change points, timer and which option is correct of a locked set's
-- question, because it re-scores every affected attempt in the same transaction and refuses once
-- the program's results snapshot exists. That function is SECURITY DEFINER owned by the NOLOGIN,
-- member-less role trivia_override, so `current_user = 'trivia_override'` is true inside it and in
-- no other session or function (no role can SET ROLE to it; a set_config GUC would not do, any
-- admin_rw session could set one). The two lock triggers are therefore SECURITY INVOKER: they must
-- see the caller as current_user (inside a SECURITY DEFINER trigger it would be the trigger's
-- owner). The lock check itself, assert_trivia_set_unlocked, stays SECURITY DEFINER so it reads
-- set_attempts and locks the set with owner rights whoever edits; its EXECUTE is granted to the
-- roles that may edit questions (grants.sql).
CREATE OR REPLACE FUNCTION public.assert_trivia_set_unlocked(p_set_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
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

-- SECURITY INVOKER (see above): current_user is whoever runs the statement. Trigger functions are
-- never called directly (EXECUTE is revoked from PUBLIC in grants.sql).
CREATE OR REPLACE FUNCTION public.questions_content_lock()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- The Owner override: points / timer only, never a move, a reorder, an insert or a delete.
  IF TG_OP = 'UPDATE' AND current_user = 'trivia_override'
     AND NEW.set_id IS NOT DISTINCT FROM OLD.set_id AND NEW.position IS NOT DISTINCT FROM OLD.position THEN
    RETURN NEW;
  END IF;
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
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_old_set uuid;
  v_new_set uuid;
BEGIN
  -- The Owner override: which option is correct only, never a move, a reorder, an insert or a delete.
  IF TG_OP = 'UPDATE' AND current_user = 'trivia_override'
     AND NEW.question_id IS NOT DISTINCT FROM OLD.question_id AND NEW.position IS NOT DISTINCT FROM OLD.position THEN
    RETURN NEW;
  END IF;
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
-- or, out of review, to the Owner's decision (order_review, US-033). SECURITY INVOKER on purpose: current_user must be the caller.
CREATE OR REPLACE FUNCTION public.orders_status_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- US-033: order_review is the owner of the Owner's review decision (sql/order-review.sql), the one way an order leaves
  -- `review` other than the payment code; it is NOLOGIN and member-less, so this holds inside that function only. admin_rw
  -- is no longer trusted here: it holds no INSERT or UPDATE on orders at all (grants.sql US-033 block).
  IF pg_has_role(current_user, 'worker_rw', 'USAGE')
     OR pg_has_role(current_user, 'migrator', 'USAGE')
     OR current_user = 'order_review' THEN
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
-- Midtrans attempts (US-020 security review P2-6): an attempt's Midtrans order id is always
-- {orders.public_id}-{n} of ITS order, for every writer. midtrans_order_id is UNIQUE already
-- (0000_init); this binds it to the order, so no writer can file attempt n of one order under another
-- order's Midtrans id (notifications and reconciliation, US-021, map by it). SECURITY DEFINER: it
-- reads orders.public_id whatever the caller may read; it decides nothing about the caller.
CREATE OR REPLACE FUNCTION public.midtrans_attempts_id_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_public_id text;
BEGIN
  SELECT o.public_id INTO v_public_id FROM public.orders o WHERE o.id = NEW.order_id;
  IF v_public_id IS NULL OR NEW.midtrans_order_id IS DISTINCT FROM v_public_id || '-' || NEW.n::text THEN
    RAISE EXCEPTION 'midtrans_order_id must be {public_id}-{n} of its order' USING ERRCODE = 'ET049';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER midtrans_attempts_id_guard
  BEFORE INSERT OR UPDATE OF order_id, n, midtrans_order_id ON public.midtrans_attempts
  FOR EACH ROW EXECUTE FUNCTION public.midtrans_attempts_id_guard();

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
-- Winners (AC-A9, AC-Q11; US-028). Written only by the grace-end results snapshot and confirmed only
-- by the Owner's confirmation, both SECURITY DEFINER functions owned by contest_results
-- (sql/contest.sql); no app role holds INSERT or DELETE on the table, and only worker_rw holds an
-- UPDATE, of the flag columns (grants.sql). For EVERY writer, the owner and superusers included:
--   - a winner is inserted awaiting_confirmation, unconfirmed and unflagged, for the program of its
--     snapshot, inside its prize tier's ranks (ET105);
--   - it is never deleted or truncated, and its id, program, snapshot, tier, player, rank and
--     created_at never change (ET105): the list is frozen with the snapshot;
--   - only these status changes exist (ET105 otherwise):
--       awaiting_confirmation -> confirmed, with confirmed_at set, flag untouched: inside
--         contest_results' functions only (the Owner's confirmation);
--       awaiting_confirmation or confirmed -> flagged, with flagged_at set, confirmed_at untouched:
--         by worker_rw only (US-021: a chargeback; plan §10 item 17), changing only status,
--         flagged_at, flag_reason and updated_at;
--       awaiting_confirmation, confirmed or flagged -> revoked, and flagged -> confirmed (the
--         Owner's revoke and reinstatement after a flag, with confirmed_at set), flag untouched:
--         inside contest_results' functions only (US-030: sql/contest.sql revoke_winner and
--         reinstate_winner).
--   US-030 EDIT: a re-award (sql/contest.sql revoke_winner) inserts the next eligible player of the snapshot
--     with the REVOKED winner's prize tier at that player's own snapshot rank, which lies outside the tier's
--     ranks: allowed only inside contest_results' functions, with replaces_winner_id naming a revoked winner of
--     the same snapshot and tier ranked above it. replaces_winner_id never changes (ET105).
-- SECURITY INVOKER: current_user must be the caller.
CREATE OR REPLACE FUNCTION public.winners_status_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'winners are never deleted' USING ERRCODE = 'ET105';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'awaiting_confirmation' OR NEW.confirmed_at IS NOT NULL OR NEW.flagged_at IS NOT NULL
       OR NEW.flag_reason IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public.leaderboard_snapshots l WHERE l.id = NEW.snapshot_id AND l.program_id = NEW.program_id)
       OR NOT EXISTS (
         SELECT 1 FROM public.prize_tiers t
          WHERE t.id = NEW.prize_tier_id AND t.program_id = NEW.program_id
            AND (CASE WHEN NEW.replaces_winner_id IS NULL THEN NEW.rank BETWEEN t.rank_from AND t.rank_to
                      ELSE current_user = 'contest_results' AND EXISTS (
                             SELECT 1 FROM public.winners r
                              WHERE r.id = NEW.replaces_winner_id AND r.status = 'revoked' AND r.snapshot_id = NEW.snapshot_id
                                AND r.prize_tier_id = NEW.prize_tier_id AND r.rank < NEW.rank) END)) THEN
      RAISE EXCEPTION 'a winner is inserted awaiting confirmation, for its snapshot''s program, inside its prize tier'
        USING ERRCODE = 'ET105';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.prize_tier_id IS DISTINCT FROM OLD.prize_tier_id
     OR NEW.player_id IS DISTINCT FROM OLD.player_id OR NEW.rank IS DISTINCT FROM OLD.rank
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.replaces_winner_id IS DISTINCT FROM OLD.replaces_winner_id THEN
    RAISE EXCEPTION 'a winner is frozen with the results snapshot' USING ERRCODE = 'ET105';
  END IF;
  -- The Owner's confirmation, revoke and reinstatement (contest_results' functions). US-030 EDIT: a winner flagged before the
  -- confirmation (never confirmed) is reinstated back to awaiting_confirmation, still unconfirmed, and the Owner's confirmation
  -- then confirms it with the others; the revoke and the reinstatement write the Owner's reason (decision_reason).
  IF current_user = 'contest_results'
     AND ((OLD.status IN ('awaiting_confirmation', 'flagged') AND NEW.status = 'confirmed' AND NEW.confirmed_at IS NOT NULL)
          OR (OLD.status = 'flagged' AND NEW.status = 'awaiting_confirmation' AND OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NULL)
          OR (OLD.status IN ('awaiting_confirmation', 'confirmed', 'flagged') AND NEW.status = 'revoked'))
     AND NEW.flagged_at IS NOT DISTINCT FROM OLD.flagged_at AND NEW.flag_reason IS NOT DISTINCT FROM OLD.flag_reason THEN
    RETURN NEW;
  END IF;
  -- US-030 EDIT: the erasure of the winner's data (sql/privacy.sql) blanks the Owner's free-text reason, and nothing else.
  IF current_user = 'pii_eraser' AND NEW.decision_reason IS NULL
     AND (to_jsonb(NEW) - ARRAY['decision_reason', 'updated_at']) = (to_jsonb(OLD) - ARRAY['decision_reason', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  -- A chargeback flag (US-021).
  IF current_user <> 'contest_results' AND pg_has_role(current_user, 'worker_rw', 'USAGE')
     AND OLD.status IN ('awaiting_confirmation', 'confirmed') AND NEW.status = 'flagged' AND NEW.flagged_at IS NOT NULL
     AND NEW.confirmed_at IS NOT DISTINCT FROM OLD.confirmed_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'winner change % -> % is not allowed for role %', OLD.status, NEW.status, current_user
    USING ERRCODE = 'ET105';
END
$fn$;

CREATE OR REPLACE TRIGGER winners_status_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.winners
  FOR EACH ROW EXECUTE FUNCTION public.winners_status_guard();

CREATE OR REPLACE TRIGGER winners_status_guard_truncate
  BEFORE TRUNCATE ON public.winners
  FOR EACH STATEMENT EXECUTE FUNCTION public.winners_status_guard();

-- Program status (US-028). admin_rw moves a program only between draft and published (the admin
-- app's publish / unpublish); the contest's own transitions happen only inside contest_results'
-- functions: published -> awaiting_confirmation with the results snapshot (grace end), and
-- awaiting_confirmation -> finalized with the Owner's winner confirmation. So an ended program never
-- re-opens and no program ends without its snapshot. Other app roles change no status (ET046).
-- migrator (and superusers) are exempt (operations, tests).
CREATE OR REPLACE FUNCTION public.programs_status_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF current_user = 'contest_results'
     AND ((OLD.status = 'published' AND NEW.status = 'awaiting_confirmation')
          OR (OLD.status = 'awaiting_confirmation' AND NEW.status = 'finalized')) THEN
    RETURN NEW;
  END IF;
  IF pg_has_role(current_user, 'migrator', 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF pg_has_role(current_user, 'admin_rw', 'USAGE')
     AND OLD.status IN ('draft', 'published') AND NEW.status IN ('draft', 'published') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'program status change % -> % is not allowed for role %', OLD.status, NEW.status, current_user
    USING ERRCODE = 'ET046';
END
$fn$;

CREATE OR REPLACE TRIGGER programs_status_guard
  BEFORE UPDATE OF status ON public.programs
  FOR EACH ROW EXECUTE FUNCTION public.programs_status_guard();

-- ---------------------------------------------------------------------------------------------
-- Play rows written by the public app (US-028 hardening, security review P1-1 / P1-2). For a writer
-- that is not trusted (trivia_play, the owner of the US-027 play functions in sql/play.sql, through which
-- alone the public app writes play rows; worker_rw, admin_rw, migrator and the trivia_override /
-- contest_results function owners are trusted):
--   - the write's ARRIVAL time (clock_timestamp() when the guard starts, whole ms) is taken first;
--     then the program's SHARED contest lock (functions.sql lock_program_contest_shared), so play
--     waits for, and is waited for by, the results snapshot, a re-score, a prize tier edit and a
--     deadline extension (all exclusive): the US-027 lock contract, enforced here. Waiting for that
--     lock never costs the player time (US-018 rule; security review N1): the answer time, the
--     deadline check and the grace-end check use the arrival time. A row trigger fires only once
--     its row lock is held, so a wait for the ROW (another transaction holding a pick of the same
--     question open) is charged: a pick queued behind an open one cannot hedge it (security review,
--     N1 follow-up; statement_timestamp() would keep the early start). Every other check runs after
--     the lock, on what is committed then;
--   - only an eligible player (paid, not refunded) on a published program plays (ET050), with the
--     questions / options of the attempt's set (ET051);
--   - a set is started, a question row added and a question served only before the grace end G
--     (ET110); a pick on a question served before G still counts until its deadline + 1500 ms;
--   - the timestamps are the database's, never the caller's: served_at, deadline_at and answered_at
--     only go from NULL to a value, in whole milliseconds; served_at = the clock after the lock (it
--     only gives the player more time), deadline_at = served_at + the question's timer; a question is
--     answered only once served by an EARLIER statement (no serve and pick in one, security review
--     N3); a set answer never changes (ET108, AC-Q8);
--   - a pick is refused when it arrives after deadline_at + 1500 ms (ET109, plan §10 item 5;
--     deadline_at holds any Owner extension) and is recorded at its arrival (never before
--     served_at); closing a question without a pick (a timeout) records LEAST(arrival, deadline_at),
--     i.e. the deadline once it has passed.
-- public_rw cannot write a score at all (grants.sql): scores are derived (score_answer), by the
-- finalize, the re-score and the answer path's SECURITY DEFINER function (US-027).
-- A deadline extension is the Owner's tool's alone, for EVERY writer (ET106): only contest_results
-- sets deadline_extension_ms, once, from 0 (the ledger deadline_extensions holds one row per answer).
CREATE OR REPLACE FUNCTION public.set_attempts_play_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_program uuid;
  v_status public.program_status;
  v_grace_end timestamptz;
  v_arrived timestamptz := date_trunc('milliseconds', clock_timestamp());
BEGIN
  IF pg_has_role(current_user, 'worker_rw', 'USAGE')
     OR pg_has_role(current_user, 'admin_rw', 'USAGE')
     OR pg_has_role(current_user, 'migrator', 'USAGE')
     OR current_user IN ('trivia_override', 'contest_results') THEN
    RETURN NEW;
  END IF;
  SELECT s.program_id INTO v_program FROM public.trivia_sets s WHERE s.id = NEW.set_id;
  IF v_program IS NOT NULL THEN
    PERFORM public.lock_program_contest_shared(v_program);
  END IF;
  SELECT p.status, p.sales_end_at + make_interval(days => p.grace_days) INTO v_status, v_grace_end
    FROM public.programs p WHERE p.id = v_program;
  IF v_status IS DISTINCT FROM 'published' OR NOT EXISTS (
    SELECT 1 FROM public.player_programs pp WHERE pp.program_id = v_program AND pp.player_id = NEW.player_id AND pp.eligible
  ) THEN
    RAISE EXCEPTION 'player is not eligible to play this set' USING ERRCODE = 'ET050';
  END IF;
  -- US-027 EDIT inside US-028's guard (kept here at the merge): only a START is refused after G; an UPDATE is the
  -- answer path's derived totals (sql/play.sql play_settle_answer), which a pick on a question served before G
  -- still writes until its deadline + 1500 ms.
  IF TG_OP = 'INSERT' AND v_arrived >= v_grace_end THEN
    RAISE EXCEPTION 'the grace period of this program has ended: no set starts' USING ERRCODE = 'ET110';
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
  v_program uuid;
  v_status public.program_status;
  v_grace_end timestamptz;
  v_timer integer;
  v_now timestamptz;
  v_arrived timestamptz := date_trunc('milliseconds', clock_timestamp());
BEGIN
  IF NEW.deadline_extension_ms IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.deadline_extension_ms ELSE 0 END)
     AND (current_user <> 'contest_results' OR TG_OP = 'INSERT' OR OLD.deadline_extension_ms <> 0) THEN
    RAISE EXCEPTION 'deadline extensions are written by the Owner''s extension tool only, once per answer' USING ERRCODE = 'ET106';
  END IF;
  IF pg_has_role(current_user, 'worker_rw', 'USAGE')
     OR pg_has_role(current_user, 'admin_rw', 'USAGE')
     OR pg_has_role(current_user, 'migrator', 'USAGE')
     OR current_user IN ('trivia_override', 'contest_results') THEN
    RETURN NEW;
  END IF;
  -- US-030 EDIT: the erasure of a data subject (sql/privacy.sql, owner pii_eraser) blanks the device of the subject's
  -- answers (ip, ua_hash) and changes nothing else of the row, whatever the program's state; any other change by it is
  -- checked like every untrusted writer's below.
  IF TG_OP = 'UPDATE' AND current_user = 'pii_eraser' AND NEW.ip IS NULL AND NEW.ua_hash IS NULL
     AND (NEW.id, NEW.attempt_id, NEW.question_id, NEW.position, NEW.permutation, NEW.served_at, NEW.deadline_at, NEW.answered_at,
          NEW.option_id, NEW.correct, NEW.points, NEW.elapsed_ms, NEW.deadline_extension_ms)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.attempt_id, OLD.question_id, OLD.position, OLD.permutation, OLD.served_at, OLD.deadline_at, OLD.answered_at,
          OLD.option_id, OLD.correct, OLD.points, OLD.elapsed_ms, OLD.deadline_extension_ms) THEN
    RETURN NEW;
  END IF;
  SELECT a.player_id, a.set_id, s.program_id INTO v_player, v_set, v_program
    FROM public.set_attempts a JOIN public.trivia_sets s ON s.id = a.set_id WHERE a.id = NEW.attempt_id;
  IF v_program IS NOT NULL THEN
    PERFORM public.lock_program_contest_shared(v_program);
  END IF;
  v_now := date_trunc('milliseconds', clock_timestamp());
  SELECT p.status, p.sales_end_at + make_interval(days => p.grace_days) INTO v_status, v_grace_end
    FROM public.programs p WHERE p.id = v_program;
  IF v_status IS DISTINCT FROM 'published' OR NOT EXISTS (
    SELECT 1 FROM public.player_programs pp WHERE pp.program_id = v_program AND pp.player_id = v_player AND pp.eligible
  ) THEN
    RAISE EXCEPTION 'player is not eligible to play this set' USING ERRCODE = 'ET050';
  END IF;
  SELECT q.timer_seconds INTO v_timer FROM public.questions q WHERE q.id = NEW.question_id AND q.set_id = v_set;
  IF v_timer IS NULL
     OR (NEW.option_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.question_options o WHERE o.id = NEW.option_id AND o.question_id = NEW.question_id)) THEN
    RAISE EXCEPTION 'question or option does not belong to the attempt''s set' USING ERRCODE = 'ET051';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- deadline_at, answered_at and option_id are not insertable by public_rw (grants.sql). No
    -- question row is added after G either (it would turn an unfinished attempt into a finished one).
    IF v_arrived >= v_grace_end THEN
      RAISE EXCEPTION 'the grace period of this program has ended: no question is served' USING ERRCODE = 'ET110';
    END IF;
    IF NEW.served_at IS NOT NULL THEN
      NEW.served_at := v_now;
      NEW.deadline_at := v_now + make_interval(secs => v_timer);
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.served_at IS NULL AND NEW.served_at IS NOT NULL THEN
    IF v_arrived >= v_grace_end THEN
      RAISE EXCEPTION 'the grace period of this program has ended: no question is served' USING ERRCODE = 'ET110';
    END IF;
    NEW.served_at := v_now;
    NEW.deadline_at := v_now + make_interval(secs => v_timer);
  ELSIF NEW.served_at IS DISTINCT FROM OLD.served_at THEN
    RAISE EXCEPTION 'served_at is set once, by the database' USING ERRCODE = 'ET108';
  ELSE
    NEW.deadline_at := OLD.deadline_at;
  END IF;
  IF OLD.answered_at IS NOT NULL THEN
    IF NEW.answered_at IS DISTINCT FROM OLD.answered_at OR NEW.option_id IS DISTINCT FROM OLD.option_id THEN
      RAISE EXCEPTION 'an answer never changes' USING ERRCODE = 'ET108';
    END IF;
  ELSIF NEW.answered_at IS NOT NULL THEN
    IF OLD.served_at IS NULL THEN
      RAISE EXCEPTION 'a question is answered only once served, by an earlier statement' USING ERRCODE = 'ET108';
    END IF;
    IF NEW.option_id IS NULL THEN
      NEW.answered_at := LEAST(GREATEST(v_arrived, NEW.served_at), NEW.deadline_at);
    ELSIF v_arrived > NEW.deadline_at + interval '1500 milliseconds' THEN
      RAISE EXCEPTION 'the question''s time is over' USING ERRCODE = 'ET109';
    ELSE
      NEW.answered_at := GREATEST(v_arrived, NEW.served_at);
    END IF;
  ELSIF NEW.option_id IS DISTINCT FROM OLD.option_id THEN
    RAISE EXCEPTION 'a pick is recorded with its answer, once' USING ERRCODE = 'ET108';
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
     OR pg_has_role(current_user, 'migrator', 'USAGE')
     OR current_user IN ('trivia_override', 'contest_results') THEN
    RETURN NEW;
  END IF;
  PERFORM public.lock_program_contest_shared(NEW.program_id);
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

-- The deadline-extension ledger (US-028, security review P1-4): one row per extended answer (its
-- primary key: at most one extension per answer), written only by extend_open_question_deadlines
-- and referenced from its audit row by extension_id. Append-only for EVERY writer (ET111).
CREATE OR REPLACE FUNCTION public.deadline_extensions_append_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'the deadline extension ledger is append-only: % rejected', TG_OP USING ERRCODE = 'ET111';
END
$fn$;

CREATE OR REPLACE TRIGGER deadline_extensions_append_only
  BEFORE UPDATE OR DELETE ON public.deadline_extensions
  FOR EACH ROW EXECUTE FUNCTION public.deadline_extensions_append_only();

CREATE OR REPLACE TRIGGER deadline_extensions_append_only_truncate
  BEFORE TRUNCATE ON public.deadline_extensions
  FOR EACH STATEMENT EXECUTE FUNCTION public.deadline_extensions_append_only();

-- ---------------------------------------------------------------------------------------------
-- settings_secrets labels (US-011; US-009 security finding: admin_rw could relabel the payment
-- row as a conversions secret of an attacker adnet + host and keep its ciphertext). The
-- ciphertext and sealed DEK are bound by their AAD to id, scope, name, adnet_id, bound_host and
-- key_id (@ebooktrivia/crypto), so such a row no longer decrypts; this guard refuses the relabel
-- itself. A label change needs a fresh encryption in the same UPDATE: ciphertext, nonce AND
-- sealed_dek all change (ET060). The id never changes (ET061). No caller check: it binds the
-- owner and superusers too.
CREATE OR REPLACE FUNCTION public.settings_secrets_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'settings_secrets.id is immutable' USING ERRCODE = 'ET061';
  END IF;
  IF (NEW.scope IS DISTINCT FROM OLD.scope
      OR NEW.name IS DISTINCT FROM OLD.name
      OR NEW.adnet_id IS DISTINCT FROM OLD.adnet_id
      OR NEW.bound_host IS DISTINCT FROM OLD.bound_host
      OR NEW.key_id IS DISTINCT FROM OLD.key_id)
     AND (NEW.ciphertext IS NOT DISTINCT FROM OLD.ciphertext
          OR NEW.nonce IS NOT DISTINCT FROM OLD.nonce
          OR NEW.sealed_dek IS NOT DISTINCT FROM OLD.sealed_dek) THEN
    RAISE EXCEPTION 'changing scope, name, adnet_id, bound_host or key_id of a secret needs a new ciphertext, nonce and sealed_dek'
      USING ERRCODE = 'ET060';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER settings_secrets_guard
  BEFORE UPDATE ON public.settings_secrets
  FOR EACH ROW EXECUTE FUNCTION public.settings_secrets_guard();

-- Endpoint binding (plan M2.3): changing an endpoint host deletes the secrets bound to it in the
-- same transaction, so a compromised admin cannot point a decrypted secret at a host it
-- controls. Raises nothing. SECURITY DEFINER: the delete runs whoever changes the endpoint.
--   adnets.endpoint_host: every secret of that adnet not bound to the new host.
--   waha_servers: messaging secrets bound to the old base_url_host, when base_url_host or the
--     scheme://authority of base_url changes (the worker sends to base_url, so a base_url moved
--     to another host while base_url_host stays the same also clears the key). Secrets bound to
--     that host are deleted even if another server uses it too: that server's key must be
--     entered again. Since migration 0002 the CHECK waha_servers_base_url_check also ties
--     base_url to base_url_host on INSERT and UPDATE (security review US-011 #1).
--   smtp_settings.host: smtp_settings_clear_bound_secrets below (US-017).
--   NOT YET COVERED: CAPI endpoints have no host column. The story that adds one (M7) must add the
--     same clear-on-change trigger and an INSERT-time consistency check.
CREATE OR REPLACE FUNCTION public.adnets_clear_bound_secrets()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  DELETE FROM public.settings_secrets s
   WHERE s.adnet_id = NEW.id AND s.bound_host IS DISTINCT FROM NEW.endpoint_host;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE TRIGGER adnets_clear_bound_secrets
  AFTER UPDATE ON public.adnets
  FOR EACH ROW WHEN (OLD.endpoint_host IS DISTINCT FROM NEW.endpoint_host)
  EXECUTE FUNCTION public.adnets_clear_bound_secrets();

CREATE OR REPLACE FUNCTION public.waha_servers_clear_bound_secrets()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  -- scheme://authority of base_url, lowercase; NULL when base_url does not start that way.
  v_old_origin text := substring(lower(OLD.base_url) from '^[a-z][a-z0-9+.-]*://[^/?#\\]*');
  v_new_origin text := substring(lower(NEW.base_url) from '^[a-z][a-z0-9+.-]*://[^/?#\\]*');
BEGIN
  IF NEW.base_url_host IS DISTINCT FROM OLD.base_url_host
     OR v_new_origin IS DISTINCT FROM v_old_origin
     OR (v_new_origin IS NULL AND NEW.base_url IS DISTINCT FROM OLD.base_url) THEN
    DELETE FROM public.settings_secrets s
     WHERE s.scope = 'messaging' AND s.bound_host = OLD.base_url_host;
  END IF;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE TRIGGER waha_servers_clear_bound_secrets
  AFTER UPDATE ON public.waha_servers
  FOR EACH ROW EXECUTE FUNCTION public.waha_servers_clear_bound_secrets();

-- ---------------------------------------------------------------------------------------------
-- Program field lock (plan §10 item 10, AC-A3; US-017). A program locks at its first PAID order:
-- orders_lock_program stamps programs.locked_at in the transaction that sets orders.paid_at
-- (worker). From then on, for EVERY writer (the admin app checks first, this is the guarantee):
--   - product_id, slug and sales_start_at never change, and locked_at never changes again (ET047);
--   - reschedule is extend-only: sales_end_at and grace_days may only grow, so the end of grace
--     only moves later (ET048);
--   - the trivia set count and order are frozen: no set is added, removed, moved to another
--     program or re-positioned (ET047), because the unlock schedule of buyers who already paid
--     depends on them (AC-Q4);
--   - the status never goes back to draft (ET047, security review US-017 S5: a draft program is off
--     sale and closed to play for buyers who already paid).
-- And for every program, locked or not (code review US-017 CM4): once the contest has ended
-- (awaiting_confirmation / finalized: the grace-end snapshot exists) sales end and grace never
-- change (ET048), so the snapshot stays the result of the schedule it was taken under.
-- A paid order is also checked directly (not only locked_at), so a program locks even if a stamp
-- were missed. SECURITY DEFINER: the checks read orders with owner rights whoever writes.
CREATE OR REPLACE FUNCTION public.orders_lock_program()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  UPDATE public.programs SET locked_at = clock_timestamp() WHERE id = NEW.program_id AND locked_at IS NULL;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE TRIGGER orders_lock_program
  AFTER INSERT OR UPDATE OF paid_at ON public.orders
  FOR EACH ROW WHEN (NEW.paid_at IS NOT NULL)
  EXECUTE FUNCTION public.orders_lock_program();

CREATE OR REPLACE FUNCTION public.programs_field_lock()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF OLD.locked_at IS NOT NULL AND NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
    RAISE EXCEPTION 'programs.locked_at cannot change once set' USING ERRCODE = 'ET047';
  END IF;
  IF OLD.status NOT IN ('draft', 'published')
     AND (NEW.sales_end_at IS DISTINCT FROM OLD.sales_end_at OR NEW.grace_days IS DISTINCT FROM OLD.grace_days) THEN
    RAISE EXCEPTION 'program % has ended (%): its sales end and grace cannot change', OLD.id, OLD.status
      USING ERRCODE = 'ET048';
  END IF;
  IF OLD.locked_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.program_id = OLD.id AND o.paid_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  NEW.locked_at := coalesce(NEW.locked_at, OLD.locked_at, clock_timestamp());
  IF NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.sales_start_at IS DISTINCT FROM OLD.sales_start_at THEN
    RAISE EXCEPTION 'program % is locked after its first paid order: product, slug and sales start cannot change', OLD.id
      USING ERRCODE = 'ET047';
  END IF;
  IF NEW.sales_end_at < OLD.sales_end_at OR NEW.grace_days < OLD.grace_days THEN
    RAISE EXCEPTION 'program % is locked after its first paid order: sales end and grace can only be extended', OLD.id
      USING ERRCODE = 'ET048';
  END IF;
  IF NEW.status = 'draft' AND OLD.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'program % is locked after its first paid order: it cannot go back to draft', OLD.id
      USING ERRCODE = 'ET047';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER programs_field_lock
  BEFORE UPDATE ON public.programs
  FOR EACH ROW EXECUTE FUNCTION public.programs_field_lock();

-- FOR UPDATE on the program row conflicts with the UPDATE orders_lock_program makes, so adding a
-- set and the first payment cannot interleave (under READ COMMITTED the lock wait re-reads the
-- row; under REPEATABLE READ / SERIALIZABLE a concurrent stamp is a serialization failure). A
-- program deleted in the same statement (cascade) is gone and has nothing to protect.
CREATE OR REPLACE FUNCTION public.assert_program_unlocked(p_program_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_locked_at timestamptz;
BEGIN
  SELECT p.locked_at INTO v_locked_at FROM public.programs p WHERE p.id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_locked_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.orders o WHERE o.program_id = p_program_id AND o.paid_at IS NOT NULL) THEN
    RAISE EXCEPTION 'program % is locked after its first paid order: its trivia sets cannot be added, removed or reordered', p_program_id
      USING ERRCODE = 'ET047';
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION public.trivia_sets_program_lock()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.assert_program_unlocked(NEW.program_id);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.assert_program_unlocked(OLD.program_id);
    RETURN OLD;
  END IF;
  IF NEW.program_id IS DISTINCT FROM OLD.program_id OR NEW.position IS DISTINCT FROM OLD.position THEN
    PERFORM public.assert_program_unlocked(OLD.program_id);
    IF NEW.program_id IS DISTINCT FROM OLD.program_id THEN
      PERFORM public.assert_program_unlocked(NEW.program_id);
      -- A set with attempts never moves to another program (security review US-018 L1): its attempts
      -- would then score in a program their players never paid for (ET020).
      PERFORM public.assert_trivia_set_unlocked(OLD.id);
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER trivia_sets_program_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.trivia_sets
  FOR EACH ROW EXECUTE FUNCTION public.trivia_sets_program_lock();

-- ---------------------------------------------------------------------------------------------
-- SMTP / WAHA secret endpoint binding (plan M2.3; the M3 carry-over for SMTP). The worker sends
-- `smtp.password` only to smtp_settings.host and `waha.<server id hex>.api_key` only to that
-- server's base_url (assertWahaTarget). These names may only be written bound to exactly that
-- endpoint host (ET062), and the SMTP password is deleted when the host, port or TLS mode changes
-- (security review US-017 INFO 6: another port may be another service) or the settings row is
-- deleted (the WAHA one by waha_servers_clear_bound_secrets above). Names outside these
-- two forms are not read by the worker and are left alone. SECURITY DEFINER: no caller check.
CREATE OR REPLACE FUNCTION public.settings_secrets_endpoint_binding()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_server_hex text := substring(NEW.name from '^waha\.([0-9a-f]{32})\.api_key$');
BEGIN
  IF NEW.name = 'smtp.password' THEN
    IF NEW.scope <> 'messaging'
       OR NOT EXISTS (SELECT 1 FROM public.smtp_settings m WHERE m.host = NEW.bound_host) THEN
      RAISE EXCEPTION 'smtp.password must be a messaging secret bound to the SMTP host' USING ERRCODE = 'ET062';
    END IF;
  ELSIF v_server_hex IS NOT NULL THEN
    IF NEW.scope <> 'messaging'
       OR NOT EXISTS (
         SELECT 1 FROM public.waha_servers w
          WHERE pg_catalog.replace(w.id::text, '-', '') = v_server_hex AND w.base_url_host = NEW.bound_host) THEN
      RAISE EXCEPTION 'a WAHA API key must be a messaging secret bound to its server''s base_url_host' USING ERRCODE = 'ET062';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER settings_secrets_endpoint_binding
  BEFORE INSERT OR UPDATE ON public.settings_secrets
  FOR EACH ROW EXECUTE FUNCTION public.settings_secrets_endpoint_binding();

CREATE OR REPLACE FUNCTION public.smtp_settings_clear_bound_secrets()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.host IS DISTINCT FROM OLD.host OR NEW.port IS DISTINCT FROM OLD.port
     OR NEW.security IS DISTINCT FROM OLD.security THEN
    DELETE FROM public.settings_secrets s WHERE s.name = 'smtp.password';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE TRIGGER smtp_settings_clear_bound_secrets
  AFTER UPDATE OR DELETE ON public.smtp_settings
  FOR EACH ROW EXECUTE FUNCTION public.smtp_settings_clear_bound_secrets();

-- ---------------------------------------------------------------------------------------------
-- Prize tiers (AC-A3, US-018). For every writer: the rank ranges of one program never overlap
-- (ET071; a trigger rather than an exclusion constraint, which would need the btree_gist
-- extension), a tier never moves to another program (ET071), and once the program's results
-- snapshot exists its tiers are final (ET072): the grace-end sweeper awards prizes from them.
-- The check runs under the program's contest lock (functions.sql lock_program_contest), which
-- the snapshot insert takes too, so a tier edit and the snapshot cannot interleave, and two
-- overlapping inserts cannot both pass: the second waits, then (READ COMMITTED, so each statement
-- sees what committed meanwhile; ET021 otherwise) sees the first. Rows inserted earlier by the same
-- statement are visible too (a clone copies all tiers in one INSERT). SECURITY DEFINER: the checks
-- read with owner rights whoever writes.
-- Owner decision (US-018 review, security I5): tiers stay editable until the results snapshot,
-- even while the contest runs; every change is audited (apps/admin lib/settings/prizes.ts).
CREATE OR REPLACE FUNCTION public.prize_tiers_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_program uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'prize tier edits must run under READ COMMITTED' USING ERRCODE = 'ET021';
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_program := OLD.program_id;
  ELSE
    v_program := NEW.program_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.program_id IS DISTINCT FROM OLD.program_id THEN
    RAISE EXCEPTION 'a prize tier cannot move to another program' USING ERRCODE = 'ET071';
  END IF;
  PERFORM public.lock_program_contest(v_program);
  IF EXISTS (SELECT 1 FROM public.leaderboard_snapshots s WHERE s.program_id = v_program) THEN
    RAISE EXCEPTION 'program % has its results snapshot: its prize tiers are final', v_program USING ERRCODE = 'ET072';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.prize_tiers t
     WHERE t.program_id = NEW.program_id AND t.id <> NEW.id
       AND t.rank_from <= NEW.rank_to AND NEW.rank_from <= t.rank_to
  ) THEN
    RAISE EXCEPTION 'prize tier ranks % to % overlap another tier of program %', NEW.rank_from, NEW.rank_to, NEW.program_id
      USING ERRCODE = 'ET071';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER prize_tiers_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.prize_tiers
  FOR EACH ROW EXECUTE FUNCTION public.prize_tiers_guard();

-- The results snapshot takes the program's contest lock (functions.sql): it waits for a running
-- override re-score or prize tier edit to commit, and none starts until it has committed (they
-- then see the snapshot and refuse, ET022 / ET072). The grace-end finalize (contest.sql
-- create_leaderboard_snapshot) takes the lock itself BEFORE it reads what it freezes. SECURITY
-- DEFINER: the lock is taken whoever inserts.
CREATE OR REPLACE FUNCTION public.leaderboard_snapshots_lock()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM public.lock_program_contest(NEW.program_id);
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER leaderboard_snapshots_lock
  BEFORE INSERT ON public.leaderboard_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.leaderboard_snapshots_lock();

-- The results snapshot is immutable for EVERY writer, the owner and superusers included (like
-- audit_log): no UPDATE, DELETE or TRUNCATE (ET104; US-028). It is written once per program
-- (UNIQUE program_id) by public.create_leaderboard_snapshot (sql/contest.sql).
CREATE OR REPLACE FUNCTION public.leaderboard_snapshots_immutable()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'the results snapshot is immutable: % rejected', TG_OP USING ERRCODE = 'ET104';
END
$fn$;

CREATE OR REPLACE TRIGGER leaderboard_snapshots_immutable
  BEFORE UPDATE OR DELETE ON public.leaderboard_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.leaderboard_snapshots_immutable();

CREATE OR REPLACE TRIGGER leaderboard_snapshots_immutable_truncate
  BEFORE TRUNCATE ON public.leaderboard_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION public.leaderboard_snapshots_immutable();

-- ---------------------------------------------------------------------------------------------
-- Legal pages (AC-A10, US-018): versioned per program and kind (terms = S&K, privacy). Every save
-- is a new draft version; publishing stamps published_at from the clock. For every writer:
--   - a version is inserted as a draft (ET073);
--   - a saved version never changes, except a draft being published (ET073); a published version
--     never changes at all (ET073);
--   - a version is never deleted or truncated (ET074): consents reference the exact version a
--     buyer accepted (consents.legal_page_id).
CREATE OR REPLACE FUNCTION public.legal_pages_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'legal page versions are never deleted' USING ERRCODE = 'ET074';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'a legal page version is saved as a draft and published afterwards' USING ERRCODE = 'ET073';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'legal page version % is published: it is immutable', OLD.id USING ERRCODE = 'ET073';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a saved legal page version never changes: save a new version' USING ERRCODE = 'ET073';
  END IF;
  IF NEW.published_at IS NOT NULL THEN
    NEW.published_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER legal_pages_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.legal_pages
  FOR EACH ROW EXECUTE FUNCTION public.legal_pages_guard();

CREATE OR REPLACE TRIGGER legal_pages_guard_truncate
  BEFORE TRUNCATE ON public.legal_pages
  FOR EACH STATEMENT EXECUTE FUNCTION public.legal_pages_guard();

-- ---------------------------------------------------------------------------------------------
-- US-021 payments (AC-S7, AC-T4, plan §10 item 17). The worker applies each re-queried Midtrans
-- status in one transaction under the order's row lock, and creates the PAID effects with
-- INSERT ... ON CONFLICT DO NOTHING on their unique keys (deliveries_order_id_channel_key,
-- conversion_events_order_id_sink_kind_key, outbox_dedupe_key_key, player_programs_pkey). These
-- guards hold for EVERY writer (no caller check), so no code path can break them:
--   ET080 a delivery, or an MT conversion row, for an order that is not paid (AC-T4: unpaid orders
--         never fire MT; nothing is delivered before PAID), or one moved to pending / sending while its
--         order is not paid (no retry, claim or re-fire after a refund, chargeback or review);
--   ET081 orders.paid_at / refunded_at, once set, never change (the first PAID is stamped once);
--   ET082 a fulfillment of a flagged or revoked winner (a chargeback after confirmation flags the
--         winner, which halts fulfillment until the Owner decides): no new fulfillment row, no status,
--         proof or winner change; notes stay editable.
-- SECURITY DEFINER where the guard reads another table (it decides nothing about the caller).
CREATE OR REPLACE FUNCTION public.paid_effects_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = NEW.order_id AND o.status = 'paid') THEN
    RAISE EXCEPTION '% rows are created for paid orders only', TG_TABLE_NAME USING ERRCODE = 'ET080';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER deliveries_paid_guard
  BEFORE INSERT OR UPDATE OF order_id ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.paid_effects_guard();

CREATE OR REPLACE TRIGGER conversion_events_mt_paid_guard
  BEFORE INSERT OR UPDATE OF order_id, kind ON public.conversion_events
  FOR EACH ROW WHEN (NEW.kind = 'mt') EXECUTE FUNCTION public.paid_effects_guard();

-- Security review US-021 P2-A: nothing of an order that left PAID goes (back) into the send path. A
-- delivery or an MT row moves to pending (due again) or sending (claimed) only while its order is paid:
-- no lease-expiry retry, no consumer claim (US-024 / US-025) and no manual re-fire of a refunded order.
CREATE OR REPLACE TRIGGER deliveries_paid_status_guard
  BEFORE UPDATE OF status ON public.deliveries
  FOR EACH ROW WHEN (NEW.status IN ('pending', 'sending')) EXECUTE FUNCTION public.paid_effects_guard();

CREATE OR REPLACE TRIGGER conversion_events_mt_paid_status_guard
  BEFORE UPDATE OF status ON public.conversion_events
  FOR EACH ROW WHEN (NEW.kind = 'mt' AND NEW.status IN ('pending', 'sending')) EXECUTE FUNCTION public.paid_effects_guard();

-- --- US-024 exactly-once conversions ----------------------------------------------------------------------
-- A conversion row the sink acknowledged (2xx, status `sent`) never leaves `sent` through any code path of
-- the worker or the admin app: no retry, claim, sweep or direct UPDATE can send it again (ET083). The one
-- way out is public.refire_conversion(id, true) (sql/conversions.sql), an explicit Owner action: it is
-- SECURITY DEFINER and owned by the NOLOGIN, member-less role conversion_refire (roles.sql), so inside it
-- current_user is conversion_refire, which no login can be and no session can SET ROLE to. SECURITY INVOKER
-- here for that reason (like the content-lock triggers): the trigger must see the caller, not its own owner.
CREATE OR REPLACE FUNCTION public.conversion_events_sent_final_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF current_user <> 'conversion_refire' THEN
    RAISE EXCEPTION 'a conversion the sink acknowledged is final: only an explicit re-fire resends it' USING ERRCODE = 'ET083';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER conversion_events_sent_final_guard
  BEFORE UPDATE OF status ON public.conversion_events
  FOR EACH ROW WHEN (OLD.status = 'sent' AND NEW.status IS DISTINCT FROM 'sent') EXECUTE FUNCTION public.conversion_events_sent_final_guard();
-- --- end US-024 ------------------------------------------------------------------------------------------

-- --- US-025 exactly-once deliveries -------------------------------------------------------------------------
-- A delivery that went out (`sent`), or that may have (`unknown`, `failed`: an uncertain or a permanently failed
-- send), never goes back on the send path through any code path of the worker or the admin app (ET130): a `sent` row
-- stays sent, an `unknown` / `failed` row never becomes `pending` or `sending` again, so no retry, claim, sweep or
-- direct UPDATE can send it a second time. (An `unknown` row can still be settled as `sent` or left for the Owner.)
-- Nor does it leave through a side door: an `unknown` or `failed` row may only become `sent` (the late outcome, or the
-- outgoing-message lookup), never `cancelled` (which payments could revive to `pending`, a two-step detour back onto
-- the send path), and a `sent` row never changes status at all.
-- The one way back is an explicit Owner or Staff resend, which US-029 builds as a SECURITY DEFINER function owned by the
-- NOLOGIN, member-less role delivery_resend (roles.sql; the conversion_refire pattern): inside it current_user is that role,
-- which no login can be and no session can SET ROLE to. A superuser (operations, repairs by hand) passes too. SECURITY INVOKER
-- for that reason (like the content-lock and the conversion guards): the trigger must see the caller, not its own owner.
-- A cancelled row (payments' own mark) is not covered by the WHEN below: payments revives it when its order is paid again.
CREATE OR REPLACE FUNCTION public.deliveries_final_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF current_user = 'delivery_resend' OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'sent' OR (OLD.status IN ('unknown', 'failed') AND NEW.status <> 'sent') THEN
    RAISE EXCEPTION 'a delivery that went out, or may have, is never put back on the send path: only an explicit resend does' USING ERRCODE = 'ET130';
  END IF;
  RETURN NEW;
END
$fn$;

-- Named so that it fires AFTER deliveries_paid_status_guard (triggers fire by name): a delivery of an order that is not paid is refused with ET080 first.
CREATE OR REPLACE TRIGGER deliveries_status_final_guard
  BEFORE UPDATE OF status ON public.deliveries
  FOR EACH ROW WHEN (OLD.status IN ('sent', 'unknown', 'failed') AND NEW.status IS DISTINCT FROM OLD.status) EXECUTE FUNCTION public.deliveries_final_guard();

-- The opener of a WhatsApp delivery (Owner decision D7) is exactly-once on its own: a `sent` opener never changes, a `failed` or `expired` one is final, and an
-- `unknown` one (it may have gone out) can only become `sent` (the late outcome of the send itself), never `pending` or `sending` again: no code path
-- sends an opener a second time (ET131). There is no resend of an opener (US-029's resend is the PDF's), so only a superuser (operations) passes.
CREATE OR REPLACE FUNCTION public.delivery_openers_final_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper) THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('sent', 'failed', 'expired') OR (OLD.status = 'unknown' AND NEW.status <> 'sent') THEN
    RAISE EXCEPTION 'an opener that went out, or may have, is never sent again' USING ERRCODE = 'ET131';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER delivery_openers_status_final_guard
  BEFORE UPDATE OF status ON public.delivery_openers
  FOR EACH ROW WHEN (OLD.status IN ('sent', 'failed', 'expired', 'unknown') AND NEW.status IS DISTINCT FROM OLD.status) EXECUTE FUNCTION public.delivery_openers_final_guard();
-- --- end US-025 ------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.orders_payment_stamps_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF (OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at)
     OR (OLD.refunded_at IS NOT NULL AND NEW.refunded_at IS DISTINCT FROM OLD.refunded_at) THEN
    RAISE EXCEPTION 'orders.paid_at and refunded_at are set once' USING ERRCODE = 'ET081';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER orders_payment_stamps_guard
  BEFORE UPDATE OF paid_at, refunded_at ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_payment_stamps_guard();

CREATE OR REPLACE FUNCTION public.fulfillments_halt_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.proof_upload_id IS NOT DISTINCT FROM OLD.proof_upload_id
     AND NEW.winner_id IS NOT DISTINCT FROM OLD.winner_id THEN
    RETURN NEW;
  END IF;
  -- US-030 EDIT: clearing the personal content of a halted fulfilment (proof and notes both emptied, nothing else changed)
  -- is not a fulfilment change: the erasure of a data subject (sql/privacy.sql) does it for a revoked or flagged winner too.
  -- This guard is SECURITY DEFINER (current_user is its owner here); WHO may do it is fulfillments_machine_guard's check
  -- (SECURITY INVOKER, US-030 block below): only pii_eraser.
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.winner_id IS NOT DISTINCT FROM OLD.winner_id
     AND NEW.proof_upload_id IS NULL AND NEW.notes IS NULL AND NEW.correction_reason IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.winners w
     WHERE w.id IN (NEW.winner_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.winner_id END)
       AND w.status IN ('flagged', 'revoked')
  ) THEN
    RAISE EXCEPTION 'fulfillment is halted: the winner is flagged or revoked' USING ERRCODE = 'ET082';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER fulfillments_halt_guard
  BEFORE INSERT OR UPDATE ON public.fulfillments
  FOR EACH ROW EXECUTE FUNCTION public.fulfillments_halt_guard();

-- ---------------------------------------------------------------------------------------------
-- US-023 (M6e LP ZIP hosting) BLOCK BEGIN.
-- ET160: a landing page's current version must be one of ITS OWN versions (a rollback cannot make
-- another page's files live on this page's domains).
CREATE OR REPLACE FUNCTION public.landing_pages_current_version_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.current_version_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.lp_versions v WHERE v.id = NEW.current_version_id AND v.landing_page_id = NEW.id) THEN
    RAISE EXCEPTION 'the current version belongs to another landing page' USING ERRCODE = 'ET160';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.landing_pages_current_version_guard() FROM PUBLIC;

CREATE OR REPLACE TRIGGER landing_pages_current_version_guard
  BEFORE INSERT OR UPDATE OF current_version_id ON public.landing_pages
  FOR EACH ROW EXECUTE FUNCTION public.landing_pages_current_version_guard();

-- The ask cache of the internal process (apps/worker/src/domains.ts) is the set public.lp_served_hosts()
-- returns, so it must hear of every change to that set: lp_domains already NOTIFYs lp_domains_changed
-- (migration 0003); a landing page that is deactivated or reactivated, changes its hosting, or gets a
-- new / rolled-back current version (an UPDATE of these columns, also through the FK's SET NULL) or is
-- deleted NOTIFYs the same channel. Statement level: one notification per statement, on commit.
CREATE OR REPLACE TRIGGER landing_pages_hosts_notify
  AFTER UPDATE OF active, hosting, current_version_id OR DELETE ON public.landing_pages
  FOR EACH STATEMENT EXECUTE FUNCTION public.lp_domains_notify();
-- US-023 BLOCK END.

-- ---------------------------------------------------------------------------------------------
-- US-030 BLOCK BEGIN (M10b: prize fulfilment, UU PDP deletion = anonymization). Three in-place edits sit outside this block,
-- each marked "US-030 EDIT": winners_status_guard admits the re-award row, attempt_questions_play_guard lets pii_eraser blank
-- the device columns, and fulfillments_halt_guard treats emptying a fulfilment's proof and notes as no fulfilment change.
--
-- Fulfilments (ET175), for EVERY writer but a superuser (operations): never deleted; created only inside contest_results'
-- functions (the confirmation, a re-award, a reinstatement: sql/contest.sql), pending and empty, for a confirmed winner;
-- moved only inside prize_fulfillment's functions (sql/fulfillment.sql): exactly one step forward or back, never out of
-- done, a proof only of kind proof and never removed (it is replaced); emptied (proof and notes, nothing else) only inside
-- pii_eraser's erasure (sql/privacy.sql). Its winner and id never change. fulfillments_halt_guard (ET082, named before
-- this one, so it fires first) still halts every fulfilment change of a flagged or revoked winner. SECURITY INVOKER: the
-- guard must see the caller.
CREATE OR REPLACE FUNCTION public.fulfillments_machine_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_steps CONSTANT text[] := ARRAY['pending', 'contacted', 'sent', 'done'];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper) THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD WHEN 'TRUNCATE' THEN NULL ELSE NEW END;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'fulfilments are never deleted' USING ERRCODE = 'ET175';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF current_user = 'contest_results' AND NEW.status = 'pending' AND NEW.notes IS NULL AND NEW.proof_upload_id IS NULL
       AND EXISTS (SELECT 1 FROM public.winners w WHERE w.id = NEW.winner_id AND w.status = 'confirmed') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a fulfilment is created pending, for a confirmed winner, by the results functions only' USING ERRCODE = 'ET175';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.winner_id IS DISTINCT FROM OLD.winner_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a fulfilment never changes its winner' USING ERRCODE = 'ET175';
  END IF;
  IF current_user = 'pii_eraser' THEN
    IF NEW.notes IS NULL AND NEW.proof_upload_id IS NULL AND NEW.correction_reason IS NULL
       AND (NEW.status, NEW.contacted_at, NEW.contacted_by_admin_user_id, NEW.sent_at, NEW.sent_by_admin_user_id, NEW.done_at, NEW.done_by_admin_user_id)
           IS NOT DISTINCT FROM
           (OLD.status, OLD.contacted_at, OLD.contacted_by_admin_user_id, OLD.sent_at, OLD.sent_by_admin_user_id, OLD.done_at, OLD.done_by_admin_user_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'the erasure only empties a fulfilment''s proof, notes and correction reason' USING ERRCODE = 'ET175';
  END IF;
  IF current_user = 'prize_fulfillment' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND (OLD.status = 'done' OR abs(array_position(v_steps, NEW.status::text) - array_position(v_steps, OLD.status::text)) <> 1) THEN
      RAISE EXCEPTION 'a fulfilment moves one step at a time and done is final: % -> % refused', OLD.status, NEW.status USING ERRCODE = 'ET175';
    END IF;
    IF NEW.proof_upload_id IS DISTINCT FROM OLD.proof_upload_id
       AND (NEW.proof_upload_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.uploads u WHERE u.id = NEW.proof_upload_id AND u.kind = 'proof')) THEN
      RAISE EXCEPTION 'a fulfilment''s proof is an upload of kind proof, replaced but never removed' USING ERRCODE = 'ET175';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a fulfilment is changed only by the fulfilment functions (role %)', current_user USING ERRCODE = 'ET175';
END
$fn$;

CREATE OR REPLACE TRIGGER fulfillments_machine_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.fulfillments
  FOR EACH ROW EXECUTE FUNCTION public.fulfillments_machine_guard();

CREATE OR REPLACE TRIGGER fulfillments_machine_guard_truncate
  BEFORE TRUNCATE ON public.fulfillments
  FOR EACH STATEMENT EXECUTE FUNCTION public.fulfillments_machine_guard();

-- Anonymized rows (ET179), for EVERY writer, superusers included: once players.anonymized_at / orders.anonymized_at is set it
-- is never cleared and the row's personal columns never change again (the CHECKs players_anonymized_check /
-- orders_anonymized_check hold them empty; this keeps the mark itself), so no code path re-links a later buyer with the same
-- phone to the old rows. Only the erasure (pii_eraser) or a superuser (operations) sets the mark: a row anonymized by an app role
-- would be a deletion with no request and no audit. An anonymized order's money columns (status, paid / refunded stamps)
-- still move with payments; its player never changes (no later buyer is linked to it).
CREATE OR REPLACE FUNCTION public.anonymized_rows_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  -- What still moves on an anonymized row: an order's money and status columns (never its player: a later buyer of the same
  -- phone is never linked to it); nothing of a player but updated_at.
  v_moving CONSTANT text[] := CASE TG_TABLE_NAME
    -- US-033 EDIT: review_since moves with the status (orders_review_since), a payment of an erased order goes to review.
    WHEN 'orders' THEN ARRAY['status', 'paid_at', 'refunded_at', 'updated_at', 'snap_attempt_count', 'snap_redirect_url',
                             'snap_expires_at', 'mo_outbox_id', 'browser_mt_fired_at', 'review_since']
    ELSE ARRAY['updated_at'] END;
BEGIN
  IF OLD.anonymized_at IS NULL THEN
    IF NEW.anonymized_at IS NOT NULL AND current_user <> 'pii_eraser'
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper) THEN
      RAISE EXCEPTION '% rows are anonymized by the erasure of a deletion request only', TG_TABLE_NAME USING ERRCODE = 'ET179';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - v_moving) IS DISTINCT FROM (to_jsonb(OLD) - v_moving) THEN
    RAISE EXCEPTION 'an anonymized % row never gets personal data back', TG_TABLE_NAME USING ERRCODE = 'ET179';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER players_anonymized_guard
  BEFORE UPDATE ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.anonymized_rows_guard();

CREATE OR REPLACE TRIGGER orders_anonymized_guard
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.anonymized_rows_guard();

-- Deletion requests (ET176), for every writer but a superuser: never deleted; inserted pending; a pending request changes only
-- by its decision: rejected (the Owner, admin_rw, with a reason) or completed (inside the erasure only, pii_eraser); what was
-- requested (by whom, when, why, how the subject was identified, which phone) never changes, and a decided request never changes
-- again. SECURITY INVOKER: the guard must see the caller.
CREATE OR REPLACE FUNCTION public.deletion_requests_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper) THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD WHEN 'TRUNCATE' THEN NULL ELSE NEW END;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'deletion requests are never deleted' USING ERRCODE = 'ET176';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.summary <> '{}'::jsonb THEN
      RAISE EXCEPTION 'a deletion request is recorded pending' USING ERRCODE = 'ET176';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending'
     OR (NEW.id, NEW.requested_at, NEW.requested_by_admin_user_id, NEW.note, NEW.lookup_kind, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.requested_at, OLD.requested_by_admin_user_id, OLD.note, OLD.lookup_kind, OLD.created_at)
     OR (NEW.status = 'pending' AND (NEW.subject_phone, NEW.player_id, NEW.summary) IS DISTINCT FROM (OLD.subject_phone, OLD.player_id, OLD.summary))
     OR (NEW.status = 'completed' AND current_user <> 'pii_eraser')
     OR (NEW.status = 'rejected' AND (NEW.player_id IS DISTINCT FROM OLD.player_id OR NEW.summary <> '{}'::jsonb)) THEN
    RAISE EXCEPTION 'a deletion request changes only by its decision (rejected by the Owner, completed by the erasure), once' USING ERRCODE = 'ET176';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER deletion_requests_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.deletion_requests
  FOR EACH ROW EXECUTE FUNCTION public.deletion_requests_guard();

CREATE OR REPLACE TRIGGER deletion_requests_guard_truncate
  BEFORE TRUNCATE ON public.deletion_requests
  FOR EACH STATEMENT EXECUTE FUNCTION public.deletion_requests_guard();

-- The webhook dedupe survives the erasure (US-025 follow-up): the erasure keeps a subject's inbound WhatsApp rows but replaces
-- their message_id, which embeds the sender's chat id, by 'erased:' || the SHA-256 of it (sql/privacy.sql). A webhook that
-- delivers such a message again (WAHA retries for a while) finds no row by message_id, so this skips its INSERT, the same as the
-- route's ON CONFLICT DO NOTHING: it is never stored or processed a second time. One index lookup per webhook insert.
CREATE OR REPLACE FUNCTION public.waha_inbound_erased_dedupe()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM public.waha_inbound w
              WHERE w.message_id = 'erased:' || encode(sha256(convert_to(NEW.message_id, 'UTF8')), 'hex')) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER waha_inbound_erased_dedupe
  BEFORE INSERT ON public.waha_inbound
  FOR EACH ROW EXECUTE FUNCTION public.waha_inbound_erased_dedupe();

-- Midtrans data that arrives AFTER an erasure (a late notification, a refund or chargeback re-query: payments.ts writes the full
-- answer to payments.raw, the webhook route to payment_notifications.raw) is cut down for an anonymized order as the erasure cut
-- what was there (functions.sql payment_raw_kept), for every writer, so no customer_details come back. SECURITY DEFINER: the
-- webhook route (public_rw) cannot read orders.anonymized_at or midtrans_attempts.midtrans_order_id; it decides nothing about the
-- caller. Until US-033 routes such a payment to the Owner's review, a late settlement on an anonymized order fails closed in
-- payments.ts (docs/runbooks/privacy.md).
CREATE OR REPLACE FUNCTION public.payment_raw_erased_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- One branch per table: a record has only its own table's fields.
  IF TG_TABLE_NAME = 'payments' THEN
    IF EXISTS (SELECT 1 FROM public.orders o WHERE o.id = NEW.order_id AND o.anonymized_at IS NOT NULL) THEN
      NEW.raw := public.payment_raw_kept(NEW.raw);
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.midtrans_attempts ma JOIN public.orders o ON o.id = ma.order_id
                 WHERE ma.midtrans_order_id = NEW.midtrans_order_id AND o.anonymized_at IS NOT NULL) THEN
    NEW.raw := public.payment_raw_kept(NEW.raw);
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.payment_raw_erased_guard() FROM PUBLIC;

CREATE OR REPLACE TRIGGER payments_raw_erased_guard
  BEFORE INSERT OR UPDATE OF raw ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.payment_raw_erased_guard();

CREATE OR REPLACE TRIGGER payment_notifications_raw_erased_guard
  BEFORE INSERT OR UPDATE OF raw ON public.payment_notifications
  FOR EACH ROW EXECUTE FUNCTION public.payment_raw_erased_guard();
-- US-030 BLOCK END.

-- ---------------------------------------------------------------------------------------------
-- US-033 (M10c Owner review queue for orders) BLOCK BEGIN.
-- orders.review_since is the instant the order last ENTERED review, set here for every writer (the payment code, the
-- Owner's decision, a fixture): kept while the order stays in review, NULL in any other status. A value written by hand
-- is replaced (the trigger also fires on the column itself), and orders_review_since_check pins the pairing.
CREATE OR REPLACE FUNCTION public.orders_review_since()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.status <> 'review' THEN
    NEW.review_since := NULL;
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'review' THEN
    NEW.review_since := OLD.review_since;
  ELSE
    NEW.review_since := clock_timestamp();
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.orders_review_since() FROM PUBLIC;

CREATE OR REPLACE TRIGGER orders_review_since
  BEFORE INSERT OR UPDATE OF status, review_since ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_review_since();

-- The Owner's decision ledger is append-only for EVERY writer, and only public.order_review_decide writes it (ET187):
-- that function is SECURITY DEFINER owned by the NOLOGIN, member-less role order_review (roles.sql), so inside it
-- current_user is order_review, which no login can be and no session can SET ROLE to. SECURITY INVOKER for that reason.
CREATE OR REPLACE FUNCTION public.order_owner_decisions_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' AND current_user = 'order_review' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the Owner''s decision ledger is append-only and written by order_review_decide only: % rejected', TG_OP USING ERRCODE = 'ET187';
END
$fn$;
REVOKE ALL ON FUNCTION public.order_owner_decisions_guard() FROM PUBLIC;

CREATE OR REPLACE TRIGGER order_owner_decisions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.order_owner_decisions
  FOR EACH ROW EXECUTE FUNCTION public.order_owner_decisions_guard();

CREATE OR REPLACE TRIGGER order_owner_decisions_guard_truncate
  BEFORE TRUNCATE ON public.order_owner_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.order_owner_decisions_guard();

-- The console's outbox rows (security review US-033): admin_rw INSERTs outbox rows for exactly two jobs, the template
-- test-send (core TEST_SEND_TOPIC) and the Owner's "re-query Midtrans now", each under a dedupe key of its own topic
-- (`<topic>:...`). Any other topic, or a key outside its topic, is refused (ET189): dedupe_key is unique across ALL topics,
-- so with a free INSERT a console session could take another job's predictable key first (e.g. order.paid:<order id>, under
-- any topic) and so suppress the payment code's own row (ON CONFLICT DO NOTHING) and its nudge, make enqueue_mo fail, or
-- block a link resend. US-031 adds 'admin.password_hibp_check' to this list, under the same key rule. The caller is a member
-- of admin_rw (the console logs in as its own login role, so current_user is never the group's name); a superuser passes
-- every pg_has_role check and is excluded explicitly (the migrate job, the test harnesses, repairs by hand). No login is a
-- member of two groups (preflight.sql ET091), so a worker login is never taken for the console. SECURITY INVOKER: the guard
-- must see the caller.
CREATE OR REPLACE FUNCTION public.outbox_admin_topic_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF (NEW.topic NOT IN ('template.test_send', 'payment.requery') OR NOT starts_with(NEW.dedupe_key, NEW.topic || ':'))
     AND pg_has_role(current_user, 'admin_rw', 'USAGE')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper) THEN
    RAISE EXCEPTION 'the console may not enqueue outbox topic % under that key', NEW.topic USING ERRCODE = 'ET189';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.outbox_admin_topic_guard() FROM PUBLIC;

CREATE OR REPLACE TRIGGER outbox_admin_topic_guard
  BEFORE INSERT ON public.outbox
  FOR EACH ROW EXECUTE FUNCTION public.outbox_admin_topic_guard();
-- US-033 BLOCK END.

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
