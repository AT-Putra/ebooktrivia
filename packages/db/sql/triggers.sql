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
-- the attempt's set/question, ET060 settings_secrets relabelled without re-encryption,
-- ET061 settings_secrets id change, ET047 program field locked after its first PAID order
-- (product, slug, sales start, trivia set count / order), ET048 reschedule of a locked program
-- that is not an extension, or of an ended program, ET062 SMTP / WAHA secret bound to another host than its endpoint.

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
