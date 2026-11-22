-- order-review.sql: the Owner's decision on an order in review, "mark paid" or "not paid" (US-033, M10c; plan M6.4, §10 items 8
-- and 17; Owner decisions D5 and D9).
--
-- Applied by src/migrate.ts LAST, after play.sql, as the connecting role (a superuser), like override.sql, contest.sql,
-- conversions.sql, delivery-resend.sql and play.sql: the function is owned by order_review (roles.sql: NOLOGIN, no members,
-- member of nothing), which only a superuser can arrange without making migrator a member of it. Re-runnable: roles.sql drops
-- the function (every signature) at the start of every run, and this file creates it again with its owner and grants.
--
-- Why a dedicated owner: the console's login (admin_rw) holds no UPDATE or DELETE of orders and no write on the attempts, the
-- payments ledger, the decision ledger, player_programs, deliveries, conversions or magic links (grants.sql; it still INSERTs
-- manual orders). This function is its ONLY way to move an order out of `review`; the order status guard lets
-- current_user = 'order_review' through and the ledger guard (ET187) lets nobody else write the ledger. EXECUTE: admin_rw only;
-- the app asks policy.ts `order.review.resolve` (Owner).
--
-- order_review_decide(order, decision, confirm, reason, request_key, actor, request_id, ip), in the caller's transaction
-- (READ COMMITTED, ET180 otherwise):
--   1. checks the arguments: decision 'paid' or 'not_paid' and the ids (ET180), a reason of 10-500 characters without an
--      e-mail address or a phone number (ET181: the audit log and the ledger hold no PII), an actor who is an active Owner (ET182);
--   2. locks the order row (FOR UPDATE), then its Midtrans attempts: the lock order of the payment code (payments.ts
--      applyRequery: the order, then its attempt) and of the checkout. Whoever takes the order's lock second sees what the
--      first committed: a late notification or the nightly reconciliation that moved the order first makes this refuse, and a
--      decision that went first is honoured by them (below). Unknown order: ET183;
--   3. the typed confirmation must equal the order's public id (ET185);
--   4. idempotency: a request_key already in the ledger for this order and decision answers that decision's result again,
--      changing nothing (a double click, a replayed POST); for another order or decision it is refused (ET184);
--   5. refuses unless the order is still `review` (ET186: decided already, or a Midtrans event moved it meanwhile);
--   6. "mark paid": order -> paid, paid_at stamped once (coalesce; orders_payment_stamps_guard ET081), then the PAID effects
--      through public.order_paid_effects (functions.sql), the SAME implementation the payment code runs: the player,
--      eligibility and first_paid_at from the orders still paid, deliveries and MT rows created on their exactly-once keys,
--      the rows payments cancelled with 'order_not_paid' (and only those) back to pending, the `order.paid` outbox once.
--      Magic links the D9 reversal deleted are not re-created (nothing issues a link here): the buyer is eligible again, so a
--      WhatsApp OTP or the login page's self-service resend logs them in. A winner flagged when the order left PAID stays flagged
--      (re-award / reinstate is the contest's own audited tool); the result counts them;
--      "not paid": order -> gateway_failed (terminal and unpaid: no Snap attempt is ever added to it, the buyer's order page
--      says failed, and the order machine still takes a LATER confirmed settlement to PAID, plan §10 item 8), eligibility and
--      first_paid_at recomputed from the orders still paid, the reversal rows of the MTs that may have reached their sink
--      (public.order_reversal_rows, as a refund), and the buyer's live magic links deleted only when no eligible program is
--      left (public.revoke_player_magic_links). Nothing can go out afterwards: the deliveries and MTs of the order were taken
--      out of the send path when it entered review, and paid_effects_guard (ET080) refuses any of them back to pending or
--      sending, and any new one, while the order is not paid, whoever asks;
--   7. records the decision (order_owner_decisions, append-only) with the fingerprint of every attempt's last re-queried
--      Midtrans status: the payment code and the reconciliation honour it while that status is unchanged, and process a
--      different status (a new Midtrans event) normally;
--      An order whose buyer was erased (orders.anonymized_at, US-030; a settlement of it is routed here by payments.ts) is
--      "keep the money, no fulfilment" on "mark paid": paid and paid_at as above, and no effect at all (fulfilment = skipped);
--   8. resolves the order's open review alerts (core REVIEW_ALERT_KINDS: payment_review, payment_paid_reversed,
--      payment_settlement_review, reconciliation_mismatch, order_review_stuck, order_decision_superseded,
--      payment_on_erased_order); a chargeback or a flagged winner keeps its own alert;
--   9. writes the audit row (actor, request id, ip; the status change, the decision, the reason and the effects; no PII);
--  10. returns {decision_id, decision, to_status, replayed, player_id, eligible, first_paid_at, ...the effect counts}.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

CREATE OR REPLACE FUNCTION public.order_review_decide(
  p_order_id uuid,
  p_decision text,
  p_confirm text,
  p_reason text,
  p_request_key uuid,
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
  o record;
  v_prior record;
  v_now timestamptz;
  v_to public.order_status;
  v_attempts jsonb;
  v_effects jsonb;
  v_player uuid;
  v_eligible boolean;
  v_first_paid timestamptz;
  v_reversals integer := 0;
  v_revoked integer := 0;
  v_flagged integer := 0;
  v_alerts integer;
  v_decision uuid;
  v_result jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the review decision must run under READ COMMITTED' USING ERRCODE = 'ET180';
  END IF;
  IF p_order_id IS NULL OR p_request_key IS NULL OR p_decision IS NULL OR p_decision NOT IN ('paid', 'not_paid') THEN
    RAISE EXCEPTION 'order_review_decide: the order, a decision (paid or not_paid) and a request key are required' USING ERRCODE = 'ET180';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 10 AND 500
     OR p_reason ~ '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+'
     OR p_reason ~ '(\+?62[[:space:].-]?|\m0)8[0-9[:space:].-]{7,}|[0-9]{10,}' THEN
    RAISE EXCEPTION 'order_review_decide: the reason is 10-500 characters without contact details' USING ERRCODE = 'ET181';
  END IF;
  IF p_actor_admin_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.admin_profiles ap
     WHERE ap.auth_user_id = p_actor_admin_user_id AND ap.role = 'owner' AND ap.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'order_review_decide: the actor must be an active Owner' USING ERRCODE = 'ET182';
  END IF;

  SELECT x.id, x.public_id, x.status, x.player_id, x.program_id, x.anonymized_at IS NOT NULL AS erased INTO o FROM public.orders x WHERE x.id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_review_decide: unknown order' USING ERRCODE = 'ET183';
  END IF;
  IF p_confirm IS DISTINCT FROM o.public_id THEN
    RAISE EXCEPTION 'order_review_decide: the confirmation does not match the order' USING ERRCODE = 'ET185';
  END IF;
  SELECT d.order_id, d.decision, d.effects INTO v_prior FROM public.order_owner_decisions d WHERE d.request_key = p_request_key;
  IF FOUND THEN
    IF v_prior.order_id <> o.id OR v_prior.decision <> p_decision THEN
      RAISE EXCEPTION 'order_review_decide: this request was used for another decision' USING ERRCODE = 'ET184';
    END IF;
    RETURN v_prior.effects || jsonb_build_object('replayed', true);
  END IF;
  IF o.status <> 'review' THEN
    RAISE EXCEPTION 'order_review_decide: the order is no longer in review (it is %)', o.status USING ERRCODE = 'ET186';
  END IF;

  PERFORM 1 FROM public.midtrans_attempts a WHERE a.order_id = o.id ORDER BY a.n FOR UPDATE;
  SELECT coalesce(jsonb_agg(jsonb_build_object('n', a.n, 'status', a.gateway_status, 'fraud', a.gateway_fraud_status) ORDER BY a.n), '[]'::jsonb)
    INTO v_attempts FROM public.midtrans_attempts a WHERE a.order_id = o.id;
  v_now := clock_timestamp();

  IF p_decision = 'paid' THEN
    v_to := 'paid';
    UPDATE public.orders x SET status = 'paid', paid_at = coalesce(x.paid_at, v_now), updated_at = v_now WHERE x.id = o.id AND x.status = 'review';
    IF o.erased THEN
      -- US-033 (after US-030): the buyer was erased (UU PDP), so "mark paid" keeps the money and fulfils nothing: no player (one from
      -- the emptied phone is refused), no eligibility, no delivery, no conversion, no order.paid job, and no revive of a row the
      -- payment code held back. The ledger says so (fulfilment = skipped).
      v_effects := jsonb_build_object('player_id', NULL, 'eligible', false, 'fulfilment', 'skipped');
    ELSE
      -- The WhatsApp delay is the admin setting delivery.wa_delay_seconds, which seed.sql seeds (180 s) and the console only
      -- edits (admin_rw has no DELETE on app_settings). 180000 stands in only if the row was removed by hand: core
      -- WA_PROACTIVE_DELAY_MS, the worker's own default (apps/worker test/order-review.int.test.ts pins the two equal).
      v_effects := public.order_paid_effects(o.id, v_now, 180000) || jsonb_build_object('fulfilment', 'done');
    END IF;
    v_player := (v_effects ->> 'player_id')::uuid;
    v_eligible := (v_effects ->> 'eligible')::boolean;
  ELSE
    v_to := 'gateway_failed';
    UPDATE public.orders x SET status = 'gateway_failed', updated_at = v_now WHERE x.id = o.id AND x.status = 'review';
    v_player := o.player_id;
    v_eligible := v_player IS NOT NULL AND public.refresh_player_eligibility(v_player, o.program_id, v_now, false);
    v_reversals := public.order_reversal_rows(o.id, v_now);
    IF v_player IS NOT NULL THEN
      v_revoked := public.revoke_player_magic_links(v_player);
    END IF;
    v_effects := jsonb_build_object('player_id', v_player, 'eligible', v_eligible);
  END IF;
  IF v_player IS NOT NULL THEN
    SELECT pp.first_paid_at INTO v_first_paid FROM public.player_programs pp WHERE pp.player_id = v_player AND pp.program_id = o.program_id;
    SELECT count(*)::integer INTO v_flagged FROM public.winners w
     WHERE w.player_id = v_player AND w.program_id = o.program_id AND w.status = 'flagged';
  END IF;

  UPDATE public.alerts al SET resolved_at = v_now
   WHERE al.resolved_at IS NULL AND al.payload ->> 'order_id' = o.id::text
     AND al.kind IN ('payment_review', 'payment_paid_reversed', 'payment_settlement_review', 'reconciliation_mismatch', 'order_review_stuck',
                     'order_decision_superseded', 'payment_on_erased_order');
  GET DIAGNOSTICS v_alerts = ROW_COUNT;

  v_decision := gen_random_uuid();
  v_result := v_effects || jsonb_build_object(
    'decision_id', v_decision, 'decision', p_decision, 'to_status', v_to::text, 'first_paid_at', v_first_paid,
    'reversals_created', v_reversals, 'magic_links_revoked', v_revoked, 'winners_flagged', v_flagged, 'alerts_resolved', v_alerts);
  INSERT INTO public.order_owner_decisions (id, order_id, decision, from_status, to_status, attempts, reason, decided_by_admin_user_id, request_key, effects, decided_at)
  VALUES (v_decision, o.id, p_decision, 'review', v_to, v_attempts, btrim(p_reason), p_actor_admin_user_id, p_request_key, v_result, v_now);
  INSERT INTO public.audit_log (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, request_id, ip)
  VALUES ('admin', p_actor_admin_user_id, 'order.review.decide', 'order', o.id::text,
          jsonb_build_object('status', jsonb_build_object('before', 'review', 'after', v_to::text), 'decision', p_decision,
                             'reason', btrim(p_reason), 'attempts', v_attempts, 'effects', v_result - 'player_id'),
          p_request_id, p_ip);
  RETURN v_result || jsonb_build_object('replayed', false);
END
$fn$;

ALTER FUNCTION public.order_review_decide(uuid, text, text, text, uuid, text, text, inet) OWNER TO order_review;

REVOKE ALL ON FUNCTION public.order_review_decide(uuid, text, text, text, uuid, text, text, inet) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
GRANT EXECUTE ON FUNCTION public.order_review_decide(uuid, text, text, text, uuid, text, text, inet) TO admin_rw;
