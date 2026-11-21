// Report rollups (US-029, plan M10; AC-A4, AC-A5, AC-A8). DERIVED data: the worker recomputes these
// every 5 minutes with public.refresh_report_rollups (sql/reports.sql), which defines every metric once;
// nothing else writes them (sql/grants.sql: worker_rw only, admin_rw reads). The live dashboard, the
// sales report and the ROI report read them; the reconciliation identity is checked against the raw
// tables instead. A day is a WIB calendar day (UTC+7, no DST): orders by the day they were created
// (the "cohort" of the day), visits by the day they happened.
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { programs } from "./catalog.ts";
import { idr, nonNegative, tstz } from "./columns.ts";
import { landingPages, orderStatus } from "./funnel.ts";

/**
 * Orders per (WIB day created, landing page, program, source, utm_campaign, status). `adnet_id` is the
 * EFFECTIVE source (order_source_adnet: the order's adnet when it has a click id, else NULL = Organic,
 * AC-T8); NULL is one group (UNIQUE NULLS NOT DISTINCT). `utm_campaign` is lower-cased and trimmed ('' = none).
 * Per order, in one statement, the money of the metrics (core and the ROI report only add them up):
 *   mo           the order has a Snap payment page (mo_outbox_id) or was paid;
 *   mt           status = paid;
 *   revenue_idr  amount when status = paid (a refunded order and one in review are not revenue);
 *   fee_idr      gateway fee, from the Owner's per-method setting midtrans.fees, for every order that was ever
 *                paid (the gateway keeps its fee on a refund); fee_missing counts those with no fee configured;
 *   payout_idr   the adnet's CPA: the payout the S2S MT reported when the sink may have counted it, less the
 *                same when the sink acknowledged the reversal.
 */
export const reportOrdersDaily = pgTable(
  "report_orders_daily",
  {
    day: date("day", { mode: "string" }).notNull(),
    landingPageId: uuid("landing_page_id")
      .notNull()
      .references(() => landingPages.id, { onDelete: "cascade" }),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    adnetId: uuid("adnet_id"),
    utmCampaign: text("utm_campaign").notNull().default(""),
    status: orderStatus("status").notNull(),
    orders: integer("orders").notNull(),
    mo: integer("mo").notNull(),
    mt: integer("mt").notNull(),
    amountIdr: idr("amount_idr").notNull(),
    revenueIdr: idr("revenue_idr").notNull(),
    feeIdr: idr("fee_idr").notNull(),
    feeMissing: integer("fee_missing").notNull(),
    payoutIdr: idr("payout_idr").notNull(),
  },
  (t) => [
    unique("report_orders_daily_key").on(t.day, t.landingPageId, t.programId, t.adnetId, t.utmCampaign, t.status).nullsNotDistinct(),
    index("report_orders_daily_landing_page_idx").on(t.landingPageId),
    index("report_orders_daily_program_idx").on(t.programId),
    nonNegative("report_orders_daily_orders_check", t.orders),
    check("report_orders_daily_mo_mt_check", sql`${t.mt} >= 0 AND ${t.mo} >= ${t.mt} AND ${t.orders} >= ${t.mo}`),
    nonNegative("report_orders_daily_amount_idr_check", t.amountIdr),
    nonNegative("report_orders_daily_revenue_idr_check", t.revenueIdr),
    nonNegative("report_orders_daily_fee_idr_check", t.feeIdr),
    nonNegative("report_orders_daily_fee_missing_check", t.feeMissing),
    nonNegative("report_orders_daily_payout_idr_check", t.payoutIdr),
  ],
);

/** Visits per (WIB day, landing page, effective source). Days older than the last two are frozen (visits are append-only). */
export const reportVisitsDaily = pgTable(
  "report_visits_daily",
  {
    day: date("day", { mode: "string" }).notNull(),
    landingPageId: uuid("landing_page_id")
      .notNull()
      .references(() => landingPages.id, { onDelete: "cascade" }),
    adnetId: uuid("adnet_id"),
    visits: integer("visits").notNull(),
  },
  (t) => [
    unique("report_visits_daily_key").on(t.day, t.landingPageId, t.adnetId).nullsNotDistinct(),
    index("report_visits_daily_landing_page_idx").on(t.landingPageId),
    nonNegative("report_visits_daily_visits_check", t.visits),
  ],
);

/** The rollups' singleton state: when they were last computed ("as of") and how far the visits are done. */
export const reportRollupState = pgTable(
  "report_rollup_state",
  {
    /** Always true: at most one row. */
    id: boolean("id").primaryKey().default(true),
    /** The instant the figures describe (the start of the last refresh). */
    asOf: tstz("as_of").notNull(),
    /** The last WIB day whose visits were computed; the next refresh recomputes from the day before it. */
    visitsThroughDay: date("visits_through_day", { mode: "string" }),
    /** The gateway fee setting (app_settings midtrans.fees) the last refresh priced with: a different one re-prices every day, so the next refresh rebuilds everything. */
    fees: jsonb("fees").notNull().default({}),
    durationMs: integer("duration_ms").notNull(),
    orderRows: integer("order_rows").notNull(),
    visitRows: integer("visit_rows").notNull(),
  },
  (t) => [
    check("report_rollup_state_singleton_check", sql`${t.id}`),
    nonNegative("report_rollup_state_duration_ms_check", t.durationMs),
    nonNegative("report_rollup_state_order_rows_check", t.orderRows),
    nonNegative("report_rollup_state_visit_rows_check", t.visitRows),
  ],
);
