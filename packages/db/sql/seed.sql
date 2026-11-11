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
