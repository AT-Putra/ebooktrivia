CREATE TABLE "admin_auth"."login_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "login_throttle_key_check" CHECK ("admin_auth"."login_throttle"."key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "login_throttle_failures_check" CHECK ("admin_auth"."login_throttle"."failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "admin_auth"."recovery_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"selector" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "recovery_code_user_id_selector_key" UNIQUE("user_id","selector"),
	CONSTRAINT "recovery_code_selector_check" CHECK ("admin_auth"."recovery_code"."selector" ~ '^[0-9A-HJKMNP-TV-Z]{4}$'),
	CONSTRAINT "recovery_code_code_hash_check" CHECK ("admin_auth"."recovery_code"."code_hash" LIKE '$argon2id$%')
);
--> statement-breakpoint
CREATE TABLE "admin_auth"."session_state" (
	"session_id" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"mfa_method" text,
	"mfa_verified_at" timestamp with time zone,
	CONSTRAINT "session_state_mfa_method_check" CHECK ("admin_auth"."session_state"."mfa_method" IN ('totp', 'recovery_code')),
	CONSTRAINT "session_state_mfa_check" CHECK (("admin_auth"."session_state"."mfa_method" IS NULL) = ("admin_auth"."session_state"."mfa_verified_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "admin_auth"."totp_used" (
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone NOT NULL,
	CONSTRAINT "totp_used_pkey" PRIMARY KEY("user_id","code_hash"),
	CONSTRAINT "totp_used_code_hash_check" CHECK ("admin_auth"."totp_used"."code_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "admin_auth"."recovery_code" ADD CONSTRAINT "recovery_code_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_auth"."session_state" ADD CONSTRAINT "session_state_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "admin_auth"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_auth"."totp_used" ADD CONSTRAINT "totp_used_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_auth"."user"("id") ON DELETE cascade ON UPDATE no action;