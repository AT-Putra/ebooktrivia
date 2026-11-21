-- US-025 (M8) delivery over WhatsApp and e-mail. The pool keeps its pacing and health on the session row (next_send_at,
-- fail_streak, cooldown_until, the ban signals of WhatsApp: reachout_until, warning_level, the timelock and capping state WAHA reports, the 463 / 475 counts,
-- and new_contact_cap, the number's daily budget of NEW contacts) and every claimed send in waha_sends (the per-number daily cap, the weighted round-robin
-- and, by contact_key, the per-contact rules count it; new_contact marks the sends that spend the new-contact budget; outcome says how it ended, for the
-- delivery report's per-number volume and failure rate). delivery_openers is the short opener
-- of a WhatsApp delivery (Owner decision D7), exactly-once on its own. wa_contacts caches what WAHA's check-exists said about a phone (the chat id to send to,
-- possibly a @lid, and the lid link). waha_inbound remembers what the worker did with a message (outcome) and when it claimed the right to answer it
-- (replied_at). deliveries gets an index for the ack webhook, attempts_base (the retry budget is attempts - attempts_base, so `attempts` only ever increases: a resend and a
-- claim that sent nothing give the budget back by moving the base, never by reusing an attempt number) and reply_chat_id (the chat a buyer-first reply went to, a @lid perhaps,
-- for the unknown-send lookup). A lid belongs to one phone: wa_contacts.lid is unique, and wa_contacts.lid_checked_at says when that link was last CONFIRMED (a check-exists answer
-- that carried the lid, or a message from it that matched an order or an opener), apart from checked_at, the refresh age of the cached answer itself. The proactive WhatsApp delay becomes the admin setting delivery.wa_delay_seconds
-- (APP_SETTING_BOUNDS, so app_settings_bounds_check is rebuilt, and a whole-number check, since 0 is allowed). The ack and session-state functions, the
-- exactly-once guards (ET130, ET131) and the grants are in sql/functions.sql, sql/triggers.sql and sql/grants.sql; the default of the setting and the
-- opener templates in sql/seed.sql.
CREATE TABLE "delivery_openers" (
	"delivery_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"session_id" uuid,
	"tried_session_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"wa_message_id" text,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_openers_status_check" CHECK ("delivery_openers"."status" IN ('pending', 'sending', 'sent', 'unknown', 'failed', 'expired')),
	CONSTRAINT "delivery_openers_attempts_check" CHECK ("delivery_openers"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wa_contacts" (
	"phone" text PRIMARY KEY NOT NULL,
	"number_exists" boolean NOT NULL,
	"chat_id" text,
	"lid" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lid_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_contacts_phone_check" CHECK ("wa_contacts"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "wa_contacts_chat_id_check" CHECK ("wa_contacts"."chat_id" IS NULL OR "wa_contacts"."chat_id" ~ '^[0-9]{5,20}@(c\.us|lid)$'),
	CONSTRAINT "wa_contacts_lid_check" CHECK ("wa_contacts"."lid" IS NULL OR "wa_contacts"."lid" ~ '^[0-9]{5,20}@lid$'),
	CONSTRAINT "wa_contacts_exists_chat_check" CHECK (NOT "wa_contacts"."number_exists" OR "wa_contacts"."chat_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "waha_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"delivery_id" uuid,
	"kind" text NOT NULL,
	"contact_key" text,
	"send_at" timestamp with time zone DEFAULT now() NOT NULL,
	"new_contact" boolean DEFAULT false NOT NULL,
	"outcome" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waha_sends_kind_check" CHECK ("waha_sends"."kind" IN ('opener', 'reply', 'text', 'otp')),
	CONSTRAINT "waha_sends_outcome_check" CHECK ("waha_sends"."outcome" IN ('reserved', 'sent', 'unknown', 'failed')),
	CONSTRAINT "waha_sends_contact_key_check" CHECK ("waha_sends"."contact_key" IS NULL OR "waha_sends"."contact_key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_bounds_check";--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "attempts_base" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "reply_chat_id" text;--> statement-breakpoint
ALTER TABLE "waha_inbound" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "waha_inbound" ADD COLUMN "replied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "next_send_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "fail_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "cooldown_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "reachout_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "warning_level" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "new_contact_cap" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "timelock_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "timelock_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "capping_status" text;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "capping_total_quota" integer;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "capping_used_quota" integer;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "capping_cycle_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "limits_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "ban_463_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "ban_475_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_openers" ADD CONSTRAINT "delivery_openers_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_openers" ADD CONSTRAINT "delivery_openers_session_id_waha_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."waha_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waha_sends" ADD CONSTRAINT "waha_sends_session_id_waha_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."waha_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waha_sends" ADD CONSTRAINT "waha_sends_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_openers_awaiting_idx" ON "delivery_openers" USING btree ("session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_contacts_lid_key" ON "wa_contacts" USING btree ("lid");--> statement-breakpoint
CREATE INDEX "waha_sends_session_created_idx" ON "waha_sends" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "waha_sends_contact_idx" ON "waha_sends" USING btree ("contact_key","send_at");--> statement-breakpoint
CREATE INDEX "deliveries_wa_message_id_idx" ON "deliveries" USING btree ("wa_message_id");--> statement-breakpoint
CREATE INDEX "waha_inbound_from_replied_idx" ON "waha_inbound" USING btree ("from_jid","replied_at");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_attempts_base_check" CHECK ("deliveries"."attempts_base" >= 0 AND "deliveries"."attempts_base" <= "deliveries"."attempts");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_reply_chat_id_check" CHECK ("deliveries"."reply_chat_id" IS NULL OR "deliveries"."reply_chat_id" ~ '^[0-9]{5,20}@(c.us|lid)$');--> statement-breakpoint
ALTER TABLE "waha_inbound" ADD CONSTRAINT "waha_inbound_outcome_check" CHECK ("waha_inbound"."outcome" IS NULL OR "waha_inbound"."outcome" ~ '^[a-z_]{1,64}$');--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD CONSTRAINT "waha_sessions_fail_streak_check" CHECK ("waha_sessions"."fail_streak" >= 0);--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD CONSTRAINT "waha_sessions_new_contact_cap_check" CHECK ("waha_sessions"."new_contact_cap" >= 0);--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD CONSTRAINT "waha_sessions_warning_level_check" CHECK ("waha_sessions"."warning_level" IN ('none', 'first', 'second'));--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD CONSTRAINT "waha_sessions_capping_status_check" CHECK ("waha_sessions"."capping_status" IS NULL OR "waha_sessions"."capping_status" ~ '^[A-Z_]{1,32}$');--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD CONSTRAINT "waha_sessions_ban_463_count_check" CHECK ("waha_sessions"."ban_463_count" >= 0);--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD CONSTRAINT "waha_sessions_ban_475_count_check" CHECK ("waha_sessions"."ban_475_count" >= 0);--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_wa_delay_whole_check" CHECK ("app_settings"."key" <> 'delivery.wa_delay_seconds' OR (jsonb_typeof("app_settings"."value") = 'number' AND ("app_settings"."value" #>> '{}')::numeric = trunc(("app_settings"."value" #>> '{}')::numeric)));--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_bounds_check" CHECK (CASE WHEN "app_settings"."key" NOT IN ('otp.code_ttl_seconds', 'otp.max_attempts', 'otp.phone_cap', 'otp.phone_window_seconds', 'otp.ip_cap', 'otp.ip_window_seconds', 'otp.cooldown_seconds', 'otp.global_send_cap', 'orders.expiry_seconds', 'orders.sales_close_buffer_minutes', 'checkout.ip_cap', 'checkout.ip_window_seconds', 'checkout.phone_cap', 'checkout.phone_window_seconds', 'checkout.lp_cap', 'checkout.lp_window_seconds', 'captcha.ip_cap', 'captcha.ip_window_seconds', 'captcha.ip48_cap', 'trivia.extension_max_minutes', 'delivery.wa_delay_seconds') THEN true WHEN jsonb_typeof("app_settings"."value") <> 'number' THEN false ELSE CASE "app_settings"."key" WHEN 'otp.code_ttl_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 900 WHEN 'otp.max_attempts' THEN (value #>> '{}')::numeric BETWEEN 1 AND 5 WHEN 'otp.phone_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 10 WHEN 'otp.phone_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 3600 AND 86400 WHEN 'otp.ip_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 100 WHEN 'otp.ip_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 600 AND 86400 WHEN 'otp.cooldown_seconds' THEN (value #>> '{}')::numeric BETWEEN 15 AND 600 WHEN 'otp.global_send_cap' THEN (value #>> '{}')::numeric BETWEEN 50 AND 100000 WHEN 'orders.expiry_seconds' THEN (value #>> '{}')::numeric BETWEEN 900 AND 86400 WHEN 'orders.sales_close_buffer_minutes' THEN (value #>> '{}')::numeric BETWEEN 5 AND 1440 WHEN 'checkout.ip_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 1000 WHEN 'checkout.ip_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 86400 WHEN 'checkout.phone_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 100 WHEN 'checkout.phone_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 86400 WHEN 'checkout.lp_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 100000 WHEN 'checkout.lp_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 86400 WHEN 'captcha.ip_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 1000 WHEN 'captcha.ip_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 86400 WHEN 'captcha.ip48_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 100000 WHEN 'trivia.extension_max_minutes' THEN (value #>> '{}')::numeric BETWEEN 1 AND 1440 WHEN 'delivery.wa_delay_seconds' THEN (value #>> '{}')::numeric BETWEEN 0 AND 86400 END END);