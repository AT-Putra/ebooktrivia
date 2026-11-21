-- reports.sql: the metric definitions of the reports and the rollup that computes them (US-029, plan M10;
-- AC-A4, AC-A5, AC-A8). Applied by src/migrate.ts after triggers.sql and before grants.sql (grants.sql holds the
-- one US-029 block that grants these functions and the rollup tables). Re-runnable: every object is CREATE OR
-- REPLACE (no return type changes here).
--
-- Every metric is defined ONCE, here, per order and in whole rupiah:
--   day          the WIB calendar day (UTC+7, no DST) an order was CREATED (its cohort), or a visit happened.
--   source       order_source_adnet: the adnet of an order WITH a click id, else NULL = "Organic" (AC-T8); the
--                label is public.order_source_label (US-024), one label for every report.
--   MO           an order with a Snap payment page (mo_outbox_id) or one that was paid.
--   MT           an order with status 'paid'.
--   revenue      amount_idr of an order with status 'paid'. A refunded order (full refund or chargeback) is not
--                revenue; an order in review (a partial refund, a partial chargeback, a challenge: the money is
--                undecided, Owner decision D5) is not revenue either, and the reports show how many there are.
--                The gateway does not tell us a partial amount, so no part of a partial refund is ever counted.
--   gateway fee  public.gateway_fee_idr: flat + ceil(amount * percent_bps / 10000), whole rupiah, per order, rounded
--                UP (a fee is never understated; the same rule as @ebooktrivia/core gatewayFeeIdr). Charged for every
--                order that was EVER paid (the gateway keeps its fee on a refund). The method comes from the order's
--                payment (midtrans_method_codes), the amounts from the Owner's setting app_settings midtrans.fees.
--                An order that was paid at some point (a refunded one included) whose method has no configured fee costs 0
--                and is counted in fee_missing, so the report says that its ROI is overstated.
--   CPA payout   the payout the S2S MT REPORTED (reported_payout_idr, the snapshot taken at the claim) for an MT the
--                sink may have counted (the sticky maybe_counted mark, or sent), less the same when the sink
--                acknowledged the reversal (status sent). A reversal that is pending, failed or skipped takes nothing back.
-- ROI = revenue - CPA payout - gateway fee - ad spend (core netProfitIdr); ad spend is the Owner's ad_spend rows.
--
-- The functions below are SECURITY INVOKER: they run with the caller's privileges (worker_rw for the rollup, whose
-- table grants are the only reason it can write the rollups).

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

-- The WIB calendar day of an instant.
CREATE OR REPLACE FUNCTION public.wib_day(p_at timestamptz)
  RETURNS date
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT ((p_at AT TIME ZONE 'UTC') + interval '7 hours')::date
$fn$;

-- The adnet an order or visit is attributed to: only with a click id (AC-T8: organic = no click id), else NULL.
CREATE OR REPLACE FUNCTION public.order_source_adnet(p_adnet_id uuid, p_clickid text)
  RETURNS uuid
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE WHEN p_clickid IS NULL OR p_clickid = '' THEN NULL ELSE p_adnet_id END
$fn$;

-- The label of an effective source (order_source_adnet), through order_source_label so no report invents its own.
CREATE OR REPLACE FUNCTION public.report_source_label(p_adnet_id uuid)
  RETURNS text
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT public.order_source_label(p_adnet_id, CASE WHEN p_adnet_id IS NULL THEN NULL ELSE 'x' END)
$fn$;

-- flat + ceil(amount * bps / 10000): whole rupiah, the percentage rounded up. numeric: no overflow, no float.
CREATE OR REPLACE FUNCTION public.gateway_fee_idr(p_amount bigint, p_flat bigint, p_bps integer)
  RETURNS bigint
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT p_flat + ceil(p_amount::numeric * p_bps / 10000)::bigint
$fn$;

-- The Snap method codes (core MIDTRANS_METHODS, the keys of midtrans.fees) a stored Midtrans payment_type may be.
-- Checked against the sandbox in US-005 (docs/spikes/R12.md, 2026-11-21). payments keeps only payment_type, not
-- the bank of a virtual account, so a bank_transfer may be any virtual-account code: the dearest configured one
-- applies (never understate). A type that is its own code (gopay, shopeepay, echannel, credit_card, akulaku,
-- kredivo) maps to itself; an unknown type maps to a code that is not configured, so it counts as fee_missing.
-- qris is TWO codes (Owner-approved, US-005): the QRIS tile (other_qris) AND the GoPay tile (gopay), because on
-- a desktop the GoPay tile shows a QR that Midtrans records as payment_type qris (acquirer gopay). A method the
-- Owner switched off keeps its fee here: an old order paid with it is still priced (fees are never dropped).
CREATE OR REPLACE FUNCTION public.midtrans_method_codes(p_payment_type text)
  RETURNS text[]
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE p_payment_type
           WHEN 'qris' THEN ARRAY['other_qris', 'gopay']
           WHEN 'bank_transfer' THEN ARRAY['bca_va', 'bni_va', 'bri_va', 'permata_va', 'cimb_va', 'other_va']
           WHEN 'cstore' THEN ARRAY['indomaret']
           ELSE CASE WHEN p_payment_type IS NULL THEN ARRAY[]::text[] ELSE ARRAY[p_payment_type] END
         END
$fn$;

-- Recomputes the report rollups (report_orders_daily, report_visits_daily, report_rollup_state), in the caller's
-- transaction. The worker calls it every 5 minutes. Idempotent, and safe under concurrency: the whole refresh holds
-- one transactional advisory lock, so a second concurrent call returns {"refreshed": false} at once and changes
-- nothing (the UNIQUE keys of the tables are the second line: two writers could never both keep a group).
-- The lock key (hashtextextended of a fixed string) is well known, and a session that can run SQL as an app role could
-- hold it: the whole impact is STALE FIGURES, which every report shows (the "as of" time and a warning after 15 minutes);
-- no figure can be forged through it and no data is exposed.
--   orders  BOUNDED recompute, so a refresh costs what changed, not the whole history. Rebuilt, whole days at a time
--           (delete the day's rows, insert them again): (1) every WIB day in a TRAILING WINDOW of p_window_days days
--           ending today (default 120: late payments, refunds and conversions land within it), and (2) every older
--           day that was TOUCHED since the last refresh: a day an order was created on whose order, payment or
--           conversion row has updated_at at or after (the last refresh's start - 15 minutes). The margin covers a
--           writer whose transaction began before the last refresh and committed after it: no session of an app
--           role stays idle inside a transaction for more than 10 minutes (idle_in_transaction_session_timeout, the
--           database default set by roles.sql), so a commit lags its statement by less than the margin. Days older than the window and
--           untouched are frozen: not read, not rewritten. Everything is rebuilt (a full recompute) on the first run
--           and whenever the Owner's gateway fee setting (app_settings midtrans.fees) differs from the one the last
--           refresh used, because a fee change re-prices every day, and whenever a row of orders, payments or
--           conversion_events was DELETED (report_mark_full_rebuild below sets that state to NULL), and once after
--           every migrate (the last statement of this file): a changed definition re-prices everything. A writer
--           that forgets to bump updated_at cannot hide a change: report_touch_updated_at (below) stamps it whenever
--           a column a report reads changed.
--   visits  INCREMENTAL: visits are append-only, so only the days from the one before the last refresh's day on
--           are rebuilt (a refresh that missed days rebuilds from where it stopped); the first run builds them all.
-- Returns {"refreshed": true, "as_of": ..., "order_rows": n, "visit_rows": n, "full": bool}.
DROP FUNCTION IF EXISTS public.refresh_report_rollups(timestamptz);
CREATE OR REPLACE FUNCTION public.refresh_report_rollups(p_now timestamptz DEFAULT pg_catalog.clock_timestamp(), p_window_days integer DEFAULT 120)
  RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_started timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.wib_day(p_now);
  v_as_of timestamptz;
  v_prev_fees jsonb;
  v_through date;
  v_from date;
  v_fees jsonb;
  v_full boolean;
  v_window_day date;
  v_window_start timestamptz;
  v_touched date[] := '{}';
  v_order_rows integer;
  v_visit_rows integer;
BEGIN
  IF p_window_days IS NULL OR p_window_days < 1 OR p_window_days > 3650 THEN
    RAISE EXCEPTION 'refresh_report_rollups: the window is 1 to 3650 days' USING ERRCODE = '22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('ebooktrivia.report_rollups', 0)) THEN
    RETURN pg_catalog.jsonb_build_object('refreshed', false);
  END IF;

  SELECT s.value INTO v_fees FROM public.app_settings s WHERE s.key = 'midtrans.fees';
  IF v_fees IS NULL OR pg_catalog.jsonb_typeof(v_fees) <> 'object' THEN
    v_fees := '{}'::jsonb;
  END IF;

  SELECT s.as_of, s.visits_through_day, s.fees INTO v_as_of, v_through, v_prev_fees FROM public.report_rollup_state s WHERE s.id;
  v_full := NOT FOUND OR v_prev_fees IS DISTINCT FROM v_fees;
  v_window_day := CASE WHEN v_full THEN date '2000-01-01' ELSE v_today - p_window_days END;
  v_window_start := ((v_window_day::timestamp - interval '7 hours') AT TIME ZONE 'UTC');

  IF NOT v_full THEN
    SELECT coalesce(pg_catalog.array_agg(DISTINCT t.d), '{}') INTO v_touched FROM (
      SELECT public.wib_day(o.created_at) AS d FROM public.orders o
       WHERE o.updated_at >= v_as_of - interval '15 minutes' AND o.created_at < v_window_start
      UNION
      SELECT public.wib_day(o.created_at) FROM public.conversion_events ce JOIN public.orders o ON o.id = ce.order_id
       WHERE ce.updated_at >= v_as_of - interval '15 minutes' AND o.created_at < v_window_start
      UNION
      SELECT public.wib_day(o.created_at) FROM public.payments p JOIN public.orders o ON o.id = p.order_id
       WHERE p.updated_at >= v_as_of - interval '15 minutes' AND o.created_at < v_window_start
    ) t;
  END IF;

  DELETE FROM public.report_orders_daily WHERE day >= v_window_day OR day = ANY (v_touched);
  WITH ranges AS (
    SELECT v_window_start AS s, 'infinity'::timestamptz AS e
    UNION ALL
    SELECT ((d::timestamp - interval '7 hours') AT TIME ZONE 'UTC'), (((d + 1)::timestamp - interval '7 hours') AT TIME ZONE 'UTC')
      FROM pg_catalog.unnest(v_touched) AS d
  ), raw_fees AS (
    SELECT f.key AS code,
           CASE WHEN (f.value ->> 'flat_idr') ~ '^[0-9]{1,9}$' THEN (f.value ->> 'flat_idr')::bigint END AS flat_idr,
           CASE WHEN (f.value ->> 'percent_bps') ~ '^[0-9]{1,5}$' THEN (f.value ->> 'percent_bps')::integer END AS percent_bps
      FROM pg_catalog.jsonb_each(v_fees) f
     WHERE pg_catalog.jsonb_typeof(f.value) = 'object'
  ), fees AS (
    SELECT code, flat_idr, percent_bps FROM raw_fees WHERE flat_idr IS NOT NULL AND percent_bps BETWEEN 0 AND 10000
  ), per_order AS (
    SELECT public.wib_day(o.created_at) AS day, o.landing_page_id, o.program_id,
           public.order_source_adnet(o.adnet_id, o.clickid) AS adnet_id,
           pg_catalog.lower(pg_catalog.btrim(coalesce(o.utm_campaign, ''))) AS utm_campaign,
           o.status, o.amount_idr,
           (o.mo_outbox_id IS NOT NULL OR o.paid_at IS NOT NULL OR o.status = 'paid') AS is_mo,
           (o.paid_at IS NOT NULL OR o.status = 'paid') AS ever_paid,
           fee.fee_idr,
           CASE WHEN (mt.maybe_counted OR mt.status = 'sent') AND coalesce(rv.status <> 'sent', true)
                THEN coalesce(mt.reported_payout_idr, 0) ELSE 0 END AS payout_idr
      FROM ranges r
      JOIN public.orders o ON o.created_at >= r.s AND o.created_at < r.e
      LEFT JOIN LATERAL (
        SELECT p.payment_type FROM public.payments p WHERE p.order_id = o.id
         ORDER BY (p.settled_at IS NULL), p.settled_at, p.created_at, p.id LIMIT 1
      ) pay ON true
      LEFT JOIN LATERAL (
        SELECT pg_catalog.max(public.gateway_fee_idr(o.amount_idr, f.flat_idr, f.percent_bps)) AS fee_idr
          FROM pg_catalog.unnest(public.midtrans_method_codes(pay.payment_type)) AS c(code)
          JOIN fees f ON f.code = c.code
      ) fee ON (o.paid_at IS NOT NULL OR o.status = 'paid')
      LEFT JOIN public.conversion_events mt ON mt.order_id = o.id AND mt.sink = 's2s' AND mt.kind = 'mt'
      LEFT JOIN public.conversion_events rv ON rv.order_id = o.id AND rv.sink = 's2s' AND rv.kind = 'reversal'
  )
  INSERT INTO public.report_orders_daily
    (day, landing_page_id, program_id, adnet_id, utm_campaign, status, orders, mo, mt, amount_idr, revenue_idr, fee_idr, fee_missing, payout_idr)
  SELECT day, landing_page_id, program_id, adnet_id, utm_campaign, status,
         pg_catalog.count(*)::integer,
         (pg_catalog.count(*) FILTER (WHERE is_mo))::integer,
         (pg_catalog.count(*) FILTER (WHERE status = 'paid'))::integer,
         pg_catalog.sum(amount_idr)::bigint,
         coalesce(pg_catalog.sum(amount_idr) FILTER (WHERE status = 'paid'), 0)::bigint,
         coalesce(pg_catalog.sum(fee_idr), 0)::bigint,
         (pg_catalog.count(*) FILTER (WHERE ever_paid AND fee_idr IS NULL))::integer,
         coalesce(pg_catalog.sum(payout_idr), 0)::bigint
    FROM per_order
   GROUP BY day, landing_page_id, program_id, adnet_id, utm_campaign, status;
  GET DIAGNOSTICS v_order_rows = ROW_COUNT;

  v_from := coalesce(v_through - 1, date '2000-01-01');
  DELETE FROM public.report_visits_daily WHERE day >= v_from;
  INSERT INTO public.report_visits_daily (day, landing_page_id, adnet_id, visits)
  SELECT public.wib_day(v.occurred_at), v.landing_page_id, public.order_source_adnet(v.adnet_id, v.clickid), (pg_catalog.count(*))::integer
    FROM public.visits v
   WHERE v.occurred_at >= ((v_from::timestamp - interval '7 hours') AT TIME ZONE 'UTC')
   GROUP BY 1, 2, 3;
  GET DIAGNOSTICS v_visit_rows = ROW_COUNT;

  INSERT INTO public.report_rollup_state (id, as_of, visits_through_day, fees, duration_ms, order_rows, visit_rows)
  VALUES (true, v_started, v_today, v_fees, (extract(epoch FROM pg_catalog.clock_timestamp() - v_started) * 1000)::integer, v_order_rows, v_visit_rows)
  ON CONFLICT (id) DO UPDATE
     SET as_of = EXCLUDED.as_of, visits_through_day = EXCLUDED.visits_through_day, duration_ms = EXCLUDED.duration_ms,
         order_rows = EXCLUDED.order_rows, visit_rows = EXCLUDED.visit_rows,
         -- A full-rebuild request (a delete, or the reset a migrate makes) that committed WHILE this refresh ran must survive it:
         -- if the stored fees are no longer the ones this refresh read at its start, someone changed them since, so keep theirs.
         -- (No row lock: a SELECT ... FOR UPDATE here would stall every writer of orders during a migrate.)
         fees = CASE WHEN public.report_rollup_state.fees IS DISTINCT FROM v_prev_fees THEN public.report_rollup_state.fees ELSE EXCLUDED.fees END;

  RETURN pg_catalog.jsonb_build_object('refreshed', true, 'as_of', v_started, 'order_rows', v_order_rows, 'visit_rows', v_visit_rows, 'full', v_full);
END
$fn$;

REVOKE ALL ON FUNCTION public.wib_day(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.order_source_adnet(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_source_label(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gateway_fee_idr(bigint, bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.midtrans_method_codes(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_report_rollups(timestamptz, integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Frozen days must never miss a change. The bounded refresh finds the old days to rebuild by updated_at, so:
--   - report_touch_updated_at (BEFORE UPDATE, a WHEN clause naming only the columns a report reads) stamps updated_at
--     when the writer left it alone: a writer that forgets cannot hide a change. Other columns do not stamp it
--     (claim_browser_mt deliberately leaves orders.updated_at alone: a claim is not a change of the order). It is named
--     so that it fires AFTER every other BEFORE trigger of these tables (alphabetical order) and sees their final NEW.
--   - report_mark_full_rebuild (AFTER DELETE, per statement) makes the next refresh a full rebuild: a deleted row leaves
--     no updated_at behind. SECURITY DEFINER (it writes the one state row for whoever deleted), search_path pinned.
CREATE OR REPLACE FUNCTION public.report_touch_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.report_mark_full_rebuild()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  UPDATE public.report_rollup_state SET fees = 'null'::pg_catalog.jsonb;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.report_touch_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_mark_full_rebuild() FROM PUBLIC;

CREATE OR REPLACE TRIGGER report_touch_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW WHEN ((OLD.status, OLD.paid_at, OLD.refunded_at, OLD.amount_idr, OLD.adnet_id, OLD.clickid, OLD.utm_campaign, OLD.mo_outbox_id, OLD.landing_page_id, OLD.program_id, OLD.created_at)
                     IS DISTINCT FROM (NEW.status, NEW.paid_at, NEW.refunded_at, NEW.amount_idr, NEW.adnet_id, NEW.clickid, NEW.utm_campaign, NEW.mo_outbox_id, NEW.landing_page_id, NEW.program_id, NEW.created_at))
  EXECUTE FUNCTION public.report_touch_updated_at();
CREATE OR REPLACE TRIGGER report_touch_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW WHEN ((OLD.payment_type, OLD.settled_at, OLD.order_id, OLD.created_at) IS DISTINCT FROM (NEW.payment_type, NEW.settled_at, NEW.order_id, NEW.created_at))
  EXECUTE FUNCTION public.report_touch_updated_at();
CREATE OR REPLACE TRIGGER report_touch_updated_at
  BEFORE UPDATE ON public.conversion_events
  FOR EACH ROW WHEN ((OLD.status, OLD.kind, OLD.sink, OLD.order_id, OLD.adnet_id, OLD.maybe_counted, OLD.reported_payout_idr)
                     IS DISTINCT FROM (NEW.status, NEW.kind, NEW.sink, NEW.order_id, NEW.adnet_id, NEW.maybe_counted, NEW.reported_payout_idr))
  EXECUTE FUNCTION public.report_touch_updated_at();

CREATE OR REPLACE TRIGGER report_mark_full_rebuild
  AFTER DELETE ON public.orders FOR EACH STATEMENT EXECUTE FUNCTION public.report_mark_full_rebuild();
CREATE OR REPLACE TRIGGER report_mark_full_rebuild
  AFTER DELETE ON public.payments FOR EACH STATEMENT EXECUTE FUNCTION public.report_mark_full_rebuild();
CREATE OR REPLACE TRIGGER report_mark_full_rebuild
  AFTER DELETE ON public.conversion_events FOR EACH STATEMENT EXECUTE FUNCTION public.report_mark_full_rebuild();

-- Like every guard of triggers.sql, these fire in ALL session_replication_role modes (that file's ALWAYS pass ran before this one).
ALTER TABLE public.orders ENABLE ALWAYS TRIGGER report_touch_updated_at;
ALTER TABLE public.payments ENABLE ALWAYS TRIGGER report_touch_updated_at;
ALTER TABLE public.conversion_events ENABLE ALWAYS TRIGGER report_touch_updated_at;
ALTER TABLE public.orders ENABLE ALWAYS TRIGGER report_mark_full_rebuild;
ALTER TABLE public.payments ENABLE ALWAYS TRIGGER report_mark_full_rebuild;
ALTER TABLE public.conversion_events ENABLE ALWAYS TRIGGER report_mark_full_rebuild;

-- Every migrate may have changed a definition above (a metric, a method map, a fee rule): the next refresh rebuilds every day once.
UPDATE public.report_rollup_state SET fees = 'null'::pg_catalog.jsonb;
