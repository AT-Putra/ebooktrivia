CREATE TABLE "test_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"label" text NOT NULL,
	"created_by_admin_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_recipients_phone_key" UNIQUE("phone"),
	CONSTRAINT "test_recipients_phone_check" CHECK ("test_recipients"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "test_recipients_label_check" CHECK (char_length("test_recipients"."label") BETWEEN 1 AND 60)
);
--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "completing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "smtp_settings" ADD CONSTRAINT "smtp_settings_security_port_check" CHECK (("smtp_settings"."security" = 'tls') = ("smtp_settings"."port" = 465));--> statement-breakpoint
ALTER TABLE "smtp_settings" ADD CONSTRAINT "smtp_settings_allow_private_ip_check" CHECK (NOT "smtp_settings"."allow_private_ip" OR "smtp_settings"."host" ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$');--> statement-breakpoint
ALTER TABLE "waha_servers" ADD CONSTRAINT "waha_servers_allow_private_ip_check" CHECK (NOT "waha_servers"."allow_private_ip" OR "waha_servers"."base_url_host" ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}(:[0-9]{1,5})?$');