ALTER TABLE "admin_auth"."login_throttle" ADD COLUMN "consecutive" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_auth"."login_throttle" ADD COLUMN "hard_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_profiles" ADD COLUMN "enroll_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_auth"."login_throttle" ADD CONSTRAINT "login_throttle_consecutive_check" CHECK ("admin_auth"."login_throttle"."consecutive" >= 0);