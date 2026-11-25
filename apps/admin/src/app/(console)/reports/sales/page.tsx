import type { Metadata } from "next";
import { ORDER_STATUSES } from "@ebooktrivia/core";
import { Card, CardTitle } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { DailyChart } from "../../../../components/reports/daily-chart.tsx";
import { AsOf, DateInput, EmptyState, ExportForm, FilterForm, FilterSelect, KpiGrid } from "../../../../components/reports/report-ui.tsx";
import { PageHeading } from "../../../../components/settings/fields.tsx";
import { formatBps, formatInt, formatRupiah } from "../../../../lib/format.ts";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { can } from "../../../../lib/policy.ts";
import { filterOptions, isStale, parseSalesFilters, type Query, rollupAsOf } from "../../../../lib/reports/common.ts";
import { reviewOrders, salesByDay, salesBySource, salesTotals } from "../../../../lib/reports/sales.ts";

export const metadata: Metadata = { title: "Sales report | Admin Console" };
export const dynamic = "force-dynamic";

const STATUS_LABELS: Readonly<Record<(typeof ORDER_STATUSES)[number], string>> = {
  pending: "Pending",
  paid: "Paid",
  review: "In review",
  expired: "Expired",
  gateway_failed: "Gateway failed",
  snap_create_failed: "Payment page failed",
  refunded: "Refunded",
};

/**
 * The sales report (AC-A5): visits, MO, MT, MO to MT % and gross revenue with filters (date range, program, landing
 * page, adnet, gateway, status) and a daily chart, from the rollups. Staff view it (reports.view) with no buyer data on
 * it; the CSV (one row per order, WITH the buyer's contact) is Owner-only (sales.export), a POST form to an audited route.
 */
export default async function SalesPage({ searchParams }: { searchParams: Promise<Query> }) {
  const admin = await requireAdmin({ permission: "reports.view" });
  const { sql } = await getRuntime();
  const now = new Date();
  const { filters, error } = parseSalesFilters(await searchParams, now);
  const [options, asOf, totals, days, rows, review] = await Promise.all([
    filterOptions(sql),
    rollupAsOf(sql),
    salesTotals(sql, filters),
    salesByDay(sql, filters),
    salesBySource(sql, filters),
    reviewOrders(sql, filters),
  ]);
  const hidden = {
    from: filters.from,
    to: filters.to,
    program: filters.programId ?? "",
    lp: filters.landingPageId ?? "",
    adnet: filters.adnet ?? "",
    gateway: filters.gateway ?? "",
    status: filters.status ?? "",
  };
  return (
    <>
      <PageHeading
        title="Sales report"
        description="Visits, leads (orders that reached the payment page), purchases (paid orders), success rate (purchases out of leads) and gross revenue per WIB day, by landing page and source. Revenue is paid orders only: refunds, chargebacks and orders in review are not in it."
      />
      {error === null ? null : (
        <p role="alert" className="rounded-md border border-destructive/60 bg-destructive-soft px-3 py-2 text-sm text-destructive-soft-foreground" data-testid="filter-error">
          {error} The last 30 days are shown instead.
        </p>
      )}
      <FilterForm label="Sales filters" action="/reports/sales" reset="/reports/sales">
        <DateInput id="f-from" name="from" label="From (WIB)" value={filters.from} />
        <DateInput id="f-to" name="to" label="To (WIB)" value={filters.to} />
        <FilterSelect id="f-program" name="program" label="Program" value={filters.programId} all="All programs" options={options.programs.map((p) => ({ value: p.id, label: p.name }))} />
        <FilterSelect id="f-lp" name="lp" label="Landing page" value={filters.landingPageId} all="All landing pages" options={options.landingPages.map((p) => ({ value: p.id, label: p.name }))} />
        <FilterSelect
          id="f-adnet"
          name="adnet"
          label="Adnet"
          value={filters.adnet}
          all="All sources"
          options={[{ value: "organic", label: "Organic (no click id)" }, ...options.adnets.map((a) => ({ value: a.id, label: a.name }))]}
        />
        <FilterSelect id="f-gateway" name="gateway" label="Gateway" value={filters.gateway} all="All gateways" options={options.gateways.map((g) => ({ value: g, label: g === "midtrans" ? "Midtrans" : g }))} />
        <FilterSelect id="f-status" name="status" label="Order status" value={filters.status} all="All statuses" options={ORDER_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} />
      </FilterForm>
      <AsOf asOf={asOf} stale={isStale(asOf, now)} />
      <KpiGrid
        title="Totals for the filters"
        tiles={[
          { label: "Visits", value: formatInt(totals.visits), note: filters.status === null ? undefined : "Visits have no status", testId: "kpi-visits" },
          { label: "Leads", value: formatInt(totals.mo), testId: "kpi-mo" },
          { label: "Purchase", value: formatInt(totals.mt), testId: "kpi-mt" },
          { label: "Success Rate", value: formatBps(totals.conversionBps), testId: "kpi-conversion" },
          { label: "Gross revenue", value: formatRupiah(totals.revenueIdr), testId: "kpi-revenue" },
        ]}
      />
      {review > 0 ? (
        <p role="status" className="rounded-md border border-warning/60 bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground" data-testid="review-orders">
          {formatInt(review)} order{review === 1 ? " is" : "s are"} in review in this range (a partial refund or chargeback): not in the revenue above.
        </p>
      ) : null}
      <DailyChart days={days} title="Daily leads and purchases" id="sales" />
      <Card data-testid="sales-table-card">
        <CardTitle className="text-base">By landing page and source</CardTitle>
        {rows.length === 0 ? (
          <EmptyState testId="sales-empty">No visits or orders match these filters.</EmptyState>
        ) : (
          <Table aria-label="Sales by landing page and source">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Landing page</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Visits</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Purchase</TableHead>
                <TableHead className="text-right">Success Rate</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.landingPageId}:${r.adnetId ?? "organic"}`} data-testid="sales-row">
                  <TableCell>{r.landingPage}</TableCell>
                  <TableCell>{r.source}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(r.visits)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(r.mo)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(r.mt)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatBps(r.conversionBps)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatRupiah(r.revenueIdr)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">Total</TableCell>
                <TableCell />
                <TableCell className="text-right font-mono tabular">{formatInt(totals.visits)}</TableCell>
                <TableCell className="text-right font-mono tabular">{formatInt(totals.mo)}</TableCell>
                <TableCell className="text-right font-mono tabular">{formatInt(totals.mt)}</TableCell>
                <TableCell className="text-right font-mono tabular">{formatBps(totals.conversionBps)}</TableCell>
                <TableCell className="text-right font-mono tabular">{formatRupiah(totals.revenueIdr)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </Card>
      {can(admin.role, "sales.export") ? (
        <ExportForm
          action="/reports/sales/export"
          fields={hidden}
          label="Download CSV"
          note="One row per order created in the range, with the buyer's name, phone and e-mail. Owner only; every download is recorded in the audit log."
          testId="sales-export"
        />
      ) : null}
    </>
  );
}
