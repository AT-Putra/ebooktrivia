-- grants.sql: the complete privilege set of the app roles (applied as migrator, last but seeds).
--
-- Authoritative: everything is revoked first and then granted, in one transaction, so a re-run
-- removes any grant that is not listed here. A table added later gets NO access until it is
-- listed below (admin_rw excepted: it gets every table by design).
-- test/__snapshots__/roles.int.test.ts.snap pins the resulting privilege matrix, and the column
-- lists of every table granted at table level to public_rw / internal_rw. The database and
-- schema public privileges, and role memberships, are reset by roles.sql.
--
-- Summary (plan M2.2):
--   public_rw   reads the catalog; writes play/player data, orders, visits, consents; never
--               INSERTs outbox (enqueue_* only); payment secrets only via get_payment_secret();
--               no admin_auth, audit_log, ad_spend, settings_secrets, otp_enqueues.
--   admin_rw    everything except UPDATE/DELETE/TRUNCATE on audit_log (and no TRUNCATE at all).
--   worker_rw   what jobs need: outbox, deliveries, conversions, waha_*, payments and order state,
--               eligibility, finalize/snapshot, alerts, heartbeats.
--   internal_rw SELECT lp_domains, INSERT alerts. Nothing else.
-- No app role may choose audit_log.id (OVERRIDING SYSTEM VALUE) or occurred_at: INSERT on
-- audit_log is granted per column.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

REVOKE ALL ON ALL TABLES IN SCHEMA public, player_auth, admin_auth
  FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, player_auth, admin_auth
  FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public
  FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw;
REVOKE ALL ON SCHEMA player_auth, admin_auth, drizzle
  FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw;

GRANT USAGE ON SCHEMA player_auth TO public_rw, admin_rw;
GRANT USAGE ON SCHEMA admin_auth TO admin_rw;

-- ---------------------------------------------------------------------------------------------
-- public_rw (apps/public: checkout, webhooks, play, order status, player auth)

GRANT SELECT ON
  public.products, public.programs, public.trivia_sets, public.questions, public.question_options,
  public.prize_tiers, public.legal_pages, public.landing_pages, public.landing_page_adnets,
  public.lp_domains, public.app_settings, public.uploads, public.leaderboard_snapshots,
  public.winners, public.player_programs
  TO public_rw;
GRANT SELECT (id, slug, name, clickid_param, active) ON public.adnets TO public_rw;
GRANT SELECT (id, phone, status, active) ON public.waha_sessions TO public_rw;

GRANT SELECT ON public.players TO public_rw;
GRANT UPDATE (auth_user_id, name, email, updated_at) ON public.players TO public_rw;

GRANT SELECT, INSERT, DELETE ON public.player_otps TO public_rw;
GRANT UPDATE (attempts) ON public.player_otps TO public_rw;

GRANT SELECT ON public.magic_links TO public_rw;
GRANT UPDATE (consumed_at) ON public.magic_links TO public_rw;

-- Play rows: INSERT gated by the *_play_guard triggers (eligible player, published program);
-- UPDATE only of the progress columns, so a row cannot be moved to another player/set/question.
GRANT SELECT, INSERT ON public.set_attempts, public.attempt_questions, public.player_program_stats
  TO public_rw;
GRANT UPDATE (finished_at, score, total_ms) ON public.set_attempts TO public_rw;
GRANT UPDATE (served_at, deadline_at, answered_at, option_id, correct, points, elapsed_ms, ip, ua_hash)
  ON public.attempt_questions TO public_rw;
GRANT UPDATE (score, total_ms, sets_completed, finished_at, updated_at) ON public.player_program_stats
  TO public_rw;

GRANT SELECT, INSERT ON public.visits, public.consents TO public_rw;

-- orders: no paid_at/refunded_at/mo_outbox_id; status limited by the orders_status_guard trigger.
GRANT SELECT ON public.orders TO public_rw;
GRANT INSERT (
  id, public_id, order_code, landing_page_id, program_id, product_id, player_id,
  buyer_name, buyer_phone, buyer_email, amount_idr, currency, status, snap_attempt_count,
  expires_at, event_id, visit_id, adnet_id, clickid, sub_id, pub,
  utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, fbp, fbc, ttclid, gclid,
  ip, ua_hash
) ON public.orders TO public_rw;
GRANT UPDATE (
  status, snap_attempt_count, snap_redirect_url, snap_expires_at, browser_mt_fired_at, updated_at
) ON public.orders TO public_rw;

GRANT SELECT ON public.midtrans_attempts TO public_rw;
GRANT INSERT (order_id, n, midtrans_order_id, status, snap_token, redirect_url, error)
  ON public.midtrans_attempts TO public_rw;
GRANT UPDATE (status, snap_token, redirect_url, error, updated_at) ON public.midtrans_attempts TO public_rw;

-- Inboxes: insert raw rows (ON CONFLICT DO NOTHING), then call enqueue_*; outbox_id/processed_at
-- are not writable.
GRANT SELECT ON public.payment_notifications, public.waha_inbound TO public_rw;
GRANT INSERT (midtrans_order_id, transaction_status, status_code, signature, raw)
  ON public.payment_notifications TO public_rw;
GRANT INSERT (message_id, session_id, session_name, from_jid, body, raw) ON public.waha_inbound TO public_rw;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA player_auth TO public_rw;

GRANT EXECUTE ON FUNCTION
  public.enqueue_otp(uuid), public.enqueue_notification(uuid), public.enqueue_waha_inbound(uuid),
  public.enqueue_mo(uuid), public.get_payment_secret()
  TO public_rw;
-- The orders checkout guard runs as the caller and reads orders.expiry_seconds through it.
GRANT EXECUTE ON FUNCTION public.setting_positive_int(text) TO public_rw;

-- ---------------------------------------------------------------------------------------------
-- admin_rw (apps/admin). Writes sealed secrets but holds no private keys.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO admin_rw;
REVOKE INSERT, UPDATE, DELETE ON public.audit_log FROM admin_rw;
GRANT INSERT (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  ON public.audit_log TO admin_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA admin_auth TO admin_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA player_auth TO admin_rw;

-- ---------------------------------------------------------------------------------------------
-- worker_rw (apps/worker: relay, consumers, sweepers, heartbeat). Holds payment, messaging and
-- conversions private keys, so it may read all sealed secrets.

GRANT SELECT ON
  public.products, public.programs, public.trivia_sets, public.questions, public.question_options,
  public.prize_tiers, public.legal_pages, public.landing_pages, public.landing_page_adnets,
  public.lp_domains, public.adnets, public.message_templates, public.app_settings, public.uploads,
  public.settings_secrets, public.visits, public.midtrans_attempts, public.waha_servers
  TO worker_rw;
-- Only published -> awaiting_confirmation (programs_status_guard); finalizing is the Owner's.
GRANT UPDATE (status, updated_at) ON public.programs TO worker_rw;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.outbox TO worker_rw;
GRANT SELECT, INSERT, UPDATE ON
  public.deliveries, public.conversion_events, public.payments, public.players, public.player_programs,
  public.attempt_questions, public.player_program_stats, public.alerts, public.heartbeats
  TO worker_rw;
-- Winners: written as awaiting_confirmation, may be flagged (chargeback); confirming is the
-- Owner's (no status/confirmed_at on INSERT, no confirmed_at on UPDATE; winners_status_guard).
GRANT SELECT ON public.winners TO worker_rw;
GRANT INSERT (program_id, snapshot_id, prize_tier_id, player_id, rank) ON public.winners TO worker_rw;
GRANT UPDATE (status, flagged_at, flag_reason, updated_at) ON public.winners TO worker_rw;
GRANT SELECT, INSERT ON public.conversion_attempts, public.leaderboard_snapshots, public.magic_links TO worker_rw;
GRANT SELECT, UPDATE ON public.set_attempts TO worker_rw;

GRANT SELECT ON public.orders TO worker_rw;
GRANT UPDATE (status, player_id, paid_at, refunded_at, updated_at) ON public.orders TO worker_rw;

GRANT SELECT ON public.waha_sessions TO worker_rw;
GRANT UPDATE (status, status_at, updated_at) ON public.waha_sessions TO worker_rw;

GRANT SELECT ON public.payment_notifications, public.waha_inbound TO worker_rw;
GRANT UPDATE (processed_at) ON public.payment_notifications, public.waha_inbound TO worker_rw;

-- System-actor audit entries (e.g. re-score job); append-only, actor_kind 'system' only
-- (audit_log_stamp trigger), no id / occurred_at.
GRANT INSERT (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  ON public.audit_log TO worker_rw;

GRANT EXECUTE ON FUNCTION public.get_payment_secret() TO worker_rw;

-- ---------------------------------------------------------------------------------------------
-- internal_rw (apps/worker --role=internal: Caddy ask, GlitchTip hook). No keys.

GRANT SELECT ON public.lp_domains TO internal_rw;
GRANT INSERT (source, kind, severity, dedupe_key, message, payload) ON public.alerts TO internal_rw;
