CREATE TABLE "alert_recipients" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"phone" text,
	"email" text,
	"min_severity" text DEFAULT 'warning' NOT NULL,
	"updated_by_admin_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_recipients_singleton_check" CHECK ("alert_recipients"."id" = 1),
	CONSTRAINT "alert_recipients_phone_check" CHECK ("alert_recipients"."phone" IS NULL OR "alert_recipients"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "alert_recipients_email_check" CHECK ("alert_recipients"."email" IS NULL OR (char_length("alert_recipients"."email") <= 254 AND "alert_recipients"."email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
	CONSTRAINT "alert_recipients_min_severity_check" CHECK ("alert_recipients"."min_severity" IN ('info', 'warning', 'critical'))
);
