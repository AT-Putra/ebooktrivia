# PII inventory (UU PDP)

Every text, varchar, jsonb, inet and bytea column of every table, classified, and what the erasure of a data subject
(`public.erase_data_subject`, `packages/db/sql/privacy.sql`, US-030) does to it.

- **Source.** The list was built from the schema (`information_schema.columns`, the same query the scan test runs, and the
  drizzle snapshot `packages/db/migrations/meta/0021_snapshot.json`).
- **The guarantee is the test, not this page.** `packages/db/test/privacy.int.test.ts` scans every such column of every table, so
  a column added later is covered automatically. When you add one, add it here as well.
- **The data subject** is one phone, the E.164 key of a buyer (AC-Q1: one buyer = one phone = one player). It covers the player
  with that phone and every order with that buyer phone or of that player.
- **Classes:**
  - **PII**: identifies a person, or is a hash of an identifier that can be brute-forced (a phone hash, a chat-id hash);
  - **pseudonymous**: a random id or a business key that identifies a person only together with a PII row;
  - **not PII**: configuration, content, codes and counts.

## Subject data: erased or blanked

| Table.column | Class | Erasure |
|---|---|---|
| players.name / phone / email / auth_user_id | PII | name `''`, the others NULL, `anonymized_at` set; `players_anonymized_check` and `anonymized_rows_guard` (ET179) keep the row empty forever |
| orders.buyer_name / buyer_email | PII | `''` |
| orders.buyer_phone | PII | NULL (allowed only with `anonymized_at`, `orders_buyer_phone_present_check`) |
| orders.buyer_key (bytea) | PII (SHA-256 of phone + name + e-mail) | replaced by random bytes |
| orders.ip / ua_hash | PII | NULL |
| orders.fbclid / fbp / fbc / ttclid / gclid | PII (ad-platform browser and click ids) | NULL |
| visits.ip / ua_hash / fbclid / fbp / fbc / ttclid / gclid | PII | NULL for the subject's orders' visits, and for the other visits from the subject's devices on the same landing pages (the same IP address AND user-agent hash as one of their orders, consents or answers) |
| consents.ip / ua_hash | PII | NULL; the row (order, legal page version, consented_at) stays as the record of consent |
| attempt_questions.ip / ua_hash | PII (anti-cheat) | NULL (`attempt_questions_play_guard` admits exactly this for pii_eraser) |
| payment_notifications.raw, payments.raw | PII (customer_details, VA numbers, masked card) | cut down to the transaction keys (`payment_raw_kept`: transaction_id, order_id, statuses, amounts, payment type, times) plus `erased: true`. What Midtrans sends later is cut the same way (`payment_raw_erased_guard`) |
| deliveries.wa_chat_id / reply_chat_id / wa_message_id | PII (the message id embeds the chat id) | NULL; a pending delivery becomes `cancelled` / `subject_erased`. An erased order is never resent (`resend_delivery`, ET179) |
| delivery_openers.wa_message_id | PII | NULL; a pending opener becomes `expired` |
| waha_inbound.from_jid / body / raw | PII | `''`, NULL, `{}`; marked processed |
| waha_inbound.message_id | PII (embeds the sender's chat id) | replaced by `erased:` + SHA-256 of it. The row stays, so the webhook dedupe holds: `waha_inbound_erased_dedupe` skips a redelivery (kept at least 60 min, in practice for good) |
| waha_sends.contact_key | PII (SHA-256 of a chat id, or of the E.164 phone for an OTP or login-link send) | NULL for the subject's chat ids, phone and deliveries. The erasure waits (ET178) while an OTP or login-link job of the subject is still live, so no send re-adds it |
| wa_contacts.phone / chat_id / lid | PII | the row is DELETED |
| player_otps.phone / mac / sealed_code | PII | rows deleted |
| otp_enqueues.phone | PII | rows deleted |
| magic_links.token_hash | pseudonymous (a login capability) | every link of the player is deleted (outstanding ones revoked) |
| player_auth.user.name / email / phoneNumber / image | PII | the subject's users are DELETED: the linked one, and any holding the phone or `<phone>@players.invalid` |
| player_auth.session.ipAddress / userAgent / token | PII | deleted with their session_state |
| player_auth.account.* | PII / secrets | deleted |
| player_auth.verification.identifier / value | PII | rows naming the phone are deleted |
| fulfillments.notes / correction_reason, winners.decision_reason | PII (the Owner's free text may name the winner) | NULL. The audit log records only that a reason was given |
| fulfillments.proof_upload_id, uploads.* of the proof | PII (a delivery photo or receipt) | unlinked, the uploads row deleted, the file removed by the admin app after the commit (the upload sweeper removes any left behind) |
| outbox.payload / sealed | PII when it quotes the subject (`otp.send` carries the phone, `waha.inbound` the message id) | payload `{"erased": true}`, sealed NULL, marked processed, for every row with a JSON string value EQUAL to the phone (E.164, 62..., 08...), an e-mail, a chat id or the lid (values of 8 characters or more), and for the `waha.inbound` jobs of the erased messages. Never a substring match: another buyer's longer phone or e-mail stays |
| alerts.payload / message | PII when it quotes the subject (it should not: alerts carry ids) | payload `{"erased": true}` on an exact value match; message `erased` when it names one as a whole word |
| deletion_requests.subject_phone | PII | NULL once decided (completed or rejected) |
| conversion_events (CAPI sinks meta / tiktok / google, still pending) | sends hashed e-mail / phone | `failed` / `subject_erased` (never sent); S2S rows carry no PII and are kept. An erased order is never re-fired (`refire_conversion`, ET179) |
## Kept: pseudonymous, the financial and contest record

| Table.column | Class | Why it stays |
|---|---|---|
| orders: id, public_id, order_code, amount, status, timestamps, player, product, program, landing page, visit, adnet_id, clickid, sub_id, pub, utm_* | pseudonymous | revenue, ROI, the MT reconciliation identity and the rollups count by them; the test checks that the report totals are identical before and after. The player of an anonymized order never changes (ET179) |
| orders.snap_redirect_url, midtrans_attempts.* (midtrans_order_id, snap_token, redirect_url, error, gateway status) | pseudonymous | the payment trail and reconciliation; no customer data |
| payments: gateway_txn_id, payment_type, statuses, amounts | pseudonymous | the money record |
| payment_reconciliation_findings.attempts | not PII | statuses per attempt |
| conversion_events (txid = order id, last_error), conversion_attempts (redacted URL, response excerpt, error) | pseudonymous | the postback record; URLs are redacted |
| set_attempts, player_program_stats, player_programs | pseudonymous (ids and numbers) | ranks never move; the live leaderboard shows the player masked as `***` |
| leaderboard_snapshots.entries | pseudonymous (player ids, scores, times; no names) | immutable (ET104) and needs no change |
| winners.flag_reason, winners (ids, rank) | not PII / pseudonymous | the prize record; a winner with an undelivered prize blocks the erasure (ET177) |
| fulfillments: status, step stamps (*_by_admin_user_id are admin ids) | pseudonymous | the delivery record |
| deliveries: channel, filename (from the product title), wa_ack, last_error (codes) | not PII | |
| waha_inbound.session_name / outcome, waha_sends.kind / outcome | not PII | |
| deletion_requests: status, lookup_kind, summary (counts); note and decision_note (contact details refused, the console asks for no names) | not PII / free text | the record that the request was handled; the audit log only records that the texts were given |
| audit_log.* | references only (ids, `pii_refs` such as `player:<id> anonymized`); audit_log.ip is the ADMIN's address | append-only (ET030) |

## Not about buyers or players

| Table.column | Class | Note |
|---|---|---|
| admin_auth.* (user, session, account, twoFactor, recovery_code, totp_used, verification, login_throttle, session_state), admin_profiles.display_name | PII of the Owner and Staff | staff accounts; not part of a buyer's request |
| test_recipients.phone / label, template_test_sends.recipient | PII of the Owner's own test numbers / addresses | Owner-managed, at most 5; not buyer data |
| smtp_settings (username, from_address, from_name), waha_sessions.phone (the pool numbers), waha_servers | business contact / configuration | |
| settings_secrets (ciphertext, nonce, sealed_dek, last4) | secrets | sealed; not PII |
| ad_spend.note, app_settings.value, report_rollup_state.fees, report_orders_daily.utm_campaign, heartbeats.info | not PII | configuration and aggregates |
| products, programs, trivia_sets, questions, question_options, prize_tiers, legal_pages, message_templates, landing_pages (pixels), lp_domains, adnets | not PII | content and configuration |
| uploads (pdf, image, lp_zip, import), upload_sessions.filename | not PII | admin content (a proof is the exception above) |
| drizzle.__drizzle_migrations | not PII | |

## Retention of strangers' WhatsApp contacts

- **Who.** A `wa_contacts` row whose phone is no order's buyer phone and no player's phone, for example an `@lid` sender resolved
  while answering a message that matched nothing.
- **Rule.** It is deleted once it has not been confirmed for 7 days: `public.prune_stranger_wa_contacts`, run every minute by the
  worker sweeper `wa_contacts_retention`, at most 500 rows a run.
- **Buyers' rows** live as long as the buyer's data does.

## Outside PostgreSQL

Valkey and the backups are covered in [docs/runbooks/privacy.md](../runbooks/privacy.md).
