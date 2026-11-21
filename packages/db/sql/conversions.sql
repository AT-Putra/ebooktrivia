-- conversions.sql: the Owner's manual re-fire of a conversion (US-024; spec AC-T3 "failed, with manual re-fire").
--
-- Applied by src/migrate.ts LAST, after contest.sql, as the connecting role (a superuser), like override.sql and
-- contest.sql: the function is owned by conversion_refire (roles.sql: NOLOGIN, no members, member of nothing),
-- which only a superuser can arrange without making migrator a member of it. Re-runnable: roles.sql drops the
-- function (every signature) at the start of every run, and this file creates it again with its owner and grants.
--
-- Why a dedicated owner: the sent-final guard (triggers.sql) refuses to move a conversion the sink acknowledged
-- (`sent`) out of `sent` for EVERY writer, and lets exactly current_user = 'conversion_refire' through, which
-- holds inside this SECURITY DEFINER function and nowhere else (no session can SET ROLE to it; a GUC could be set
-- by any session). admin_rw holds no INSERT, UPDATE or DELETE on conversion_events or conversion_attempts
-- (grants.sql): this function is the Owner's only write to them.
--
-- refire_conversion(id, resend_sent): the ONLY way a conversion that ended `failed` (or, explicitly, `sent`) goes
-- back into the send path. The admin app calls it and records the audit entry in the same transaction. It sets
-- the row pending and due now; the worker then claims it like any other (core conversion-machine), so it is sent
-- once more with the next attempt number. maybe_counted and reported_payout_idr are never cleared: a refund
-- still reverses what the sink may have counted, with the payout it reported. Refused (ET084) when the row is
-- not failed (pending and sending rows are the worker's; a `sent` row only with p_resend_sent = true, for an
-- adnet that says it never received a conversion it acknowledged). A row payments took out of the send path
-- (last_error = 'order_not_paid') may be re-fired once its order is paid NOW: the MT of an order that is not
-- paid is refused by paid_effects_guard (ET080, triggers.sql) whoever asks, so this needs no check of its own.
-- Locks the order (shared) before the row, the order payments takes them in.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

CREATE OR REPLACE FUNCTION public.refire_conversion(p_id uuid, p_resend_sent boolean DEFAULT false)
  RETURNS void
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_order uuid;
  v_status public.conversion_status;
BEGIN
  SELECT c.order_id INTO v_order FROM public.conversion_events c WHERE c.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversion event not found' USING ERRCODE = 'ET010';
  END IF;
  PERFORM 1 FROM public.orders o WHERE o.id = v_order FOR SHARE;
  -- US-030: nothing is re-fired for an order whose buyer asked for their data to be deleted (sql/privacy.sql).
  IF EXISTS (SELECT 1 FROM public.orders o WHERE o.id = v_order AND o.anonymized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the buyer of this order had their data deleted: its conversions are not re-fired' USING ERRCODE = 'ET179';
  END IF;
  SELECT c.status INTO v_status FROM public.conversion_events c WHERE c.id = p_id FOR UPDATE;
  IF NOT (v_status = 'failed' OR (v_status = 'sent' AND coalesce(p_resend_sent, false))) THEN
    RAISE EXCEPTION 'only a failed conversion can be re-fired (a sent one only when explicitly resent)' USING ERRCODE = 'ET084';
  END IF;
  UPDATE public.conversion_events c
     SET status = 'pending', next_attempt_at = clock_timestamp(), lease_until = NULL, failed_at = NULL, sent_at = NULL,
         last_error = NULL, last_http_status = NULL, updated_at = clock_timestamp()
   WHERE c.id = p_id;
END
$fn$;

ALTER FUNCTION public.refire_conversion(uuid, boolean) OWNER TO conversion_refire;

REVOKE ALL ON FUNCTION public.refire_conversion(uuid, boolean) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
GRANT EXECUTE ON FUNCTION public.refire_conversion(uuid, boolean) TO admin_rw;
