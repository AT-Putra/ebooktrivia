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
--   public_rw   reads the catalog; writes play/player data, orders, visits, consents (reads only
--               the checkout columns of orders and the keys of visits / consents); never
--               INSERTs outbox (enqueue_* only); payment secrets only via get_payment_secret();
--               no admin_auth, audit_log, ad_spend, settings_secrets, otp_enqueues.
--   admin_rw    everything except UPDATE/DELETE/TRUNCATE on audit_log (and no TRUNCATE at all).
--   worker_rw   what jobs need: outbox, deliveries, conversions, waha_*, payments and order state,
--               eligibility, finalize/snapshot, alerts, heartbeats, each Midtrans attempt's
--               re-queried status and the payment reconciliation (US-021).
--   internal_rw EXECUTE lp_served_hosts() (US-023), INSERT alerts. Nothing else.
--   trivia_override (not a group, owns override_question_scoring only; sql/override.sql): the
--               columns that function reads and writes, nothing more.
-- admin_rw writes no play rows and no results snapshot (US-018): deleting or moving an attempt
-- would unlock a set's questions, and deleting the snapshot would re-open the override. It changes
-- scores only through override_question_scoring, which derives every score it writes from the
-- answer rows (it takes no scores from the caller) and is refused after the snapshot / grace.
-- No app role may choose audit_log.id (OVERRIDING SYSTEM VALUE) or occurred_at: INSERT on
-- audit_log is granted per column.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

REVOKE ALL ON ALL TABLES IN SCHEMA public, player_auth, admin_auth
  FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, trivia_override;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, player_auth, admin_auth
  FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, trivia_override;
-- override_question_scoring does not exist at this point (roles.sql drops it; sql/override.sql, run
-- last, creates it with its owner trivia_override and its privileges).
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public
  FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, trivia_override;
REVOKE ALL ON SCHEMA player_auth, admin_auth, drizzle
  FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, trivia_override;

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

-- players and magic_links: NO privilege at all (US-026, the US-009 carry-over); the login reaches them
-- only through the US-026 functions (block at the end). player_otps: what the OTP issue (insert,
-- supersede = delete) and the verify (attempts + 1 RETURNING mac) need, never the sealed code.
GRANT SELECT (id, phone, mac, expires_at, attempts, created_at), INSERT, DELETE ON public.player_otps TO public_rw;
GRANT UPDATE (attempts) ON public.player_otps TO public_rw;

-- Play rows: INSERT gated by the *_play_guard triggers (eligible player, published program);
-- UPDATE only of the progress columns, so a row cannot be moved to another player/set/question.
GRANT SELECT, INSERT ON public.set_attempts, public.attempt_questions, public.player_program_stats
  TO public_rw;
GRANT UPDATE (finished_at, score, total_ms) ON public.set_attempts TO public_rw;
GRANT UPDATE (served_at, deadline_at, answered_at, option_id, correct, points, elapsed_ms, ip, ua_hash)
  ON public.attempt_questions TO public_rw;
GRANT UPDATE (score, total_ms, sets_completed, finished_at, updated_at) ON public.player_program_stats
  TO public_rw;

-- visits / consents: INSERT, and SELECT of the keys only (US-020: the checkout checks that a visit_id
-- belongs to the landing page; it never reads a visit's or a consent's IP, user agent or attribution).
GRANT INSERT ON public.visits, public.consents TO public_rw;
GRANT SELECT (id, landing_page_id) ON public.visits TO public_rw;
GRANT SELECT (id, order_id, legal_page_id, consented_at) ON public.consents TO public_rw;

-- orders: no paid_at/refunded_at/mo_outbox_id; status limited by the orders_status_guard trigger.
-- SELECT (US-020, US-009 carry-over) only of what the checkout's dedupe and Snap bookkeeping read:
-- never the buyer's name, e-mail, IP, user agent or attribution. buyer_phone is the dedupe key.
-- browser_mt_fired_at is NOT updatable by public_rw (US-022): only claim_browser_mt() sets it.
GRANT SELECT (
  id, public_id, landing_page_id, buyer_phone, buyer_key, amount_idr, status, snap_attempt_count, snap_redirect_url,
  snap_expires_at, expires_at, event_id, created_at
) ON public.orders TO public_rw;
GRANT INSERT (
  id, public_id, order_code, landing_page_id, program_id, product_id, player_id,
  buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, currency, status, snap_attempt_count,
  expires_at, event_id, visit_id, adnet_id, clickid, sub_id, pub,
  utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, fbp, fbc, ttclid, gclid,
  ip, ua_hash
) ON public.orders TO public_rw;
GRANT UPDATE (
  status, snap_attempt_count, snap_redirect_url, snap_expires_at, updated_at
) ON public.orders TO public_rw;

-- midtrans_attempts: what the checkout's dedupe and bookkeeping read (US-020 security review P2-7), never
-- another order's snap_token or redirect_url.
GRANT SELECT (id, order_id, n, status, created_at) ON public.midtrans_attempts TO public_rw;
GRANT INSERT (order_id, n, midtrans_order_id, status, snap_token, redirect_url, error)
  ON public.midtrans_attempts TO public_rw;
GRANT UPDATE (status, snap_token, redirect_url, error, updated_at) ON public.midtrans_attempts TO public_rw;

-- Inboxes: insert raw rows (ON CONFLICT DO NOTHING), then call enqueue_*; outbox_id/processed_at
-- are not writable.
GRANT SELECT ON public.payment_notifications, public.waha_inbound TO public_rw;
GRANT INSERT (midtrans_order_id, transaction_status, status_code, signature, raw)
  ON public.payment_notifications TO public_rw;
-- No `body` (US-025 review): the webhook route stores no message text, the worker re-fetches the message from WAHA by id, so public_rw may not write it.
GRANT INSERT (message_id, session_id, session_name, from_jid, raw) ON public.waha_inbound TO public_rw;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA player_auth TO public_rw;

GRANT EXECUTE ON FUNCTION
  public.enqueue_otp(uuid), public.enqueue_notification(uuid), public.enqueue_waha_inbound(uuid),
  public.enqueue_mo(uuid), public.get_payment_secret()
  TO public_rw;
-- The orders checkout guard runs as the caller and reads orders.expiry_seconds through it.
GRANT EXECUTE ON FUNCTION public.setting_positive_int(text) TO public_rw;

-- ===== US-022: order status page ====================================================================
-- The status read and the exactly-once browser MT claim (functions.sql); orders.browser_mt_fired_at has
-- no UPDATE grant for public_rw (see the orders grants above).
GRANT EXECUTE ON FUNCTION public.get_order_status(text), public.claim_browser_mt(text) TO public_rw;
-- ===== end US-022 ===================================================================================

-- ---------------------------------------------------------------------------------------------
-- admin_rw (apps/admin). Writes sealed secrets but holds no private keys.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO admin_rw;
REVOKE INSERT, UPDATE, DELETE ON public.audit_log FROM admin_rw;
-- Play rows and the results snapshot: read only (US-018, see the summary above).
REVOKE INSERT, UPDATE, DELETE ON public.set_attempts, public.attempt_questions, public.player_program_stats,
  public.leaderboard_snapshots FROM admin_rw;
-- Settings are edited, never deleted or renamed (security review US-018 N3 / D1: a missing or renamed
-- otp.phone_cap would break OTP sending and the checkout guard for everyone). The admin writers
-- (lib/settings/limits.ts, midtrans.ts) upsert only value, updated_by_admin_user_id and updated_at;
-- a column UPDATE grant also covers their SELECT ... FOR UPDATE.
REVOKE DELETE, UPDATE ON public.app_settings FROM admin_rw;
GRANT UPDATE (value, updated_by_admin_user_id, updated_at) ON public.app_settings TO admin_rw;
-- Question edits run the content lock check (triggers.sql, SECURITY DEFINER) as the caller; the
-- override re-score and its pre-read take the program's contest lock.
GRANT EXECUTE ON FUNCTION public.assert_trivia_set_unlocked(uuid), public.lock_program_contest(uuid) TO admin_rw;
GRANT INSERT (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  ON public.audit_log TO admin_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA admin_auth TO admin_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA player_auth TO admin_rw;
-- No decryptable form is readable by admin_rw (US-017, plan M2.3 "admin cannot decrypt"): it
-- writes sealed secrets and outbox rows but never reads back a ciphertext, sealed DEK or sealed
-- OTP code, only the labels it needs to find, show (`last4`) and replace a row. Writes need no
-- SELECT on these columns (no RETURNING / upsert of them).
REVOKE SELECT ON public.settings_secrets, public.outbox, public.player_otps FROM admin_rw;
GRANT SELECT (id, scope, name, adnet_id, bound_host, key_id, last4, created_at, updated_at)
  ON public.settings_secrets TO admin_rw;
GRANT SELECT (id, topic, dedupe_key, payload, available_at, relayed_at, processed_at, attempts, last_error, created_at)
  ON public.outbox TO admin_rw;
GRANT SELECT (id, phone, expires_at, attempts, created_at) ON public.player_otps TO admin_rw;

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
GRANT SELECT, INSERT ON public.conversion_attempts, public.leaderboard_snapshots TO worker_rw;
-- Magic links are issued only through issue_magic_link (US-026 block); the worker still reads them.
GRANT SELECT ON public.magic_links TO worker_rw;
GRANT SELECT, UPDATE ON public.set_attempts TO worker_rw;

GRANT SELECT ON public.orders TO worker_rw;
GRANT UPDATE (status, player_id, paid_at, refunded_at, updated_at) ON public.orders TO worker_rw;

GRANT SELECT ON public.waha_sessions TO worker_rw;
GRANT UPDATE (status, status_at, updated_at) ON public.waha_sessions TO worker_rw;

-- SMTP settings (e-mail delivery) and admin template test-sends (US-017): the worker claims a
-- test-send (pending -> sending), sends it and records the outcome; it cannot change what or to
-- whom.
GRANT SELECT ON public.smtp_settings TO worker_rw;
GRANT SELECT ON public.template_test_sends TO worker_rw;
GRANT UPDATE (status, error, sent_at, updated_at) ON public.template_test_sends TO worker_rw;

GRANT SELECT ON public.payment_notifications, public.waha_inbound TO worker_rw;
GRANT UPDATE (processed_at) ON public.payment_notifications, public.waha_inbound TO worker_rw;

-- System-actor audit entries (e.g. re-score job); append-only, actor_kind 'system' only
-- (audit_log_stamp trigger), no id / occurred_at.
GRANT INSERT (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  ON public.audit_log TO worker_rw;

GRANT EXECUTE ON FUNCTION public.get_payment_secret() TO worker_rw;
-- Deletes spent admin login-throttle rows only (functions.sql); no other admin_auth access.
GRANT EXECUTE ON FUNCTION public.sweep_login_throttle(integer) TO worker_rw;

-- --- US-021 (Midtrans notifications, processing, reconciliation) ----------------------------------
-- The worker records each attempt's last re-queried status (never which order or Midtrans id it is,
-- nor its Snap fields, nor updated_at: the reconciliation's "active in 7 days" reads the checkout's
-- activity, and its own nightly re-query must not keep every order active forever), and the nightly
-- reconciliation's runs and report rows (append-only findings).
-- public_rw reaches none of these: its midtrans_attempts SELECT stays the US-020 column list, and the
-- notification route needs no orders read at all (payment_notifications + enqueue_notification).
GRANT UPDATE (gateway_status, gateway_fraud_status, gateway_checked_at) ON public.midtrans_attempts TO worker_rw;
-- A run is claimed by INSERT (or by re-stamping a stale one) and then only reports its progress.
GRANT SELECT, INSERT ON public.payment_reconciliation_runs TO worker_rw;
GRANT UPDATE (started_at, heartbeat_at, finished_at, attempts_checked, findings, errors) ON public.payment_reconciliation_runs TO worker_rw;
GRANT SELECT, INSERT ON public.payment_reconciliation_findings TO worker_rw;
-- admin_rw (every table by design, above) reads the reconciliation for its reports but cannot write
-- or delete what the reconciliation found.
REVOKE INSERT, UPDATE, DELETE ON public.payment_reconciliation_runs, public.payment_reconciliation_findings FROM admin_rw;
-- --- end US-021 -------------------------------------------------------------------------------------

-- --- US-024 (tracking and conversions) --------------------------------------------------------------------
-- The worker needs nothing new: it already writes conversion_events (claim, outcome, MO rows) and appends
-- conversion_attempts. The admin console only READS the conversion log (reports, US-029) and re-fires through
-- refire_conversion (sql/conversions.sql, EXECUTE admin_rw): a console that could INSERT / UPDATE / DELETE
-- these rows could fabricate a sent conversion, hide a failure or reset a sent row, so it cannot (ET083 holds
-- for every writer, and this keeps admin_rw from the paths around it).
REVOKE INSERT, UPDATE, DELETE ON public.conversion_events, public.conversion_attempts FROM admin_rw;
-- The source label of an order for the reports ('Organic' when it has no click id, else the adnet's name).
GRANT EXECUTE ON FUNCTION public.order_source_label(uuid, text) TO admin_rw;
-- conversion_refire: the owner of public.refire_conversion (sql/conversions.sql), which runs as it. It reads
-- a conversion row and its order and writes only what a re-fire resets (never maybe_counted, the payout it
-- reported, the attempt count or the log). UPDATE (updated_at) on orders is only for the FOR SHARE row lock
-- (no refund meanwhile).
REVOKE ALL ON ALL TABLES IN SCHEMA public, player_auth, admin_auth FROM conversion_refire;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, player_auth, admin_auth FROM conversion_refire;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM conversion_refire;
REVOKE ALL ON SCHEMA player_auth, admin_auth, drizzle FROM conversion_refire;
GRANT SELECT ON public.conversion_events TO conversion_refire;
GRANT SELECT (id) ON public.orders TO conversion_refire;
GRANT UPDATE (updated_at) ON public.orders TO conversion_refire;
GRANT UPDATE (status, next_attempt_at, lease_until, failed_at, sent_at, last_error, last_http_status, updated_at)
  ON public.conversion_events TO conversion_refire;
-- --- end US-024 -------------------------------------------------------------------------------------------

-- --- US-025 (delivery over WhatsApp and e-mail) ------------------------------------------------------------------
-- The pool: the worker paces and rests a number (next_send_at, fail_streak, cooldown_until, next to the status it polls),
-- appends every claimed send to waha_sends (the daily cap and the round-robin count it) and prunes old rows. waha_sends
-- is append-only for the console (it reads it for the delivery report, US-029). The worker records what it did with an
-- inbound WhatsApp message and claims its one text reply (waha_inbound.outcome, replied_at); the webhook route's
-- INSERT grant (public_rw, above) is unchanged. record_waha_ack (functions.sql) is how the verified ack webhook moves
-- deliveries.wa_ack: public_rw cannot UPDATE deliveries.
GRANT UPDATE (next_send_at, fail_streak, cooldown_until, reachout_until, warning_level, timelock_active, timelock_ends_at, capping_status, capping_total_quota,
              capping_used_quota, capping_cycle_end, limits_checked_at, ban_463_count, ban_475_count) ON public.waha_sessions TO worker_rw;
-- What WAHA said about a phone (check-exists, the lid link): the worker reads and writes it; it holds personal data, so nobody else touches it.
GRANT SELECT, INSERT ON public.wa_contacts TO worker_rw;
GRANT UPDATE (number_exists, chat_id, lid, checked_at, lid_checked_at) ON public.wa_contacts TO worker_rw;
REVOKE INSERT, UPDATE, DELETE ON public.wa_contacts FROM admin_rw;
-- The webhook route records the limits a verified session.status event carries (record_waha_session_state, functions.sql).
GRANT EXECUTE ON FUNCTION public.record_waha_session_state(text, jsonb, jsonb) TO public_rw;
-- ... and keeps a code-less message that answers a WhatsApp opener (waha_reply_expected, functions.sql).
GRANT EXECUTE ON FUNCTION public.waha_reply_expected(text, text) TO public_rw;
GRANT SELECT, INSERT, DELETE ON public.waha_sends TO worker_rw;
-- ... and writes how each send ended (outcome: sent, unknown, failed), which the delivery report counts per number; nothing else of a row changes.
GRANT UPDATE (outcome) ON public.waha_sends TO worker_rw;
REVOKE INSERT, UPDATE, DELETE ON public.waha_sends FROM admin_rw;
-- The opener of a WhatsApp delivery (Owner decision D7): the worker creates it at its first claim and moves it (pending -> sending -> sent / unknown /
-- failed / expired; delivery_openers_final_guard, ET131, refuses a way back). The console reads it (the delivery report, US-029) and never writes it.
GRANT SELECT, INSERT ON public.delivery_openers TO worker_rw;
GRANT UPDATE (status, attempts, session_id, tried_session_ids, next_attempt_at, lease_until, wa_message_id, sent_at, last_error, updated_at) ON public.delivery_openers TO worker_rw;
REVOKE INSERT, UPDATE, DELETE ON public.delivery_openers FROM admin_rw;
GRANT UPDATE (outcome, replied_at) ON public.waha_inbound TO worker_rw;
GRANT EXECUTE ON FUNCTION public.record_waha_ack(text, text) TO public_rw;
-- The console reads deliveries (the failed-deliveries list, US-029) but never writes them: a delivery's state is the worker's, and the one way
-- back from `sent` / `unknown` / `failed` is public.resend_delivery (ET130). admin_rw keeps SELECT only (and EXECUTE on that function).
REVOKE INSERT, UPDATE, DELETE ON public.deliveries FROM admin_rw;
-- delivery_resend: the owner of public.resend_delivery (sql/delivery-resend.sql), which runs as it. It reads a delivery and writes only what a resend
-- resets (the machine's columns, never the ack, the message id, the order or the channel). UPDATE (updated_at) on orders is only for the FOR SHARE row lock.
REVOKE ALL ON ALL TABLES IN SCHEMA public, player_auth, admin_auth FROM delivery_resend;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, player_auth, admin_auth FROM delivery_resend;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM delivery_resend;
REVOKE ALL ON SCHEMA player_auth, admin_auth, drizzle FROM delivery_resend;
GRANT SELECT ON public.deliveries TO delivery_resend;
GRANT UPDATE (status, not_before, lease_until, session_id, tried_session_ids, attempts_base, last_error, sent_at, updated_at) ON public.deliveries TO delivery_resend;
GRANT SELECT (id, status) ON public.orders TO delivery_resend;
GRANT UPDATE (updated_at) ON public.orders TO delivery_resend;
-- --- end US-025 -------------------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------------------------
-- trivia_override: the owner of public.override_question_scoring (sql/override.sql), which runs as
-- it. Reads what the override checks and scores with (program, sets, question, options, snapshot,
-- attempts, answers, stats, the actor's admin profile) and writes only: points / timer of the
-- question, which option is correct, the affected players' re-scored answers (correct, points,
-- elapsed), their attempts' score / total_ms / finished_at and per-program stats (a missing stats
-- row is inserted), and its own audit row. It scores through public.score_answer.
-- UPDATE (updated_at) on trivia_sets is only for the FOR UPDATE row lock (no attempt starts meanwhile).
GRANT SELECT ON
  public.programs, public.trivia_sets, public.questions, public.question_options, public.set_attempts,
  public.attempt_questions, public.player_program_stats, public.leaderboard_snapshots
  TO trivia_override;
GRANT SELECT (auth_user_id, role, disabled_at) ON public.admin_profiles TO trivia_override;
GRANT UPDATE (updated_at) ON public.trivia_sets TO trivia_override;
GRANT UPDATE (points, timer_seconds, updated_at) ON public.questions TO trivia_override;
GRANT UPDATE (is_correct, updated_at) ON public.question_options TO trivia_override;
GRANT UPDATE (correct, points, elapsed_ms) ON public.attempt_questions TO trivia_override;
GRANT UPDATE (score, total_ms, finished_at) ON public.set_attempts TO trivia_override;
GRANT INSERT (player_id, program_id, score, total_ms, sets_completed, finished_at, updated_at),
  UPDATE (score, total_ms, sets_completed, finished_at, updated_at)
  ON public.player_program_stats TO trivia_override;
GRANT INSERT (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  ON public.audit_log TO trivia_override;
GRANT EXECUTE ON FUNCTION public.lock_program_contest(uuid),
  public.score_answer(integer, integer, uuid, uuid, timestamptz, timestamptz, timestamptz, integer) TO trivia_override;

-- ---------------------------------------------------------------------------------------------
-- internal_rw (apps/worker --role=internal: Caddy ask, GlitchTip hook). No keys.

-- The served LP hosts through public.lp_served_hosts() only (US-023): an exact registered host of an
-- ACTIVE zip-hosted landing page with a live version; no table read of lp_domains.
GRANT EXECUTE ON FUNCTION public.lp_served_hosts() TO internal_rw;
GRANT INSERT (source, kind, severity, dedupe_key, message, payload) ON public.alerts TO internal_rw;

-- ---------------------------------------------------------------------------------------------
-- US-028 (M9c) BLOCK BEGIN: grace end, results snapshot, winners, deadline extension.
-- Kept in one block for the merge with US-020; the REVOKEs below supersede worker_rw lines of the
-- worker section above and are to be folded into it.
--
-- worker_rw: the grace-end finalize, the snapshot and the winners are written ONLY through
-- public.create_leaderboard_snapshot (sql/contest.sql, EXECUTE granted there), which derives every
-- score in SQL; the worker keeps no direct write on play rows, the snapshot or a program's status
-- (it needs no contest lock grant either: the function takes it). It keeps its UPDATE of winners'
-- flag columns above: the chargeback flag (US-021), which the winners guard allows as the one
-- worker change (awaiting_confirmation / confirmed -> flagged).
REVOKE INSERT ON public.leaderboard_snapshots FROM worker_rw;
REVOKE INSERT ON public.winners FROM worker_rw;
REVOKE INSERT, UPDATE ON public.attempt_questions, public.player_program_stats FROM worker_rw;
REVOKE UPDATE ON public.set_attempts, public.programs FROM worker_rw;
-- admin_rw: winners are confirmed only through public.confirm_program_winners (sql/contest.sql); no
-- direct write (the winners guard refuses every writer but that function anyway, ET105). No write on
-- eligibility either (security review P1-3: a forged eligible / first_paid_at would change who ranks
-- and who wins), nor on the deadline extension ledger.
REVOKE INSERT, UPDATE, DELETE ON public.winners FROM admin_rw;
REVOKE INSERT, UPDATE, DELETE ON public.player_programs FROM admin_rw;
REVOKE INSERT, UPDATE, DELETE ON public.deadline_extensions FROM admin_rw;

-- public_rw (security review P1-2, P1-5): play rows carry only what the player does; the database
-- sets every timestamp (play guards, triggers.sql) and no score is writable (scores come only from
-- score_answer: the finalize, the re-score and US-027's SECURITY DEFINER answer function). Starting
-- a set: its player and set; a question row: its place, order and the serve; an answer: the serve,
-- the answer, the pick and the device. It reads the results only through program_winners_banner
-- (sql/contest.sql), never the snapshot or winners tables. The play guards take the shared contest
-- lock as the caller.
REVOKE INSERT, UPDATE ON public.set_attempts, public.attempt_questions, public.player_program_stats FROM public_rw;
GRANT INSERT (player_id, set_id) ON public.set_attempts TO public_rw;
GRANT INSERT (attempt_id, question_id, position, permutation, served_at, ip, ua_hash) ON public.attempt_questions TO public_rw;
GRANT UPDATE (served_at, answered_at, option_id, ip, ua_hash) ON public.attempt_questions TO public_rw;
REVOKE SELECT ON public.winners, public.leaderboard_snapshots FROM public_rw;
GRANT EXECUTE ON FUNCTION public.lock_program_contest_shared(uuid) TO public_rw;
-- Which option is correct is never readable before answering (AC-Q9, security review N3): the
-- options without is_correct; US-027's SECURITY DEFINER answer function reads correctness.
REVOKE SELECT ON public.question_options FROM public_rw;
GRANT SELECT (id, question_id, position, label, created_at, updated_at) ON public.question_options TO public_rw;

-- contest_results: the owner of the sql/contest.sql functions, which run as it. Reads what the
-- finalize, the confirmation, the extension and the banner read (programs, sets, questions,
-- options, attempts, answers, stats, eligibility, prize tiers, the snapshot, winners, the actor's
-- admin profile, the extension bound in app_settings, and players' name and phone, which it only
-- returns masked); writes only: the finalized answers (answered_at, correct, points, elapsed) and
-- extended deadlines, attempts' and stats' derived columns, the snapshot, winners and their
-- confirmation, a program's status / winners_confirmed_at, and its own audit rows.
-- UPDATE (updated_at) on trivia_sets is only for the FOR SHARE row lock (no scoring edit meanwhile).
REVOKE ALL ON ALL TABLES IN SCHEMA public, player_auth, admin_auth FROM contest_results;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, player_auth, admin_auth FROM contest_results;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM contest_results;
REVOKE ALL ON SCHEMA player_auth, admin_auth, drizzle FROM contest_results;
GRANT SELECT ON
  public.programs, public.trivia_sets, public.questions, public.question_options, public.set_attempts,
  public.attempt_questions, public.player_program_stats, public.player_programs, public.prize_tiers,
  public.leaderboard_snapshots, public.winners
  TO contest_results;
GRANT SELECT (id, name, phone) ON public.players TO contest_results;
GRANT SELECT (auth_user_id, role, disabled_at) ON public.admin_profiles TO contest_results;
GRANT SELECT (key, value) ON public.app_settings TO contest_results;
GRANT UPDATE (updated_at) ON public.trivia_sets TO contest_results;
-- Only for the FOR SHARE row lock on the winners' eligibility in the confirmation (no refund meanwhile).
GRANT UPDATE (updated_at) ON public.player_programs TO contest_results;
GRANT SELECT, INSERT (attempt_question_id, extension_id, program_id, original_deadline_at, granted_ms)
  ON public.deadline_extensions TO contest_results;
GRANT UPDATE (status, winners_confirmed_at, updated_at) ON public.programs TO contest_results;
GRANT UPDATE (answered_at, correct, points, elapsed_ms, deadline_at, deadline_extension_ms) ON public.attempt_questions TO contest_results;
GRANT UPDATE (score, total_ms, finished_at) ON public.set_attempts TO contest_results;
GRANT INSERT (player_id, program_id, score, total_ms, sets_completed, finished_at, updated_at),
  UPDATE (score, total_ms, sets_completed, finished_at, updated_at)
  ON public.player_program_stats TO contest_results;
GRANT INSERT (program_id, frozen_at, entries) ON public.leaderboard_snapshots TO contest_results;
GRANT INSERT (program_id, snapshot_id, prize_tier_id, player_id, rank),
  UPDATE (status, confirmed_at, updated_at)
  ON public.winners TO contest_results;
GRANT INSERT (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  ON public.audit_log TO contest_results;
GRANT EXECUTE ON FUNCTION public.lock_program_contest(uuid), public.setting_positive_int(text),
  public.score_answer(integer, integer, uuid, uuid, timestamptz, timestamptz, timestamptz, integer),
  public.mask_name(text), public.mask_phone(text)
  TO contest_results;
-- US-028 BLOCK END.

-- ---------------------------------------------------------------------------------------------
-- US-026 (M9a player authentication) BLOCK BEGIN. The table privileges of players, magic_links and
-- player_otps are final in the role sections above (folded, no REVOKE needed here); this block adds the
-- function grants and the few new privileges.
--
-- public_rw (US-009 carry-over: no table-level read of players): it reads no column of players at all. A
-- phone becomes a login only through prepare_player_login (the OTP path), a magic link only through
-- magic_link_login_user + consume_magic_link, a session a player id only through player_for_login, and the
-- signed-in label only through player_login_label (masked; sql/functions.sql), so a compromised public app
-- cannot list buyers' phones, names or e-mail addresses from players. (Better Auth needs player_auth: its
-- user rows hold the phone of each player who has logged in, see functions.sql.)
GRANT EXECUTE ON FUNCTION public.prepare_player_login(text), public.player_for_login(text), public.player_login_label(text),
  public.magic_link_login_user(bytea, text), public.consume_magic_link(bytea, text)
  TO public_rw;
-- worker_rw: issues magic links only through issue_magic_link (US-025; it derives the expiry and keeps one
-- live link per player and channel), and the minute sweeper deletes expired OTP rows (their HMAC and any
-- sealed code not moved yet): the expiry to find them, never the code or its HMAC.
GRANT EXECUTE ON FUNCTION public.issue_magic_link(uuid, text, bytea) TO worker_rw;
-- ... and revokes a player's live links when Midtrans reverses a payment we counted (Owner D9, US-005; the payment consumer).
GRANT EXECUTE ON FUNCTION public.revoke_player_magic_links(uuid) TO worker_rw;
GRANT SELECT (id, expires_at), DELETE ON public.player_otps TO worker_rw;
-- The same sweeper prunes the OTP send ledger, older than 24 hours only (prune_otp_enqueues), and expired player
-- sessions with their state (prune_player_sessions); it has no other access to player_auth.
GRANT EXECUTE ON FUNCTION public.prune_otp_enqueues(), public.prune_player_sessions() TO worker_rw;
-- admin_rw (security review L4): reads magic links (support), never issues, consumes or deletes one; reads the
-- OTP send ledger, never writes it (deleting or backdating its rows would reset a phone's cap and the breaker).
REVOKE INSERT, UPDATE, DELETE ON public.magic_links FROM admin_rw;
REVOKE INSERT, UPDATE, DELETE ON public.otp_enqueues FROM admin_rw;
-- US-026 BLOCK END.

-- ---------------------------------------------------------------------------------------------
-- US-029 (M10a reports and ROI) BLOCK BEGIN: the report rollups and the metric functions (sql/reports.sql).
-- The rollups are derived data: ONLY worker_rw writes them (public.refresh_report_rollups, SECURITY INVOKER, so
-- these grants are the only reason it can), admin_rw reads them for the reports and cannot forge or change a
-- figure, and public_rw / internal_rw reach none. The refresh reads orders, payments, conversion_events, visits and
-- app_settings, which worker_rw already reads. The console reads ad_spend and the raw tables for the reports that
-- are not rollups (admin_rw holds every table by design).
-- The two daily tables are rebuilt by delete and insert of whole days, never updated in place: no UPDATE. The one-row state is upserted: no DELETE.
GRANT SELECT, INSERT, DELETE ON public.report_orders_daily, public.report_visits_daily TO worker_rw;
GRANT SELECT, INSERT, UPDATE ON public.report_rollup_state TO worker_rw;
REVOKE INSERT, UPDATE, DELETE ON public.report_orders_daily, public.report_visits_daily, public.report_rollup_state FROM admin_rw;
GRANT EXECUTE ON FUNCTION public.refresh_report_rollups(timestamptz, integer) TO worker_rw;
GRANT EXECUTE ON FUNCTION public.wib_day(timestamptz), public.order_source_adnet(uuid, text), public.gateway_fee_idr(bigint, bigint, integer),
  public.midtrans_method_codes(text) TO worker_rw, admin_rw;
-- The console labels sources through order_source_label (US-024) and masks buyers and winners in SQL, with the one
-- masking rule of the product (functions.sql), wherever Staff can see them.
GRANT EXECUTE ON FUNCTION public.report_source_label(uuid), public.mask_name(text), public.mask_phone(text) TO admin_rw;
-- US-029 BLOCK END.
-- US-027 (M9b trivia page, question flow, leaderboard) BLOCK BEGIN.
--
-- public_rw plays ONLY through the SECURITY DEFINER functions of sql/play.sql (EXECUTE granted there), owned by
-- trivia_play. It loses every write on play rows (this supersedes the US-028 block's public_rw INSERT / UPDATE
-- grants) and the shared contest lock (only the play guards take it, running as trivia_play: a public_rw session
-- holding it in an open transaction would stall the results snapshot). It reads no question text, option text,
-- explanation, correctness or answer row (AC-Q9; US-027 contract: a compromised public app must neither read a
-- question before it is served nor read another player's pick, which names the correct option id everyone gets):
-- of questions only what the trivia page counts (id, set, position, points, timer), nothing of question_options
-- or attempt_questions. No score either (security review HIGH-1, the rollback probe: a score read in the
-- transaction of a pick tells whether the pick was right before it is committed): of set_attempts only which sets
-- the player started and finished, nothing of player_program_stats. Scores and ranks are read only through the
-- play functions that refuse a transaction that has written (sql/play.sql play_attempts, play_standing,
-- play_leaderboard, play_reveal).
REVOKE INSERT, UPDATE ON public.set_attempts, public.attempt_questions, public.player_program_stats FROM public_rw;
REVOKE SELECT ON public.attempt_questions, public.questions, public.question_options, public.set_attempts,
  public.player_program_stats FROM public_rw;
GRANT SELECT (id, set_id, position, points, timer_seconds, created_at, updated_at) ON public.questions TO public_rw;
GRANT SELECT (id, player_id, set_id, started_at, finished_at, created_at) ON public.set_attempts TO public_rw;
REVOKE EXECUTE ON FUNCTION public.lock_program_contest_shared(uuid) FROM public_rw;

-- trivia_play: the owner of the sql/play.sql functions, which run as it. It is checked by the play guards like
-- any untrusted writer (triggers.sql), which run as it too: they read programs, sets, questions, options,
-- attempts and eligibility and take the shared contest lock. It reads the players' names only to mask them
-- (public.mask_name); it writes only: an attempt (player, set) and its derived totals; the answer rows (place,
-- order; the serve, the pick and the device, which the guards stamp; the score columns, which it derives with
-- public.score_answer); the stats' derived columns (a missing stats row is inserted); and the unlock floor.
-- UPDATE (score) on set_attempts / player_program_stats also covers their FOR UPDATE row locks (play_settle_answer).
REVOKE ALL ON ALL TABLES IN SCHEMA public, player_auth, admin_auth FROM trivia_play;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, player_auth, admin_auth FROM trivia_play;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM trivia_play;
REVOKE ALL ON SCHEMA player_auth, admin_auth, drizzle FROM trivia_play;
GRANT SELECT ON
  public.programs, public.trivia_sets, public.questions, public.question_options, public.set_attempts,
  public.attempt_questions, public.player_program_stats, public.player_programs
  TO trivia_play;
GRANT SELECT (id, name) ON public.players TO trivia_play;
GRANT INSERT (player_id, set_id), UPDATE (score, total_ms, finished_at) ON public.set_attempts TO trivia_play;
GRANT INSERT (attempt_id, question_id, position, permutation),
  UPDATE (served_at, answered_at, option_id, ip, ua_hash, correct, points, elapsed_ms)
  ON public.attempt_questions TO trivia_play;
GRANT INSERT (player_id, program_id), UPDATE (score, total_ms, sets_completed, finished_at, updated_at)
  ON public.player_program_stats TO trivia_play;
GRANT UPDATE (unlock_floor) ON public.player_programs TO trivia_play;
GRANT EXECUTE ON FUNCTION public.lock_program_contest_shared(uuid),
  public.score_answer(integer, integer, uuid, uuid, timestamptz, timestamptz, timestamptz, integer),
  public.mask_name(text)
  TO trivia_play;

-- The login page's "send my login link again" (Owner decision; functions.sql US-027 block): public_rw only asks for
-- the job; the worker issues the links (issue_magic_link, already worker_rw's) and sends them.
GRANT EXECUTE ON FUNCTION public.enqueue_magic_link_resend(text) TO public_rw;
-- US-027 BLOCK END.


-- ---------------------------------------------------------------------------------------------
-- US-023 (M6e LP ZIP hosting) BLOCK BEGIN.
-- admin_rw (the console publishes and switches the host links) uses public.lp_served_hosts() too, the
-- function internal_rw (Caddy's ask) reads the hosts through (internal_rw section above), so what is
-- linked on disk and what gets a certificate are one set.
GRANT EXECUTE ON FUNCTION public.lp_served_hosts() TO admin_rw;
-- US-023 BLOCK END.

-- ---------------------------------------------------------------------------------------------
-- US-030 (M10b prize fulfilment, UU PDP deletion = anonymization) BLOCK BEGIN.
--
-- admin_rw: fulfilments are written ONLY through the prize_fulfillment functions (sql/fulfillment.sql) and created by the results
-- functions (sql/contest.sql); the console reads them. Deletion requests are recorded and rejected by the console, completed only by
-- the erasure (deletion_requests_guard), and never deleted. The console calls the US-030 functions (EXECUTE granted in their files).
REVOKE INSERT, UPDATE, DELETE ON public.fulfillments FROM admin_rw;
REVOKE DELETE ON public.deletion_requests FROM admin_rw;
-- worker_rw: the stranger retention of wa_contacts (functions.sql prune_stranger_wa_contacts), from the minute sweeper.
GRANT EXECUTE ON FUNCTION public.prune_stranger_wa_contacts() TO worker_rw;

-- contest_results (sql/contest.sql, on top of the US-028 block): the revoke and re-award reads the players' erasure mark and the
-- program's chargebacks (orders and payments of a candidate), inserts the re-award row naming the winner it replaces, and creates
-- the pending fulfilment of a confirmed winner (the confirmation, a re-award, a reinstatement).
-- UPDATE (updated_at) on players is only for the candidate's FOR SHARE row lock (no erasure meanwhile); the anonymized-rows
-- guard and these functions never change a player. The revoke and the reinstatement write the Owner's reason (decision_reason).
GRANT SELECT (anonymized_at) ON public.players TO contest_results;
GRANT UPDATE (updated_at) ON public.players TO contest_results;
GRANT SELECT (id, player_id, program_id) ON public.orders TO contest_results;
GRANT SELECT (order_id, transaction_status) ON public.payments TO contest_results;
GRANT INSERT (replaces_winner_id), UPDATE (decision_reason) ON public.winners TO contest_results;
GRANT SELECT (winner_id, status), INSERT (winner_id) ON public.fulfillments TO contest_results;
-- The resend of a delivery and the re-fire of a conversion refuse an anonymized order (sql/delivery-resend.sql, conversions.sql).
GRANT SELECT (anonymized_at) ON public.orders TO delivery_resend, conversion_refire;

-- prize_fulfillment: the owner of the sql/fulfillment.sql functions, which run as it. Reads the fulfilment, its winner and program,
-- the actor's admin profile and the proof upload; writes only a fulfilment's status, step stamps, notes and proof, deletes the proof
-- upload it replaces, and its own audit rows. UPDATE (updated_at) on winners is only for the FOR SHARE row lock (no flag or revoke
-- meanwhile); winners_status_guard refuses any real change by it.
REVOKE ALL ON ALL TABLES IN SCHEMA public, player_auth, admin_auth FROM prize_fulfillment;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, player_auth, admin_auth FROM prize_fulfillment;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM prize_fulfillment;
REVOKE ALL ON SCHEMA player_auth, admin_auth, drizzle FROM prize_fulfillment;
GRANT SELECT ON public.fulfillments TO prize_fulfillment;
GRANT UPDATE (status, notes, proof_upload_id, contacted_at, contacted_by_admin_user_id, sent_at, sent_by_admin_user_id, done_at,
              done_by_admin_user_id, correction_reason, updated_at) ON public.fulfillments TO prize_fulfillment;
GRANT SELECT (id, program_id, status) ON public.winners TO prize_fulfillment;
GRANT UPDATE (updated_at) ON public.winners TO prize_fulfillment;
GRANT SELECT (id, status) ON public.programs TO prize_fulfillment;
GRANT SELECT (id, kind, storage_path), DELETE ON public.uploads TO prize_fulfillment;
GRANT SELECT (auth_user_id, role, disabled_at) ON public.admin_profiles TO prize_fulfillment;
GRANT INSERT (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  ON public.audit_log TO prize_fulfillment;

-- pii_eraser: the owner of public.erase_data_subject (sql/privacy.sql), which runs as it. SELECT only of the columns it matches the
-- subject on (and those an UPDATE's expressions read), UPDATE only of the personal columns it blanks (plus the cancellation of an
-- unsent send: a delivery, an opener, a CAPI event), DELETE only of rows that are personal data and nothing else (the login rows,
-- magic links, OTP rows, wa_contacts, proof uploads). No money column, no play result, no winner, no other audit row.
REVOKE ALL ON ALL TABLES IN SCHEMA public, player_auth, admin_auth FROM pii_eraser;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, player_auth, admin_auth FROM pii_eraser;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM pii_eraser;
REVOKE ALL ON SCHEMA player_auth, admin_auth, drizzle FROM pii_eraser;
GRANT USAGE ON SCHEMA player_auth TO pii_eraser;
GRANT SELECT (auth_user_id, role, disabled_at) ON public.admin_profiles TO pii_eraser;
GRANT SELECT (id, status, subject_phone, summary, player_id),
  UPDATE (status, completed_at, decided_by_admin_user_id, player_id, subject_phone, summary, updated_at)
  ON public.deletion_requests TO pii_eraser;
GRANT SELECT (id, phone, email, auth_user_id), UPDATE (name, phone, email, auth_user_id, anonymized_at, updated_at) ON public.players TO pii_eraser;
GRANT SELECT (id, player_id, buyer_phone, buyer_email, status, visit_id, landing_page_id, ip, ua_hash),
  UPDATE (buyer_name, buyer_phone, buyer_email, buyer_key, ip, ua_hash, fbclid, fbp, fbc, ttclid, gclid, anonymized_at, updated_at)
  ON public.orders TO pii_eraser;
GRANT SELECT (order_id, ip, ua_hash), UPDATE (ip, ua_hash) ON public.consents TO pii_eraser;
GRANT SELECT (id, landing_page_id, ip, ua_hash), UPDATE (ip, ua_hash, fbclid, fbp, fbc, ttclid, gclid) ON public.visits TO pii_eraser;
-- The contest lock of the subject's programs (a re-award serialises with the erasure), and the cut of a payment's raw JSON.
GRANT SELECT (player_id, program_id) ON public.player_programs TO pii_eraser;
GRANT EXECUTE ON FUNCTION public.lock_program_contest(uuid), public.payment_raw_kept(jsonb) TO pii_eraser;
GRANT SELECT (order_id, midtrans_order_id) ON public.midtrans_attempts TO pii_eraser;
GRANT SELECT (midtrans_order_id, raw), UPDATE (raw) ON public.payment_notifications TO pii_eraser;
GRANT SELECT (order_id, raw), UPDATE (raw) ON public.payments TO pii_eraser;
GRANT SELECT (id, order_id, status, wa_chat_id, reply_chat_id, wa_message_id),
  UPDATE (wa_chat_id, reply_chat_id, wa_message_id, status, last_error, lease_until, updated_at)
  ON public.deliveries TO pii_eraser;
GRANT SELECT (delivery_id, status, wa_message_id), UPDATE (wa_message_id, status, lease_until, updated_at) ON public.delivery_openers TO pii_eraser;
GRANT SELECT (order_id, sink, status), UPDATE (status, failed_at, last_error, lease_until, updated_at) ON public.conversion_events TO pii_eraser;
GRANT SELECT (id, player_id) ON public.set_attempts TO pii_eraser;
GRANT SELECT (attempt_id, ip, ua_hash), UPDATE (ip, ua_hash) ON public.attempt_questions TO pii_eraser;
GRANT SELECT (id, player_id, status, decision_reason), UPDATE (decision_reason, updated_at) ON public.winners TO pii_eraser;
GRANT SELECT (winner_id, status, notes, proof_upload_id, correction_reason), UPDATE (notes, proof_upload_id, correction_reason, updated_at)
  ON public.fulfillments TO pii_eraser;
GRANT SELECT (id, kind, storage_path), DELETE ON public.uploads TO pii_eraser;
GRANT SELECT (player_id), DELETE ON public.magic_links TO pii_eraser;
GRANT SELECT (phone), DELETE ON public.player_otps, public.otp_enqueues TO pii_eraser;
GRANT SELECT (id, message_id, from_jid, processed_at), UPDATE (message_id, from_jid, body, raw, processed_at) ON public.waha_inbound TO pii_eraser;
GRANT SELECT (contact_key, delivery_id), UPDATE (contact_key) ON public.waha_sends TO pii_eraser;
GRANT SELECT (phone, chat_id, lid), DELETE ON public.wa_contacts TO pii_eraser;
GRANT SELECT (topic, payload, processed_at, attempts, deferrals), UPDATE (payload, sealed, processed_at) ON public.outbox TO pii_eraser;
GRANT SELECT (payload, message), UPDATE (payload, message) ON public.alerts TO pii_eraser;
GRANT SELECT (id, "phoneNumber", email), DELETE ON player_auth."user" TO pii_eraser;
GRANT SELECT ("userId"), DELETE ON player_auth.session, player_auth.account TO pii_eraser;
GRANT SELECT (identifier), DELETE ON player_auth.verification TO pii_eraser;
GRANT INSERT (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  ON public.audit_log TO pii_eraser;
-- US-030 BLOCK END.
