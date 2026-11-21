import type { Metadata } from "next";
import Link from "next/link";
import { WarningIcon } from "@phosphor-icons/react/ssr";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardTitle } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { AsOf, DateInput, EmptyState, FilterForm, FilterSelect, KpiGrid, Pager } from "../../../../components/reports/report-ui.tsx";
import { PageHeading } from "../../../../components/settings/fields.tsx";
import { formatInt, formatRupiah, formatRupiahSigned } from "../../../../lib/format.ts";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { can } from "../../../../lib/policy.ts";
import { isStale, pageOf, param, parseSalesFilters, type Query, rollupAsOf } from "../../../../lib/reports/common.ts";
import { isRoiGroup, ROI_GROUP_LABELS, ROI_GROUPS, type RoiRow, roiReport } from "../../../../lib/reports/roi.ts";

export const metadata: Metadata = { title: "Profit and ROI | Admin Console" };
export const dynamic = "force-dynamic";

function NetCell({ row }: { row: RoiRow }) {
  return (
    <TableCell className="text-right font-mono tabular" data-testid="roi-net">
      {formatRupiahSigned(row.netIdr)}
      {row.netIdr < 0 ? <Badge variant="destructive" className="ml-1.5">Loss</Badge> : null}
    </TableCell>
  );
}

/**
 * The profit / ROI report (AC-A8), Owner only (roi.view): revenue - CPA - gateway fee - ad spend per landing page, adnet or campaign.
 * It shows adnet payouts, gateway fees and ad spend, which are Owner-only settings, so Staff cannot open it. The order figures
 * are the rollups' (as of the time shown); the ad spend is read live.
 */
export default async function RoiPage({ searchParams }: { searchParams: Promise<Query> }) {
  const admin = await requireAdmin({ permission: "roi.view" });
  const { sql } = await getRuntime();
  const now = new Date();
  const query = await searchParams;
  const { filters, error } = parseSalesFilters(query, now);
  const groupRaw = param(query, "group");
  const group = isRoiGroup(groupRaw) ? groupRaw : "adnet";
  const page = pageOf(query);
  const [asOf, report] = await Promise.all([rollupAsOf(sql), roiReport(sql, { from: filters.from, to: filters.to, group, page })]);
  const t = report.totals;
  const keep = { from: filters.from, to: filters.to, group };
  return (
    <>
      <PageHeading
        title="Profit and ROI"
        description="Net = revenue - adnet payout (CPA) - gateway fee - ad spend, in whole rupiah, over the orders created in the range and the ad spend dated in it."
      />
      {error === null ? null : (
        <p role="alert" className="rounded-md border border-destructive/60 bg-destructive-soft px-3 py-2 text-sm text-destructive-soft-foreground">
          {error} The last 30 days are shown instead.
        </p>
      )}
      <FilterForm label="Profit filters" action="/reports/roi" reset="/reports/roi">
        <DateInput id="r-from" name="from" label="From (WIB)" value={filters.from} />
        <DateInput id="r-to" name="to" label="To (WIB)" value={filters.to} />
        <FilterSelect id="r-group" name="group" label="Group by" value={group === "adnet" ? null : group} all={ROI_GROUP_LABELS.adnet} options={ROI_GROUPS.filter((g) => g !== "adnet").map((g) => ({ value: g, label: ROI_GROUP_LABELS[g] }))} />
      </FilterForm>
      <AsOf asOf={asOf} stale={isStale(asOf, now)} live="Ad spend is read live." />
      <KpiGrid
        title="Totals for the range"
        tiles={[
          { label: "Revenue", value: formatRupiah(t.revenueIdr), note: `${formatInt(t.paidOrders)} paid orders`, testId: "roi-revenue" },
          { label: "Adnet payout (CPA)", value: formatRupiah(t.payoutIdr), testId: "roi-payout" },
          { label: "Gateway fee", value: formatRupiah(t.gatewayFeeIdr), testId: "roi-fee" },
          { label: "Ad spend", value: formatRupiah(t.adSpendIdr), testId: "roi-spend" },
          { label: "Net profit", value: formatRupiahSigned(t.netIdr), note: t.netIdr < 0 ? "A loss" : undefined, testId: "roi-total-net" },
        ]}
      />
      {t.feeMissingOrders > 0 ? (
        <p role="status" className="flex items-start gap-2 rounded-md border border-warning/60 bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground" data-testid="fee-missing">
          <WarningIcon aria-hidden="true" size={16} weight="fill" className="mt-0.5 shrink-0" />
          <span>
            {formatInt(t.feeMissingOrders)} order{t.feeMissingOrders === 1 ? " that was" : "s that were"} paid at some point (refunded ones included) {t.feeMissingOrders === 1 ? "has" : "have"} a payment method with no gateway fee set, so the fee counts as Rp 0 and the profit is overstated.{" "}
            {can(admin.role, "midtrans.edit") ? (
              <Link href="/settings/midtrans" className="underline underline-offset-4">
                Set the fees
              </Link>
            ) : null}
          </span>
        </p>
      ) : null}
      <Card data-testid="roi-table-card">
        <CardTitle className="text-base">By {ROI_GROUP_LABELS[group].toLowerCase()}</CardTitle>
        {report.rows.length === 0 ? (
          <EmptyState testId="roi-empty">No orders or ad spend in this range.</EmptyState>
        ) : (
          <Table aria-label="Profit by group">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{ROI_GROUP_LABELS[group]}</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">CPA</TableHead>
                <TableHead className="text-right">Gateway fee</TableHead>
                <TableHead className="text-right">Ad spend</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((r) => (
                <TableRow key={r.key ?? "unassigned"} data-testid="roi-row">
                  <TableCell>{r.label}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(r.paidOrders)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatRupiah(r.revenueIdr)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatRupiah(r.payoutIdr)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatRupiah(r.gatewayFeeIdr)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatRupiah(r.adSpendIdr)}</TableCell>
                  <NetCell row={r} />
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">Total</TableCell>
                <TableCell className="text-right font-mono tabular">{formatInt(t.paidOrders)}</TableCell>
                <TableCell className="text-right font-mono tabular">{formatRupiah(t.revenueIdr)}</TableCell>
                <TableCell className="text-right font-mono tabular">{formatRupiah(t.payoutIdr)}</TableCell>
                <TableCell className="text-right font-mono tabular">{formatRupiah(t.gatewayFeeIdr)}</TableCell>
                <TableCell className="text-right font-mono tabular">{formatRupiah(t.adSpendIdr)}</TableCell>
                <NetCell row={t} />
              </TableRow>
            </TableFooter>
          </Table>
        )}
        <Pager path="/reports/roi" query={keep} page={report.page} count={report.rowCount} />
        <p className="text-xs text-muted-foreground">
          Revenue counts paid orders only (a refund, a chargeback or an order in review is out of it; no part of a partial refund is counted). The gateway fee is flat + the
          percentage rounded up to the next rupiah, for every order that was ever paid. CPA is the payout the adnet was told when the MT was sent, less the reversal it acknowledged.
          Ad spend that names no landing page, adnet or campaign has a row of its own (it is not charged to Organic), so the total is the same for every grouping.{" "}
          <Link href="/reports/ad-spend" className="underline underline-offset-4">
            Enter ad spend
          </Link>
          .
        </p>
      </Card>
    </>
  );
}
