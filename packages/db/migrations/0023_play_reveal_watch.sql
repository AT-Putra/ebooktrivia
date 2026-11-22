-- US-031 (M11a security hardening), the one migration of the story:
--   - answer_reveals: the reveal watch of public.play_reveal (owner trivia_play; the US-027 accepted residual, a stolen
--     public_rw login acting as a player). Counts of answered and refused (late) reveals and the first refusal; ids,
--     counts and times only. play_reveal refuses a reveal more than 60 s after the answer and raises play_reveal_misuse
--     on 3+ distinct flagged attempts an hour (sql/play.sql).
--   - app_settings_bounds_check: otp.code_ttl_seconds 60..600 (was 900; ASVS V6.5.5).
--   - admin_profiles.password_check_id / password_breached_at: the breached-password check of an admin's current password
--     (ASVS V6.2.12; the worker's flag_breached_admin_password, sql/functions.sql); a flagged admin must change it.
CREATE TABLE "answer_reveals" (
	"answer_id" uuid PRIMARY KEY NOT NULL,
	"reveals" integer DEFAULT 0 NOT NULL,
	"late_reveals" integer DEFAULT 0 NOT NULL,
	"first_revealed_at" timestamp with time zone NOT NULL,
	"last_revealed_at" timestamp with time zone NOT NULL,
	"flagged_at" timestamp with time zone,
	CONSTRAINT "answer_reveals_counts_check" CHECK ("answer_reveals"."reveals" >= 0 AND "answer_reveals"."late_reveals" >= 0 AND "answer_reveals"."reveals" + "answer_reveals"."late_reveals" >= 1),
	CONSTRAINT "answer_reveals_flagged_check" CHECK (("answer_reveals"."flagged_at" IS NULL) = ("answer_reveals"."late_reveals" = 0))
);
--> statement-breakpoint
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_bounds_check";--> statement-breakpoint
-- US-031 (ASVS V6.5.5): an OTP code lives 10 minutes at most. A stored value above the new bound is clamped first,
-- so the constraint below can be added (codes already issued keep their expiry).
UPDATE "app_settings" SET "value" = '600'::jsonb WHERE "key" = 'otp.code_ttl_seconds' AND jsonb_typeof("value") = 'number' AND ("value" #>> '{}')::numeric > 600;--> statement-breakpoint
ALTER TABLE "admin_profiles" ADD COLUMN "password_check_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_profiles" ADD COLUMN "password_breached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "answer_reveals" ADD CONSTRAINT "answer_reveals_answer_id_attempt_questions_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."attempt_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_reveals_flagged_at_idx" ON "answer_reveals" USING btree ("flagged_at") WHERE "answer_reveals"."flagged_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_profiles" ADD CONSTRAINT "admin_profiles_breach_check" CHECK ("admin_profiles"."password_breached_at" IS NULL OR "admin_profiles"."password_check_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_bounds_check" CHECK (CASE WHEN "app_settings"."key" NOT IN ('otp.code_ttl_seconds', 'otp.max_attempts', 'otp.phone_cap', 'otp.phone_window_seconds', 'otp.ip_cap', 'otp.ip_window_seconds', 'otp.cooldown_seconds', 'otp.global_send_cap', 'orders.expiry_seconds', 'orders.sales_close_buffer_minutes', 'checkout.ip_cap', 'checkout.ip_window_seconds', 'checkout.phone_cap', 'checkout.phone_window_seconds', 'checkout.lp_cap', 'checkout.lp_window_seconds', 'captcha.ip_cap', 'captcha.ip_window_seconds', 'captcha.ip48_cap', 'trivia.extension_max_minutes', 'delivery.wa_delay_seconds') THEN true WHEN jsonb_typeof("app_settings"."value") <> 'number' THEN false ELSE CASE "app_settings"."key" WHEN 'otp.code_ttl_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 600 WHEN 'otp.max_attempts' THEN (value #>> '{}')::numeric BETWEEN 1 AND 5 WHEN 'otp.phone_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 10 WHEN 'otp.phone_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 3600 AND 86400 WHEN 'otp.ip_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 100 WHEN 'otp.ip_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 600 AND 86400 WHEN 'otp.cooldown_seconds' THEN (value #>> '{}')::numeric BETWEEN 15 AND 600 WHEN 'otp.global_send_cap' THEN (value #>> '{}')::numeric BETWEEN 50 AND 100000 WHEN 'orders.expiry_seconds' THEN (value #>> '{}')::numeric BETWEEN 900 AND 86400 WHEN 'orders.sales_close_buffer_minutes' THEN (value #>> '{}')::numeric BETWEEN 5 AND 1440 WHEN 'checkout.ip_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 1000 WHEN 'checkout.ip_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 86400 WHEN 'checkout.phone_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 100 WHEN 'checkout.phone_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 86400 WHEN 'checkout.lp_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 100000 WHEN 'checkout.lp_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 86400 WHEN 'captcha.ip_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 1000 WHEN 'captcha.ip_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 86400 WHEN 'captcha.ip48_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 100000 WHEN 'trivia.extension_max_minutes' THEN (value #>> '{}')::numeric BETWEEN 1 AND 1440 WHEN 'delivery.wa_delay_seconds' THEN (value #>> '{}')::numeric BETWEEN 0 AND 86400 END END);