-- privacy.sql: UU PDP deletion = anonymization of one data subject (US-030; plan §10 item 6, M10 item 3, R9; spec AC-A10).
--
-- Applied by src/migrate.ts LAST, after fulfillment.sql, as the connecting role (a superuser): the function is owned by
-- pii_eraser (roles.sql: NOLOGIN, no members, member of nothing), which only a superuser can arrange without making migrator a
-- member of it. Re-runnable: roles.sql drops it (every signature) at the start of every run, and this file creates it again.
--
-- Why a dedicated owner with the minimum grants (grants.sql, US-030 block): the erasure blanks personal columns across many
-- tables that no app role may write (play rows, deliveries, the WhatsApp tables, the Better Auth player tables, the inboxes),
-- and the guards that protect them admit exactly current_user = 'pii_eraser' for exactly that (attempt_questions_play_guard,
-- fulfillments_machine_guard, anonymized_rows_guard, deletion_requests_guard: triggers.sql). pii_eraser holds SELECT on the
-- columns it matches on and UPDATE / DELETE only of what it erases; it can write no money column, no status but the
-- cancellation of an unsent send, no play result and no audit row but its own.
--
-- erase_data_subject(request, confirmation, actor, request id, ip): EXECUTE admin_rw, Owner-only in the console (policy
-- deletion_request.process), and checked here: an active Owner (ET171), the request's 8-character reference typed as the
-- confirmation (ET171). ONE transaction (READ COMMITTED, ET170). The data subject is the request's phone (one buyer = one
-- phone = one player, AC-Q1): the player with that phone and every order with that buyer phone or of that player.
-- Idempotent: the request row is locked first; a completed request returns its summary and changes nothing (a concurrent
-- second call waits for the lock and then finds it completed); a rejected one is refused (ET176).
-- Refused, nothing changed, when:
--   ET177 the subject holds a prize not delivered yet: a winner awaiting confirmation, confirmed or flagged whose fulfilment
--         is not done. The Owner first forfeits it (revoke and re-award, sql/contest.sql), or waits until it is delivered;
--   ET178 an order of the subject is still pending (its payment page may still be paid) or in review (the Owner decides it
--         first), or a send to the subject is in flight (a delivery, an opener or a CAPI event in `sending`, or an OTP or login
--         link job not processed yet): retry later.
-- Locks: the contest lock of each of the player's programs first (in program id order: a revoke and re-award serialises with
-- it), then the orders and the player row.
-- What it does (docs/compliance/pii-inventory.md is the column-by-column inventory):
--   login      every player_auth user of the subject (the linked one, and any holding the phone or its placeholder e-mail)
--              with its sessions (cascading session_state) and accounts, and verification rows naming the phone, are DELETED,
--              so the subject can never log in again; every magic link is deleted (outstanding ones revoked); OTP rows and
--              the OTP send ledger of the phone are deleted;
--   player     name '', phone / e-mail / auth user NULL, anonymized_at set (players_anonymized_check). Its id stays: play
--              rows, stats, eligibility, snapshot entries (ids and numbers only) and winners are pseudonymous and are kept,
--              so ranks never move; the live leaderboard shows the player masked as "***";
--   orders     name and e-mail '', phone, IP, UA hash and the ad-platform click ids (fbclid, fbp, fbc, ttclid, gclid) NULL,
--              buyer_key replaced by random bytes (it was a hash of phone + name + e-mail), anonymized_at set. Kept: ids,
--              public id, order code, amounts, status, timestamps, product, program, landing page, visit, adnet, clickid,
--              sub_id, pub, utm_* (the attribution keys the reports and the MT reconciliation count by);
--   consents   IP and UA hash NULL; the row (order, legal page version, consented_at) stays as the record of consent;
--   visits     of the subject's orders, and the other visits from the subject's devices (same IP address and user-agent hash
--              as an order, consent or answer of theirs, on the same landing pages): IP, UA hash and ad-platform click ids NULL;
--   payments   the raw Midtrans JSON of the orders' payments and notifications is cut down to the transaction's own keys
--              (functions.sql payment_raw_kept: ids, status, amounts, times, payment type), dropping customer_details and
--              anything else; what Midtrans sends later is cut the same way (triggers.sql payment_raw_erased_guard);
--   sends      deliveries: chat ids and the WhatsApp message id (it embeds the chat) NULL, a pending one cancelled
--              ('subject_erased'); openers: message id NULL, a pending one expired; CAPI conversions (meta, tiktok, google)
--              still pending fail with 'subject_erased' (they would send the hashed e-mail and phone); S2S rows carry no
--              personal data and are kept as they are;
--   play       the IP and UA hash of every answer of the subject NULL;
--   prizes     the notes, correction reason and proof of the subject's fulfilments emptied, the revoke / reinstatement reason
--              of their winners blanked, the proof uploads deleted (their storage paths are returned: the admin app removes the
--              files after the commit, the upload sweeper any it missed);
--   WhatsApp   wa_contacts rows of the phone, its lid or its chat ids DELETED; inbound messages from those chats keep their
--              row (the webhook dedupe) with message_id replaced by 'erased:' || its SHA-256 (triggers.sql
--              waha_inbound_erased_dedupe keeps a redelivery out) and from_jid '', body and raw emptied, marked processed;
--              waha_sends contact keys of those chats and of the phone (an OTP or login-link send is keyed on it), and of the
--              subject's deliveries, NULL;
--   outbox / alerts  rows with a JSON string value EQUAL to the phone (E.164, 62..., 08...), an e-mail, a chat id or the lid
--              (values of at least 8 characters; never a substring match), or an alert message naming one as a whole word, get
--              the payload {"erased": true} (an outbox row loses its sealed bytes and is marked processed; the message 'erased').
-- The request becomes completed (its phone NULL, the summary of counts), and the audit row holds only ids and references.
-- Postgres is the scan target (test/privacy.int.test.ts). Valkey and backups age out: docs/runbooks/privacy.md.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

CREATE OR REPLACE FUNCTION public.erase_data_subject(
  p_request_id uuid,
  p_confirmation text,
  p_actor_admin_user_id text,
  p_request text,
  p_ip inet
)
  RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_status text;
  v_phone text;
  v_old_summary jsonb;
  v_digits text;
  v_player uuid;
  v_program uuid;
  v_boundary text;
  v_inbound text[];
  v_orders uuid[];
  v_deliveries uuid[];
  v_users text[];
  v_emails text[];
  v_chats text[];
  v_lids text[];
  v_keys text[];
  v_patterns text[];
  v_proofs uuid[];
  v_paths text[];
  v_n jsonb := '{}'::jsonb;
  v_count integer;
  v_summary jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the erasure of a data subject must run under READ COMMITTED' USING ERRCODE = 'ET170';
  END IF;
  IF p_request_id IS NULL OR p_actor_admin_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.admin_profiles ap
     WHERE ap.auth_user_id = p_actor_admin_user_id AND ap.role = 'owner' AND ap.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'erase_data_subject: the request is required and the actor must be an active Owner' USING ERRCODE = 'ET171';
  END IF;

  SELECT r.status, r.subject_phone, r.summary INTO v_status, v_phone, v_old_summary
    FROM public.deletion_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'erase_data_subject: unknown deletion request' USING ERRCODE = 'ET171';
  END IF;
  IF v_status = 'completed' THEN
    RETURN v_old_summary || jsonb_build_object('request_id', p_request_id, 'erased', false, 'removed_files', '[]'::jsonb);
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'deletion request % was rejected: it is never executed', p_request_id USING ERRCODE = 'ET176';
  END IF;
  IF p_confirmation IS DISTINCT FROM left(p_request_id::text, 8) THEN
    RAISE EXCEPTION 'erase_data_subject: type the request reference to confirm the erasure' USING ERRCODE = 'ET171';
  END IF;
  v_digits := substr(v_phone, 2);

  -- The subject's player, then THE contest lock of each of its programs, in program id order: an erasure and a revoke and
  -- re-award (sql/contest.sql, which takes that lock first too) serialise, so a re-award never picks a player while it is being
  -- erased and the prize check below sees every prize re-awarded to the subject. Then the orders and the player row, in the
  -- order payments takes them (an order, then its player's rows).
  SELECT p.id INTO v_player FROM public.players p WHERE p.phone = v_phone;
  IF v_player IS NOT NULL THEN
    FOR v_program IN SELECT pp.program_id FROM public.player_programs pp WHERE pp.player_id = v_player ORDER BY pp.program_id LOOP
      PERFORM public.lock_program_contest(v_program);
    END LOOP;
  END IF;
  PERFORM 1 FROM public.orders o
   WHERE o.buyer_phone = v_phone OR (v_player IS NOT NULL AND o.player_id = v_player)
   ORDER BY o.id FOR UPDATE;
  SELECT coalesce(array_agg(o.id ORDER BY o.id), '{}') INTO v_orders FROM public.orders o
   WHERE o.buyer_phone = v_phone OR (v_player IS NOT NULL AND o.player_id = v_player);
  IF v_player IS NOT NULL THEN
    PERFORM 1 FROM public.players p WHERE p.id = v_player FOR UPDATE;
  END IF;
  SELECT coalesce(array_agg(d.id), '{}') INTO v_deliveries FROM public.deliveries d WHERE d.order_id = ANY (v_orders);

  IF v_player IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.winners w LEFT JOIN public.fulfillments f ON f.winner_id = w.id
     WHERE w.player_id = v_player AND w.status <> 'revoked' AND f.status IS DISTINCT FROM 'done'
  ) THEN
    RAISE EXCEPTION 'the subject holds a prize that was not delivered: forfeit it (revoke and re-award) or deliver it first' USING ERRCODE = 'ET177';
  END IF;
  IF EXISTS (SELECT 1 FROM public.orders o WHERE o.id = ANY (v_orders) AND o.status IN ('pending', 'review'))
     OR EXISTS (SELECT 1 FROM public.deliveries d WHERE d.id = ANY (v_deliveries) AND d.status = 'sending')
     OR EXISTS (SELECT 1 FROM public.delivery_openers op WHERE op.delivery_id = ANY (v_deliveries) AND op.status = 'sending')
     OR EXISTS (SELECT 1 FROM public.conversion_events c
                 WHERE c.order_id = ANY (v_orders) AND c.sink IN ('meta', 'tiktok', 'google') AND c.status = 'sending')
     -- An OTP or a login link still on its way: the WhatsApp send would record the phone's contact key (waha_sends) after this
     -- erasure. Live = not processed, below its consumer's claim cap (raised by the deferrals) and, for an OTP, not expired (an
     -- expired one is never sent); a job past its cap is never claimed again, so it never holds the erasure back. The caps mirror
     -- apps/worker otp-send.ts OTP_MAX_ATTEMPTS and magic-link-resend.ts MAGIC_LINK_RESEND_MAX_ATTEMPTS (privacy-caps.test.ts
     -- pins them equal).
     OR EXISTS (SELECT 1 FROM public.outbox o
                 WHERE o.processed_at IS NULL
                   AND o.attempts < (CASE o.topic WHEN 'otp.send' THEN 6 WHEN 'magic_link.resend' THEN 5 END) + o.deferrals
                   AND ((o.topic = 'otp.send' AND o.payload ->> 'phone' = v_phone
                         AND coalesce(o.payload ->> 'expires_at', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
                         AND (o.payload ->> 'expires_at')::timestamptz > v_now)
                        OR (o.topic = 'magic_link.resend' AND v_player IS NOT NULL AND o.payload ->> 'player_id' = v_player::text))) THEN
    RAISE EXCEPTION 'an order of the subject is pending or in review, or a send to the subject is in flight: retry later' USING ERRCODE = 'ET178';
  END IF;

  -- What identifies the subject elsewhere, read before it is erased.
  SELECT coalesce(array_agg(DISTINCT lower(e.v)), '{}') INTO v_emails
    FROM (SELECT o.buyer_email AS v FROM public.orders o WHERE o.id = ANY (v_orders)
          UNION ALL SELECT p.email FROM public.players p WHERE p.id = v_player) e
   WHERE e.v IS NOT NULL AND e.v <> '';
  SELECT coalesce(array_agg(DISTINCT c.v), '{}') INTO v_chats
    FROM (SELECT v_digits || '@c.us' AS v
          UNION ALL SELECT w.chat_id FROM public.wa_contacts w WHERE w.phone = v_phone
          UNION ALL SELECT w.lid FROM public.wa_contacts w WHERE w.phone = v_phone
          UNION ALL SELECT d.wa_chat_id FROM public.deliveries d WHERE d.id = ANY (v_deliveries)
          UNION ALL SELECT d.reply_chat_id FROM public.deliveries d WHERE d.id = ANY (v_deliveries)) c
   WHERE c.v ~ '^[0-9]{5,20}@(c\.us|lid)$';
  SELECT coalesce(array_agg(c), '{}') INTO v_lids FROM unnest(v_chats) c WHERE c LIKE '%@lid';
  -- The pool's contact keys (apps/worker delivery/pool.ts contactKey: SHA-256 hex of 'ebooktrivia/contact/v1|' and the contact):
  -- a delivery is keyed on its chat id, an OTP or login-link send on the E.164 phone.
  SELECT coalesce(array_agg(encode(sha256(convert_to('ebooktrivia/contact/v1|' || c, 'UTF8')), 'hex')), '{}') INTO v_keys
    FROM unnest(v_chats || v_phone) c;
  -- The values (lower case, at least 8 characters, so nothing short and common matches) the outbox and alerts are matched on,
  -- EXACTLY (a JSON string value equal to one, or a whole word of an alert message): the phone in its E.164, 62... and 08... forms,
  -- the e-mails, the chat ids and their digits (a lid).
  SELECT coalesce(array_agg(DISTINCT lower(pt)), '{}') INTO v_patterns
    FROM unnest(ARRAY[v_phone, v_digits] || v_emails || v_chats
                || CASE WHEN v_digits LIKE '62%' THEN ARRAY['0' || substr(v_digits, 3)] ELSE '{}'::text[] END
                || ARRAY(SELECT split_part(c, '@', 1) FROM unnest(v_chats) c)) pt
   WHERE char_length(pt) >= 8;
  -- One regular expression for a whole-word match in free text (a pattern's special characters escaped). A dot ends a word when
  -- nothing alphanumeric follows it ("... +62812....", "... a@b.test."), so a sentence's full stop is a boundary while the dot
  -- of a longer address or phone is not.
  SELECT '(^|[^0-9a-z@._+-])(' || string_agg(regexp_replace(pt, '([.+*?^$(){}|\[\]\\-])', '\\\1', 'g'), '|')
         || ')($|[^0-9a-z@._+-]|\.($|[^0-9a-z]))'
    INTO v_boundary FROM unnest(v_patterns) pt;

  -- Login: the player_auth users (Better Auth) and what hangs off them, the links, the OTPs.
  SELECT coalesce(array_agg(DISTINCT u.id), '{}') INTO v_users
    FROM player_auth."user" u
   WHERE u.id = (SELECT p.auth_user_id FROM public.players p WHERE p.id = v_player)
      OR u."phoneNumber" = v_phone OR u.email = v_phone || '@players.invalid';
  DELETE FROM player_auth.session s WHERE s."userId" = ANY (v_users);
  GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('sessions', v_count);
  DELETE FROM player_auth.account a WHERE a."userId" = ANY (v_users);
  DELETE FROM player_auth.verification v WHERE v.identifier IN (v_phone, v_digits);
  IF v_player IS NOT NULL THEN
    UPDATE public.players SET name = '', phone = NULL, email = NULL, auth_user_id = NULL, anonymized_at = v_now, updated_at = v_now
     WHERE id = v_player;
    DELETE FROM public.magic_links m WHERE m.player_id = v_player;
    GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('magic_links', v_count);
  END IF;
  DELETE FROM player_auth."user" u WHERE u.id = ANY (v_users);
  v_n := v_n || jsonb_build_object('login_users', cardinality(v_users));
  DELETE FROM public.player_otps o WHERE o.phone = v_phone;
  DELETE FROM public.otp_enqueues e WHERE e.phone = v_phone;

  -- Visits (before the orders lose their device): the visits of the subject's orders, and the other visits of the subject's
  -- devices on the same landing pages, i.e. the same IP address AND the same user-agent hash as one of the subject's orders,
  -- consents or answers. A visit that shares both with the subject is the subject's browser in practice (another person would
  -- need the same network address and the very same browser build); its attribution keys stay, as an order's do.
  UPDATE public.visits v SET ip = NULL, ua_hash = NULL, fbclid = NULL, fbp = NULL, fbc = NULL, ttclid = NULL, gclid = NULL
   WHERE v.id IN (SELECT o.visit_id FROM public.orders o WHERE o.id = ANY (v_orders))
      OR (v.landing_page_id IN (SELECT o.landing_page_id FROM public.orders o WHERE o.id = ANY (v_orders))
          AND v.ip IS NOT NULL AND v.ua_hash IS NOT NULL
          AND (v.ip, v.ua_hash) IN (SELECT o.ip, o.ua_hash FROM public.orders o WHERE o.id = ANY (v_orders) AND o.ip IS NOT NULL
                                    UNION SELECT c.ip, c.ua_hash FROM public.consents c WHERE c.order_id = ANY (v_orders) AND c.ip IS NOT NULL
                                    UNION SELECT aq.ip, aq.ua_hash FROM public.attempt_questions aq
                                           JOIN public.set_attempts a ON a.id = aq.attempt_id
                                          WHERE a.player_id = v_player AND aq.ip IS NOT NULL));
  GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('visits', v_count);

  -- Orders and what was recorded with them.
  UPDATE public.orders
     SET buyer_name = '', buyer_phone = NULL, buyer_email = '', ip = NULL, ua_hash = NULL,
         fbclid = NULL, fbp = NULL, fbc = NULL, ttclid = NULL, gclid = NULL,
         buyer_key = sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())),
         anonymized_at = v_now, updated_at = v_now
   WHERE id = ANY (v_orders);
  v_n := v_n || jsonb_build_object('orders', cardinality(v_orders));
  UPDATE public.consents c SET ip = NULL, ua_hash = NULL WHERE c.order_id = ANY (v_orders);
  GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('consents', v_count);
  -- What arrives from Midtrans later is cut the same way by triggers.sql payment_raw_erased_guard.
  UPDATE public.payment_notifications n SET raw = public.payment_raw_kept(n.raw)
   WHERE n.midtrans_order_id IN (SELECT ma.midtrans_order_id FROM public.midtrans_attempts ma WHERE ma.order_id = ANY (v_orders));
  GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('payment_notifications', v_count);
  UPDATE public.payments pay SET raw = public.payment_raw_kept(pay.raw)
   WHERE pay.order_id = ANY (v_orders);
  GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('payments', v_count);

  -- Sends: no chat id or message id is kept, and nothing unsent goes out any more.
  UPDATE public.deliveries d SET wa_chat_id = NULL, reply_chat_id = NULL, wa_message_id = NULL, updated_at = v_now
   WHERE d.id = ANY (v_deliveries) AND (d.wa_chat_id IS NOT NULL OR d.reply_chat_id IS NOT NULL OR d.wa_message_id IS NOT NULL);
  UPDATE public.deliveries d SET status = 'cancelled', last_error = 'subject_erased', lease_until = NULL, updated_at = v_now
   WHERE d.id = ANY (v_deliveries) AND d.status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('deliveries_cancelled', v_count);
  UPDATE public.delivery_openers op SET wa_message_id = NULL, updated_at = v_now
   WHERE op.delivery_id = ANY (v_deliveries) AND op.wa_message_id IS NOT NULL;
  UPDATE public.delivery_openers op SET status = 'expired', lease_until = NULL, updated_at = v_now
   WHERE op.delivery_id = ANY (v_deliveries) AND op.status = 'pending';
  UPDATE public.conversion_events c SET status = 'failed', failed_at = v_now, last_error = 'subject_erased', lease_until = NULL, updated_at = v_now
   WHERE c.order_id = ANY (v_orders) AND c.sink IN ('meta', 'tiktok', 'google') AND c.status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('capi_cancelled', v_count);

  -- Play: the device of every answer.
  IF v_player IS NOT NULL THEN
    UPDATE public.attempt_questions aq SET ip = NULL, ua_hash = NULL
     WHERE aq.attempt_id IN (SELECT a.id FROM public.set_attempts a WHERE a.player_id = v_player)
       AND (aq.ip IS NOT NULL OR aq.ua_hash IS NOT NULL);
    GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('answers', v_count);

    -- Prizes: the notes, correction reason and proof of the subject's fulfilments, and the Owner's revoke / reinstatement reason.
    SELECT coalesce(array_agg(f.proof_upload_id), '{}') INTO v_proofs
      FROM public.fulfillments f JOIN public.winners w ON w.id = f.winner_id
     WHERE w.player_id = v_player AND f.proof_upload_id IS NOT NULL;
    UPDATE public.fulfillments f SET notes = NULL, proof_upload_id = NULL, correction_reason = NULL, updated_at = v_now
      FROM public.winners w
     WHERE w.id = f.winner_id AND w.player_id = v_player
       AND (f.notes IS NOT NULL OR f.proof_upload_id IS NOT NULL OR f.correction_reason IS NOT NULL);
    GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('fulfillments', v_count);
    UPDATE public.winners w SET decision_reason = NULL, updated_at = v_now WHERE w.player_id = v_player AND w.decision_reason IS NOT NULL;
  END IF;
  WITH removed AS (DELETE FROM public.uploads u WHERE u.id = ANY (coalesce(v_proofs, '{}')) AND u.kind = 'proof' RETURNING u.storage_path)
  SELECT coalesce(array_agg(r.storage_path), '{}') INTO v_paths FROM removed r;

  -- WhatsApp.
  WITH erased AS (
    UPDATE public.waha_inbound i
       SET message_id = 'erased:' || encode(sha256(convert_to(i.message_id, 'UTF8')), 'hex'), from_jid = '', body = NULL, raw = '{}'::jsonb,
           processed_at = coalesce(i.processed_at, v_now)
     WHERE i.from_jid = ANY (v_chats)
    RETURNING i.id
  )
  SELECT coalesce(array_agg(e.id::text), '{}') INTO v_inbound FROM erased e;
  v_n := v_n || jsonb_build_object('inbound_messages', cardinality(v_inbound));
  UPDATE public.waha_sends s SET contact_key = NULL
   WHERE s.contact_key IS NOT NULL AND (s.contact_key = ANY (v_keys) OR s.delivery_id = ANY (v_deliveries));
  GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('pool_sends', v_count);
  DELETE FROM public.wa_contacts w WHERE w.phone = v_phone OR w.lid = ANY (v_lids) OR w.chat_id = ANY (v_chats);
  GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('wa_contacts', v_count);

  -- Outbox and alerts that quote the subject: a JSON string value EQUAL to one of the patterns (never a substring: erasing
  -- ana@example.test leaves diana@example.test alone, and a phone leaves a longer phone it is the prefix of), and for an alert's
  -- message a whole-word match.
  -- The inbound jobs of the erased messages too: their payload carries the original message id, which embeds the chat id.
  UPDATE public.outbox o SET payload = '{"erased": true}'::jsonb, sealed = NULL, processed_at = coalesce(o.processed_at, v_now)
   WHERE EXISTS (SELECT 1 FROM jsonb_path_query(o.payload, 'strict $.**') v
                  WHERE jsonb_typeof(v) = 'string' AND lower(v #>> '{}') = ANY (v_patterns))
      OR (o.topic = 'waha.inbound' AND o.payload ->> 'inbound_id' = ANY (v_inbound));
  GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('outbox', v_count);
  -- An alert's payload may hold free text (a GlitchTip event's attachments and fields), so each of its JSON string values is
  -- matched like the message, by whole word.
  UPDATE public.alerts a
     SET payload = CASE WHEN EXISTS (SELECT 1 FROM jsonb_path_query(a.payload, 'strict $.**') v
                                      WHERE jsonb_typeof(v) = 'string' AND lower(v #>> '{}') ~ v_boundary)
                        THEN '{"erased": true}'::jsonb ELSE a.payload END,
         message = CASE WHEN lower(a.message) ~ v_boundary THEN 'erased' ELSE a.message END
   WHERE EXISTS (SELECT 1 FROM jsonb_path_query(a.payload, 'strict $.**') v
                  WHERE jsonb_typeof(v) = 'string' AND lower(v #>> '{}') ~ v_boundary)
      OR lower(a.message) ~ v_boundary;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_n := v_n || jsonb_build_object('alerts', v_count);

  v_summary := v_n || jsonb_build_object('player', v_player IS NOT NULL, 'files', cardinality(v_paths));
  UPDATE public.deletion_requests
     SET status = 'completed', completed_at = v_now, decided_by_admin_user_id = p_actor_admin_user_id,
         player_id = coalesce(player_id, v_player), subject_phone = NULL, summary = v_summary, updated_at = v_now
   WHERE id = p_request_id;
  INSERT INTO public.audit_log (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  VALUES ('admin', p_actor_admin_user_id, 'privacy.deletion_execute', 'deletion_request', p_request_id::text, v_summary,
          CASE WHEN v_player IS NULL THEN '{}'::text[] ELSE ARRAY['player:' || v_player::text || ' anonymized'] END
            || ARRAY(SELECT 'order:' || o::text || ' anonymized' FROM unnest(v_orders) o),
          p_request, p_ip);
  RETURN v_summary || jsonb_build_object('request_id', p_request_id, 'erased', true, 'removed_files', to_jsonb(v_paths));
END
$fn$;

ALTER FUNCTION public.erase_data_subject(uuid, text, text, text, inet) OWNER TO pii_eraser;
REVOKE ALL ON FUNCTION public.erase_data_subject(uuid, text, text, text, inet) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
GRANT EXECUTE ON FUNCTION public.erase_data_subject(uuid, text, text, text, inet) TO admin_rw;
