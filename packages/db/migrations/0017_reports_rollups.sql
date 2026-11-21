-- US-029 (M10a reports and ROI): the report rollups the worker recomputes every 5 minutes (report_orders_daily,
-- report_visits_daily and the singleton report_rollup_state: derived data, written by public.refresh_report_rollups
-- in sql/reports.sql under worker_rw only), a BRIN index on visits(occurred_at) for the incremental visit rollup, the
-- (created_at, id) indexes the reports page through (orders, conversion_events, deliveries) and updated_at indexes
-- (orders, payments, conversion_events) that find the days the rollup must rebuild. The metric functions, the
-- updated_at guard triggers, the grants (sql/grants.sql, one US-029 block) and the rollup function are in sql/reports.sql.
CREATE TABLE "report_orders_daily" (
	"day" date NOT NULL,
	"landing_page_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"adnet_id" uuid,
	"utm_campaign" text DEFAULT '' NOT NULL,
	"status" "order_status" NOT NULL,
	"orders" integer NOT NULL,
	"mo" integer NOT NULL,
	"mt" integer NOT NULL,
	"amount_idr" bigint NOT NULL,
	"revenue_idr" bigint NOT NULL,
	"fee_idr" bigint NOT NULL,
	"fee_missing" integer NOT NULL,
	"payout_idr" bigint NOT NULL,
	CONSTRAINT "report_orders_daily_key" UNIQUE NULLS NOT DISTINCT("day","landing_page_id","program_id","adnet_id","utm_campaign","status"),
	CONSTRAINT "report_orders_daily_orders_check" CHECK ("report_orders_daily"."orders" >= 0),
	CONSTRAINT "report_orders_daily_mo_mt_check" CHECK ("report_orders_daily"."mt" >= 0 AND "report_orders_daily"."mo" >= "report_orders_daily"."mt" AND "report_orders_daily"."orders" >= "report_orders_daily"."mo"),
	CONSTRAINT "report_orders_daily_amount_idr_check" CHECK ("report_orders_daily"."amount_idr" >= 0),
	CONSTRAINT "report_orders_daily_revenue_idr_check" CHECK ("report_orders_daily"."revenue_idr" >= 0),
	CONSTRAINT "report_orders_daily_fee_idr_check" CHECK ("report_orders_daily"."fee_idr" >= 0),
	CONSTRAINT "report_orders_daily_fee_missing_check" CHECK ("report_orders_daily"."fee_missing" >= 0),
	CONSTRAINT "report_orders_daily_payout_idr_check" CHECK ("report_orders_daily"."payout_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "report_rollup_state" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"visits_through_day" date,
	"fees" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duration_ms" integer NOT NULL,
	"order_rows" integer NOT NULL,
	"visit_rows" integer NOT NULL,
	CONSTRAINT "report_rollup_state_singleton_check" CHECK ("report_rollup_state"."id"),
	CONSTRAINT "report_rollup_state_duration_ms_check" CHECK ("report_rollup_state"."duration_ms" >= 0),
	CONSTRAINT "report_rollup_state_order_rows_check" CHECK ("report_rollup_state"."order_rows" >= 0),
	CONSTRAINT "report_rollup_state_visit_rows_check" CHECK ("report_rollup_state"."visit_rows" >= 0)
);
--> statement-breakpoint
CREATE TABLE "report_visits_daily" (
	"day" date NOT NULL,
	"landing_page_id" uuid NOT NULL,
	"adnet_id" uuid,
	"visits" integer NOT NULL,
	CONSTRAINT "report_visits_daily_key" UNIQUE NULLS NOT DISTINCT("day","landing_page_id","adnet_id"),
	CONSTRAINT "report_visits_daily_visits_check" CHECK ("report_visits_daily"."visits" >= 0)
);
--> statement-breakpoint
ALTER TABLE "report_orders_daily" ADD CONSTRAINT "report_orders_daily_landing_page_id_landing_pages_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_orders_daily" ADD CONSTRAINT "report_orders_daily_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_visits_daily" ADD CONSTRAINT "report_visits_daily_landing_page_id_landing_pages_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_orders_daily_landing_page_idx" ON "report_orders_daily" USING btree ("landing_page_id");--> statement-breakpoint
CREATE INDEX "report_orders_daily_program_idx" ON "report_orders_daily" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "report_visits_daily_landing_page_idx" ON "report_visits_daily" USING btree ("landing_page_id");--> statement-breakpoint
CREATE INDEX "deliveries_created_at_id_idx" ON "deliveries" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "orders_created_at_id_idx" ON "orders" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "orders_updated_at_idx" ON "orders" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "payments_updated_at_idx" ON "payments" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "visits_occurred_at_brin_idx" ON "visits" USING brin ("occurred_at");--> statement-breakpoint
CREATE INDEX "conversion_events_created_at_id_idx" ON "conversion_events" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "conversion_events_updated_at_idx" ON "conversion_events" USING btree ("updated_at");