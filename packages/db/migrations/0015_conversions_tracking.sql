-- US-024 (M7) tracking and conversions. The conversion log keeps the first 4 KB of a response (it was 2 KB)
-- and one row per (event, attempt number), served by the unique key's index (the plain event index is
-- dropped); the only conversions secret without an adnet is the CAPI access token of a landing page's Meta or
-- TikTok pixel (capi.meta.<pixel id>, capi.tiktok.<pixel code>), bound to the vendor's fixed API host. A
-- conversion row also remembers that the sink MAY have counted it (maybe_counted, sticky) and the payout its S2S
-- MT reported (reported_payout_idr), which the reversal takes back. The conversion guards, the manual re-fire
-- function (owned by the NOLOGIN role conversion_refire), the order source label and the grants are in
-- sql/roles.sql, sql/triggers.sql, sql/functions.sql, sql/conversions.sql and sql/grants.sql.
ALTER TABLE "settings_secrets" DROP CONSTRAINT "settings_secrets_binding_check";--> statement-breakpoint
ALTER TABLE "conversion_attempts" DROP CONSTRAINT "conversion_attempts_response_excerpt_check";--> statement-breakpoint
DROP INDEX "conversion_attempts_event_idx";--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN "maybe_counted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN "reported_payout_idr" bigint;--> statement-breakpoint
ALTER TABLE "conversion_attempts" ADD CONSTRAINT "conversion_attempts_event_attempt_key" UNIQUE("conversion_event_id","attempt");--> statement-breakpoint
ALTER TABLE "settings_secrets" ADD CONSTRAINT "settings_secrets_binding_check" CHECK (("settings_secrets"."scope" = 'conversions' AND "settings_secrets"."bound_host" IS NOT NULL AND ("settings_secrets"."adnet_id" IS NOT NULL
            OR ("settings_secrets"."name" ~ '^capi\.meta\.[0-9]{10,20}$' AND "settings_secrets"."bound_host" = 'graph.facebook.com')
            OR ("settings_secrets"."name" ~ '^capi\.tiktok\.[a-z0-9]{16,32}$' AND "settings_secrets"."bound_host" = 'business-api.tiktok.com')))
          OR ("settings_secrets"."scope" <> 'conversions' AND "settings_secrets"."adnet_id" IS NULL));--> statement-breakpoint
ALTER TABLE "conversion_attempts" ADD CONSTRAINT "conversion_attempts_response_excerpt_check" CHECK ("conversion_attempts"."response_excerpt" IS NULL OR char_length("conversion_attempts"."response_excerpt") <= 4096);--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_reported_payout_idr_check" CHECK ("conversion_events"."reported_payout_idr" IS NULL OR "conversion_events"."reported_payout_idr" >= 0);