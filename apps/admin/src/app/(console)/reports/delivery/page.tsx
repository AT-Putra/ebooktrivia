import type { Metadata } from "next";
import { CheckCircleIcon, QuestionIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react/ssr";
import { DELIVERY_CHANNELS, DELIVERY_STATUSES } from "@ebooktrivia/core";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { DateInput, EmptyState, FilterForm, FilterSelect, Pager } from "../../../../components/reports/report-ui.tsx";
import { PageHeading } from "../../../../components/settings/fields.tsx";
import { formatBps, formatInt, formatWibTime } from "../../../../lib/format.ts";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { pageOf, type Query } from "../../../../lib/reports/common.ts";
import { channelCounts, deliveryList, parseDeliveryFilters, perNumberStats } from "../../../../lib/reports/delivery-source.ts";

export const metadata: Metadata = { title: "Delivery report | Admin Console" };
export const dynamic = "force-dynamic";

const CHANNEL_LABELS: Readonly<Record<string, string>> = { whatsapp: "WhatsApp", email: "E-mail" };
const STATUS_LABELS: Readonly<Record<string, string>> = { pending: "Pending", sending: "Sending", sent: "Sent", failed: "Failed", unknown: "Unknown", cancelled: "Cancelled" };

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
  if (status === "unknown") {
    return (
      <Badge variant="warning">
        <QuestionIcon aria-hidden="true" weight="fill" />
        Unknown
      </Badge>
    );
  }
  return <Badge variant={status === "cancelled" ? "secondary" : "info"}>{STATUS_LABELS[status] ?? status}</Badge>;
}

/**
 * The delivery report (AC-A6): per-order WhatsApp and e-mail status, the sender number and the retries, and the volume and failure
 * rate of every pool number. Staff view it (reports.view); buyers appear masked (SQL mask_name / mask_phone). The figures come from
 * lib/reports/delivery-source.ts (the one place that knows where deliveries are recorded).
 */
export default async function DeliveryPage({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin({ permission: "reports.view" });
  const { sql } = await getRuntime();
  const query = await searchParams;
  const { filters, error } = parseDeliveryFilters(query, new Date());
  const page = pageOf(query);
  const [numbers, channels, list] = await Promise.all([perNumberStats(sql, filters), channelCounts(sql, filters), deliveryList(sql, filters, page)]);
  const keep: Record<string, string> = { from: filters.from, to: filters.to, channel: filters.channel ?? "", status: filters.status ?? "", number: filters.sessionId ?? "" };
  return (
    <>
      <PageHeading
        title="Delivery report"
        description="WhatsApp and e-mail deliveries of the orders created in the range (WIB): who got the ebook, from which number, after how many tries, and how each sender number is doing."
      />
      {error === null ? null : (
        <p role="alert" className="rounded-md border border-destructive/60 bg-destructive-soft px-3 py-2 text-sm text-destructive-soft-foreground" data-testid="filter-error">
          {error} The last 30 days are shown instead.
        </p>
      )}
      <FilterForm label="Delivery filters" action="/reports/delivery" reset="/reports/delivery">
        <DateInput id="d-from" name="from" label="From (WIB)" value={filters.from} />
        <DateInput id="d-to" name="to" label="To (WIB)" value={filters.to} />
        <FilterSelect id="d-channel" name="channel" label="Channel" value={filters.channel} all="All channels" options={DELIVERY_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] ?? c }))} />
        <FilterSelect id="d-status" name="status" label="Status" value={filters.status} all="All statuses" options={DELIVERY_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s }))} />
        <FilterSelect
          id="d-number"
          name="number"
          label="Sender number"
          value={filters.sessionId}
          all="All numbers"
          options={numbers.map((n) => ({ value: n.sessionId, label: n.phone ?? n.session }))}
        />
      </FilterForm>

      <Card data-testid="delivery-numbers">
        <CardTitle className="text-base">Per sender number</CardTitle>
        <CardDescription>
          Every attempt of a number counts: a number that was left for the next one after a failure has a failed attempt. Volume = sent + failed + unknown; failure rate = failed / volume. Attempts still in
          flight are in neither.
        </CardDescription>
        {numbers.length === 0 ? (
          <EmptyState testId="numbers-empty">No sender number is set up yet.</EmptyState>
        ) : (
          <Table aria-label="Volume and failure rate per sender number">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Number</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Unknown</TableHead>
                <TableHead className="text-right">In flight</TableHead>
                <TableHead className="text-right">Failure rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {numbers.map((n) => (
                <TableRow key={n.sessionId} data-testid="number-row">
                  <TableCell>
                    <span className="font-mono">{n.phone ?? "Not paired yet"}</span>
                    <span className="block text-xs text-muted-foreground">
                      {n.session}
                      {n.active ? "" : " (switched off)"}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(n.volume)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(n.sent)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(n.failed)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(n.unknown)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(n.inFlight)}</TableCell>
                  <TableCell className="text-right font-mono tabular" data-testid="failure-rate">
                    {formatBps(n.failureBps)}
                    {n.failureBps !== null && n.failureBps >= 2000 ? (
                      <Badge variant="warning" className="ml-1.5">
                        <WarningIcon aria-hidden="true" weight="fill" />
                        High
                      </Badge>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card data-testid="delivery-channels">
        <CardTitle className="text-base">By channel</CardTitle>
        {channels.length === 0 ? (
          <EmptyState testId="channels-empty">No deliveries in this range.</EmptyState>
        ) : (
          <Table aria-label="Deliveries by channel">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Channel</TableHead>
                <TableHead className="text-right">Deliveries</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Unknown</TableHead>
                <TableHead className="text-right">Pending</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {channels.map((c) => (
                <TableRow key={c.channel} data-testid="channel-row">
                  <TableCell>{CHANNEL_LABELS[c.channel] ?? c.channel}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(c.total)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(c.sent)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(c.failed)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(c.unknown)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(c.pending)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card data-testid="delivery-list">
        <CardTitle className="text-base">Deliveries</CardTitle>
        <CardDescription>Newest first. Buyers are masked; the order code is what the buyer sees.</CardDescription>
        {list.rows.length === 0 ? (
          <EmptyState testId="deliveries-empty">No deliveries match these filters.</EmptyState>
        ) : (
          <Table aria-label="Deliveries">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Created</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Buyer</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sender</TableHead>
                <TableHead className="text-right">Tries</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.rows.map((r) => (
                <TableRow key={r.id} data-testid="delivery-row">
                  <TableCell className="tabular whitespace-nowrap">{formatWibTime(r.createdAt)}</TableCell>
                  <TableCell className="font-mono">{r.orderCode}</TableCell>
                  <TableCell>
                    {r.buyerName}
                    <span className="block text-xs text-muted-foreground">{r.buyerPhone ?? ""}</span>
                  </TableCell>
                  <TableCell>{CHANNEL_LABELS[r.channel] ?? r.channel}</TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="font-mono">{r.channel === "whatsapp" ? (r.sender ?? "-") : "-"}</TableCell>
                  <TableCell className="text-right font-mono tabular">
                    {r.attempts}
                    {r.channel === "whatsapp" && r.numbersTried > 1 ? <span className="block text-xs text-muted-foreground">{`${String(r.numbersTried)} numbers`}</span> : null}
                  </TableCell>
                  <TableCell className="max-w-64 text-xs text-muted-foreground">
                    {r.ack === null ? "" : `Ack ${r.ack}. `}
                    {r.lastError ?? ""}
                    {r.sentAt === null ? "" : ` Sent ${formatWibTime(r.sentAt)}.`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pager path="/reports/delivery" query={keep} page={page} count={list.count} />
      </Card>
    </>
  );
}
