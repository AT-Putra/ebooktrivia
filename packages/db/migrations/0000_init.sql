CREATE SCHEMA "admin_auth";
--> statement-breakpoint
CREATE SCHEMA "player_auth";
--> statement-breakpoint
CREATE TYPE "public"."program_status" AS ENUM('draft', 'published', 'awaiting_confirmation', 'finalized');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'paid', 'review', 'expired', 'gateway_failed', 'snap_create_failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_status" AS ENUM('pending', 'contacted', 'sent', 'done');--> statement-breakpoint
CREATE TYPE "public"."winner_status" AS ENUM('awaiting_confirmation', 'confirmed', 'flagged', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."conversion_status" AS ENUM('pending', 'sending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "admin_auth"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_auth"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "admin_auth"."twoFactor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backupCodes" text NOT NULL,
	"userId" text NOT NULL,
	"verified" boolean,
	"failedVerificationCount" integer,
	"lockedUntil" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_auth"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"twoFactorEnabled" boolean,
	CONSTRAINT "user_email_key" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "admin_auth"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_auth"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_auth"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "player_auth"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"phoneNumber" text,
	"phoneNumberVerified" boolean,
	CONSTRAINT "user_email_key" UNIQUE("email"),
	CONSTRAINT "user_phoneNumber_key" UNIQUE("phoneNumber")
);
--> statement-breakpoint
CREATE TABLE "player_auth"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"price_idr" bigint NOT NULL,
	"pdf_upload_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_price_idr_check" CHECK ("products"."price_idr" > 0)
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "program_status" DEFAULT 'draft' NOT NULL,
	"sales_start_at" timestamp with time zone NOT NULL,
	"sales_end_at" timestamp with time zone NOT NULL,
	"grace_days" integer NOT NULL,
	"locked_at" timestamp with time zone,
	"default_points" integer DEFAULT 10 NOT NULL,
	"default_timer_seconds" integer DEFAULT 20 NOT NULL,
	"leaderboard_top_n" integer DEFAULT 10 NOT NULL,
	"cloned_from_program_id" uuid,
	"winners_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "programs_slug_key" UNIQUE("slug"),
	CONSTRAINT "programs_slug_check" CHECK ("programs"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "programs_sales_window_check" CHECK ("programs"."sales_end_at" > "programs"."sales_start_at"),
	CONSTRAINT "programs_grace_days_check" CHECK ("programs"."grace_days" >= 0),
	CONSTRAINT "programs_default_points_check" CHECK ("programs"."default_points" >= 0),
	CONSTRAINT "programs_default_timer_check" CHECK ("programs"."default_timer_seconds" > 0),
	CONSTRAINT "programs_leaderboard_top_n_check" CHECK ("programs"."leaderboard_top_n" > 0)
);
--> statement-breakpoint
CREATE TABLE "question_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"label" text NOT NULL,
	"is_correct" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_options_question_id_position_key" UNIQUE("question_id","position"),
	CONSTRAINT "question_options_position_check" CHECK ("question_options"."position" BETWEEN 1 AND 4)
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"prompt" text NOT NULL,
	"image_upload_id" uuid,
	"points" integer NOT NULL,
	"timer_seconds" integer NOT NULL,
	"explanation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_set_id_position_key" UNIQUE("set_id","position"),
	CONSTRAINT "questions_points_check" CHECK ("questions"."points" >= 0),
	CONSTRAINT "questions_timer_seconds_check" CHECK ("questions"."timer_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "trivia_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"thumbnail_upload_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trivia_sets_program_id_position_key" UNIQUE("program_id","position")
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"session_id" uuid,
	"wa_chat_id" text,
	"filename" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"tried_session_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"wa_message_id" text,
	"wa_ack" text,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_order_id_channel_key" UNIQUE("order_id","channel"),
	CONSTRAINT "deliveries_channel_check" CHECK ("deliveries"."channel" IN ('whatsapp', 'email')),
	CONSTRAINT "deliveries_wa_ack_check" CHECK ("deliveries"."wa_ack" IS NULL OR "deliveries"."wa_ack" IN ('queued', 'sent', 'delivered', 'read', 'failed')),
	CONSTRAINT "deliveries_attempts_check" CHECK ("deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "waha_inbound" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" text NOT NULL,
	"session_id" uuid,
	"session_name" text NOT NULL,
	"from_jid" text NOT NULL,
	"body" text,
	"raw" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outbox_id" uuid,
	"processed_at" timestamp with time zone,
	CONSTRAINT "waha_inbound_message_id_key" UNIQUE("message_id"),
	CONSTRAINT "waha_inbound_raw_check" CHECK (jsonb_typeof("waha_inbound"."raw") = 'object')
);
--> statement-breakpoint
CREATE TABLE "waha_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"base_url_host" text NOT NULL,
	"allow_private_ip" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waha_servers_base_url_host_check" CHECK ("waha_servers"."base_url_host" = lower("waha_servers"."base_url_host"))
);
--> statement-breakpoint
CREATE TABLE "waha_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"session_name" text NOT NULL,
	"phone" text,
	"weight" integer DEFAULT 1 NOT NULL,
	"daily_cap" integer DEFAULT 200 NOT NULL,
	"status" text,
	"status_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waha_sessions_server_id_session_name_key" UNIQUE("server_id","session_name"),
	CONSTRAINT "waha_sessions_phone_check" CHECK ("waha_sessions"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "waha_sessions_weight_check" CHECK ("waha_sessions"."weight" > 0),
	CONSTRAINT "waha_sessions_daily_cap_check" CHECK ("waha_sessions"."daily_cap" >= 0)
);
--> statement-breakpoint
CREATE TABLE "landing_page_adnets" (
	"landing_page_id" uuid NOT NULL,
	"adnet_id" uuid NOT NULL,
	CONSTRAINT "landing_page_adnets_pkey" PRIMARY KEY("landing_page_id","adnet_id")
);
--> statement-breakpoint
CREATE TABLE "landing_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lp_key" text NOT NULL,
	"name" text NOT NULL,
	"program_id" uuid NOT NULL,
	"gateway" text DEFAULT 'midtrans' NOT NULL,
	"hosting" text DEFAULT 'external' NOT NULL,
	"pixels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_version_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_pages_lp_key_key" UNIQUE("lp_key"),
	CONSTRAINT "landing_pages_lp_key_check" CHECK ("landing_pages"."lp_key" ~ '^lp_[0-9A-Za-z]{8,40}$'),
	CONSTRAINT "landing_pages_gateway_check" CHECK ("landing_pages"."gateway" IN ('midtrans')),
	CONSTRAINT "landing_pages_hosting_check" CHECK ("landing_pages"."hosting" IN ('external', 'zip')),
	CONSTRAINT "landing_pages_pixels_check" CHECK (jsonb_typeof("landing_pages"."pixels") = 'object')
);
--> statement-breakpoint
CREATE TABLE "lp_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"landing_page_id" uuid NOT NULL,
	"host" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lp_domains_host_key" UNIQUE("host"),
	CONSTRAINT "lp_domains_host_check" CHECK ("lp_domains"."host" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' AND char_length("lp_domains"."host") <= 253)
);
--> statement-breakpoint
CREATE TABLE "lp_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"landing_page_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"upload_id" uuid NOT NULL,
	"file_count" integer NOT NULL,
	"uncompressed_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lp_versions_landing_page_id_version_key" UNIQUE("landing_page_id","version"),
	CONSTRAINT "lp_versions_version_check" CHECK ("lp_versions"."version" >= 1),
	CONSTRAINT "lp_versions_file_count_check" CHECK ("lp_versions"."file_count" >= 0),
	CONSTRAINT "lp_versions_uncompressed_bytes_check" CHECK ("lp_versions"."uncompressed_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "midtrans_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"midtrans_order_id" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"snap_token" text,
	"redirect_url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "midtrans_attempts_midtrans_order_id_key" UNIQUE("midtrans_order_id"),
	CONSTRAINT "midtrans_attempts_order_id_n_key" UNIQUE("order_id","n"),
	CONSTRAINT "midtrans_attempts_n_check" CHECK ("midtrans_attempts"."n" >= 1),
	CONSTRAINT "midtrans_attempts_midtrans_order_id_check" CHECK (char_length("midtrans_attempts"."midtrans_order_id") <= 50),
	CONSTRAINT "midtrans_attempts_status_check" CHECK ("midtrans_attempts"."status" IN ('requested', 'created', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"order_code" text NOT NULL,
	"landing_page_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"player_id" uuid,
	"buyer_name" text NOT NULL,
	"buyer_phone" text NOT NULL,
	"buyer_email" text NOT NULL,
	"amount_idr" bigint NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"snap_attempt_count" integer DEFAULT 0 NOT NULL,
	"snap_redirect_url" text,
	"snap_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid,
	"adnet_id" uuid,
	"clickid" text,
	"sub_id" text,
	"pub" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"fbclid" text,
	"fbp" text,
	"fbc" text,
	"ttclid" text,
	"gclid" text,
	"ip" "inet",
	"ua_hash" "bytea",
	"mo_outbox_id" uuid,
	"browser_mt_fired_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "orders_order_code_key" UNIQUE("order_code"),
	CONSTRAINT "orders_event_id_key" UNIQUE("event_id"),
	CONSTRAINT "orders_public_id_check" CHECK ("orders"."public_id" ~ '^[0-9A-Za-z]{16,40}$'),
	CONSTRAINT "orders_order_code_check" CHECK ("orders"."order_code" ~ '^[0-9A-HJKMNP-TV-Z]{8,16}$'),
	CONSTRAINT "orders_buyer_phone_check" CHECK ("orders"."buyer_phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "orders_amount_idr_check" CHECK ("orders"."amount_idr" > 0),
	CONSTRAINT "orders_currency_check" CHECK ("orders"."currency" = 'IDR'),
	CONSTRAINT "orders_snap_attempt_count_check" CHECK ("orders"."snap_attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"midtrans_order_id" text NOT NULL,
	"transaction_status" text NOT NULL,
	"status_code" text NOT NULL,
	"signature" text NOT NULL,
	"raw" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outbox_id" uuid,
	"processed_at" timestamp with time zone,
	CONSTRAINT "payment_notifications_dedupe_key" UNIQUE("midtrans_order_id","transaction_status","status_code","signature"),
	CONSTRAINT "payment_notifications_raw_check" CHECK (jsonb_typeof("payment_notifications"."raw") = 'object')
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"midtrans_attempt_id" uuid,
	"gateway_txn_id" text NOT NULL,
	"payment_type" text,
	"transaction_status" text NOT NULL,
	"fraud_status" text,
	"gross_amount_idr" bigint NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"fee_idr" bigint,
	"settled_at" timestamp with time zone,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_gateway_txn_id_key" UNIQUE("gateway_txn_id"),
	CONSTRAINT "payments_gross_amount_idr_check" CHECK ("payments"."gross_amount_idr" >= 0),
	CONSTRAINT "payments_fee_idr_check" CHECK ("payments"."fee_idr" IS NULL OR "payments"."fee_idr" >= 0),
	CONSTRAINT "payments_currency_check" CHECK ("payments"."currency" = 'IDR')
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"landing_page_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"adnet_id" uuid,
	"clickid" text,
	"sub_id" text,
	"pub" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"fbclid" text,
	"fbp" text,
	"fbc" text,
	"ttclid" text,
	"gclid" text,
	"ip" "inet",
	"ua_hash" "bytea"
);
--> statement-breakpoint
CREATE TABLE "ad_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spend_date" date NOT NULL,
	"platform" text NOT NULL,
	"landing_page_id" uuid,
	"adnet_id" uuid,
	"utm_campaign" text,
	"amount_idr" bigint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_spend_platform_check" CHECK ("ad_spend"."platform" IN ('meta', 'tiktok', 'google', 'other')),
	CONSTRAINT "ad_spend_amount_idr_check" CHECK ("ad_spend"."amount_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "admin_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_user_id" text NOT NULL,
	"role" text NOT NULL,
	"display_name" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_profiles_auth_user_id_key" UNIQUE("auth_user_id"),
	CONSTRAINT "admin_profiles_role_check" CHECK ("admin_profiles"."role" IN ('owner', 'staff'))
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"dedupe_key" text,
	"message" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "alerts_source_check" CHECK ("alerts"."source" IN ('internal', 'glitchtip', 'worker', 'monitor')),
	CONSTRAINT "alerts_severity_check" CHECK ("alerts"."severity" IN ('info', 'warning', 'critical')),
	CONSTRAINT "alerts_payload_check" CHECK (jsonb_typeof("alerts"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_user_id" text,
	CONSTRAINT "app_settings_key_check" CHECK ("app_settings"."key" ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
	CONSTRAINT "app_settings_positive_int_check" CHECK (("app_settings"."key" NOT LIKE 'otp.%' AND "app_settings"."key" NOT LIKE 'orders.%') OR (jsonb_typeof("app_settings"."value") = 'number' AND ("app_settings"."value" #>> '{}')::numeric > 0 AND ("app_settings"."value" #>> '{}')::numeric = trunc(("app_settings"."value" #>> '{}')::numeric)))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_admin_user_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pii_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"request_id" text,
	"ip" "inet",
	CONSTRAINT "audit_log_actor_kind_check" CHECK ("audit_log"."actor_kind" IN ('admin', 'system', 'cli')),
	CONSTRAINT "audit_log_admin_actor_check" CHECK ("audit_log"."actor_kind" <> 'admin' OR "audit_log"."actor_admin_user_id" IS NOT NULL),
	CONSTRAINT "audit_log_changes_check" CHECK (jsonb_typeof("audit_log"."changes") = 'object')
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"legal_page_id" uuid NOT NULL,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" "inet",
	"ua_hash" "bytea",
	CONSTRAINT "consents_order_id_legal_page_id_key" UNIQUE("order_id","legal_page_id")
);
--> statement-breakpoint
CREATE TABLE "deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by_admin_user_id" text,
	"completed_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_requests_status_check" CHECK ("deletion_requests"."status" IN ('pending', 'completed', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "heartbeats" (
	"component" text PRIMARY KEY NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"info" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_pages_program_kind_version_key" UNIQUE("program_id","kind","version"),
	CONSTRAINT "legal_pages_kind_check" CHECK ("legal_pages"."kind" IN ('terms', 'privacy')),
	CONSTRAINT "legal_pages_version_check" CHECK ("legal_pages"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"channel" text NOT NULL,
	"locale" text DEFAULT 'id' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_key_channel_locale_key" UNIQUE("key","channel","locale"),
	CONSTRAINT "message_templates_channel_check" CHECK ("message_templates"."channel" IN ('whatsapp', 'email'))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sealed" "bytea",
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"relayed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_dedupe_key_key" UNIQUE("dedupe_key"),
	CONSTRAINT "outbox_topic_check" CHECK ("outbox"."topic" ~ '^[a-z_]+(\.[a-z_]+)+$'),
	CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("outbox"."payload") = 'object'),
	CONSTRAINT "outbox_attempts_check" CHECK ("outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "settings_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"name" text NOT NULL,
	"adnet_id" uuid,
	"bound_host" text,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"sealed_dek" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_secrets_scope_name_adnet_key" UNIQUE NULLS NOT DISTINCT("scope","name","adnet_id"),
	CONSTRAINT "settings_secrets_scope_check" CHECK ("settings_secrets"."scope" IN ('payment', 'messaging', 'conversions')),
	CONSTRAINT "settings_secrets_name_check" CHECK ("settings_secrets"."name" ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'),
	CONSTRAINT "settings_secrets_nonce_check" CHECK (octet_length("settings_secrets"."nonce") = 12),
	CONSTRAINT "settings_secrets_last4_check" CHECK (char_length("settings_secrets"."last4") <= 4),
	CONSTRAINT "settings_secrets_bound_host_check" CHECK ("settings_secrets"."bound_host" IS NULL OR "settings_secrets"."bound_host" = lower("settings_secrets"."bound_host"))
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"storage_path" text NOT NULL,
	"original_filename" text,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" "bytea" NOT NULL,
	"created_by_admin_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uploads_storage_path_key" UNIQUE("storage_path"),
	CONSTRAINT "uploads_kind_check" CHECK ("uploads"."kind" IN ('pdf', 'image', 'lp_zip', 'import', 'proof')),
	CONSTRAINT "uploads_size_bytes_check" CHECK ("uploads"."size_bytes" >= 0),
	CONSTRAINT "uploads_sha256_check" CHECK (octet_length("uploads"."sha256") = 32)
);
--> statement-breakpoint
CREATE TABLE "attempt_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"permutation" uuid[] NOT NULL,
	"served_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"option_id" uuid,
	"correct" boolean,
	"points" integer DEFAULT 0 NOT NULL,
	"elapsed_ms" integer,
	"ip" "inet",
	"ua_hash" "bytea",
	CONSTRAINT "attempt_questions_attempt_id_question_id_key" UNIQUE("attempt_id","question_id"),
	CONSTRAINT "attempt_questions_attempt_id_position_key" UNIQUE("attempt_id","position"),
	CONSTRAINT "attempt_questions_deadline_check" CHECK ("attempt_questions"."deadline_at" IS NULL OR "attempt_questions"."deadline_at" >= "attempt_questions"."served_at"),
	CONSTRAINT "attempt_questions_points_check" CHECK ("attempt_questions"."points" >= 0),
	CONSTRAINT "attempt_questions_elapsed_ms_check" CHECK ("attempt_questions"."elapsed_ms" IS NULL OR "attempt_questions"."elapsed_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fulfillments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"winner_id" uuid NOT NULL,
	"status" "fulfillment_status" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"proof_upload_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillments_winner_id_key" UNIQUE("winner_id")
);
--> statement-breakpoint
CREATE TABLE "leaderboard_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"frozen_at" timestamp with time zone NOT NULL,
	"entries" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leaderboard_snapshots_program_id_key" UNIQUE("program_id"),
	CONSTRAINT "leaderboard_snapshots_entries_check" CHECK (jsonb_typeof("leaderboard_snapshots"."entries") = 'array')
);
--> statement-breakpoint
CREATE TABLE "player_program_stats" (
	"player_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"total_ms" bigint DEFAULT 0 NOT NULL,
	"sets_completed" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_program_stats_pkey" PRIMARY KEY("player_id","program_id")
);
--> statement-breakpoint
CREATE TABLE "prize_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"rank_from" integer NOT NULL,
	"rank_to" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image_upload_id" uuid,
	"value_idr" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prize_tiers_rank_check" CHECK ("prize_tiers"."rank_from" >= 1 AND "prize_tiers"."rank_to" >= "prize_tiers"."rank_from"),
	CONSTRAINT "prize_tiers_value_idr_check" CHECK ("prize_tiers"."value_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "set_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"score" integer DEFAULT 0 NOT NULL,
	"total_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "set_attempts_player_id_set_id_key" UNIQUE("player_id","set_id"),
	CONSTRAINT "set_attempts_score_check" CHECK ("set_attempts"."score" >= 0),
	CONSTRAINT "set_attempts_total_ms_check" CHECK ("set_attempts"."total_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "winners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"prize_tier_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"status" "winner_status" DEFAULT 'awaiting_confirmation' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"flagged_at" timestamp with time zone,
	"flag_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "winners_snapshot_id_player_id_key" UNIQUE("snapshot_id","player_id"),
	CONSTRAINT "winners_rank_check" CHECK ("winners"."rank" >= 1)
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_links_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "magic_links_channel_check" CHECK ("magic_links"."channel" IN ('whatsapp', 'email')),
	CONSTRAINT "magic_links_token_hash_check" CHECK (octet_length("magic_links"."token_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "otp_enqueues" (
	"otp_id" uuid PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"outbox_id" uuid NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_enqueues_phone_check" CHECK ("otp_enqueues"."phone" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "player_otps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"mac" "bytea" NOT NULL,
	"sealed_code" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_otps_phone_check" CHECK ("player_otps"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "player_otps_mac_check" CHECK (octet_length("player_otps"."mac") = 32),
	CONSTRAINT "player_otps_sealed_code_check" CHECK (octet_length("player_otps"."sealed_code") BETWEEN 48 AND 128),
	CONSTRAINT "player_otps_attempts_check" CHECK ("player_otps"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "player_programs" (
	"player_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"first_paid_at" timestamp with time zone,
	"eligible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_programs_pkey" PRIMARY KEY("player_id","program_id"),
	CONSTRAINT "player_programs_eligible_paid_check" CHECK (NOT "player_programs"."eligible" OR "player_programs"."first_paid_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_user_id" text,
	"phone" text,
	"name" text NOT NULL,
	"email" text,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_auth_user_id_key" UNIQUE("auth_user_id"),
	CONSTRAINT "players_phone_key" UNIQUE("phone"),
	CONSTRAINT "players_phone_check" CHECK ("players"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "players_phone_present_check" CHECK ("players"."phone" IS NOT NULL OR "players"."anonymized_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "adnets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"clickid_param" text NOT NULL,
	"mo_url_template" text,
	"mt_url_template" text,
	"reversal_url_template" text,
	"payout_idr" bigint DEFAULT 0 NOT NULL,
	"endpoint_host" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adnets_slug_key" UNIQUE("slug"),
	CONSTRAINT "adnets_slug_check" CHECK ("adnets"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "adnets_clickid_param_check" CHECK ("adnets"."clickid_param" ~ '^[A-Za-z0-9_.-]{1,64}$'),
	CONSTRAINT "adnets_payout_idr_check" CHECK ("adnets"."payout_idr" >= 0),
	CONSTRAINT "adnets_endpoint_host_check" CHECK ("adnets"."endpoint_host" IS NULL OR "adnets"."endpoint_host" = lower("adnets"."endpoint_host"))
);
--> statement-breakpoint
CREATE TABLE "conversion_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversion_event_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"request_url_redacted" text,
	"http_status" integer,
	"response_excerpt" text,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversion_attempts_attempt_check" CHECK ("conversion_attempts"."attempt" >= 1),
	CONSTRAINT "conversion_attempts_response_excerpt_check" CHECK ("conversion_attempts"."response_excerpt" IS NULL OR char_length("conversion_attempts"."response_excerpt") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "conversion_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"sink" text NOT NULL,
	"kind" text NOT NULL,
	"status" "conversion_status" DEFAULT 'pending' NOT NULL,
	"adnet_id" uuid,
	"txid" text NOT NULL,
	"event_id" uuid NOT NULL,
	"value_idr" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_http_status" integer,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversion_events_order_id_sink_kind_key" UNIQUE("order_id","sink","kind"),
	CONSTRAINT "conversion_events_sink_check" CHECK ("conversion_events"."sink" IN ('s2s', 'meta', 'tiktok', 'google')),
	CONSTRAINT "conversion_events_kind_check" CHECK ("conversion_events"."kind" IN ('mo', 'mt', 'reversal')),
	CONSTRAINT "conversion_events_s2s_adnet_check" CHECK ("conversion_events"."sink" <> 's2s' OR "conversion_events"."adnet_id" IS NOT NULL),
	CONSTRAINT "conversion_events_value_idr_check" CHECK ("conversion_events"."value_idr" IS NULL OR "conversion_events"."value_idr" >= 0),
	CONSTRAINT "conversion_events_attempts_check" CHECK ("conversion_events"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "admin_auth"."account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "admin_auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_auth"."session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "admin_auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_auth"."twoFactor" ADD CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "admin_auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_auth"."account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "player_auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_auth"."session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "player_auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_pdf_upload_id_uploads_id_fk" FOREIGN KEY ("pdf_upload_id") REFERENCES "public"."uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_cloned_from_program_id_programs_id_fk" FOREIGN KEY ("cloned_from_program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_options" ADD CONSTRAINT "question_options_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_set_id_trivia_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."trivia_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_image_upload_id_uploads_id_fk" FOREIGN KEY ("image_upload_id") REFERENCES "public"."uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trivia_sets" ADD CONSTRAINT "trivia_sets_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trivia_sets" ADD CONSTRAINT "trivia_sets_thumbnail_upload_id_uploads_id_fk" FOREIGN KEY ("thumbnail_upload_id") REFERENCES "public"."uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_session_id_waha_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."waha_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waha_inbound" ADD CONSTRAINT "waha_inbound_session_id_waha_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."waha_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD CONSTRAINT "waha_sessions_server_id_waha_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."waha_servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_page_adnets" ADD CONSTRAINT "landing_page_adnets_landing_page_id_landing_pages_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_page_adnets" ADD CONSTRAINT "landing_page_adnets_adnet_id_adnets_id_fk" FOREIGN KEY ("adnet_id") REFERENCES "public"."adnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_current_version_id_lp_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."lp_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lp_domains" ADD CONSTRAINT "lp_domains_landing_page_id_landing_pages_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lp_versions" ADD CONSTRAINT "lp_versions_landing_page_id_landing_pages_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lp_versions" ADD CONSTRAINT "lp_versions_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "midtrans_attempts" ADD CONSTRAINT "midtrans_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_landing_page_id_landing_pages_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_adnet_id_adnets_id_fk" FOREIGN KEY ("adnet_id") REFERENCES "public"."adnets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_midtrans_attempt_id_midtrans_attempts_id_fk" FOREIGN KEY ("midtrans_attempt_id") REFERENCES "public"."midtrans_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_landing_page_id_landing_pages_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_adnet_id_adnets_id_fk" FOREIGN KEY ("adnet_id") REFERENCES "public"."adnets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_landing_page_id_landing_pages_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_adnet_id_adnets_id_fk" FOREIGN KEY ("adnet_id") REFERENCES "public"."adnets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_profiles" ADD CONSTRAINT "admin_profiles_auth_user_id_user_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "admin_auth"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_legal_page_id_legal_pages_id_fk" FOREIGN KEY ("legal_page_id") REFERENCES "public"."legal_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_pages" ADD CONSTRAINT "legal_pages_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_secrets" ADD CONSTRAINT "settings_secrets_adnet_id_adnets_id_fk" FOREIGN KEY ("adnet_id") REFERENCES "public"."adnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_attempt_id_set_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."set_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_option_id_question_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."question_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_winner_id_winners_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."winners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_proof_upload_id_uploads_id_fk" FOREIGN KEY ("proof_upload_id") REFERENCES "public"."uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_snapshots" ADD CONSTRAINT "leaderboard_snapshots_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_program_stats" ADD CONSTRAINT "player_program_stats_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_program_stats" ADD CONSTRAINT "player_program_stats_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_tiers" ADD CONSTRAINT "prize_tiers_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_tiers" ADD CONSTRAINT "prize_tiers_image_upload_id_uploads_id_fk" FOREIGN KEY ("image_upload_id") REFERENCES "public"."uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "set_attempts" ADD CONSTRAINT "set_attempts_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "set_attempts" ADD CONSTRAINT "set_attempts_set_id_trivia_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."trivia_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_snapshot_id_leaderboard_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."leaderboard_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_prize_tier_id_prize_tiers_id_fk" FOREIGN KEY ("prize_tier_id") REFERENCES "public"."prize_tiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_programs" ADD CONSTRAINT "player_programs_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_programs" ADD CONSTRAINT "player_programs_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_auth_user_id_user_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "player_auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_attempts" ADD CONSTRAINT "conversion_attempts_conversion_event_id_conversion_events_id_fk" FOREIGN KEY ("conversion_event_id") REFERENCES "public"."conversion_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_adnet_id_adnets_id_fk" FOREIGN KEY ("adnet_id") REFERENCES "public"."adnets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "admin_auth"."account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "admin_auth"."session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "admin_auth"."twoFactor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "admin_auth"."twoFactor" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "admin_auth"."verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "player_auth"."account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "player_auth"."session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "player_auth"."verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "question_options_one_correct_idx" ON "question_options" USING btree ("question_id") WHERE "question_options"."is_correct";--> statement-breakpoint
CREATE INDEX "deliveries_due_idx" ON "deliveries" USING btree ("status","not_before");--> statement-breakpoint
CREATE INDEX "orders_dedupe_idx" ON "orders" USING btree ("buyer_phone","landing_page_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_created_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "orders_program_status_idx" ON "orders" USING btree ("program_id","status");--> statement-breakpoint
CREATE INDEX "orders_player_idx" ON "orders" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "visits_landing_page_occurred_idx" ON "visits" USING btree ("landing_page_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ad_spend_date_idx" ON "ad_spend" USING btree ("spend_date");--> statement-breakpoint
CREATE INDEX "alerts_dedupe_idx" ON "alerts" USING btree ("dedupe_key","created_at");--> statement-breakpoint
CREATE INDEX "alerts_unnotified_idx" ON "alerts" USING btree ("created_at") WHERE "alerts"."notified_at" IS NULL;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "outbox_unrelayed_idx" ON "outbox" USING btree ("available_at") WHERE "outbox"."relayed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_unprocessed_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "player_program_stats_ranking_idx" ON "player_program_stats" USING btree ("program_id","score" DESC NULLS LAST,"total_ms","finished_at");--> statement-breakpoint
CREATE INDEX "set_attempts_set_id_idx" ON "set_attempts" USING btree ("set_id");--> statement-breakpoint
CREATE INDEX "otp_enqueues_phone_idx" ON "otp_enqueues" USING btree ("phone","enqueued_at");--> statement-breakpoint
CREATE INDEX "player_otps_phone_idx" ON "player_otps" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "player_programs_program_eligible_idx" ON "player_programs" USING btree ("program_id","eligible");--> statement-breakpoint
CREATE INDEX "conversion_attempts_event_idx" ON "conversion_attempts" USING btree ("conversion_event_id");--> statement-breakpoint
CREATE INDEX "conversion_events_due_idx" ON "conversion_events" USING btree ("status","next_attempt_at");