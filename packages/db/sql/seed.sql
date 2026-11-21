-- seed.sql: default admin settings (applied as migrator, last). Never overwrites an edited value.
SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

-- OTP and rate-limit parameters (AC-A3; values per spec + plan M9): 6-digit codes valid 5 min
-- (the player_otps trigger clamps expires_at to otp.code_ttl_seconds), 5 attempts; 3 sends per
-- phone per hour (enforced in SQL by enqueue_otp); 10 per IP per hour and a 60 s cooldown
-- (enforced by the app).
-- Orders (AC-S8 / AC-S10): unpaid orders and the Snap page expire after 24 h; the orders
-- checkout guard rejects an expires_at later than now + orders.expiry_seconds.
INSERT INTO public.app_settings (key, value) VALUES
  ('otp.code_ttl_seconds', '300'),
  ('otp.max_attempts', '5'),
  ('otp.phone_cap', '3'),
  ('otp.phone_window_seconds', '3600'),
  ('otp.ip_cap', '10'),
  ('otp.ip_window_seconds', '3600'),
  ('otp.cooldown_seconds', '60'),
  -- US-026: the global OTP send breaker (enqueue_otp), codes per 10 minutes over all phones. 500 is about
  -- 3000 logins an hour, several times a launch wave of buyers (3 codes per phone per hour at most), and
  -- far below what a WhatsApp number may send before a ban (docs/runbooks/staging-provision.md).
  ('otp.global_send_cap', '500'),
  ('orders.expiry_seconds', '86400')
ON CONFLICT (key) DO NOTHING;

-- Checkout (US-020; AC-S4, AC-S8): checkout closes 30 minutes before sales_end_at; the public API's
-- Valkey rate limits (Owner decision D2, 2026-11-20): 100 checkouts per client IP (an IPv6 /64) per
-- 10 minutes (mobile carriers put many buyers behind one IPv4 address), 10 per phone per hour, 600
-- per landing page per minute; 300 Cap challenge / redeem requests per client IP and 3000 per IPv6
-- /48 per 10 minutes (Cap itself stores nothing: docs/runbooks/staging-provision.md).
INSERT INTO public.app_settings (key, value) VALUES
  ('orders.sales_close_buffer_minutes', '30'),
  ('checkout.ip_cap', '100'),
  ('checkout.ip_window_seconds', '600'),
  ('checkout.phone_cap', '10'),
  ('checkout.phone_window_seconds', '3600'),
  ('checkout.lp_cap', '600'),
  ('checkout.lp_window_seconds', '60'),
  ('captcha.ip_cap', '300'),
  ('captcha.ip_window_seconds', '600'),
  ('captcha.ip48_cap', '3000')
ON CONFLICT (key) DO NOTHING;

-- The Owner's deadline-extension tool (US-028, outages): covers an outage that started at most 60
-- minutes back by default (APP_SETTING_BOUNDS 1..1440), read by extend_open_question_deadlines.
INSERT INTO public.app_settings (key, value) VALUES ('trivia.extension_max_minutes', '60')
ON CONFLICT (key) DO NOTHING;

-- Delivery (US-025; AC-D8): the proactive WhatsApp send waits 3 minutes after PAID (the buyer may message first); the
-- Owner may set 0 (at once) up to a day. The worker reads it when an order is paid (WORKER_WA_DELAY_MS stays as the
-- fallback while the setting is missing).
INSERT INTO public.app_settings (key, value) VALUES ('delivery.wa_delay_seconds', '180')
ON CONFLICT (key) DO NOTHING;

-- Midtrans (AC-S10, US-017): sandbox until the Owner switches (audited, and only once the
-- production server key is set); the methods offered in Snap; per-method fees (flat IDR + basis
-- points, packages/core money.ts) start empty. Not secret (public_rw reads app_settings); the
-- server keys are sealed payment secrets.
-- Owner D11 (US-005): every method is ON except shopeepay, bri_va, cimb_va and kredivo, which the Owner's Midtrans account does
-- not have active (Snap accepts their codes but offers nothing for them, docs/spikes/R12.md); the Owner switches each one in
-- the console (Midtrans settings, audited).
INSERT INTO public.app_settings (key, value) VALUES
  ('midtrans.environment', '"sandbox"'),
  ('midtrans.enabled_methods', '["other_qris", "gopay", "bca_va", "bni_va", "permata_va", "echannel", "other_va", "credit_card", "indomaret", "akulaku"]'),
  ('midtrans.fees', '{}')
ON CONFLICT (key) DO NOTHING;
-- A database seeded before D11 still holds the OLD default list. Replace it, once, only while no admin ever saved the setting
-- (updated_by_admin_user_id IS NULL: an Owner's choice, even the same list, is never touched).
UPDATE public.app_settings
   SET value = '["other_qris", "gopay", "bca_va", "bni_va", "permata_va", "echannel", "other_va", "credit_card", "indomaret", "akulaku"]'::jsonb, updated_at = now()
 WHERE key = 'midtrans.enabled_methods' AND updated_by_admin_user_id IS NULL
   AND value = '["other_qris", "gopay", "shopeepay", "bca_va", "bni_va", "bri_va", "permata_va", "echannel"]'::jsonb;

-- Default message templates (AC-A10, Bahasa Indonesia), editable in the admin console. Keys and
-- the variables each may use: apps/admin/src/lib/settings/templates.ts.
INSERT INTO public.message_templates (key, channel, locale, subject, body) VALUES
  ('delivery', 'whatsapp', 'id', NULL,
   E'Halo {nama}, terima kasih sudah membeli *{judul_ebook}*.\n\nEbook terlampir di pesan ini. Masuk ke trivia lewat tautan ini: {link_trivia}\n\nKode pesanan: {order_id}'),
  ('delivery', 'email', 'id', 'Ebook {judul_ebook} untuk {nama}',
   E'<p>Halo {nama},</p>\n<p>Terima kasih sudah membeli <strong>{judul_ebook}</strong>. Ebook terlampir di email ini.</p>\n<p><a href="{link_trivia}">Masuk ke trivia</a></p>\n<p>Kode pesanan: {order_id}</p>'),
  -- The short opener (US-025, Owner decision D7): the proactive WhatsApp message to a buyer who has not written first. Text only (no file, no
  -- link); it asks the buyer to reply, and the ebook and the login link follow the reply. The worker picks one variant at random for each
  -- buyer; {nama} is the buyer's FIRST name here. Add or edit variants freely (keys delivery_opener_1 .. delivery_opener_3).
  ('delivery_opener_1', 'whatsapp', 'id', NULL,
   E'Halo {nama}, pembayaran Anda untuk {judul_ebook} sudah kami terima. Balas pesan ini ya, ebooknya langsung kami kirim ke sini.'),
  ('delivery_opener_2', 'whatsapp', 'id', NULL,
   E'Hai {nama}, terima kasih sudah membeli {judul_ebook}. Silakan balas pesan ini supaya ebooknya bisa kami kirim lewat WhatsApp.'),
  ('delivery_opener_3', 'whatsapp', 'id', NULL,
   E'Selamat datang {nama}! Pesanan {judul_ebook} sudah lunas. Balas pesan ini dengan satu kata saja, nanti ebooknya kami kirim di chat ini.'),
  ('otp', 'whatsapp', 'id', NULL,
   E'Kode masuk trivia Anda: {kode_otp}. Berlaku 5 menit. Jangan berikan kode ini kepada siapa pun.')
ON CONFLICT (key, channel, locale) DO NOTHING;
-- The first pass of US-025 had a link-free ebook template for a sender nobody confirmed; Owner decision D6 replaced it with a fixed caption (no name, no
-- link, packages/i18n), so the row is not used by anything.
DELETE FROM public.message_templates WHERE key = 'delivery_without_link';
