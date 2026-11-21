-- US-026 (player authentication):
--   - player_auth.session_state: when the login that started a player session's rotation chain happened (the
--     90-day absolute cap; written by apps/public, deleted with the session);
--   - player_otps.sealed_code becomes nullable: enqueue_otp moves the sealed code into the outbox and NULLs it
--     here, so once the worker has sent (and wiped) it only the HMAC is left;
--   - otp.global_send_cap joins the bounded settings (the global OTP send breaker in enqueue_otp, sql/seed.sql),
--     and otp_enqueues gets an index on enqueued_at (the breaker's 10-minute count, the daily prune);
--   - one live (unconsumed) magic link per player and channel (plan M8.4 / §10 item 4, "one per channel");
--     public.issue_magic_link replaces the previous one. No issuer existed before this story, so a database
--     can only hold hand-made rows here: of several live links of one player and channel, the newest is kept.
DELETE FROM "magic_links" m
 USING "magic_links" n
 WHERE m."consumed_at" IS NULL AND n."consumed_at" IS NULL
   AND m."player_id" = n."player_id" AND m."channel" = n."channel"
   AND (m."created_at", m."id") < (n."created_at", n."id");--> statement-breakpoint
CREATE TABLE "player_auth"."session_state" (
	"session_id" text PRIMARY KEY NOT NULL,
	"login_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_bounds_check";--> statement-breakpoint
ALTER TABLE "player_otps" ALTER COLUMN "sealed_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "player_auth"."session_state" ADD CONSTRAINT "session_state_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "player_auth"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "magic_links_player_channel_live_key" ON "magic_links" USING btree ("player_id","channel") WHERE "magic_links"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "otp_enqueues_enqueued_at_idx" ON "otp_enqueues" USING btree ("enqueued_at");--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_bounds_check" CHECK (CASE WHEN "app_settings"."key" NOT IN ('otp.code_ttl_seconds', 'otp.max_attempts', 'otp.phone_cap', 'otp.phone_window_seconds', 'otp.ip_cap', 'otp.ip_window_seconds', 'otp.cooldown_seconds', 'otp.global_send_cap', 'orders.expiry_seconds', 'orders.sales_close_buffer_minutes', 'checkout.ip_cap', 'checkout.ip_window_seconds', 'checkout.phone_cap', 'checkout.phone_window_seconds', 'checkout.lp_cap', 'checkout.lp_window_seconds', 'captcha.ip_cap', 'captcha.ip_window_seconds', 'captcha.ip48_cap', 'trivia.extension_max_minutes') THEN true WHEN jsonb_typeof("app_settings"."value") <> 'number' THEN false ELSE CASE "app_settings"."key" WHEN 'otp.code_ttl_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 900 WHEN 'otp.max_attempts' THEN (value #>> '{}')::numeric BETWEEN 1 AND 5 WHEN 'otp.phone_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 10 WHEN 'otp.phone_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 3600 AND 86400 WHEN 'otp.ip_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 100 WHEN 'otp.ip_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 600 AND 86400 WHEN 'otp.cooldown_seconds' THEN (value #>> '{}')::numeric BETWEEN 15 AND 600 WHEN 'otp.global_send_cap' THEN (value #>> '{}')::numeric BETWEEN 50 AND 100000 WHEN 'orders.expiry_seconds' THEN (value #>> '{}')::numeric BETWEEN 900 AND 86400 WHEN 'orders.sales_close_buffer_minutes' THEN (value #>> '{}')::numeric BETWEEN 5 AND 1440 WHEN 'checkout.ip_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 1000 WHEN 'checkout.ip_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 86400 WHEN 'checkout.phone_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 100 WHEN 'checkout.phone_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 86400 WHEN 'checkout.lp_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 100000 WHEN 'checkout.lp_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 86400 WHEN 'captcha.ip_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 1000 WHEN 'captcha.ip_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 86400 WHEN 'captcha.ip48_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 100000 WHEN 'trivia.extension_max_minutes' THEN (value #>> '{}')::numeric BETWEEN 1 AND 1440 END END);
