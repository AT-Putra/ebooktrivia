-- delivery-resend.sql: the explicit resend of a delivery that failed or may have been sent (US-025, completed by US-029; spec AC-A1: Staff may manage resends).
--
-- Applied by src/migrate.ts LAST, after conversions.sql, as the connecting role (a superuser), like override.sql, contest.sql and conversions.sql: the function
-- is owned by delivery_resend (roles.sql: NOLOGIN, no members, member of nothing), which only a superuser can arrange without making migrator a member of it.
-- Re-runnable: roles.sql drops the function (every signature) at the start of every run, and this file creates it again with its owner and grants.
--
-- Why a dedicated owner: the final guard of deliveries (triggers.sql, ET130) refuses to put a delivery that went out (`sent`), may have (`unknown`) or failed
-- for good (`failed`) back on the send path for EVERY writer, and lets exactly current_user = 'delivery_resend' through, which holds inside this SECURITY
-- DEFINER function and nowhere else (no session can SET ROLE to it; a GUC could be set by any session). admin_rw holds no INSERT, UPDATE or DELETE on
-- deliveries (grants.sql): this function is the console's only write to them.
--
-- resend_delivery(id, confirm_unknown): puts a delivery back to `pending`, due now, with a fresh retry budget and no numbers tried, so the worker sends it again like
-- a fresh one (an e-mail at once; a WhatsApp PDF when the buyer writes: the buyer-first path claims the row, Owner decision D7). `attempts` is NEVER reset: it only
-- ever increases, and the retry budget is `attempts - attempts_base`, so the resend moves attempts_base up to attempts. That way a stale finisher of an old claim
-- (one still holding attempt 3 when the row was resent) can never record its outcome onto the new claim (core recordDeliveryOutcome compares attempt numbers).
-- It returns the status the delivery had, for the audit entry the admin app writes in the same transaction. Which role may call it is the app's rule (Staff: a `failed` delivery;
-- the Owner: an `unknown` one, with confirm_unknown = true); the DATABASE refuses what no caller may do:
--   ET010 the delivery does not exist;
--   ET133 only a `failed` or an `unknown` delivery is resent (a `sent` one is the buyer's to ask for again, a pending / sending one is the worker's);
--   ET134 the delivery's lease has not ended (lease_until in the future): a send may still be running, and an unknown delivery keeps its lease until the unknown-send
--         lookup has had its chance;
--   ET132 an `unknown` delivery (a send that MAY have gone out: a timeout, a connection reset, an answer that was lost) is never resent without
--         p_confirm_unknown = true: the buyer may already have the message, and a second one is a second ebook / a second login link;
--   ET080 (the paid guard of deliveries) the order is not paid, so nothing is sent for it, whoever asks.
-- Locks the order (shared) before the row, the order payments takes them in. The opener of a WhatsApp delivery is untouched (ET131: it is exactly-once on its
-- own, and a buyer's reply to it, or the order page's WhatsApp button, is what sends the PDF).

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

CREATE OR REPLACE FUNCTION public.resend_delivery(p_id uuid, p_confirm_unknown boolean DEFAULT false)
  RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_order uuid;
  v_status text;
  v_lease timestamptz;
BEGIN
  SELECT d.order_id INTO v_order FROM public.deliveries d WHERE d.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery not found' USING ERRCODE = 'ET010';
  END IF;
  PERFORM 1 FROM public.orders o WHERE o.id = v_order FOR SHARE;
  -- US-030: nothing is sent for an order whose buyer asked for their data to be deleted (sql/privacy.sql): it has no contact left.
  IF EXISTS (SELECT 1 FROM public.orders o WHERE o.id = v_order AND o.anonymized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the buyer of this order had their data deleted: nothing is sent for it' USING ERRCODE = 'ET179';
  END IF;
  SELECT d.status, d.lease_until INTO v_status, v_lease FROM public.deliveries d WHERE d.id = p_id FOR UPDATE;
  IF v_status NOT IN ('failed', 'unknown') THEN
    RAISE EXCEPTION 'only a failed or an unknown delivery can be resent' USING ERRCODE = 'ET133';
  END IF;
  IF v_lease IS NOT NULL AND v_lease > pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'a send of this delivery may still be running: resend it after its lease has ended' USING ERRCODE = 'ET134';
  END IF;
  IF v_status = 'unknown' AND NOT coalesce(p_confirm_unknown, false) THEN
    RAISE EXCEPTION 'a delivery that may have been sent is resent only on explicit confirmation' USING ERRCODE = 'ET132';
  END IF;
  UPDATE public.deliveries d
     SET status = 'pending', not_before = clock_timestamp(), lease_until = NULL, session_id = NULL, tried_session_ids = '{}', attempts_base = d.attempts,
         last_error = NULL, sent_at = NULL, updated_at = clock_timestamp()
   WHERE d.id = p_id;
  RETURN v_status;
END
$fn$;

ALTER FUNCTION public.resend_delivery(uuid, boolean) OWNER TO delivery_resend;

REVOKE ALL ON FUNCTION public.resend_delivery(uuid, boolean) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
GRANT EXECUTE ON FUNCTION public.resend_delivery(uuid, boolean) TO admin_rw;
