import type { Metadata } from "next";
import { CheckCircleIcon, QuestionIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react/ssr";
import { DELIVERY_CHANNELS, DELIVERY_STATUSES } from "@ebooktrivia/core";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { DateInput, EmptyState, FilterForm, FilterSelect, Pager } from "../../../../components/reports/report-ui.tsx";
import { PageHeading } from "../../../../components/settings/fields.tsx";
import { BuyerContact } from "../../../../components/buyer-contact.tsx";
import { MarkHandledForm } from "../../../../components/reports/mark-handled-form.tsx";
import { ResendForm } from "../../../../components/reports/resend-form.tsx";
import { formatBps, formatInt, formatWibTime } from "../../../../lib/format.ts";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { can } from "../../../../lib/policy.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { pageOf, type Query } from "../../../../lib/reports/common.ts";
import { attentionList, channelCounts, deliveryList, parseDeliveryFilters, perNumberStats } from "../../../../lib/reports/delivery-source.ts";
import { markWrongFileHandledAction, resendDeliveryAction, resendUnknownDeliveryAction } from "./actions.ts";

export const metadata: Metadata = { title: "Delivery report | Admin Console" };
export const dynamic = "force-dynamic";

const CHANNEL_LABELS: Readonly<Record<string, string>> = { whatsapp: "WhatsApp", email: "E-mail" };
const STATUS_LABELS: Readonly<Record<string, string>> = { pending: "Pending", sending: "Sending", sent: "Sent", failed: "Failed", unknown: "Unknown", cancelled: "Cancelled" };
/** The WhatsApp opener (Owner decision D7): the short message that asks the buyer to reply; the ebook follows the reply. */
const OPENER_LABELS: Readonly<Record<string, string>> = {
  pending: "Opener waiting",
  sending: "Opener sending",
  sent: "Opener sent, no reply yet",
  unknown: "Opener may have been sent",
  failed: "No opener (not on WhatsApp, or given up)",
  expired: "Opener not needed",
};

/** The Owner's note on a `sent` delivery whose WhatsApp file arrived wrong (last_error delivered_wrong_file). Staff sees the error code only. */
const WRONG_FILE_NOTE = "WhatsApp delivered a wrong file. Check that the buyer received the PDF by email, and send the file manually if needed.";

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
 * The delivery report (AC-A6): per-order WhatsApp and e-mail status, the sender number and the retries, the volume and failure
 * rate of every pool number (from the send ledger), and the failed deliveries with their resend (AC-A1: Staff manage resends). Staff
 * view it (reports.view); buyers appear in full (the Owner's decision of 2026-11-25) and an error is only ever shown as its code. The figures come
 * from lib/reports/delivery-source.ts (the one place that knows where deliveries are recorded).
 */
export default async function DeliveryPage({ searchParams }: { searchParams: Promise<Query> }) {
  const admin = await requireAdmin({ permission: "reports.view" });
  const canResend = can(admin.role, "delivery.resend");
  const canResendUnknown = can(admin.role, "delivery.resend_unknown");
  const canMarkHandled = can(admin.role, "delivery.wrong_file_handled");
  const { sql } = await getRuntime();
  const query = await searchParams;
  const { filters, error } = parseDeliveryFilters(query, new Date());
  const page = pageOf(query);
  const [numbers, channels, list, attention] = await Promise.all([perNumberStats(sql, filters), channelCounts(sql, filters), deliveryList(sql, filters, page), attentionList(sql)]);
  const keep: Record<string, string> = { from: filters.from, to: filters.to, channel: filters.channel ?? "", status: filters.status ?? "", number: filters.sessionId ?? "" };
  return (
    <>
      <PageHeading
        title="Delivery report"
        description="WhatsApp and e-mail deliveries of the orders created in the range (WIB): who got the ebook, from which number, after how many tries, how each sender number is doing, and the failed deliveries to resend."
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
          Every message a number sent in the range (openers, ebooks, replies and login codes; the send ledger keeps 31 days): a message WhatsApp refused for sure is a failed attempt. Volume = sent + failed +
          unknown; failure rate = failed / volume. Messages still in flight are in neither.
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

      <Card data-testid="delivery-attention">
        <CardTitle className="text-base">Needs attention</CardTitle>
        <CardDescription>
          {`${formatInt(attention.failed)} failed, ${formatInt(attention.unknown)} unknown and ${formatInt(attention.wrongFile)} wrong-file deliveries of paid orders (all dates; the newest ${formatInt(attention.rows.length)} are listed). A failed delivery had nothing delivered: Staff and the Owner can resend it. An unknown one may already have reached the buyer: only the Owner can resend it, after confirming that. A resent e-mail goes out within a minute; a resent WhatsApp ebook goes out when the buyer writes to one of the numbers. A wrong-file delivery is shown for information: it stays Sent and has no resend; the Owner can mark it handled to take it off this list.`}
        </CardDescription>
        {attention.rows.length === 0 ? (
          <EmptyState testId="attention-empty">Nothing needs attention.</EmptyState>
        ) : (
          <Table aria-label="Deliveries that need attention">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Created</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Buyer</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Error code</TableHead>
                {canResend ? <TableHead className="text-right">Resend</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {attention.rows.map((r) => (
                <TableRow key={r.id} data-testid="attention-row">
                  <TableCell className="tabular whitespace-nowrap">{formatWibTime(r.createdAt)}</TableCell>
                  <TableCell className="font-mono whitespace-nowrap">{r.orderCode}</TableCell>
                  <TableCell>
                    <BuyerContact name={r.buyerName} phone={r.buyerPhone} email={r.buyerEmail} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{CHANNEL_LABELS[r.channel] ?? r.channel}</TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="font-mono text-xs" data-testid="attention-error">
                    {r.errorCode ?? "-"}
                    {r.status === "sent" && canMarkHandled ? (
                      <>
                        <span className="mt-1 block max-w-64 font-sans text-xs text-muted-foreground" data-testid="attention-wrong-file-note">
                          {WRONG_FILE_NOTE}
                        </span>
                        <MarkHandledForm id={r.id} action={markWrongFileHandledAction} />
                      </>
                    ) : null}
                  </TableCell>
                  {canResend ? (
                    // Wide enough for the confirmation's two lines: a phone's table scrolls sideways instead of folding them word by word into a tall row.
                    <TableCell className="min-w-72 py-1.5">
                      {r.status === "failed" ? <ResendForm id={r.id} unknown={false} action={resendDeliveryAction} /> : null}
                      {r.status === "unknown" && canResendUnknown ? <ResendForm id={r.id} unknown action={resendUnknownDeliveryAction} /> : null}
                      {r.status === "unknown" && !canResendUnknown ? <span className="block text-right text-xs text-muted-foreground">The Owner decides</span> : null}
                    </TableCell>
                  ) : null}
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
        <CardDescription>Newest first. The order code is what the buyer sees.</CardDescription>
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
                  <TableCell className="font-mono whitespace-nowrap">{r.orderCode}</TableCell>
                  <TableCell>
                    <BuyerContact name={r.buyerName} phone={r.buyerPhone} email={r.buyerEmail} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{CHANNEL_LABELS[r.channel] ?? r.channel}</TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="font-mono whitespace-nowrap">{r.channel === "whatsapp" ? (r.sender ?? "-") : "-"}</TableCell>
                  <TableCell className="text-right font-mono tabular">
                    {r.attempts}
                    {r.channel === "whatsapp" && r.numbersTried > 1 ? <span className="block text-xs text-muted-foreground">{`${String(r.numbersTried)} numbers`}</span> : null}
                  </TableCell>
                  <TableCell className="max-w-64 text-xs text-muted-foreground">
                    {r.channel === "whatsapp" && r.opener !== null ? `${OPENER_LABELS[r.opener] ?? r.opener}. ` : ""}
                    {r.ack === null ? "" : `Ack ${r.ack}. `}
                    {r.errorCode === null ? "" : <span className="font-mono">{r.errorCode}</span>}
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
