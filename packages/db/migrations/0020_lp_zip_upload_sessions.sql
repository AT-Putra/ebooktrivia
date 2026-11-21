-- US-023 (M6e): landing-page ZIPs go up through the chunked upload sessions of US-017 (Caddy's 30 s body
-- timeout): a session targets a product (kind pdf) or a landing page (kind lp_zip), never both. The admin
-- app may raise alerts (source 'admin': repeated LP host relink failures).
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_source_check";--> statement-breakpoint
ALTER TABLE "upload_sessions" DROP CONSTRAINT "upload_sessions_kind_check";--> statement-breakpoint
ALTER TABLE "upload_sessions" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "landing_page_id" uuid;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_landing_page_id_landing_pages_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_source_check" CHECK ("alerts"."source" IN ('internal', 'glitchtip', 'worker', 'monitor', 'admin'));--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_target_check" CHECK (("upload_sessions"."kind" = 'pdf' AND "upload_sessions"."product_id" IS NOT NULL AND "upload_sessions"."landing_page_id" IS NULL) OR ("upload_sessions"."kind" = 'lp_zip' AND "upload_sessions"."landing_page_id" IS NOT NULL AND "upload_sessions"."product_id" IS NULL));--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_kind_check" CHECK ("upload_sessions"."kind" IN ('pdf', 'lp_zip'));