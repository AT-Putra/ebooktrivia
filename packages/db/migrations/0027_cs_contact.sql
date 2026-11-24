-- Customer-service contact (Owner decision 2026-11-24). Additive: one new single-row table. The Owner sets one WhatsApp number, one e-mail address and the opening hours in the
-- console; the buyer site shows them, the worker puts them in a few fixed WhatsApp replies and in the {cs_whatsapp} / {cs_email} template variables. No row, or an empty field,
-- means nothing is shown. The rule that the CS number is never a sending number (waha_sessions.phone) is held by two triggers (sql/triggers.sql, ET190); the grants (public_rw and
-- worker_rw read the three fields only) are in sql/grants.sql.
CREATE TABLE "cs_contact" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"whatsapp" text,
	"email" text,
	"hours" text,
	"updated_by_admin_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cs_contact_singleton_check" CHECK ("cs_contact"."id" = 1),
	CONSTRAINT "cs_contact_whatsapp_check" CHECK ("cs_contact"."whatsapp" IS NULL OR "cs_contact"."whatsapp" ~ '^\+628[1-35-9][0-9]{7,10}$'),
	CONSTRAINT "cs_contact_email_check" CHECK ("cs_contact"."email" IS NULL OR (char_length("cs_contact"."email") <= 254 AND "cs_contact"."email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
	CONSTRAINT "cs_contact_hours_check" CHECK ("cs_contact"."hours" IS NULL OR (char_length("cs_contact"."hours") BETWEEN 1 AND 80 AND "cs_contact"."hours" !~ '[[:cntrl:]]'))
);
