-- US-033 (M10c): the Owner's review queue for orders. The decision ledger (order_owner_decisions, append-only, written by
-- the SECURITY DEFINER public.order_review_decide in sql/order-review.sql) and orders.review_since (kept by the trigger
-- orders_review_since in sql/triggers.sql). An order already in review gets its last change as the time it entered review.
CREATE TABLE "order_owner_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"from_status" "order_status" NOT NULL,
	"to_status" "order_status" NOT NULL,
	"attempts" jsonb NOT NULL,
	"reason" text NOT NULL,
	"decided_by_admin_user_id" text NOT NULL,
	"request_key" uuid NOT NULL,
	"effects" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_owner_decisions_request_key_key" UNIQUE("request_key"),
	CONSTRAINT "order_owner_decisions_decision_check" CHECK ("order_owner_decisions"."decision" IN ('paid', 'not_paid')),
	CONSTRAINT "order_owner_decisions_status_check" CHECK ("order_owner_decisions"."from_status" = 'review' AND "order_owner_decisions"."to_status" IN ('paid', 'gateway_failed')),
	CONSTRAINT "order_owner_decisions_attempts_check" CHECK (jsonb_typeof("order_owner_decisions"."attempts") = 'array'),
	CONSTRAINT "order_owner_decisions_reason_check" CHECK (char_length("order_owner_decisions"."reason") BETWEEN 10 AND 500),
	CONSTRAINT "order_owner_decisions_effects_check" CHECK (jsonb_typeof("order_owner_decisions"."effects") = 'object')
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "review_since" timestamp with time zone;--> statement-breakpoint
UPDATE "orders" SET "review_since" = "updated_at" WHERE "status" = 'review';--> statement-breakpoint
ALTER TABLE "order_owner_decisions" ADD CONSTRAINT "order_owner_decisions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_owner_decisions_order_idx" ON "order_owner_decisions" USING btree ("order_id","decided_at");--> statement-breakpoint
CREATE INDEX "orders_review_since_idx" ON "orders" USING btree ("review_since") WHERE "orders"."review_since" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_review_since_check" CHECK (("orders"."status" = 'review') = ("orders"."review_since" IS NOT NULL));