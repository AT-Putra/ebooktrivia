CREATE TABLE "smtp_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"security" text NOT NULL,
	"username" text,
	"from_address" text NOT NULL,
	"from_name" text,
	"allow_private_ip" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "smtp_settings_singleton_check" CHECK ("smtp_settings"."id"),
	CONSTRAINT "smtp_settings_host_check" CHECK ("smtp_settings"."host" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' AND char_length("smtp_settings"."host") <= 253),
	CONSTRAINT "smtp_settings_port_check" CHECK ("smtp_settings"."port" BETWEEN 1 AND 65535),
	CONSTRAINT "smtp_settings_security_check" CHECK ("smtp_settings"."security" IN ('starttls', 'tls'))
);
--> statement-breakpoint
CREATE TABLE "template_test_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"waha_session_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_admin_user_id" text NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_test_sends_channel_check" CHECK ("template_test_sends"."channel" IN ('whatsapp', 'email')),
	CONSTRAINT "template_test_sends_status_check" CHECK ("template_test_sends"."status" IN ('pending', 'sending', 'sent', 'failed')),
	CONSTRAINT "template_test_sends_target_check" CHECK (("template_test_sends"."channel" = 'whatsapp' AND "template_test_sends"."recipient" ~ '^\+[1-9][0-9]{7,14}$') OR ("template_test_sends"."channel" = 'email' AND "template_test_sends"."waha_session_id" IS NULL AND char_length("template_test_sends"."recipient") <= 254 AND "template_test_sends"."recipient" ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
	CONSTRAINT "template_test_sends_error_check" CHECK ("template_test_sends"."error" IS NULL OR "template_test_sends"."error" ~ '^[a-z_]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"product_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" "bytea" NOT NULL,
	"chunk_bytes" integer NOT NULL,
	"received_chunks" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"large_confirmed" boolean DEFAULT false NOT NULL,
	"created_by_admin_user_id" text NOT NULL,
	"upload_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_sessions_kind_check" CHECK ("upload_sessions"."kind" IN ('pdf')),
	CONSTRAINT "upload_sessions_size_bytes_check" CHECK ("upload_sessions"."size_bytes" > 0),
	CONSTRAINT "upload_sessions_sha256_check" CHECK (octet_length("upload_sessions"."sha256") = 32),
	CONSTRAINT "upload_sessions_chunk_bytes_check" CHECK ("upload_sessions"."chunk_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "template_test_sends" ADD CONSTRAINT "template_test_sends_template_id_message_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."message_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_test_sends" ADD CONSTRAINT "template_test_sends_waha_session_id_waha_sessions_id_fk" FOREIGN KEY ("waha_session_id") REFERENCES "public"."waha_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "template_test_sends_template_idx" ON "template_test_sends" USING btree ("template_id","created_at");--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD CONSTRAINT "waha_sessions_session_name_check" CHECK ("waha_sessions"."session_name" ~ '^[A-Za-z0-9_-]{1,64}$');--> statement-breakpoint
-- US-017: a program locks at its first PAID order (sql/triggers.sql orders_lock_program and
-- programs_field_lock, applied after the migrations). Programs that already have one lock now.
UPDATE "programs" p
   SET "locked_at" = (SELECT min(o."paid_at") FROM "orders" o WHERE o."program_id" = p."id")
 WHERE p."locked_at" IS NULL
   AND EXISTS (SELECT 1 FROM "orders" o WHERE o."program_id" = p."id" AND o."paid_at" IS NOT NULL);
