import type { Metadata } from "next";
import Link from "next/link";
import { WarningIcon } from "@phosphor-icons/react/ssr";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { AsOf, KpiGrid } from "../../components/reports/report-ui.tsx";
import { DailyChart } from "../../components/reports/daily-chart.tsx";
import { unusedRecoveryCodes } from "../../lib/auth/recovery-codes.ts";
import { formatBps, formatDay, formatInt, formatRupiah } from "../../lib/format.ts";
import { requireAdmin } from "../../lib/next/require-admin.ts";
import { getRuntime } from "../../lib/next/runtime.ts";
import { can } from "../../lib/policy.ts";
import { DASHBOARD_DAYS, loadDashboard } from "../../lib/reports/dashboard.ts";
import { reviewCount } from "../../lib/review/review.ts";

export const metadata: Metadata = { title: "Overview | Admin Console" };
// The figures come from the rollups the worker refreshes every 5 minutes: never a build-time snapshot.
export const dynamic = "force-dynamic";

/**
 * The dashboard (AC-A4): today's visits, MO, MT, MO to MT % and revenue (WIB day), read from the rollups, so it says when they
 * were computed. Staff and Owner see the same figures (reports.view); nothing here is personal data.
 */
export default async function OverviewPage() {
  const admin = await requireAdmin({ permission: "dashboard.view" });
  const { sql } = await getRuntime();
  const now = new Date();
  const owner = can(admin.role, "order.review.resolve");
  const [codesLeft, d, waiting] = await Promise.all([unusedRecoveryCodes(sql, admin.userId), loadDashboard(sql, now), owner ? reviewCount(sql) : Promise.resolve(0)]);
  const t = d.todayTotals;
  const y = d.yesterdayTotals;
  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="text-xs text-muted-foreground">Signed in as {admin.role === "owner" ? "the Owner" : "Staff"}.</p>
      </div>
      {codesLeft <= 3 ? (
        <Card role="status" className="border-destructive/60">
          <CardTitle className="flex items-center gap-2 text-base">
            <WarningIcon aria-hidden="true" size={18} weight="fill" />
            {codesLeft === 0 ? "No recovery codes left" : `Only ${String(codesLeft)} recovery code${codesLeft === 1 ? "" : "s"} left`}
          </CardTitle>
          <CardDescription>
            Without recovery codes, losing your authenticator locks you out.{" "}
            <Link href="/account" className="underline underline-offset-4">
              Create new codes
            </Link>
            .
          </CardDescription>
        </Card>
      ) : null}
      {owner && waiting > 0 ? (
        <Card role="status" className="border-warning/60" data-testid="review-queue">
          <CardTitle className="flex items-center gap-2 text-base">
            <WarningIcon aria-hidden="true" size={18} weight="fill" />
            {formatInt(waiting)} order{waiting === 1 ? " waits" : "s wait"} for your decision
          </CardTitle>
          <CardDescription>
            Payments the system could not settle on its own (a payment Midtrans reversed, a fraud challenge, a partial refund or chargeback).{" "}
            <Link href="/orders/review" className="underline underline-offset-4">
              Open the review queue
            </Link>
            .
          </CardDescription>
        </Card>
      ) : null}
      <AsOf asOf={d.asOf} stale={d.stale} />
      <KpiGrid
        title={`Today, ${formatDay(d.today)}`}
        tiles={[
          { label: "Visits today", value: formatInt(t.visits), note: `Yesterday ${formatInt(y.visits)}`, testId: "kpi-visits" },
          { label: "MO today", value: formatInt(t.mo), note: `Yesterday ${formatInt(y.mo)}`, testId: "kpi-mo" },
          { label: "MT today", value: formatInt(t.mt), note: `Yesterday ${formatInt(y.mt)}`, testId: "kpi-mt" },
          { label: "MO to MT today", value: formatBps(t.conversionBps), note: `Yesterday ${formatBps(y.conversionBps)}`, testId: "kpi-conversion" },
          { label: "Revenue today", value: formatRupiah(t.revenueIdr), note: `Yesterday ${formatRupiah(y.revenueIdr)}`, testId: "kpi-revenue" },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        MO is an order with a payment page, MT a paid order; both count the orders created on that WIB day, so a payment that arrives tomorrow raises
        today&apos;s MT. Revenue is the amount of paid orders (a refund or a chargeback removes it).{" "}
        <Link href="/reports/sales" className="underline underline-offset-4">
          Open the sales report
        </Link>
        .
      </p>
      {d.reviewOrders > 0 ? (
        <p role="status" className="flex items-start gap-2 rounded-md border border-warning/60 bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground" data-testid="review-orders">
          <WarningIcon aria-hidden="true" size={16} weight="fill" className="mt-0.5 shrink-0" />
          {formatInt(d.reviewOrders)} order{d.reviewOrders === 1 ? " is" : "s are"} in review in these {String(DASHBOARD_DAYS)} days (a partial refund or chargeback): the money is undecided, so it is in no revenue figure.
        </p>
      ) : null}
      <DailyChart days={d.series} title={`Daily MO and MT, last ${String(DASHBOARD_DAYS)} days`} id="dashboard" />
    </>
  );
}
