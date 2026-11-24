-- Customer-service contact (Owner decision 2026-11-24). Additive: one new single-row table. The Owner sets one WhatsApp number, one e-mail address and the opening hours in the
-- console; the buyer site shows them, the worker puts them in a few fixed WhatsApp replies and in the {cs_whatsapp} / {cs_email} template variables. No row, or an empty field,
-- means nothing is shown. The rule that the CS number is never a sending number (waha_sessions.phone) is held by two triggers (sql/triggers.sql, ET190); the grants (public_rw and
-- worker_rw read the four columns a reader needs: id, whatsapp, email, hours) are in sql/grants.sql.
-- The address is ASCII only, and the hours hold no control, format (bidi, zero-width, soft hyphen, BOM ...) or line-separator character: the same rules as core isCsEmail / isCsHours.
CREATE TABLE "cs_contact" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"whatsapp" text,
	"email" text,
	"hours" text,
	"updated_by_admin_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cs_contact_singleton_check" CHECK ("cs_contact"."id" = 1),
	CONSTRAINT "cs_contact_whatsapp_check" CHECK ("cs_contact"."whatsapp" IS NULL OR "cs_contact"."whatsapp" ~ '^\+628[1-35-9][0-9]{7,10}$'),
	CONSTRAINT "cs_contact_email_check" CHECK ("cs_contact"."email" IS NULL OR (char_length("cs_contact"."email") <= 254 AND "cs_contact"."email" ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$')),
	CONSTRAINT "cs_contact_hours_check" CHECK ("cs_contact"."hours" IS NULL OR (char_length("cs_contact"."hours") BETWEEN 1 AND 80 AND "cs_contact"."hours" !~ '[\u0001-\u001f\u007f-\u009f\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f]'))
);
