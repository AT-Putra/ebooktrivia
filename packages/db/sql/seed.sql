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
  ('orders.expiry_seconds', '86400')
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
