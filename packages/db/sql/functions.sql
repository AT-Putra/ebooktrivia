-- functions.sql: SECURITY DEFINER entry points (applied as migrator, so migrator owns them).
--
-- Rules for every function here and in triggers.sql:
--   * SET search_path = pg_catalog, pg_temp. `public` is NOT on the path: a function or operator
--     planted in public with a better-matching signature would otherwise win an unqualified call
--     and run with the definer's rights. pg_temp is listed last on purpose (it is never searched
--     for functions or operators, and for relations/types only after pg_catalog);
--   * so every object of ours is schema-qualified (public.<table>, public.<function>,
--     public.<enum type>), and every unqualified name is a pg_catalog builtin;
--   * EXECUTE revoked from PUBLIC (below, and again in grants.sql), granted per role in grants.sql;
--   * targets are derived from DB rows only; callers pass ids, never payloads;
--   * time comes from clock_timestamp(), never now(): now() is frozen at transaction start, so a
--     caller holding a transaction open could backdate what it writes.
--
-- Custom SQLSTATEs (class ET). The app maps ET001 and ET002 to one generic OTP response.
--   ET001 enqueue_otp: phone not eligible       ET002 enqueue_otp: per-phone cap exceeded
--   ET003 enqueue_otp: OTP row not found        ET004 enqueue_otp: OTP expired
--   ET005 enqueue_otp: isolation level is not READ COMMITTED (the cap check would race)
--   ET009 setting missing or not a positive integer
--   ET010 enqueue_*: source row not found       ET011 enqueue_mo: order has no Snap redirect URL
--   triggers.sql: ET020/ET021 content lock, ET030/ET031 audit_log, ET040-ET044 orders,
--   ET045 winners, ET046 programs, ET050/ET051 play rows, ET060/ET061 settings_secrets,
--   ET071/ET072 prize tiers, ET073/ET074 legal pages;
--   override.sql: ET022 override after the results snapshot or the end of grace, ET023 override
--   arguments out of scope (ids, reason, actor);
--   roles.sql: ET090 foreign-owned object.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

-- Positive integer from app_settings; fails closed when missing or malformed. Executable by
-- public_rw (the orders checkout guard runs as the caller and reads orders.expiry_seconds).
CREATE OR REPLACE FUNCTION public.setting_positive_int(p_key text)
  RETURNS integer
  LANGUAGE plpgsql
  STABLE
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v jsonb;
BEGIN
  SELECT s.value INTO v FROM public.app_settings s WHERE s.key = p_key;
  IF v IS NULL
     OR jsonb_typeof(v) <> 'number'
     OR (v #>> '{}')::numeric <= 0
     OR (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) THEN
    RAISE EXCEPTION 'setting % is missing or not a positive integer', p_key USING ERRCODE = 'ET009';
  END IF;
  RETURN (v #>> '{}')::integer;
END
$fn$;

-- Enqueue the WhatsApp send of an OTP the app stored in player_otps (mac + sealed code).
-- Enforces in SQL: (a) the phone belongs to a player eligible for at least one program;
-- (b) at most `otp.phone_cap` enqueues per phone within `otp.phone_window_seconds` (sliding
-- window over otp_enqueues, a ledger no app role can write). Idempotent per otp_id.
CREATE OR REPLACE FUNCTION public.enqueue_otp(p_otp_id uuid)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_phone text;
  v_sealed bytea;
  v_expires timestamptz;
  v_now timestamptz;
  v_cap integer;
  v_window integer;
  v_recent integer;
  v_outbox uuid;
BEGIN
  -- The cap count must see every committed enqueue. Only READ COMMITTED gives each statement a
  -- fresh snapshot after the lock below; REPEATABLE READ and SERIALIZABLE would count on an old
  -- snapshot (and SSI does not see READ COMMITTED writers).
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'enqueue_otp must run under READ COMMITTED' USING ERRCODE = 'ET005';
  END IF;

  SELECT o.phone, o.sealed_code, o.expires_at INTO v_phone, v_sealed, v_expires
    FROM public.player_otps o
   WHERE o.id = p_otp_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'otp not found' USING ERRCODE = 'ET003';
  END IF;

  -- One enqueue at a time per phone (held until the caller's transaction ends).
  PERFORM pg_advisory_xact_lock(hashtextextended('enqueue_otp:' || v_phone, 0::bigint));
  v_now := clock_timestamp();

  SELECT e.outbox_id INTO v_outbox FROM public.otp_enqueues e WHERE e.otp_id = p_otp_id;
  IF FOUND THEN
    RETURN v_outbox; -- already enqueued: never sent or counted twice
  END IF;

  IF v_expires <= v_now THEN
    RAISE EXCEPTION 'otp expired' USING ERRCODE = 'ET004';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.players p
      JOIN public.player_programs pp ON pp.player_id = p.id
     WHERE p.phone = v_phone AND pp.eligible
  ) THEN
    RAISE EXCEPTION 'phone not eligible' USING ERRCODE = 'ET001';
  END IF;

  v_cap := public.setting_positive_int('otp.phone_cap');
  v_window := public.setting_positive_int('otp.phone_window_seconds');
  SELECT count(*) INTO v_recent
    FROM public.otp_enqueues e
   WHERE e.phone = v_phone
     AND e.enqueued_at > v_now - make_interval(secs => v_window);
  IF v_recent >= v_cap THEN
    RAISE EXCEPTION 'otp cap exceeded' USING ERRCODE = 'ET002';
  END IF;

  INSERT INTO public.outbox (topic, dedupe_key, payload, sealed)
  VALUES (
    'otp.send',
    'otp.send:' || p_otp_id::text,
    jsonb_build_object('otp_id', p_otp_id, 'phone', v_phone, 'expires_at', v_expires),
    v_sealed
  )
  RETURNING id INTO v_outbox;

  INSERT INTO public.otp_enqueues (otp_id, phone, outbox_id, enqueued_at)
  VALUES (p_otp_id, v_phone, v_outbox, v_now);
  RETURN v_outbox;
END
$fn$;

-- Enqueue processing of a Midtrans notification already stored in the inbox.
CREATE OR REPLACE FUNCTION public.enqueue_notification(p_inbox_id uuid)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_midtrans_order_id text;
  v_outbox uuid;
BEGIN
  SELECT n.midtrans_order_id, n.outbox_id INTO v_midtrans_order_id, v_outbox
    FROM public.payment_notifications n
   WHERE n.id = p_inbox_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment notification not found' USING ERRCODE = 'ET010';
  END IF;
  IF v_outbox IS NOT NULL THEN
    RETURN v_outbox;
  END IF;

  INSERT INTO public.outbox (topic, dedupe_key, payload)
  VALUES (
    'payment.notification',
    'payment.notification:' || p_inbox_id::text,
    jsonb_build_object('inbox_id', p_inbox_id, 'midtrans_order_id', v_midtrans_order_id)
  )
  RETURNING id INTO v_outbox;

  UPDATE public.payment_notifications n SET outbox_id = v_outbox WHERE n.id = p_inbox_id;
  RETURN v_outbox;
END
$fn$;

-- Enqueue handling of an inbound WhatsApp message (buyer-first). The worker re-fetches the
-- message from WAHA by message_id before acting.
CREATE OR REPLACE FUNCTION public.enqueue_waha_inbound(p_inbound_id uuid)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_message_id text;
  v_outbox uuid;
BEGIN
  SELECT w.message_id, w.outbox_id INTO v_message_id, v_outbox
    FROM public.waha_inbound w
   WHERE w.id = p_inbound_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'waha inbound message not found' USING ERRCODE = 'ET010';
  END IF;
  IF v_outbox IS NOT NULL THEN
    RETURN v_outbox;
  END IF;

  INSERT INTO public.outbox (topic, dedupe_key, payload)
  VALUES (
    'waha.inbound',
    'waha.inbound:' || p_inbound_id::text,
    jsonb_build_object('inbound_id', p_inbound_id, 'message_id', v_message_id)
  )
  RETURNING id INTO v_outbox;

  UPDATE public.waha_inbound w SET outbox_id = v_outbox WHERE w.id = p_inbound_id;
  RETURN v_outbox;
END
$fn$;

-- Enqueue the MO conversion of an order, only after Snap succeeded (redirect URL stored).
-- At most once per order: orders.mo_outbox_id is writable only here.
CREATE OR REPLACE FUNCTION public.enqueue_mo(p_order_id uuid)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_redirect text;
  v_outbox uuid;
BEGIN
  SELECT o.snap_redirect_url, o.mo_outbox_id INTO v_redirect, v_outbox
    FROM public.orders o
   WHERE o.id = p_order_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found' USING ERRCODE = 'ET010';
  END IF;
  IF v_outbox IS NOT NULL THEN
    RETURN v_outbox;
  END IF;
  IF v_redirect IS NULL THEN
    RAISE EXCEPTION 'order has no Snap redirect URL yet' USING ERRCODE = 'ET011';
  END IF;

  INSERT INTO public.outbox (topic, dedupe_key, payload)
  VALUES ('conversion.mo', 'conversion.mo:' || p_order_id::text, jsonb_build_object('order_id', p_order_id))
  RETURNING id INTO v_outbox;

  UPDATE public.orders o SET mo_outbox_id = v_outbox WHERE o.id = p_order_id;
  RETURN v_outbox;
END
$fn$;

-- Payment-scope secrets only, still sealed (decryption happens in the app with the payment
-- private key). The only way public_rw can read settings_secrets.
CREATE OR REPLACE FUNCTION public.get_payment_secret()
  RETURNS TABLE (
    id uuid,
    name text,
    ciphertext bytea,
    nonce bytea,
    sealed_dek bytea,
    key_id text,
    bound_host text,
    updated_at timestamptz
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
  -- adnet_id IS NULL: callers rebuild the AAD with adnet null (settings_secrets_binding_check
  -- already guarantees it for payment rows; this keeps the function correct on its own).
  SELECT s.id, s.name, s.ciphertext, s.nonce, s.sealed_dek, s.key_id, s.bound_host, s.updated_at
    FROM public.settings_secrets s
   WHERE s.scope = 'payment' AND s.adnet_id IS NULL
   ORDER BY s.name;
$fn$;

-- Admin login throttle housekeeping (US-016), run by the worker's minute sweepers: deletes
-- admin_auth.login_throttle rows whose window and lock are both over. The window is the caller's
-- (@ebooktrivia/db LOGIN_THROTTLE_WINDOW_SECONDS, the same constant the admin app counts with); it
-- must be at least 15 minutes, so a caller cannot sweep windows that are still counting (ET070).
-- Rows counting consecutive second-factor failures, or hard-locked, stay: deleting them would reset
-- the long-term budget. worker_rw has no other access to admin_auth; this function is its only way
-- in, and it can only delete spent rows. (Migration 0006 drops the earlier argument-less version.)
CREATE OR REPLACE FUNCTION public.sweep_login_throttle(p_window_seconds integer)
  RETURNS integer
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  IF p_window_seconds IS NULL OR p_window_seconds < 900 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'sweep_login_throttle: window must be 900..86400 seconds' USING ERRCODE = 'ET070';
  END IF;
  DELETE FROM admin_auth.login_throttle
   WHERE window_started_at <= clock_timestamp() - make_interval(secs => p_window_seconds)
     AND (locked_until IS NULL OR locked_until <= clock_timestamp())
     AND consecutive = 0
     AND hard_locked_at IS NULL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$fn$;

-- The per-program CONTEST LOCK (US-018): one transaction-scoped advisory lock key per program, in
-- two modes. Held to commit, so these never interleave:
--   EXCLUSIVE (lock_program_contest): whatever changes the rules or freezes the result:
--     - the Owner's locked-field override and its re-score (override_question_scoring);
--     - prize tier edits (prize_tiers_guard) and the results snapshot (leaderboard_snapshots_lock);
--     - REQUIRED FOR M9: the grace-end finalize and snapshot sweeper, BEFORE it reads the stats it
--       freezes.
--   SHARED (lock_program_contest_shared): play, which only applies the current rules. Players do not
--   block each other, and all of them wait for (and are waited for by) an exclusive holder:
--     - REQUIRED FOR M9: attempt start, serve and the answer path call it BEFORE they read anything
--       they score with (correctness, points, timer), in the same transaction. The answer path
--       records answered_at (clock_timestamp(), truncated to milliseconds) BEFORE it waits for the
--       lock, so a re-score running meanwhile never costs the player time; it then scores with the
--       rules as they are after that re-score. Without the lock a re-score could be overwritten by
--       an answer scored with the old rules.
-- A hash collision between two programs only serialises them. SECURITY INVOKER (pg_catalog's
-- advisory lock functions are executable by everyone); EXECUTE per role in grants.sql (the M9
-- grants to public_rw / worker_rw come with M9).
CREATE OR REPLACE FUNCTION public.lock_program_contest(p_program_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  VOLATILE
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('program_contest:' || p_program_id::text, 0));
END
$fn$;

CREATE OR REPLACE FUNCTION public.lock_program_contest_shared(p_program_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  VOLATILE
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('program_contest:' || p_program_id::text, 0));
END
$fn$;

-- The per-answer scoring rule (US-018), THE same rule as @ebooktrivia/core rescore.ts scoreAnswer
-- (apps/admin test/rescore-oracle.int.test.ts checks them against each other on random inputs).
-- Used by override_question_scoring; M9's answer path and finalize must use it too. All in whole
-- milliseconds (answer timestamps are whole ms, CHECK), with raw = answered - served (0 if
-- negative), timer = p_timer_seconds in ms, shown = deadline - served when a deadline was shown,
-- cap = the smaller of timer and shown:
--   answered_at NULL                          -> (NULL, 0, NULL)  pending
--   served_at NULL                            -> (false, 0, timer) never shown: the full timer
--   no pick, or raw > cap + 1500 ms (late)    -> (false, 0, min(raw, cap))
--   otherwise                                 -> (pick = correct option, points if correct, min(raw, cap))
-- Elapsed never exceeds the deadline the player was shown, so lengthening a timer neither rewards a
-- late pick nor adds time to a SERVED timeout; an unserved row (served_at NULL) counts the current
-- timer, so it does gain time. IMMUTABLE: only interval arithmetic between the arguments.
CREATE OR REPLACE FUNCTION public.score_answer(
  p_points integer,
  p_timer_seconds integer,
  p_correct_option_id uuid,
  p_option_id uuid,
  p_served_at timestamptz,
  p_deadline_at timestamptz,
  p_answered_at timestamptz,
  OUT correct boolean,
  OUT points integer,
  OUT elapsed_ms integer
)
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT
    CASE
      WHEN p_answered_at IS NULL THEN NULL
      WHEN p_served_at IS NULL OR p_option_id IS NULL OR x.raw > x.cap + 1500 THEN false
      ELSE coalesce(p_option_id = p_correct_option_id, false)
    END,
    CASE
      WHEN p_answered_at IS NULL OR p_served_at IS NULL OR p_option_id IS NULL OR x.raw > x.cap + 1500 THEN 0
      WHEN p_option_id = p_correct_option_id THEN p_points
      ELSE 0
    END,
    CASE
      WHEN p_answered_at IS NULL THEN NULL
      WHEN p_served_at IS NULL THEN x.timer
      ELSE LEAST(x.raw, x.cap)
    END::integer
  FROM (
    SELECT p_timer_seconds::bigint * 1000 AS timer,
           GREATEST(0, (extract(epoch FROM p_answered_at - p_served_at) * 1000)::bigint) AS raw,
           LEAST(p_timer_seconds::bigint * 1000, (extract(epoch FROM p_deadline_at - p_served_at) * 1000)::bigint) AS cap
  ) x
$fn$;

REVOKE ALL ON FUNCTION public.setting_positive_int(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.score_answer(integer, integer, uuid, uuid, timestamptz, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_program_contest(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_program_contest_shared(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sweep_login_throttle(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_otp(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_notification(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_waha_inbound(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_mo(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_payment_secret() FROM PUBLIC;
