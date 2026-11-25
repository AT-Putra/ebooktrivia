import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { WarningIcon } from "@phosphor-icons/react/ssr";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { EmptyState } from "../../../../components/reports/report-ui.tsx";
import { DecisionForm, RequeryForm } from "../../../../components/review/review-forms.tsx";
import { Notice, PageHeading } from "../../../../components/settings/fields.tsx";
import { formatInt, formatRupiah, formatWibTime } from "../../../../lib/format.ts";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { DECISION_STATUS } from "@ebooktrivia/core";
import { decisionMessage, loadRecentDecisions, loadReviewQueue, type ReviewOrder } from "../../../../lib/review/review.ts";
import { decideReviewAction, requeryReviewAction } from "./actions.ts";

export const metadata: Metadata = { title: "Review queue | Admin Console" };
export const dynamic = "force-dynamic";

const SOURCE_LABELS: Readonly<Record<string, string>> = { notification: "a Midtrans notification", reconciliation: "the nightly reconciliation", owner_requery: "your re-query" };
const ELIGIBILITY: Readonly<Record<ReviewOrder["eligibility"]["state"], string>> = {
  no_player: "Not a player yet (never paid)",
  suspended: "Suspended until you decide (no other paid order)",
  eligible: "Eligible through another paid order",
};
const hours = (since: Date, now: Date): string => {
  const h = Math.floor((now.getTime() - since.getTime()) / 3_600_000);
  return h < 1 ? "less than an hour" : `${String(h)} h`;
};
const gateway = (status: string | null, fraud: string | null): string => (status === null ? "not re-queried yet" : fraud === null ? status : `${status} (fraud ${fraud})`);

function History({ order }: { order: ReviewOrder }) {
  if (order.history.length === 0) return null;
  return (
    <details>
      <summary className="cursor-pointer text-sm font-medium">Status history ({formatInt(order.history.length)})</summary>
      <ol className="mt-1 flex flex-col gap-0.5 text-xs">
        {order.history.map((h, i) => (
          <li key={`${h.at.toISOString()}-${String(i)}`} className="tabular">
            {formatWibTime(h.at)}:{" "}
            {h.action === "order.review.requery"
              ? "you asked for a re-query"
              : h.action === "order.review.decide"
                ? `your decision: ${h.event === "paid" ? "mark paid" : "not paid"} (${h.from ?? "?"} to ${h.to ?? "?"})`
                : `${h.from ?? "?"} to ${h.to ?? "?"} on ${h.event ?? "?"}${h.attempt === null ? "" : `, attempt ${String(h.attempt)}`}${h.source === null ? "" : `, by ${SOURCE_LABELS[h.source] ?? h.source}`}`}
          </li>
        ))}
      </ol>
    </details>
  );
}

function OrderCard({ order, now }: { order: ReviewOrder; now: Date }) {
  return (
    <Card data-testid={`review-${order.publicId}`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle className="font-mono text-base">{order.publicId}</CardTitle>
        <span className="text-sm">
          <span className="tabular font-semibold">{formatRupiah(order.amountIdr)}</span> · {order.product} · {order.program}
        </span>
      </div>
      <CardDescription>
        Ordered {formatWibTime(order.createdAt)}; in review since {formatWibTime(order.reviewSince)} ({hours(order.reviewSince, now)}).
      </CardDescription>
      <section aria-label="Why it is in review" className="flex flex-col gap-1 text-sm">
        <p data-testid="review-reason">
          <span className="font-medium">Why: </span>
          {order.reason === null
            ? "not recorded"
            : `${order.reason.label}${order.reason.attempt === null ? "" : `, attempt ${String(order.reason.attempt)}`}${order.reason.source === null ? "" : `, found by ${SOURCE_LABELS[order.reason.source] ?? order.reason.source}`}.`}
        </p>
        {order.alerts.length === 0 ? null : (
          <ul className="flex flex-wrap gap-1.5" aria-label="Open alerts">
            {order.alerts.map((a) => (
              <li key={`${a.kind}-${a.createdAt.toISOString()}`}>
                <Badge variant={a.severity === "critical" ? "destructive" : "warning"}>
                  <WarningIcon aria-hidden="true" weight="fill" />
                  {a.label}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {order.findings.length === 0 ? null : (
          <p className="text-xs text-muted-foreground">Reconciliation: {order.findings.map((f) => `${f.kind.replaceAll("_", " ")} (${f.runDate})`).join(", ")}</p>
        )}
      </section>
      <div className="grid gap-3 md:grid-cols-2">
        <section aria-label="Buyer" className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Buyer</h2>
          {order.erased ? (
            <p className="text-sm" data-testid="buyer-erased">
              Erased on request (UU PDP): no contact is kept, and nothing can be delivered.
            </p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm" data-testid={`buyer-${order.id}`}>
              <dt className="text-muted-foreground">Name</dt>
              <dd className="[overflow-wrap:anywhere]" data-testid="buyer-name">
                {order.buyer.name}
              </dd>
              <dt className="text-muted-foreground">WhatsApp</dt>
              <dd className="font-mono tabular" data-testid="buyer-phone">
                {order.buyer.phone}
              </dd>
              <dt className="text-muted-foreground">E-mail</dt>
              <dd className="break-all" data-testid="buyer-email">
                {order.buyer.email}
              </dd>
            </dl>
          )}
          <p className="text-xs" data-testid="eligibility">
            Player: {ELIGIBILITY[order.eligibility.state]}
            {order.eligibility.firstPaidAt === null ? "" : `; first paid ${formatWibTime(order.eligibility.firstPaidAt)}`}
          </p>
        </section>
        <section aria-label="Midtrans" className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Midtrans attempts</h2>
          <Table aria-label={`Midtrans attempts of ${order.publicId}`}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>#</TableHead>
                <TableHead>Latest re-queried status</TableHead>
                <TableHead>Checked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.attempts.map((a) => (
                <TableRow key={a.n} data-testid="attempt-row">
                  <TableCell className="tabular">{a.n}</TableCell>
                  <TableCell>{gateway(a.gatewayStatus, a.gatewayFraudStatus)}</TableCell>
                  <TableCell className="tabular text-xs">{a.gatewayCheckedAt === null ? "-" : formatWibTime(a.gatewayCheckedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {order.payments.length === 0 ? null : (
            <p className="text-xs text-muted-foreground">
              Ledger:{" "}
              {order.payments
                .map((p) => `${p.n === null ? "" : `#${String(p.n)} `}${p.transactionStatus}${p.paymentType === null ? "" : ` ${p.paymentType}`} ${formatRupiah(p.grossIdr)}${p.settledAt === null ? "" : `, held money since ${formatWibTime(p.settledAt)}`}`)
                .join("; ")}
            </p>
          )}
          <RequeryForm id={order.id} requestKey={randomUUID()} action={requeryReviewAction} />
          {order.requery === null ? null : (
            <p className="text-xs text-muted-foreground" data-testid="requery-state">
              {order.requery.pending ? "A re-query is running" : "Last re-query asked"} {formatWibTime(order.requery.requestedAt)}.
            </p>
          )}
        </section>
      </div>
      <History order={order} />
      <section aria-label="Decide" className="grid gap-4 border-t pt-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">{order.erased ? "Keep the money, no fulfilment" : "Mark paid"}</h2>
          <p className="text-xs text-muted-foreground">
            {order.erased
              ? "The money is ours, but the buyer was erased: the order is PAID and nothing is delivered, reported or made eligible."
              : "The money is ours: the order is PAID, the deliveries and conversions held back go out, the buyer may play."}
          </p>
          <DecisionForm id={order.id} publicId={order.publicId} decision="paid" requestKey={randomUUID()} action={decideReviewAction} erased={order.erased} />
        </div>
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Not paid</h2>
          <p className="text-xs text-muted-foreground">
            The money is not ours: the order closes as failed, conversions that may have counted get their reversal, the buyer loses eligibility unless
            another paid order stands. A later real settlement on Midtrans still makes it PAID.
          </p>
          <DecisionForm id={order.id} publicId={order.publicId} decision="not_paid" requestKey={randomUUID()} action={decideReviewAction} />
        </div>
      </section>
    </Card>
  );
}

/**
 * The Owner's review queue (US-033): every order in review with why it is there, what Midtrans says about each attempt, the buyer
 * (in full) and the player's eligibility, and the two decisions. Owner only
 * (order.review.resolve): Staff get 403 here and on every action.
 */
export default async function ReviewQueuePage() {
  await requireAdmin({ permission: "order.review.resolve" });
  const { sql } = await getRuntime();
  const now = new Date();
  const [{ total, orders }, recent] = await Promise.all([loadReviewQueue(sql), loadRecentDecisions(sql)]);
  return (
    <>
      <PageHeading
        title="Review queue"
        description="Orders the payment code could not settle on its own (a payment Midtrans reversed, a fraud challenge, a partial refund or chargeback, a reconciliation mismatch). Decide each one: mark paid or not paid."
      />
      {/* One line when nothing waits (the empty state), never a sentence and an empty box saying the same twice. */}
      {total === 0 || orders.length === 0 ? (
        <EmptyState testId="review-total">No order is waiting for you.</EmptyState>
      ) : (
        <p className="text-sm" data-testid="review-total">{`${formatInt(total)} order${total === 1 ? "" : "s"} in review, the oldest first.`}</p>
      )}
      {total > orders.length && orders.length > 0 ? <Notice tone="info">The oldest {formatInt(orders.length)} are shown; decide them to see the rest.</Notice> : null}
      {orders.map((order) => (
        <OrderCard key={order.id} order={order} now={now} />
      ))}
      {recent.length === 0 ? null : (
        <Card data-testid="recent-decisions" className="flex flex-col gap-2">
          <CardTitle className="text-base">Decided in the last 24 hours</CardTitle>
          <ul className="flex flex-col gap-1.5 text-sm">
            {recent.map((d) => (
              <li key={`${d.orderId}-${d.decidedAt.toISOString()}`} data-testid={`decided-${d.publicId}`}>
                <span className="font-mono">{d.publicId}</span>, {formatWibTime(d.decidedAt)}: {decisionMessage(d.result)}
                {d.status === DECISION_STATUS[d.result.decision] ? null : <span className="font-medium"> Now {d.status}: a Midtrans event changed it since.</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
