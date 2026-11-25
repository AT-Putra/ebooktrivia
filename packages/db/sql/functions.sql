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
--   ET006 enqueue_otp: the OTP row holds no sealed code (never set, or already moved to the outbox)
--   ET009 setting missing or not a positive integer
--   ET010 enqueue_*: source row not found       ET011 enqueue_mo: order has no Snap redirect URL
--   ET084 refire_conversion (sql/conversions.sql): the row cannot be re-fired
--   triggers.sql: ET020/ET021 content lock, ET030/ET031 audit_log, ET040-ET044 orders,
--   ET045 winners, ET046 programs, ET050/ET051 play rows, ET060/ET061 settings_secrets,
--   ET071/ET072 prize tiers, ET073/ET074 legal pages, ET080-ET082 payment effects and the fulfillment
--   halt (US-021);
--   override.sql: ET022 override after the results snapshot or the end of grace, ET023 override
--   arguments out of scope (ids, reason, actor);
--   contest.sql (US-028): ET100 not READ COMMITTED, ET101 arguments out of scope (ids, outage
--   start, reason, actor), ET102 the contest is not in the state the call needs (no snapshot yet,
--   already confirmed, ended), ET103 the grace end (+ settle) has not passed yet or a question is
--   still running, ET107 a winner is no longer eligible (refunded since the snapshot) or flagged;
--   triggers.sql ET104 the results snapshot is immutable, ET105 winners are immutable (and
--   consistent with their snapshot), ET106 a deadline extension written outside the Owner's tool,
--   ET108-ET110 play timestamps (set by the database; a pick after the deadline; play after the
--   grace end), ET111 the deadline extension ledger is append-only;
--   triggers.sql ET130 (US-025) a delivery that went out (or may have) put back on the send path, ET131 an opener sent again;
--   sql/delivery-resend.sql ET132 an unknown delivery resent without confirmation, ET133 a delivery that is not failed or unknown, ET134 a delivery whose lease has not ended;
--   roles.sql: ET090 foreign-owned object.
--   US-026 (player authentication, below): ET120 issue_magic_link arguments out of scope (channel, token
--   hash), ET121 the player may not log in (unknown, anonymized, eligible for no program), ET122 a
--   player_auth user that holds the player's phone is linked to another player.
--   play.sql (US-027, the question flow): ET140-ET148 (listed there); enqueue_magic_link_resend (below) ET146.
--   US-030 (prize fulfilment, UU PDP deletion = anonymization): ET170 not READ COMMITTED, ET171 arguments out of scope
--   (ids, actor not an active Owner, reason, notes, proof upload, typed confirmation), ET172 a fulfilment move that is not
--   exactly one step, out of done, from a stale status, or for a winner that is not a confirmed winner of a finalized
--   program (fulfillment.sql), ET173 a revoke or reinstatement the winner's or program's state does not allow, or of a
--   delivered prize (contest.sql), ET174 a reinstated winner is no longer eligible or was erased (contest.sql),
--   ET177 an erasure refused: the subject holds a prize not delivered yet, ET178 an erasure refused: an order of the subject
--   is pending or in review, or a send to the subject is in flight (privacy.sql); triggers.sql ET175 a fulfilment written
--   outside the fulfilment functions or off its machine, ET176 a deletion request changed once decided (or completed
--   outside the erasure; also privacy.sql: a rejected request executed), ET179 an anonymized row given personal data again.
--   US-033 (the Owner's review queue for orders): sql/order-review.sql ET180 not READ COMMITTED or the decision / ids out of
--   scope, ET181 a reason that is not 10-500 characters or holds contact details, ET182 the actor is not an active Owner,
--   ET183 unknown order, ET184 a request key already used for another decision, ET185 the typed confirmation does not match,
--   ET186 the order is no longer in review; triggers.sql ET187 the decision ledger is append-only (written by order_review
--   only); the shared effects below ET188 arguments out of scope; triggers.sql ET189 an outbox topic the console does not enqueue.

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
-- window over otp_enqueues, a ledger no app role can write); (c) US-026, the global send breaker: at
-- most `otp.global_send_cap` enqueues over ALL phones within 10 minutes. Over (c) nothing is enqueued,
-- a critical alert is written (once an hour while it lasts; it must commit with the caller, so (c) is
-- NOT an error) and NULL is returned: the caller then keeps no live code. Idempotent per otp_id.
-- The sealed code is MOVED (US-026): copied into the outbox row and set NULL in player_otps, so after
-- the worker's wipe of the outbox copy only the HMAC is left in the database.
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
  v_global integer;
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
  IF v_sealed IS NULL THEN
    RAISE EXCEPTION 'otp has no sealed code' USING ERRCODE = 'ET006';
  END IF;

  -- US-030: the player of the phone FOR SHARE first (after the phone's advisory lock; the erasure takes no such lock, so the
  -- order cannot cycle). An erasure of this player (sql/privacy.sql locks it FOR UPDATE) either committed before, and the phone is
  -- gone (not eligible), or waits for this transaction and then finds its OTP job live and refuses (ET178), so no code is sent
  -- to, and no contact key recorded for, a subject being erased.
  PERFORM 1 FROM public.players p WHERE p.phone = v_phone FOR SHARE;
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

  -- (c) The global breaker (US-026), counted one enqueue at a time over all phones (this lock is always
  -- taken after the phone's). A burst far above the normal login rate is abuse or a bug, and every
  -- message puts the WhatsApp numbers at risk: stop sending and tell the Owner.
  PERFORM pg_advisory_xact_lock(hashtextextended('enqueue_otp:global', 0::bigint));
  v_global := public.setting_positive_int('otp.global_send_cap');
  IF (SELECT count(*) FROM public.otp_enqueues e WHERE e.enqueued_at > v_now - interval '10 minutes') >= v_global THEN
    INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload)
    SELECT 'monitor', 'otp_send_breaker', 'critical', 'otp_send_breaker',
           'OTP sends stopped: the global ceiling otp.global_send_cap (codes per 10 minutes) was reached',
           jsonb_build_object('cap_per_10_minutes', v_global)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.alerts a
        WHERE a.dedupe_key = 'otp_send_breaker' AND a.resolved_at IS NULL AND a.created_at > v_now - interval '1 hour');
    RETURN NULL;
  END IF;

  INSERT INTO public.outbox (topic, dedupe_key, payload, sealed)
  VALUES (
    'otp.send',
    'otp.send:' || p_otp_id::text,
    jsonb_build_object('otp_id', p_otp_id, 'phone', v_phone, 'expires_at', v_expires),
    v_sealed
  )
  RETURNING id INTO v_outbox;
  UPDATE public.player_otps SET sealed_code = NULL WHERE id = p_otp_id;

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
--     - the grace-end finalize and snapshot (contest.sql create_leaderboard_snapshot, US-028), the
--       Owner's winner confirmation and deadline extension (confirm_program_winners,
--       extend_open_question_deadlines), each BEFORE it reads what it decides on.
--   SHARED (lock_program_contest_shared): play, which only applies the current rules. Players do not
--   block each other, and all of them wait for (and are waited for by) an exclusive holder:
--     - attempt start, serve and the answer path: the play guards (triggers.sql) take it for every
--       write of a play row by the US-027 play functions (sql/play.sql, owned by trivia_play), BEFORE
--       they read anything they decide on; the play functions never take it themselves (US-027 contract,
--       revised). The guard records the arrival (clock_timestamp(), truncated to milliseconds) BEFORE it
--       waits for the lock, so a re-score running meanwhile never costs the player time; the pick is
--       then scored with the rules as they are after that re-score. A play row locked first and an
--       exclusive holder's row locks can deadlock; PostgreSQL then aborts one (40P01) and the public
--       app retries the play call once.
-- A hash collision between two programs only serialises them. SECURITY INVOKER (pg_catalog's
-- advisory lock functions are executable by everyone); EXECUTE per role in grants.sql.
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
-- Used by override_question_scoring and the grace-end finalize (contest.sql); M9's answer path must
-- use it too. All in whole milliseconds (answer timestamps are whole ms, CHECK), with raw =
-- answered - served (0 if negative), timer = p_timer_seconds in ms, ext = p_extension_ms (what the
-- Owner's outage extension added to the deadline, attempt_questions.deadline_extension_ms, US-028),
-- shown = deadline - served - ext when a deadline was shown, cap = the smaller of timer and shown:
--   answered_at NULL                               -> (NULL, 0, NULL)  pending
--   served_at NULL                                 -> (false, 0, timer) never shown: the full timer
--   no pick, or raw > cap + ext + 1500 ms (late)   -> (false, 0, min(raw, cap))
--   otherwise                                      -> (pick = correct option, points if correct, min(raw, cap))
-- Elapsed never exceeds the deadline the player was served with, so lengthening a timer neither
-- rewards a late pick nor adds time to a SERVED timeout, and an extension lets a pick count without
-- lowering the time charged; an unserved row (served_at NULL) counts the current timer, so it does
-- gain time. IMMUTABLE: only interval arithmetic between the arguments. US-028's migration dropped
-- the 7-argument version (no extension), so every caller passes the extension.
CREATE OR REPLACE FUNCTION public.score_answer(
  p_points integer,
  p_timer_seconds integer,
  p_correct_option_id uuid,
  p_option_id uuid,
  p_served_at timestamptz,
  p_deadline_at timestamptz,
  p_answered_at timestamptz,
  p_extension_ms integer,
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
      WHEN p_served_at IS NULL OR p_option_id IS NULL OR x.raw > x.cap + x.ext + 1500 THEN false
      ELSE coalesce(p_option_id = p_correct_option_id, false)
    END,
    CASE
      WHEN p_answered_at IS NULL OR p_served_at IS NULL OR p_option_id IS NULL OR x.raw > x.cap + x.ext + 1500 THEN 0
      WHEN p_option_id = p_correct_option_id THEN p_points
      ELSE 0
    END,
    CASE
      WHEN p_answered_at IS NULL THEN NULL
      WHEN p_served_at IS NULL THEN x.timer
      ELSE LEAST(x.raw, x.cap)
    END::integer
  FROM (
    SELECT y.timer, y.raw, y.ext,
           LEAST(y.timer, (extract(epoch FROM p_deadline_at - p_served_at) * 1000)::bigint - y.ext) AS cap
      FROM (
        SELECT p_timer_seconds::bigint * 1000 AS timer,
               GREATEST(0, (extract(epoch FROM p_answered_at - p_served_at) * 1000)::bigint) AS raw,
               coalesce(p_extension_ms, 0)::bigint AS ext
      ) y
  ) x
$fn$;

-- Masking (AC-Q2, AC-A9), THE same rules as @ebooktrivia/core contest.ts maskName / maskPhone
-- (apps/admin test/contest-oracle.int.test.ts checks them against each other): every word of a name
-- (split on ASCII whitespace) keeps its first character, then "***" ("***" when there is no word);
-- a phone shows "****" and its last 3 digits (NULL stays NULL: an anonymized player). Fixed-length
-- masks. Used by the banner read path (contest.sql program_winners_banner), which therefore never
-- returns a raw name or phone.
CREATE OR REPLACE FUNCTION public.mask_name(p_name text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT coalesce(string_agg(left(t.w, 1) || '***', ' ' ORDER BY t.n), '***')
    FROM regexp_split_to_table(coalesce(p_name, ''), '[\t\n\v\f\r ]+') WITH ORDINALITY AS t(w, n)
   WHERE t.w <> ''
$fn$;

CREATE OR REPLACE FUNCTION public.mask_phone(p_phone text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE WHEN p_phone IS NULL THEN NULL ELSE '****' || right(regexp_replace(p_phone, '[^0-9]', '', 'g'), 3) END
$fn$;

-- A player as the OTHER players see them (Owner decision 2026-11-25: the trivia leaderboard and the winners banner show the
-- WhatsApp number, its last 4 digits hidden): the Indonesian local form, grouped 4 / the rest / 4, "0812-3456-****" for
-- +6281234567890. A number outside +62 keeps its own digits; a short one hides its last 4; no phone (an anonymized player): '***'.
-- The same grouping as the profile's full number (apps/public lib/format.ts formatPhoneLocal).
CREATE OR REPLACE FUNCTION public.mask_phone_tail(p_phone text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE
           WHEN l IS NULL OR length(l) < 6 THEN '***'
           WHEN length(l) <= 8 THEN left(l, length(l) - 4) || '-****'
           ELSE left(l, 4) || '-' || substr(l, 5, length(l) - 8) || '-****'
         END
    FROM (SELECT CASE WHEN d LIKE '62%' THEN '0' || substr(d, 3) ELSE d END AS l
            FROM (SELECT nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '') AS d) AS digits) AS local
$fn$;

-- ===== US-022: order status page (order.<dom>/{publicId}) ========================================
-- public_rw has column grants on orders (never the buyer's name or e-mail, order_code or
-- browser_mt_fired_at), so the page reads and claims through these two narrow entry points. Both
-- take the order's public_id (the page's capability) and return only what the page needs.
--
-- get_order_status: one row for the order, none for an unknown id (the caller answers a malformed id
-- the same way). The buyer's personal data never leaves the database raw: the name and phone come back
-- ONLY as public.mask_name / public.mask_phone_tail ("0812-3456-****", the one masked form of a number, shared with
-- the leaderboard, the winners banner and the login label), and the e-mail is not returned at all. `order_code` is the code
-- the page shows and puts in the WhatsApp message. `pixels` is the landing page's registered browser
-- pixel ids (jsonb), checked by the app against the vendors' id formats; the page's CSP is built from
-- it, and the ids themselves reach a browser only through claim_browser_mt. `lp_host` is the landing
-- page's primary host, its first registered domain (the page's "order again" link goes back to the page
-- the buyer came from), null when it has none.
-- The phone is masked like on the trivia board and the winners banner (mask_phone_tail, "0812-3456-****"; the Owner's decision of
-- 2026-11-25, security review L1): one rule wherever someone else may see a number, so two views of one buyer never add up to more.
-- Accepted deviation (security review US-022 L1): public_rw can enumerate, through a LATERAL call over
-- orders.public_id, which it already reads (checkout dedupe also reads buyer_phone), every order's code,
-- masks and status. An order code alone grants nothing: the WhatsApp claim (US-025) needs the sender's
-- phone to match the order's, and the page data is masked.
-- The return type changed while US-022 was being built, and CREATE OR REPLACE cannot change it: the
-- function is dropped only when its result is not the one below, so a database that applied an earlier
-- shape re-runs, and a normal migrate never drops it (a drop would be a window in which the page 503s).
DO $do$
BEGIN
  IF pg_catalog.to_regprocedure('public.get_order_status(text)') IS NOT NULL
     AND pg_catalog.pg_get_function_result(pg_catalog.to_regprocedure('public.get_order_status(text)'))
         <> 'TABLE(status text, order_code text, masked_name text, masked_phone text, product_title text, amount_idr bigint, pixels jsonb, lp_host text)' THEN
    DROP FUNCTION public.get_order_status(text);
  END IF;
END
$do$;
CREATE OR REPLACE FUNCTION public.get_order_status(p_public_id text)
  RETURNS TABLE (status text, order_code text, masked_name text, masked_phone text, product_title text, amount_idr bigint, pixels jsonb, lp_host text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT o.status::text, o.order_code, public.mask_name(o.buyer_name), public.mask_phone_tail(o.buyer_phone), pr.title, o.amount_idr, lp.pixels,
         (SELECT d.host FROM public.lp_domains d WHERE d.landing_page_id = lp.id ORDER BY d.created_at, d.id LIMIT 1)
    FROM public.orders o
    JOIN public.products pr ON pr.id = o.product_id
    JOIN public.landing_pages lp ON lp.id = o.landing_page_id
   WHERE o.public_id = p_public_id
$fn$;

-- claim_browser_mt: the exactly-once claim of the browser MT pixel. One conditional UPDATE: the order
-- must be PAID, paid within the last hour, and not yet claimed, and the row lock makes a second
-- concurrent caller wait, re-check the condition on the committed row (a refund that committed meanwhile
-- included) and get no row. It returns the one row to the winner only: the pixel contract's values
-- (event_id = orders.event_id, transaction_id = orders.id, the amount) and the landing page's pixel ids.
-- public_rw has no UPDATE on browser_mt_fired_at (grants.sql), so this is the only way to set it, and
-- nothing can clear it. The claim is a bearer action (whoever holds the public id can make it), so it
-- expires an hour after payment: a later visitor gets nothing, and the server-side conversion with the
-- same event_id covers the order. It is at most once for the browser: a claimer that never fires (tab
-- closed) is covered the same way. orders.updated_at is not touched: the claim is not a change of the order.
CREATE OR REPLACE FUNCTION public.claim_browser_mt(p_public_id text)
  RETURNS TABLE (order_id uuid, event_id uuid, amount_idr bigint, pixels jsonb)
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
  WITH claimed AS (
    UPDATE public.orders o
       SET browser_mt_fired_at = pg_catalog.clock_timestamp()
     WHERE o.public_id = p_public_id AND o.status = 'paid' AND o.browser_mt_fired_at IS NULL
       AND o.paid_at > pg_catalog.clock_timestamp() - interval '1 hour'
    RETURNING o.id, o.event_id, o.amount_idr, o.landing_page_id
  )
  SELECT c.id, c.event_id, c.amount_idr, lp.pixels
    FROM claimed c
    JOIN public.landing_pages lp ON lp.id = c.landing_page_id
$fn$;

REVOKE ALL ON FUNCTION public.get_order_status(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_browser_mt(text) FROM PUBLIC;
-- ===== end US-022 ==================================================================================

-- --- US-024 the source of an order, for the reports (US-029) ----------------------------------------------
-- AC-T8: an organic order is one with NO CLICK ID. 'Organic' when orders.clickid is NULL (or empty) or orders.adnet_id
-- is NULL (an adnet the page did not allow, or none), else the adnet's name. The click id decides because the
-- checkout keeps the adnet of an order whose click id was dropped (malformed, too long, a contact detail): such an
-- order has an adnet_id and no clickid, gets no S2S row (core mtSinks / moSinks) and reports as Organic. One label
-- for every report, so no screen invents its own. SECURITY INVOKER: the caller needs SELECT on adnets (admin_rw
-- has it); EXECUTE admin_rw only (grants.sql).
CREATE OR REPLACE FUNCTION public.order_source_label(p_adnet_id uuid, p_clickid text)
  RETURNS text
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE
           WHEN p_adnet_id IS NULL OR p_clickid IS NULL OR p_clickid = '' THEN 'Organic'
           ELSE coalesce((SELECT a.name FROM public.adnets a WHERE a.id = p_adnet_id), 'Organic')
         END
$fn$;
-- --- end US-024 ------------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------------------------
-- US-026 (M9a player authentication) BLOCK BEGIN.
-- Who may log in to play.<DOMAIN> (AC-Q1, plan M9.1): a player who is not anonymized and is eligible for at
-- least one program (a paid, non-refunded order), by WhatsApp OTP or by a magic link. The login itself is
-- Better Auth's player instance in schema player_auth (spike R13); its user row is created HERE, by the
-- database, for an eligible player only, and before any OTP is issued (R13 finding 7), so the stock phone
-- plugin never creates users. public_rw reads no players column (grants.sql): the public app maps a phone or
-- a session to a player only through these functions.

-- The player_auth user of a player who may log in, created on first need (internal: called by the
-- functions below, EXECUTE granted to nobody). The row is what Better Auth's stock phone plugin finds and
-- updates: phoneNumber = the E.164 phone, phoneNumberVerified (an unverified number would be nulled by the
-- plugin's own user hook), the placeholder e-mail <phone>@players.invalid (user.email is NOT NULL UNIQUE) and
-- a constant name, so no buyer name is copied into player_auth. NULL when the player may not log in.
CREATE OR REPLACE FUNCTION public.player_auth_user_for(p_player_id uuid)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_phone text;
  v_user text;
  v_owner uuid;
BEGIN
  SELECT p.phone, p.auth_user_id INTO v_phone, v_user
    FROM public.players p
   WHERE p.id = p_player_id AND p.anonymized_at IS NULL AND p.phone IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.player_programs pp WHERE pp.player_id = p.id AND pp.eligible)
     FOR UPDATE OF p;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_user IS NOT NULL THEN
    RETURN v_user;
  END IF;
  INSERT INTO player_auth."user" (id, name, email, "emailVerified", "phoneNumber", "phoneNumberVerified", "createdAt", "updatedAt")
  VALUES (gen_random_uuid()::text, 'pemain', v_phone || '@players.invalid', false, v_phone, true, clock_timestamp(), clock_timestamp())
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_user;
  IF v_user IS NULL THEN
    -- A user with this phone (or its placeholder e-mail) already exists: it is this player's only if no
    -- other player is linked to it (e.g. the link was cleared); never take over another player's login.
    SELECT u.id INTO v_user FROM player_auth."user" u
     WHERE u."phoneNumber" = v_phone OR u.email = v_phone || '@players.invalid'
     ORDER BY (u."phoneNumber" = v_phone) IS TRUE DESC
     LIMIT 1;
    SELECT p.id INTO v_owner FROM public.players p WHERE p.auth_user_id = v_user;
    IF v_user IS NULL OR v_owner IS NOT NULL THEN
      RAISE EXCEPTION 'the player_auth user of this phone belongs to another player' USING ERRCODE = 'ET122';
    END IF;
    UPDATE player_auth."user" SET "phoneNumber" = v_phone, "phoneNumberVerified" = true, "updatedAt" = clock_timestamp()
     WHERE id = v_user;
  END IF;
  UPDATE public.players SET auth_user_id = v_user, updated_at = clock_timestamp() WHERE id = p_player_id;
  RETURN v_user;
END
$fn$;

-- The OTP path (apps/public, after its uniform answer was sent): the player_auth user id to issue a code
-- for, or NULL when the phone is not an eligible player's (then no code exists and nothing is sent).
CREATE OR REPLACE FUNCTION public.prepare_player_login(p_phone text)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_player uuid;
BEGIN
  SELECT p.id INTO v_player FROM public.players p WHERE p.phone = p_phone;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN public.player_auth_user_for(v_player);
END
$fn$;

-- The player behind a player_auth user, or NULL when that player may not log in (anonymized, eligible for no
-- program, or no player at all). Gates every new session (Better Auth's session.create hook) and maps a
-- session to the player id US-027's play calls use.
CREATE OR REPLACE FUNCTION public.player_for_login(p_auth_user_id text)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT p.id
    FROM public.players p
   WHERE p.auth_user_id = p_auth_user_id AND p.anonymized_at IS NULL AND p.phone IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.player_programs pp WHERE pp.player_id = p.id AND pp.eligible)
$fn$;

-- Issues a magic link (worker_rw; US-025 sends it, AC-D2): the caller makes the token (packages/core
-- issueMagicLink: 32 random bytes) and passes only its SHA-256; the database sets the expiry (its clock +
-- 72 h) and keeps ONE live link per player and channel, deleting the previous unconsumed one of that channel
-- (a resend supersedes what was sent before). Consumed links stay (a replay is refused as used).
CREATE OR REPLACE FUNCTION public.issue_magic_link(p_player_id uuid, p_channel text, p_token_hash bytea)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF p_player_id IS NULL OR p_channel IS NULL OR p_channel NOT IN ('whatsapp', 'email')
     OR p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'issue_magic_link: player, channel (whatsapp, email) and a 32-byte token hash are required' USING ERRCODE = 'ET120';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.players p
     WHERE p.id = p_player_id AND p.anonymized_at IS NULL AND p.phone IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.player_programs pp WHERE pp.player_id = p.id AND pp.eligible)
  ) THEN
    RAISE EXCEPTION 'issue_magic_link: the player may not log in' USING ERRCODE = 'ET121';
  END IF;
  -- One issuer at a time per player and channel (the partial unique index is the backstop).
  PERFORM pg_advisory_xact_lock(hashtextextended('magic_link:' || p_player_id::text || ':' || p_channel, 0::bigint));
  DELETE FROM public.magic_links WHERE player_id = p_player_id AND channel = p_channel AND consumed_at IS NULL;
  INSERT INTO public.magic_links (player_id, channel, token_hash, expires_at, created_at)
  VALUES (p_player_id, p_channel, p_token_hash, clock_timestamp() + interval '72 hours', clock_timestamp())
  RETURNING id INTO v_id;
  RETURN v_id;
END
$fn$;

-- The player_auth user a magic link WOULD log in, without using it up (public_rw): the login creates the
-- session first and consumes the link last (consume_magic_link), so a failure in between leaves the link
-- unspent. NULL exactly when consume_magic_link would refuse.
CREATE OR REPLACE FUNCTION public.magic_link_login_user(p_token_hash bytea, p_channel text)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_player uuid;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 OR p_channel IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT m.player_id INTO v_player
    FROM public.magic_links m
   WHERE m.token_hash = p_token_hash AND m.channel = p_channel
     AND m.consumed_at IS NULL AND m.expires_at > clock_timestamp();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN public.player_auth_user_for(v_player);
END
$fn$;

-- Whose account a session is (public_rw), shown right after a login so that a player who opened someone
-- else's forwarded link sees it is not theirs (login CSRF): the player's phone with its last 4 digits hidden,
-- mask_phone_tail ("0812-3456-****", the leaderboard's and the order page's form; Owner decision 2026-11-25),
-- or NULL when the player may not log in. It shows no more than the play page's own profile card shows the
-- signed-in player in full.
-- The signed-in player's own contact, in full, for the profile card of the play page (Owner decision 2026-11-25: the name, the
-- e-mail and the WhatsApp number, unmasked, to the player themself). Keyed by the request's player SESSION (apps/public
-- lib/play/page.ts readPlayerSession), never by a player id: public_rw can list every player id (player_programs), so an
-- id-keyed read would let a compromised public app dump every player's name and e-mail (security review 2026-11-25 M1). Only a
-- session that has not expired and has its login state row answers; a player who may not log in (anonymized, no phone, no
-- eligible program) gets no row. Accepted risk (docs/compliance/pii-inventory.md): a compromised public app, which can read
-- player_auth.session, could still read the contact of the players signed in at that time.
CREATE OR REPLACE FUNCTION public.player_profile_contact(p_session_id text)
  RETURNS TABLE (name text, email text, phone text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT p.name, p.email, p.phone
    FROM player_auth.session s
    JOIN player_auth.session_state st ON st.session_id = s.id
    JOIN public.players p ON p.auth_user_id = s."userId"
   WHERE s.id = p_session_id AND s."expiresAt" > pg_catalog.clock_timestamp()
     AND p.anonymized_at IS NULL AND p.phone IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.player_programs pp WHERE pp.player_id = p.id AND pp.eligible)
$fn$;

CREATE OR REPLACE FUNCTION public.player_login_label(p_auth_user_id text)
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT public.mask_phone_tail(p.phone) FROM public.players p WHERE p.id = public.player_for_login(p_auth_user_id)
$fn$;

-- Consumes a magic link (public_rw; the POST behind the confirm page, never a GET): single use, the first
-- caller wins (the row lock; a concurrent caller re-reads consumed_at and finds no row). Returns the
-- player_auth user to create the session for, or NULL for an unknown, used or expired link, a link of the
-- OTHER channel (not consumed then), or a player who may no longer log in (the link is then left unused).
CREATE OR REPLACE FUNCTION public.consume_magic_link(p_token_hash bytea, p_channel text)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_id uuid;
  v_player uuid;
  v_user text;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 OR p_channel IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT m.id, m.player_id INTO v_id, v_player
    FROM public.magic_links m
   WHERE m.token_hash = p_token_hash AND m.channel = p_channel
     AND m.consumed_at IS NULL AND m.expires_at > clock_timestamp()
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_user := public.player_auth_user_for(v_player);
  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE public.magic_links SET consumed_at = clock_timestamp() WHERE id = v_id;
  RETURN v_user;
END
$fn$;

-- Revokes a player's live (unconsumed) magic links, on every channel (worker_rw; Owner D9, US-005: Midtrans reversed a
-- payment we counted, so the order went to review and the buyer's eligibility is suspended). A suspended player's links
-- are refused at use already (consume_magic_link asks player_auth_user_for), but they stay in the table and would work
-- again the moment the player is eligible; deleting them takes the old links away for good. A buyer whose order is
-- restored logs in with a WhatsApp OTP, or with the self-service resend on the login page (US-027), or the Owner
-- re-sends; nothing here issues a link. It DELETES NOTHING (returns 0) while the player still has an eligible
-- player_programs row (another paid order stands: that player is not suspended, so their links are not touched).
-- Consumed links stay (a replay is refused as used). Takes the same per player+channel advisory locks as
-- issue_magic_link, in a fixed order, so it does not interleave with an issue; an issue that checked eligibility just
-- before this commits can still leave one link behind, and that link is inert for as long as the player is suspended.
-- Returns how many were deleted.
CREATE OR REPLACE FUNCTION public.revoke_player_magic_links(p_player_id uuid)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_count integer;
BEGIN
  IF p_player_id IS NULL THEN
    RETURN 0;
  END IF;
  IF EXISTS (SELECT 1 FROM public.player_programs pp WHERE pp.player_id = p_player_id AND pp.eligible) THEN
    RETURN 0;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('magic_link:' || p_player_id::text || ':email', 0::bigint));
  PERFORM pg_advisory_xact_lock(hashtextextended('magic_link:' || p_player_id::text || ':whatsapp', 0::bigint));
  DELETE FROM public.magic_links WHERE player_id = p_player_id AND consumed_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$fn$;

-- Prunes the OTP send ledger (worker_rw, the minute sweeper): rows older than 24 hours count for no cap any more
-- (otp.phone_window_seconds is at most 86400 s, the global breaker counts 10 minutes), so only those go. The
-- worker cannot delete a newer row, which would reset a phone's cap or the breaker. Returns how many went.
CREATE OR REPLACE FUNCTION public.prune_otp_enqueues()
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.otp_enqueues e WHERE e.enqueued_at < clock_timestamp() - interval '24 hours';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$fn$;

-- Deletes expired player sessions (worker_rw, the minute sweeper; it has no access to player_auth otherwise), and
-- with them their session_state rows (ON DELETE CASCADE): a rotated-out token past its grace period, a session
-- past its 30 days or its 90-day cap. Better Auth only deletes an expired session when that very cookie comes back.
CREATE OR REPLACE FUNCTION public.prune_player_sessions()
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM player_auth.session s
   WHERE s."expiresAt" < clock_timestamp()
      OR EXISTS (SELECT 1 FROM player_auth.session_state st
                  WHERE st.session_id = s.id AND st.login_at < clock_timestamp() - interval '90 days');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$fn$;

REVOKE ALL ON FUNCTION public.prune_player_sessions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_otp_enqueues() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.player_auth_user_for(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_player_login(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.player_for_login(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.issue_magic_link(uuid, text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_magic_link(bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_player_magic_links(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.magic_link_login_user(bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.player_login_label(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.player_profile_contact(text) FROM PUBLIC;
-- US-026 BLOCK END.

-- ---------------------------------------------------------------------------------------------
-- US-027 BLOCK BEGIN (Owner decision: "send my login link again", the recovery path for a player whose OTP verify
-- budget an attacker spent; the play functions themselves are in sql/play.sql).
-- The play login page's resend (apps/public lib/play/handlers.ts handleMagicLinkResend, after its uniform answer was
-- sent): for the phone of a player who may log in (not anonymized, eligible for a program; the rule of
-- issue_magic_link and player_for_login), one magic_link.resend job for the worker, payload {player_id}; for any
-- other phone nothing at all (NULL, no row). The worker issues a fresh link per channel through issue_magic_link,
-- which replaces the live one of that channel (the link sent before stops working), and sends it by WhatsApp and
-- e-mail (apps/worker magic-link-resend.ts). At most 3 jobs per player and WIB day, whatever the app's own limits
-- say (the app counts 3 per 24 h per phone in Valkey first, apps/public lib/play/limits.ts): the job's dedupe key
-- takes one of three slots of the day, so a fourth finds them all taken and enqueues nothing (the outbox's unique
-- key, no count query). The caller learns only whether a job was made, and the app neither returns nor logs it.
-- THE GLOBAL BREAKER (security review LOW-1), the resend's twin of enqueue_otp's: at most otp.global_send_cap
-- resend jobs over all players in any 10 minutes (counted one enqueue at a time, on the partial index
-- outbox_magic_link_resend_created_at_idx). A burst beyond it is abuse or a bug and every message puts the WhatsApp numbers at
-- risk: nothing is enqueued (NULL, the app's answer does not change) and one critical alert tells the Owner.
CREATE OR REPLACE FUNCTION public.enqueue_magic_link_resend(p_phone text)
  RETURNS uuid
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_player uuid;
  v_now timestamptz := clock_timestamp();
  v_day text := to_char(clock_timestamp() AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD');
  v_cap integer;
  v_outbox uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'enqueue_magic_link_resend must run under READ COMMITTED' USING ERRCODE = 'ET146';
  END IF;
  SELECT p.id INTO v_player
    FROM public.players p
   WHERE p.phone = p_phone AND p.anonymized_at IS NULL
     AND EXISTS (SELECT 1 FROM public.player_programs pp WHERE pp.player_id = p.id AND pp.eligible);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('enqueue_magic_link_resend:global', 0::bigint));
  v_cap := public.setting_positive_int('otp.global_send_cap');
  IF (SELECT count(*) FROM public.outbox o WHERE o.topic = 'magic_link.resend' AND o.created_at > v_now - interval '10 minutes') >= v_cap THEN
    INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload)
    SELECT 'monitor', 'magic_link_resend_breaker', 'critical', 'magic_link_resend_breaker',
           'Login link resends stopped: the global ceiling otp.global_send_cap (per 10 minutes) was reached',
           jsonb_build_object('cap_per_10_minutes', v_cap)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.alerts a
        WHERE a.dedupe_key = 'magic_link_resend_breaker' AND a.resolved_at IS NULL AND a.created_at > v_now - interval '1 hour');
    RETURN NULL;
  END IF;
  FOR v_slot IN 1..3 LOOP
    INSERT INTO public.outbox (topic, dedupe_key, payload)
    VALUES ('magic_link.resend', pg_catalog.format('magic_link.resend:%s:%s:%s', v_player, v_day, v_slot), jsonb_build_object('player_id', v_player))
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id INTO v_outbox;
    IF v_outbox IS NOT NULL THEN
      RETURN v_outbox;
    END IF;
  END LOOP;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.enqueue_magic_link_resend(text) FROM PUBLIC;
-- US-027 BLOCK END.

-- --- US-025 the WAHA ack webhook (AC-D6) ----------------------------------------------------------------------
-- record_waha_ack: moves a WhatsApp delivery's ack forward (queued -> sent -> delivered -> read) from the message id
-- its send returned. The webhook route calls it AFTER it verified the HMAC of the body; the function changes
-- deliveries.wa_ack (and updated_at) and nothing else, and never backwards: an ack that is not ahead of the stored
-- one changes nothing, and `failed` only counts before the message was delivered. Whether anything changed is
-- the answer (an unknown message id, a repeat and a late ack all say false: the route acknowledges every
-- verified webhook either way). Executable by public_rw only (grants.sql); it reads no personal data.
-- For US-029 (the delivery report): an ack that arrives BEFORE the worker has stored wa_message_id finds no row and is dropped, so a
-- delivered message can show no ack until its next one. The report must not read a NULL wa_ack as "never delivered": status is the truth.
CREATE OR REPLACE FUNCTION public.record_waha_ack(p_message_id text, p_ack text)
  RETURNS boolean
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_changed integer;
BEGIN
  IF p_message_id IS NULL OR p_message_id = '' OR p_ack IS NULL
     OR p_ack NOT IN ('queued', 'sent', 'delivered', 'read', 'failed') THEN
    RETURN false;
  END IF;
  UPDATE public.deliveries d
     SET wa_ack = p_ack, updated_at = pg_catalog.clock_timestamp()
   WHERE d.wa_message_id = p_message_id
     AND d.channel = 'whatsapp'
     AND (
       (p_ack = 'failed' AND (d.wa_ack IS NULL OR d.wa_ack IN ('queued', 'sent')))
       OR (p_ack <> 'failed' AND (
         d.wa_ack IS NULL OR d.wa_ack = 'failed'
         OR pg_catalog.array_position(ARRAY['queued', 'sent', 'delivered', 'read'], d.wa_ack)
            < pg_catalog.array_position(ARRAY['queued', 'sent', 'delivered', 'read'], p_ack)))
     );
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed > 0;
END
$fn$;
REVOKE ALL ON FUNCTION public.record_waha_ack(text, text) FROM PUBLIC;

-- record_waha_session_state: the limits WhatsApp puts on a number, as a VERIFIED session.status webhook reports them (WAHA docs, Sessions: Reachout timelock,
-- Message capping: data.reachoutTimelock {isActive, timeEnforcementEnds} and data.messageCapping {cappingStatus, totalQuota, usedQuota, cycleEnd}; the shapes are
-- the same objects GET /api/sessions/:session answers, RECORDED in US-005; a real webhook delivery is verified on staging). The route calls it AFTER it verified the HMAC of the body, like record_waha_ack; only a session name that belongs to exactly ONE
-- active session is updated (the same name on two servers is ambiguous, the health poll sorts it out), every value is checked here (bounded numbers, an
-- upper-case status word) and a block never lasts more than 31 days. It only ever EXTENDS the block (reachout_until moves forward; the poll and the clock end
-- it) and sets the warning level; it writes nothing else. Returns whether a session was updated; the worker's poll raises the alerts on a change.
CREATE OR REPLACE FUNCTION public.record_waha_session_state(p_session_name text, p_timelock jsonb, p_capping jsonb)
  RETURNS boolean
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_ids uuid[];
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_active boolean;
  v_ends timestamptz;
  v_status text;
  v_cycle timestamptz;
  v_total integer;
  v_used integer;
  v_until timestamptz;
  v_has_timelock boolean := false;
  v_has_capping boolean := false;
BEGIN
  IF p_session_name IS NULL OR p_session_name !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RETURN false;
  END IF;
  SELECT pg_catalog.array_agg(s.id) INTO v_ids
    FROM public.waha_sessions s JOIN public.waha_servers w ON w.id = s.server_id
   WHERE s.session_name = p_session_name AND s.active AND w.active;
  IF v_ids IS NULL OR pg_catalog.cardinality(v_ids) <> 1 THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_typeof(p_timelock) = 'object' AND pg_catalog.jsonb_typeof(p_timelock -> 'isActive') = 'boolean' THEN
    v_has_timelock := true;
    v_active := (p_timelock ->> 'isActive')::boolean;
    IF pg_catalog.jsonb_typeof(p_timelock -> 'timeEnforcementEnds') = 'number' AND (p_timelock ->> 'timeEnforcementEnds')::numeric BETWEEN 1 AND 4102444800 THEN
      v_ends := pg_catalog.to_timestamp((p_timelock ->> 'timeEnforcementEnds')::double precision);
    END IF;
  END IF;
  IF pg_catalog.jsonb_typeof(p_capping) = 'object' AND (p_capping ->> 'cappingStatus') ~ '^[A-Z_]{1,32}$' THEN
    v_has_capping := true;
    v_status := p_capping ->> 'cappingStatus';
    IF pg_catalog.jsonb_typeof(p_capping -> 'cycleEnd') = 'number' AND (p_capping ->> 'cycleEnd')::numeric BETWEEN 1 AND 4102444800 THEN
      v_cycle := pg_catalog.to_timestamp((p_capping ->> 'cycleEnd')::double precision);
    END IF;
    IF pg_catalog.jsonb_typeof(p_capping -> 'totalQuota') = 'number' AND (p_capping ->> 'totalQuota')::numeric BETWEEN -1 AND 1000000 THEN
      v_total := (p_capping ->> 'totalQuota')::numeric::integer;
    END IF;
    IF pg_catalog.jsonb_typeof(p_capping -> 'usedQuota') = 'number' AND (p_capping ->> 'usedQuota')::numeric BETWEEN 0 AND 1000000 THEN
      v_used := (p_capping ->> 'usedQuota')::numeric::integer;
    END IF;
  END IF;
  IF NOT v_has_timelock AND NOT v_has_capping THEN
    RETURN false;
  END IF;
  -- Where the number may not send a new contact until: the timelock's end while it is active, the cycle's end while capped (an hour when WAHA names none).
  v_until := greatest(
    CASE WHEN v_has_timelock AND v_active THEN coalesce(v_ends, v_now + interval '1 hour') END,
    CASE WHEN v_has_capping AND v_status = 'CAPPED' THEN coalesce(v_cycle, v_now + interval '1 hour') END);
  -- (LEAST ignores NULL: with no block at all v_until stays NULL and nothing is extended.) A webhook event (a verified one, but public_rw's own door into
  -- waha_sessions) extends the block by at most 24 hours per event: the worker's poll of the timelock and the capping is the authority for anything longer,
  -- and CLEARS the block when WAHA says the number is not limited.
  IF v_until IS NOT NULL THEN
    v_until := least(v_until, v_now + interval '24 hours');
  END IF;
  UPDATE public.waha_sessions s
     SET timelock_active = CASE WHEN v_has_timelock THEN v_active ELSE s.timelock_active END,
         timelock_ends_at = CASE WHEN v_has_timelock THEN v_ends ELSE s.timelock_ends_at END,
         capping_status = CASE WHEN v_has_capping THEN v_status ELSE s.capping_status END,
         capping_total_quota = CASE WHEN v_has_capping THEN v_total ELSE s.capping_total_quota END,
         capping_used_quota = CASE WHEN v_has_capping THEN v_used ELSE s.capping_used_quota END,
         capping_cycle_end = CASE WHEN v_has_capping THEN v_cycle ELSE s.capping_cycle_end END,
         warning_level = CASE WHEN v_has_capping THEN (CASE v_status WHEN 'FIRST_WARNING' THEN 'first' WHEN 'SECOND_WARNING' THEN 'second' ELSE 'none' END) ELSE s.warning_level END,
         reachout_until = CASE WHEN v_until IS NULL THEN s.reachout_until ELSE greatest(s.reachout_until, v_until) END,
         limits_checked_at = v_now
   WHERE s.id = v_ids[1];
  RETURN true;
END
$fn$;
REVOKE ALL ON FUNCTION public.record_waha_session_state(text, jsonb, jsonb) FROM PUBLIC;

-- waha_reply_expected: does this chat owe us a reply? (Owner decision D7: the proactive WhatsApp message is a short opener that asks the buyer to reply, with no
-- order code in it, so the reply carries none either.) True when a WhatsApp opener went out (or may have) from a number of this session name to this chat,
-- whose delivery still awaits the buyer: the chat is the order's phone (@c.us), or a @lid that is the phone's (wa_contacts) or that we do not know yet (a reply
-- may arrive from a lid check-exists did not teach us; the worker then asks WAHA who it is). The webhook route uses it to keep a code-less message that is a
-- reply, and to drop every other chatter as before. Reads no more than the one boolean; public_rw cannot read these tables itself.
CREATE OR REPLACE FUNCTION public.waha_reply_expected(p_session_name text, p_from_jid text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT p_session_name IS NOT NULL AND p_from_jid IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.delivery_openers p
      JOIN public.waha_sessions s ON s.id = p.session_id AND s.session_name = p_session_name
      JOIN public.deliveries d ON d.id = p.delivery_id AND d.channel = 'whatsapp' AND d.status = 'pending'
      JOIN public.orders o ON o.id = d.order_id
     WHERE p.status IN ('sent', 'unknown')
       AND p.updated_at > pg_catalog.clock_timestamp() - interval '30 days'
       AND (
         ('+' OPERATOR(pg_catalog.||) pg_catalog.substring(p_from_jid, '^([0-9]{5,20})@c\.us$')) = o.buyer_phone
         OR EXISTS (SELECT 1 FROM public.wa_contacts c WHERE c.lid = p_from_jid AND c.phone = o.buyer_phone)
         OR (p_from_jid ~ '^[0-9]{5,20}@lid$' AND NOT EXISTS (SELECT 1 FROM public.wa_contacts c2 WHERE c2.lid = p_from_jid))
       )
  )
$fn$;
REVOKE ALL ON FUNCTION public.waha_reply_expected(text, text) FROM PUBLIC;
-- --- end US-025 ------------------------------------------------------------------------------------------

-- --- US-030 BLOCK BEGIN: the retention of strangers' WhatsApp contacts (US-025 follow-up) --------------------------------------
-- wa_contacts caches what WAHA said about a phone (check-exists, the lid -> phone link). A buyer's or a player's row lives as long
-- as their data does (the erasure of a deletion request deletes it, sql/privacy.sql). A STRANGER's row (a phone that is no order's
-- buyer phone and no player's phone: e.g. an @lid sender resolved while answering a message that matched nothing) is personal data
-- with no purpose, so it is deleted once it has not been confirmed for 7 days (checked_at, lid_checked_at). EXECUTE worker_rw: the
-- minute sweeper (apps/worker sweepers.ts sweepExpiredOtps) calls it; at most 500 rows a call. Returns how many it deleted.
CREATE OR REPLACE FUNCTION public.prune_stranger_wa_contacts()
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.wa_contacts w
   WHERE w.phone IN (
     SELECT c.phone FROM public.wa_contacts c
      WHERE GREATEST(c.checked_at, coalesce(c.lid_checked_at, c.checked_at)) < clock_timestamp() - interval '7 days'
        AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.buyer_phone = c.phone)
        AND NOT EXISTS (SELECT 1 FROM public.players p WHERE p.phone = c.phone)
      ORDER BY c.checked_at
      LIMIT 500);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$fn$;
REVOKE ALL ON FUNCTION public.prune_stranger_wa_contacts() FROM PUBLIC;

-- What stays of a Midtrans payment's or notification's raw JSON once its order is anonymized (sql/privacy.sql, and the guard
-- payment_raw_erased_guard in triggers.sql for what arrives later): the transaction's own keys (ids, statuses, amounts, payment
-- type, times), plus "erased": true. customer_details, VA numbers, masked cards and everything else go.
CREATE OR REPLACE FUNCTION public.payment_raw_kept(p_raw jsonb)
  RETURNS jsonb
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT coalesce((SELECT jsonb_object_agg(k.key, k.value) FROM jsonb_each(CASE WHEN jsonb_typeof(p_raw) = 'object' THEN p_raw ELSE '{}'::jsonb END) k
                    WHERE k.key = ANY (ARRAY['transaction_id', 'order_id', 'transaction_status', 'fraud_status', 'status_code', 'status_message',
                                             'gross_amount', 'currency', 'payment_type', 'transaction_time', 'settlement_time', 'expiry_time'])),
                  '{}'::jsonb) || '{"erased": true}'::jsonb
$fn$;
REVOKE ALL ON FUNCTION public.payment_raw_kept(jsonb) FROM PUBLIC;
-- --- US-030 BLOCK END ------------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.setting_positive_int(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.score_answer(integer, integer, uuid, uuid, timestamptz, timestamptz, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mask_name(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mask_phone(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mask_phone_tail(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_program_contest(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_program_contest_shared(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sweep_login_throttle(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_otp(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_notification(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_waha_inbound(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_mo(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_payment_secret() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.order_source_label(uuid, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- US-023 (M6e LP ZIP hosting) BLOCK BEGIN.
-- The hosts a hosted landing page is served on, with the version that is live there: one row per
-- registered domain of an ACTIVE landing page whose hosting is 'zip' and that has a current version
-- (of its own). It is the one definition of "served" for both sides:
--   - internal_rw: Caddy's on-demand TLS ask (apps/worker/src/domains.ts) approves exactly these hosts;
--   - admin_rw: the console makes /srv/lp/hosts/{host}/current point at exactly these versions and
--     removes every other host directory (apps/admin/src/lib/settings/lp-hosting.ts).
-- An external landing page, an inactive one, or one without an uploaded version gets no certificate
-- and no content. SECURITY DEFINER so internal_rw needs no read of landing_pages / lp_versions.
CREATE OR REPLACE FUNCTION public.lp_served_hosts()
  RETURNS TABLE (host text, landing_page_id uuid, version integer)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT d.host, lp.id, v.version
    FROM public.lp_domains d
    JOIN public.landing_pages lp ON lp.id = d.landing_page_id
    JOIN public.lp_versions v ON v.id = lp.current_version_id AND v.landing_page_id = lp.id
   WHERE lp.active AND lp.hosting = 'zip'
$fn$;
REVOKE ALL ON FUNCTION public.lp_served_hosts() FROM PUBLIC;
-- US-023 BLOCK END.

-- ---------------------------------------------------------------------------------------------
-- US-033 (M10c Owner review queue for orders) BLOCK BEGIN. The effects of an order becoming PAID, and the reversal rows of
-- an order that is no longer paid, in ONE implementation for both paths that move an order: the payment code (apps/worker
-- src/payments.ts applyRequery, as worker_rw, for a notification, the nightly reconciliation or the Owner's re-query) and
-- the Owner's decision on an order in review (sql/order-review.sql order_review_decide, as order_review). SECURITY INVOKER:
-- each runs with its caller's own privileges (grants.sql), so neither caller gains anything through them. Every effect is
-- an INSERT ... ON CONFLICT DO NOTHING on its unique key (deliveries order+channel, conversion_events order+sink+kind,
-- outbox dedupe_key, player_programs pkey) and the triggers (paid_effects_guard ET080 and the final guards) hold for every
-- writer, so a replay or a race never doubles anything. The caller holds the order's row lock and passes the instant it
-- read under it (p_now), which every row written here carries. The rules are @ebooktrivia/core's (mtSinks, reversalSinks,
-- deliverySchedule, EFFECT_CANCELLED, NO_MT_TEMPLATE); apps/worker test/order-review.int.test.ts holds this SQL to them.

-- The proactive WhatsApp delay in ms (AC-D8): the admin setting delivery.wa_delay_seconds (0..86400, a whole number of
-- seconds), read when the order is paid; p_fallback_ms (the worker's WORKER_WA_DELAY_MS, default 3 minutes) only while the
-- setting is missing or malformed. ET188 for a fallback that is not a non-negative number.
CREATE OR REPLACE FUNCTION public.proactive_delay_ms(p_fallback_ms bigint)
  RETURNS bigint
  LANGUAGE plpgsql
  STABLE
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v jsonb;
BEGIN
  IF p_fallback_ms IS NULL OR p_fallback_ms < 0 OR p_fallback_ms > 9007199254740991 THEN
    RAISE EXCEPTION 'the WhatsApp delay fallback must be a non-negative number of ms' USING ERRCODE = 'ET188';
  END IF;
  SELECT s.value INTO v FROM public.app_settings s WHERE s.key = 'delivery.wa_delay_seconds';
  IF jsonb_typeof(v) = 'number' AND v::text::numeric = trunc(v::text::numeric) AND v::text::numeric BETWEEN 0 AND 86400 THEN
    RETURN (v::text::numeric * 1000)::bigint;
  END IF;
  RETURN p_fallback_ms;
END
$fn$;

-- Eligibility of one player for one program (plan M6.4; Owner D4 / D5): eligible = the player has a PAID order of the
-- program (an EXISTS over orders, no view), first_paid_at = the earliest paid_at among the orders STILL paid (NULL when
-- none is left). The player_programs row is locked first and both are computed in a later statement (READ COMMITTED: a
-- fresh snapshot after the lock), so two orders of one player that leave PAID at once cannot both see the other one still
-- paid. p_create inserts the row first (a PAID order); without it a missing row stays missing and false is returned.
CREATE OR REPLACE FUNCTION public.refresh_player_eligibility(p_player_id uuid, p_program_id uuid, p_now timestamptz, p_create boolean)
  RETURNS boolean
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_eligible boolean;
BEGIN
  IF p_create THEN
    INSERT INTO public.player_programs (player_id, program_id) VALUES (p_player_id, p_program_id) ON CONFLICT (player_id, program_id) DO NOTHING;
  END IF;
  PERFORM 1 FROM public.player_programs pp WHERE pp.player_id = p_player_id AND pp.program_id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.player_programs pp
     SET eligible = EXISTS (SELECT 1 FROM public.orders o WHERE o.player_id = pp.player_id AND o.program_id = pp.program_id AND o.status = 'paid'),
         first_paid_at = (SELECT min(o.paid_at) FROM public.orders o WHERE o.player_id = pp.player_id AND o.program_id = pp.program_id AND o.status = 'paid'),
         updated_at = p_now
   WHERE pp.player_id = p_player_id AND pp.program_id = p_program_id
  RETURNING pp.eligible INTO v_eligible;
  RETURN coalesce(v_eligible, false);
END
$fn$;

-- The PAID effects of an order (AC-S7, AC-T4, AC-D1, AC-D8), for an order the caller has just made paid under its row lock:
--   the buyer's player (one WhatsApp phone = one player; an existing player keeps its profile), linked to the order once;
--   eligibility and first_paid_at (refresh_player_eligibility);
--   the deliveries (e-mail at p_now, WhatsApp after proactive_delay_ms), and the rows payments cancelled when the order left
--   PAID (cancelled + 'order_not_paid', core EFFECT_CANCELLED) back to pending, never a row cancelled for another reason;
--   one MT conversion row per sink (core mtSinks: S2S for an attributed click, Meta / TikTok for a pixel of the landing page;
--   txid = the order id), an S2S row of an adnet without an MT template created failed at once (core NO_MT_TEMPLATE), and the
--   MTs payments failed with 'order_not_paid' back to pending (an MT already attempted is retried too: sinks dedupe by txid);
--   the outbox row `order.paid` (once per order).
-- Returns what it did: {player_id, eligible, deliveries_created, deliveries_revived, mt_created, mt_revived, order_paid_outbox}.
CREATE OR REPLACE FUNCTION public.order_paid_effects(p_order_id uuid, p_now timestamptz, p_wa_delay_fallback_ms bigint)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  o record;
  v_player uuid;
  v_eligible boolean;
  v_wa_at timestamptz;
  v_sink text;
  v_unreportable boolean;
  v_n integer;
  v_deliveries_created integer;
  v_deliveries_revived integer;
  v_mt_created integer := 0;
  v_mt_revived integer;
  v_outbox integer;
BEGIN
  IF p_order_id IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'order_paid_effects: the order and the instant are required' USING ERRCODE = 'ET188';
  END IF;
  SELECT x.id, x.program_id, x.buyer_phone, x.buyer_name, x.buyer_email, x.adnet_id, x.clickid, x.event_id, x.amount_idr, lp.pixels,
         coalesce(a.mt_url_template IS NOT NULL, false) AS adnet_has_mt_template
    INTO o
    FROM public.orders x JOIN public.landing_pages lp ON lp.id = x.landing_page_id
    LEFT JOIN public.adnets a ON a.id = x.adnet_id
   WHERE x.id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_paid_effects: unknown order' USING ERRCODE = 'ET188';
  END IF;
  v_wa_at := p_now + make_interval(secs => public.proactive_delay_ms(p_wa_delay_fallback_ms) / 1000.0);

  INSERT INTO public.players (phone, name, email) VALUES (o.buyer_phone, o.buyer_name, o.buyer_email) ON CONFLICT (phone) DO NOTHING;
  SELECT p.id INTO v_player FROM public.players p WHERE p.phone = o.buyer_phone;
  IF v_player IS NULL THEN
    RAISE EXCEPTION 'the buyer''s player row is missing' USING ERRCODE = 'ET188';
  END IF;
  UPDATE public.orders x SET player_id = coalesce(x.player_id, v_player) WHERE x.id = o.id RETURNING x.player_id INTO v_player;
  v_eligible := public.refresh_player_eligibility(v_player, o.program_id, p_now, true);

  INSERT INTO public.deliveries (order_id, channel, not_before)
  VALUES (o.id, 'email', p_now), (o.id, 'whatsapp', v_wa_at)
  ON CONFLICT (order_id, channel) DO NOTHING;
  GET DIAGNOSTICS v_deliveries_created = ROW_COUNT;
  UPDATE public.deliveries d
     SET status = 'pending', last_error = NULL, not_before = CASE d.channel WHEN 'email' THEN p_now ELSE v_wa_at END, updated_at = p_now
   WHERE d.order_id = o.id AND d.status = 'cancelled' AND d.last_error = 'order_not_paid';
  GET DIAGNOSTICS v_deliveries_revived = ROW_COUNT;

  FOREACH v_sink IN ARRAY ARRAY['s2s', 'meta', 'tiktok'] LOOP
    IF (v_sink = 's2s' AND o.adnet_id IS NOT NULL AND o.clickid IS NOT NULL AND o.clickid <> '')
       OR (v_sink <> 's2s' AND jsonb_typeof(o.pixels) = 'object' AND jsonb_typeof(o.pixels -> v_sink) = 'string' AND o.pixels ->> v_sink <> '') THEN
      v_unreportable := v_sink = 's2s' AND NOT o.adnet_has_mt_template;
      INSERT INTO public.conversion_events (order_id, sink, kind, status, adnet_id, txid, event_id, value_idr, next_attempt_at, failed_at, last_error)
      VALUES (o.id, v_sink, 'mt', CASE WHEN v_unreportable THEN 'failed' ELSE 'pending' END::public.conversion_status,
              CASE WHEN v_sink = 's2s' THEN o.adnet_id END, o.id::text, o.event_id, o.amount_idr, p_now,
              CASE WHEN v_unreportable THEN p_now END, CASE WHEN v_unreportable THEN 'the adnet has no mt postback template' END)
      ON CONFLICT (order_id, sink, kind) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_mt_created := v_mt_created + v_n;
    END IF;
  END LOOP;
  UPDATE public.conversion_events c
     SET status = 'pending', failed_at = NULL, last_error = NULL, next_attempt_at = p_now, updated_at = p_now
   WHERE c.order_id = o.id AND c.kind = 'mt' AND c.status = 'failed' AND c.last_error = 'order_not_paid';
  GET DIAGNOSTICS v_mt_revived = ROW_COUNT;

  INSERT INTO public.outbox (topic, dedupe_key, payload)
  VALUES ('order.paid', 'order.paid:' || o.id::text, jsonb_build_object('order_id', o.id))
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_outbox = ROW_COUNT;

  RETURN jsonb_build_object('player_id', v_player, 'eligible', v_eligible, 'deliveries_created', v_deliveries_created,
                            'deliveries_revived', v_deliveries_revived, 'mt_created', v_mt_created, 'mt_revived', v_mt_revived,
                            'order_paid_outbox', v_outbox);
END
$fn$;

-- The reversal rows of an order that is no longer paid (AC-T8, plan §10 item 17): the MTs the sink may have counted (the
-- sticky maybe_counted mark: a 2xx or an uncertain send, never cleared) or that are in flight (sending / sent) get their
-- reversal, which is the adnet's optional reversal postback only: an S2S MT row of an adnet with a reversal template (core
-- reversalSinks; Meta and TikTok have no standard refund event). Returns how many reversal rows it created.
CREATE OR REPLACE FUNCTION public.order_reversal_rows(p_order_id uuid, p_now timestamptz)
  RETURNS integer
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO public.conversion_events (order_id, sink, kind, adnet_id, txid, event_id, value_idr, next_attempt_at)
  SELECT o.id, 's2s', 'reversal', o.adnet_id, o.id::text, o.event_id, o.amount_idr, p_now
    FROM public.orders o JOIN public.adnets a ON a.id = o.adnet_id
   WHERE o.id = p_order_id AND a.reversal_url_template IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.conversion_events c
                  WHERE c.order_id = o.id AND c.kind = 'mt' AND c.sink = 's2s' AND (c.maybe_counted OR c.status IN ('sending', 'sent')))
  ON CONFLICT (order_id, sink, kind) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.proactive_delay_ms(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_player_eligibility(uuid, uuid, timestamptz, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.order_paid_effects(uuid, timestamptz, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.order_reversal_rows(uuid, timestamptz) FROM PUBLIC;
-- US-033 BLOCK END.

-- US-031 BLOCK BEGIN: the breached-password flag of an admin (ASVS V6.2.12) -------------------------------------------------------
-- Where a password is set, the admin app writes a new admin_profiles.password_check_id and an outbox job
-- admin.password_hibp_check {admin_user_id, check_id} whose `sealed` is the password's SHA-1 sealed to the messaging key. The
-- worker opens it, asks Have I Been Pwned's range API (k-anonymity) and, when the password is in a breach, calls this: it sets
-- password_breached_at ONLY while that check is still the current password's (a check of a password changed since is a no-op),
-- audits it (actor 'system') and raises one warning alert with the admin id only. From then on the admin's session may only
-- change the password (apps/admin lib/access.ts). Returns whether it flagged. EXECUTE worker_rw only.
CREATE OR REPLACE FUNCTION public.flag_breached_admin_password(p_admin_user_id text, p_check_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  UPDATE public.admin_profiles p
     SET password_breached_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
   WHERE p.auth_user_id = p_admin_user_id AND p.password_check_id = p_check_id AND p.password_breached_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.audit_log (actor_kind, action, entity_type, entity_id, changes)
  VALUES ('system', 'admin_user.password_breached', 'admin_user', p_admin_user_id,
          pg_catalog.jsonb_build_object('must_change_password', pg_catalog.jsonb_build_object('before', false, 'after', true)));
  INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload)
  VALUES ('worker', 'admin_password_breached', 'warning', 'admin_password_breached:' || p_check_id::text,
          'An admin password is in a known data breach (Have I Been Pwned): that admin must change it at the next sign-in (docs/runbooks/security-scans.md section 6)',
          pg_catalog.jsonb_build_object('admin_user_id', p_admin_user_id));
  RETURN true;
END
$fn$;
REVOKE ALL ON FUNCTION public.flag_breached_admin_password(text, uuid) FROM PUBLIC;
-- US-031 BLOCK END.
