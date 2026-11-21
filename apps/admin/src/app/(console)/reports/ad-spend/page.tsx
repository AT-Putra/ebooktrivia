import type { Metadata } from "next";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { wibDateOf } from "@ebooktrivia/core";
import { AdSpendFields } from "../../../../components/reports/ad-spend-fields.tsx";
import { DateInput, EmptyState, FilterForm, Pager } from "../../../../components/reports/report-ui.tsx";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { PageHeading } from "../../../../components/settings/fields.tsx";
import { formatInt, formatRupiah } from "../../../../lib/format.ts";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { AD_PLATFORM_LABELS, listAdSpend } from "../../../../lib/reports/ad-spend.ts";
import { filterOptions, pageOf, parseSalesFilters, type Query } from "../../../../lib/reports/common.ts";
import { createAdSpendAction, deleteAdSpendAction, updateAdSpendAction } from "./actions.ts";

export const metadata: Metadata = { title: "Ad spend | Admin Console" };
export const dynamic = "force-dynamic";

/** Ad spend (AC-A8), Owner only: the money spent on Meta, TikTok, Google or elsewhere, which the profit report subtracts. */
export default async function AdSpendPage({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin({ permission: "ad_spend.edit" });
  const { sql } = await getRuntime();
  const query = await searchParams;
  const { filters, error } = parseSalesFilters(query, new Date());
  const page = pageOf(query);
  const [options, list] = await Promise.all([filterOptions(sql), listAdSpend(sql, { from: filters.from, to: filters.to, page })]);
  const today = wibDateOf(new Date());
  return (
    <>
      <PageHeading
        title="Ad spend"
        description="What you spent on ads, by day and platform, whole rupiah. It is subtracted in the profit report (as of the day it is dated). Name the landing page, adnet or campaign when you know it; spend without them still counts in the total."
      />
      <Card>
        <CardTitle className="text-base">Add spend</CardTitle>
        <CardDescription>The campaign is matched to the orders&apos; utm_campaign ignoring case and surrounding spaces.</CardDescription>
        <ActionForm action={createAdSpendAction} submitLabel="Save ad spend" testId="ad-spend-create">
          <AdSpendFields idPrefix="new" today={today} landingPages={options.landingPages} adnets={options.adnets} />
        </ActionForm>
      </Card>
      {error === null ? null : (
        <p role="alert" className="rounded-md border border-destructive/60 bg-destructive-soft px-3 py-2 text-sm text-destructive-soft-foreground">
          {error} The last 30 days are shown instead.
        </p>
      )}
      <FilterForm label="Ad spend range" action="/reports/ad-spend" reset="/reports/ad-spend">
        <DateInput id="a-from" name="from" label="From" value={filters.from} />
        <DateInput id="a-to" name="to" label="To" value={filters.to} />
      </FilterForm>
      <Card data-testid="ad-spend-list">
        <CardTitle className="text-base">Entries</CardTitle>
        {list.rows.length === 0 ? (
          <EmptyState testId="ad-spend-empty">No ad spend in this range.</EmptyState>
        ) : (
          <Table aria-label="Ad spend entries">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Date</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Landing page</TableHead>
                <TableHead>Adnet</TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.rows.map((r) => (
                <TableRow key={r.id} data-testid="ad-spend-row">
                  <TableCell className="tabular">{r.spendDate}</TableCell>
                  <TableCell>{AD_PLATFORM_LABELS[r.platform]}</TableCell>
                  <TableCell>{r.landingPage ?? "-"}</TableCell>
                  <TableCell>{r.adnet ?? "-"}</TableCell>
                  <TableCell>{r.utmCampaign ?? "-"}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatRupiah(r.amountIdr)}</TableCell>
                  <TableCell>
                    <details className="min-w-48">
                      <summary className="flex min-h-9 cursor-pointer items-center text-xs font-medium underline underline-offset-4">Edit or delete</summary>
                      <div className="flex flex-col gap-3 pt-2">
                        <ActionForm action={updateAdSpendAction} submitLabel="Save changes" testId={`ad-spend-edit-${r.id}`}>
                          <input type="hidden" name="id" value={r.id} />
                          <AdSpendFields
                            idPrefix={`e-${r.id}`}
                            today={today}
                            landingPages={options.landingPages}
                            adnets={options.adnets}
                            current={{ spendDate: r.spendDate, platform: r.platform, landingPageId: r.landingPageId, adnetId: r.adnetId, utmCampaign: r.utmCampaign, amountIdr: r.amountIdr, note: r.note }}
                          />
                        </ActionForm>
                        <ActionForm action={deleteAdSpendAction} submitLabel="Delete this entry" variant="destructive" testId={`ad-spend-delete-${r.id}`}>
                          <input type="hidden" name="id" value={r.id} />
                        </ActionForm>
                      </div>
                    </details>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold" colSpan={5}>
                  Total in the range ({formatInt(list.count)} entr{list.count === 1 ? "y" : "ies"})
                </TableCell>
                <TableCell className="text-right font-mono tabular" data-testid="ad-spend-total">
                  {formatRupiah(list.total)}
                </TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        )}
        <Pager path="/reports/ad-spend" query={{ from: filters.from, to: filters.to }} page={page} count={list.count} />
      </Card>
    </>
  );
}
