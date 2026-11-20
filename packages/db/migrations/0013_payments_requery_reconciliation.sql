-- US-021 (M6c) Midtrans notifications, processing and reconciliation. midtrans_attempts keeps each
-- attempt's last RE-QUERIED status (gateway_*; the worker writes them, public_rw cannot read them), so
-- the order machine can count an order's other settled attempts and an older re-query is never applied
-- over a newer one. The nightly reconciliation records one run per WIB day and one report row per
-- mismatch. The guards (paid-only effects, paid_at set once, the fulfillment halt) and the grants are in
-- sql/triggers.sql and sql/grants.sql.
CREATE TABLE "payment_reconciliation_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"order_status" "order_status" NOT NULL,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_reconciliation_findings_run_id_order_id_kind_key" UNIQUE("run_id","order_id","kind"),
	CONSTRAINT "payment_reconciliation_findings_kind_check" CHECK ("payment_reconciliation_findings"."kind" IN ('settled_not_paid', 'paid_not_settled', 'double_settlement', 'settlement_review', 'refunded_but_settled', 'requery_refused')),
	CONSTRAINT "payment_reconciliation_findings_attempts_check" CHECK (jsonb_typeof("payment_reconciliation_findings"."attempts") = 'array')
);
--> statement-breakpoint
CREATE TABLE "payment_reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_date" date NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"attempts_checked" integer DEFAULT 0 NOT NULL,
	"findings" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "payment_reconciliation_runs_run_date_key" UNIQUE("run_date"),
	CONSTRAINT "payment_reconciliation_runs_attempts_checked_check" CHECK ("payment_reconciliation_runs"."attempts_checked" >= 0),
	CONSTRAINT "payment_reconciliation_runs_findings_check" CHECK ("payment_reconciliation_runs"."findings" >= 0),
	CONSTRAINT "payment_reconciliation_runs_errors_check" CHECK ("payment_reconciliation_runs"."errors" >= 0)
);
--> statement-breakpoint
ALTER TABLE "midtrans_attempts" ADD COLUMN "gateway_status" text;--> statement-breakpoint
ALTER TABLE "midtrans_attempts" ADD COLUMN "gateway_fraud_status" text;--> statement-breakpoint
ALTER TABLE "midtrans_attempts" ADD COLUMN "gateway_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_reconciliation_findings" ADD CONSTRAINT "payment_reconciliation_findings_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payment_reconciliation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reconciliation_findings" ADD CONSTRAINT "payment_reconciliation_findings_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_reconciliation_findings_order_idx" ON "payment_reconciliation_findings" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "midtrans_attempts" ADD CONSTRAINT "midtrans_attempts_gateway_check" CHECK (("midtrans_attempts"."gateway_status" IS NULL) = ("midtrans_attempts"."gateway_checked_at" IS NULL) AND char_length("midtrans_attempts"."gateway_status") <= 64 AND char_length("midtrans_attempts"."gateway_fraud_status") <= 64);