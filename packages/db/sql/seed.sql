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

-- Midtrans (AC-S10, US-017): sandbox until the Owner switches (audited, and only once the
-- production server key is set); the methods offered in Snap; per-method fees (flat IDR + basis
-- points, packages/core money.ts) start empty. Not secret (public_rw reads app_settings); the
-- server keys are sealed payment secrets.
INSERT INTO public.app_settings (key, value) VALUES
  ('midtrans.environment', '"sandbox"'),
  ('midtrans.enabled_methods', '["other_qris", "gopay", "shopeepay", "bca_va", "bni_va", "bri_va", "permata_va", "echannel"]'),
  ('midtrans.fees', '{}')
ON CONFLICT (key) DO NOTHING;

-- Default message templates (AC-A10, Bahasa Indonesia), editable in the admin console. Keys and
-- the variables each may use: apps/admin/src/lib/settings/templates.ts.
INSERT INTO public.message_templates (key, channel, locale, subject, body) VALUES
  ('delivery', 'whatsapp', 'id', NULL,
   E'Halo {nama}, terima kasih sudah membeli *{judul_ebook}*.\n\nEbook terlampir di pesan ini. Masuk ke trivia lewat tautan ini: {link_trivia}\n\nKode pesanan: {order_id}'),
  ('delivery', 'email', 'id', 'Ebook {judul_ebook} untuk {nama}',
   E'<p>Halo {nama},</p>\n<p>Terima kasih sudah membeli <strong>{judul_ebook}</strong>. Ebook terlampir di email ini.</p>\n<p><a href="{link_trivia}">Masuk ke trivia</a></p>\n<p>Kode pesanan: {order_id}</p>'),
  ('delivery_without_link', 'whatsapp', 'id', NULL,
   E'Halo {nama}, berikut ebook *{judul_ebook}* untuk pesanan {order_id}. Tautan masuk trivia kami kirim lewat email.'),
  ('otp', 'whatsapp', 'id', NULL,
   E'Kode masuk trivia Anda: {kode_otp}. Berlaku 5 menit. Jangan berikan kode ini kepada siapa pun.')
ON CONFLICT (key, channel, locale) DO NOTHING;
