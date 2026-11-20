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
-- ET045 winner confirmation reserved for admin, ET046 program status change reserved for admin,
-- ET050 play row for a player not eligible on a published program, ET051 question/option not in
-- the attempt's set/question, ET060 settings_secrets relabelled without re-encryption,
-- ET061 settings_secrets id change, ET047 program field locked after its first PAID order
-- (product, slug, sales start, trivia set count / order), ET048 reschedule of a locked program
-- that is not an extension, or of an ended program, ET062 SMTP / WAHA secret bound to another host than its endpoint,
-- ET049 a Midtrans attempt whose midtrans_order_id is not {public_id}-{n} of its order.
-- ET080 a delivery / MT conversion row of an unpaid order, ET081 orders.paid_at / refunded_at changed
-- once set, ET082 a fulfillment change of a flagged or revoked winner (US-021).

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
-- Trusted writers are exempt (the worker finalizes attempts of players refunded meanwhile; the
-- Owner override's re-score, running as trivia_override, rewrites the scores of every affected player).
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
     OR pg_has_role(current_user, 'migrator', 'USAGE')
     OR current_user = 'trivia_override' THEN
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
     OR pg_has_role(current_user, 'migrator', 'USAGE')
     OR current_user = 'trivia_override' THEN
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
     OR pg_has_role(current_user, 'migrator', 'USAGE')
     OR current_user = 'trivia_override' THEN
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
-- then see the snapshot and refuse, ET022 / ET072). The grace-end sweeper (M9) must also take the
-- lock BEFORE it reads the stats it freezes. SECURITY DEFINER: the lock is taken whoever inserts.
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
