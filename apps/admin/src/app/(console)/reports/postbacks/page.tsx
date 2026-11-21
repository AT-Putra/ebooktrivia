import type { Metadata } from "next";
import { CheckCircleIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react/ssr";
import { CONVERSION_STATUSES } from "@ebooktrivia/core";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { DateInput, EmptyState, FilterForm, FilterSelect, Pager } from "../../../../components/reports/report-ui.tsx";
import { RefireForm } from "../../../../components/reports/refire-form.tsx";
import { PageHeading } from "../../../../components/settings/fields.tsx";
import { formatInt, formatRupiah, formatWibTime } from "../../../../lib/format.ts";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { can } from "../../../../lib/policy.ts";
import { filterOptions, pageOf, type Query } from "../../../../lib/reports/common.ts";
import {
  KIND_LABELS,
  KINDS,
  MARKERS,
  type Marker,
  parsePostbackFilters,
  postbackList,
  postbackSummary,
  reconcileMt,
  SINK_LABELS,
  SINKS,
  type StatusCounts,
} from "../../../../lib/reports/postbacks.ts";
import { refireConversionAction } from "./actions.ts";

export const metadata: Metadata = { title: "Postback report | Admin Console" };
export const dynamic = "force-dynamic";

function Counts({ c }: { c: StatusCounts }) {
  return (
    <span className="tabular">
      {formatInt(c.sent)} sent
      {c.failed > 0 ? <span className="font-semibold">, {formatInt(c.failed)} failed</span> : ", 0 failed"}
      {c.inFlight > 0 ? `, ${formatInt(c.inFlight)} in flight` : ""}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "sent") {
    return (
      <Badge variant="success">
        <CheckCircleIcon aria-hidden="true" weight="fill" />
        Sent
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive">
        <XCircleIcon aria-hidden="true" weight="fill" />
        Failed
      </Badge>
    );
  }
  return <Badge variant="info">{status === "sending" ? "Sending" : "Pending"}</Badge>;
}

/**
 * The postback report (AC-A7): MO / MT / reversals fired per adnet (and per CAPI sink), the HTTP result, retries and answer, the failed
 * ones with filters and the markers that explain them, the reconciliation identity per adnet (from the raw tables), and the Owner's
 * manual re-fire. Staff view it (reports.view); the re-fire button and the payout of each row (an adnet setting only the Owner sees) are
 * Owner-only. A source is labelled by order_source_label: Organic = no click id.
 */
export default async function PostbacksPage({ searchParams }: { searchParams: Promise<Query> }) {
  const admin = await requireAdmin({ permission: "reports.view" });
  const { sql } = await getRuntime();
  const query = await searchParams;
  const { filters, error } = parsePostbackFilters(query, new Date());
  const page = pageOf(query);
  const owner = can(admin.role, "conversion.refire");
  const showPayout = can(admin.role, "roi.view");
  const [options, summary, reconciliation, list] = await Promise.all([filterOptions(sql), postbackSummary(sql, filters), reconcileMt(sql, filters), postbackList(sql, filters, page)]);
  const keep: Record<string, string> = {
    from: filters.from,
    to: filters.to,
    adnet: filters.adnet ?? "",
    sink: filters.sink ?? "",
    kind: filters.kind ?? "",
    status: filters.status ?? "",
    marker: filters.marker ?? "",
  };
  return (
    <>
      <PageHeading
        title="Postback report"
        description="What was sent to each adnet and ad platform when an order was created (MO), paid (MT) or refunded (reversal), with the HTTP result, the retries and the answer. Events created in the range, WIB."
      />
      {error === null ? null : (
        <p role="alert" className="rounded-md border border-destructive/60 bg-destructive-soft px-3 py-2 text-sm text-destructive-soft-foreground" data-testid="filter-error">
          {error} The last 30 days are shown instead.
        </p>
      )}
      <FilterForm label="Postback filters" action="/reports/postbacks" reset="/reports/postbacks">
        <DateInput id="p-from" name="from" label="From (WIB)" value={filters.from} />
        <DateInput id="p-to" name="to" label="To (WIB)" value={filters.to} />
        <FilterSelect id="p-adnet" name="adnet" label="Adnet" value={filters.adnet} all="All adnets" options={options.adnets.map((a) => ({ value: a.id, label: a.name }))} />
        <FilterSelect id="p-sink" name="sink" label="Sink" value={filters.sink} all="All sinks" options={SINKS.map((s) => ({ value: s, label: SINK_LABELS[s] }))} />
        <FilterSelect id="p-kind" name="kind" label="Event" value={filters.kind} all="All events" options={KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))} />
        <FilterSelect
          id="p-status"
          name="status"
          label="Status"
          value={filters.status}
          all="All statuses"
          options={CONVERSION_STATUSES.map((s) => ({ value: s, label: s === "sent" ? "Sent" : s === "failed" ? "Failed" : s === "sending" ? "Sending" : "Pending" }))}
        />
        <FilterSelect id="p-marker" name="marker" label="Marker" value={filters.marker} all="Any marker" options={(Object.keys(MARKERS) as Marker[]).map((m) => ({ value: m, label: MARKERS[m].label }))} />
      </FilterForm>

      <Card data-testid="postback-summary">
        <CardTitle className="text-base">Fired per adnet and sink</CardTitle>
        {summary.length === 0 ? (
          <EmptyState testId="summary-empty">No postbacks in this range.</EmptyState>
        ) : (
          <Table aria-label="Postbacks per adnet and sink">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Source</TableHead>
                <TableHead>Sink</TableHead>
                <TableHead>MO</TableHead>
                <TableHead>MT</TableHead>
                <TableHead>Reversals</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.map((r) => (
                <TableRow key={`${r.sink}:${r.adnetId ?? "none"}`} data-testid="summary-row">
                  <TableCell>{r.source}</TableCell>
                  <TableCell>{SINK_LABELS[r.sink]}</TableCell>
                  <TableCell>
                    <Counts c={r.mo} />
                  </TableCell>
                  <TableCell>
                    <Counts c={r.mt} />
                  </TableCell>
                  <TableCell>
                    <Counts c={r.reversal} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card data-testid="reconciliation">
        <CardTitle className="text-base">Reconciliation: MT per adnet against paid orders</CardTitle>
        <CardDescription>
          Per adnet, for the orders created in the range and from the raw tables: the S2S MT rows that ended (sent + failed) must equal the orders that were paid with a click id. Rows still pending or
          sending are in flight, not a mismatch.
        </CardDescription>
        {reconciliation.length === 0 ? (
          <EmptyState testId="reconciliation-empty">No paid order with a click id in this range.</EmptyState>
        ) : (
          <Table aria-label="MT reconciliation per adnet">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Adnet</TableHead>
                <TableHead className="text-right">Paid with click id</TableHead>
                <TableHead className="text-right">MT sent</TableHead>
                <TableHead className="text-right">MT failed</TableHead>
                <TableHead className="text-right">In flight</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reconciliation.map((r) => (
                <TableRow key={r.adnetId} data-testid="reconciliation-row">
                  <TableCell>{r.adnet}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(r.paidOrders)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(r.sent)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(r.failed)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(r.inFlight)}</TableCell>
                  <TableCell>
                    {r.identity ? (
                      <Badge variant="success">
                        <CheckCircleIcon aria-hidden="true" weight="fill" />
                        Matches
                      </Badge>
                    ) : r.balanced ? (
                      <Badge variant="info">In flight</Badge>
                    ) : (
                      <Badge variant="destructive" data-testid="reconciliation-gap">
                        <WarningIcon aria-hidden="true" weight="fill" />
                        {r.gap > 0 ? `${formatInt(r.gap)} paid without an MT row` : `${formatInt(-r.gap)} MT row${r.gap === -1 ? "" : "s"} without a paid order`}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card data-testid="postback-list">
        <CardTitle className="text-base">Events</CardTitle>
        <CardDescription>Newest first. A failed event can be re-fired by the Owner; the answer shown is the first 300 characters of the last attempt, with secrets removed.</CardDescription>
        {list.rows.length === 0 ? (
          <EmptyState testId="list-empty">No events match these filters.</EmptyState>
        ) : (
          <Table aria-label="Postback events">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Created</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tries</TableHead>
                <TableHead>HTTP and answer</TableHead>
                {showPayout ? <TableHead className="text-right">Payout</TableHead> : null}
                {owner ? <TableHead>Re-fire</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.rows.map((r) => (
                <TableRow key={r.id} data-testid="postback-row">
                  <TableCell className="tabular whitespace-nowrap">{formatWibTime(r.createdAt)}</TableCell>
                  <TableCell className="font-mono">{r.orderCode}</TableCell>
                  <TableCell>{r.source}</TableCell>
                  <TableCell>{KIND_LABELS[r.kind]}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <StatusBadge status={r.status} />
                      {r.marker === null ? null : (
                        <Badge variant="warning" title={MARKERS[r.marker].hint} data-testid={`marker-${r.marker}`}>
                          {MARKERS[r.marker].label}
                        </Badge>
                      )}
                      {r.maybeCounted && r.status !== "sent" ? <span className="text-xs text-muted-foreground">The sink may have counted it</span> : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular">{r.attempts}</TableCell>
                  <TableCell className="max-w-72">
                    <span className="tabular">{r.httpStatus === null ? "No answer" : `HTTP ${String(r.httpStatus)}`}</span>
                    {r.latencyMs === null ? null : <span className="tabular text-muted-foreground">{` in ${String(r.latencyMs)} ms`}</span>}
                    {r.lastError !== null && r.marker === null ? <span className="block text-xs text-muted-foreground">{r.lastError.slice(0, 200)}</span> : null}
                    {r.response === null || r.response === "" ? null : <span className="block font-mono text-xs break-all text-muted-foreground">{r.response}</span>}
                  </TableCell>
                  {showPayout ? <TableCell className="text-right font-mono tabular">{r.payoutIdr === null ? "-" : formatRupiah(r.payoutIdr)}</TableCell> : null}
                  {owner ? <TableCell>{r.status === "failed" || r.status === "sent" ? <RefireForm id={r.id} sent={r.status === "sent"} action={refireConversionAction} /> : null}</TableCell> : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pager path="/reports/postbacks" query={keep} page={page} count={list.count} />
      </Card>
    </>
  );
}
