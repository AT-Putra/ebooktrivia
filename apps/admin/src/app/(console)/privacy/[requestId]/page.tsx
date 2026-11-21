import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isUuid } from "@ebooktrivia/core";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { Notice, PageHeading, TextArea, TextField } from "../../../../components/settings/fields.tsx";
import { formatRupiah } from "../../../../lib/format.ts";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { getDeletionReview, LOOKUP_LABEL } from "../../../../lib/settings/privacy.ts";
import { executeDeletionRequestAction, rejectDeletionRequestAction } from "../actions.ts";

export const metadata: Metadata = { title: "Deletion request | Admin Console" };

const WIB = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" });
const KIND: Readonly<Record<string, string>> = { terms: "Terms (S&K)", privacy: "Privacy policy" };

/**
 * Owner only (US-030): one deletion request. While pending: the matched person (masked), every order with the consents recorded
 * at checkout, their prizes, what blocks the erasure, and the two decisions (execute with the typed reference, or reject with a
 * reason). Once decided: the record of what was done (counts only).
 */
export default async function DeletionRequestPage({ params }: { params: Promise<{ requestId: string }> }) {
  await requireAdmin({ permission: "deletion_request.process" });
  const { requestId } = await params;
  if (!isUuid(requestId)) notFound();
  const { sql } = await getRuntime();
  const review = await getDeletionReview(sql, requestId);
  if (review === null) notFound();
  const s = review.subject;
  return (
    <>
      <p className="text-sm">
        <Link href="/privacy" className="underline underline-offset-4">
          Data deletion
        </Link>
      </p>
      <PageHeading
        title={`Deletion request ${review.ref}`}
        description={`Recorded ${WIB.format(review.requestedAt)}${review.lookupKind === null ? "" : `, identified by ${LOOKUP_LABEL[review.lookupKind].toLowerCase()}`}.`}
      />
      <Card data-testid="deletion-request">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Request</CardTitle>
          <Badge variant={review.status === "pending" ? "warning" : review.status === "completed" ? "success" : "secondary"} data-testid="deletion-status">
            {review.status === "pending" ? "Pending" : review.status === "completed" ? "Erased" : "Rejected"}
          </Badge>
        </div>
        <p className="text-sm whitespace-pre-wrap">{review.note ?? ""}</p>
        {review.decidedAt === null ? null : <p className="text-sm text-muted-foreground">Decided {WIB.format(review.decidedAt)}.</p>}
        {review.decisionNote === null ? null : <p className="text-sm whitespace-pre-wrap">Rejected: {review.decisionNote}</p>}
        {review.status === "completed" ? (
          <dl className="grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4" data-testid="deletion-summary">
            {Object.entries(review.summary).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{key.replaceAll("_", " ")}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </Card>

      {s === null ? null : (
        <>
          <Card data-testid="deletion-subject">
            <CardTitle className="text-base">Who would be erased</CardTitle>
            <dl className="grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{s.maskedName ?? "unknown"}</dd>
              <dt className="text-muted-foreground">WhatsApp</dt>
              <dd>{s.maskedPhone ?? "none"}</dd>
              <dt className="text-muted-foreground">E-mail</dt>
              <dd>{s.maskedEmail ?? "none"}</dd>
              <dt className="text-muted-foreground">Player</dt>
              <dd>{s.playerRef === null ? "Never played (no paid order)" : `ref ${s.playerRef}`}</dd>
            </dl>
            {s.prizes.length === 0 ? null : (
              <ul className="text-sm" data-testid="deletion-prizes">
                {s.prizes.map((p) => (
                  <li key={`${p.program}-${String(p.rank)}`}>
                    Prize: {p.program}, rank {p.rank}, {p.status}
                    {p.fulfillment === null ? "" : `, fulfilment ${p.fulfillment}`}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card data-testid="deletion-orders">
            <CardTitle className="text-base">Orders and consents</CardTitle>
            <CardDescription>The orders stay as anonymous records (amount, status, dates, attribution); the consents keep the legal page version and time, without the device.</CardDescription>
            {s.orders.length === 0 ? (
              <p className="text-sm">No order.</p>
            ) : (
              <Table aria-label="Orders">
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Program</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Consents</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.orders.map((o) => (
                    <TableRow key={o.publicId}>
                      <TableCell className="font-mono text-xs">{o.publicId}</TableCell>
                      <TableCell>{o.program}</TableCell>
                      <TableCell>{o.status}</TableCell>
                      <TableCell>{formatRupiah(o.amountIdr)}</TableCell>
                      <TableCell className="text-xs" data-testid="order-consents">
                        {o.consents.length === 0
                          ? "None recorded"
                          : o.consents.map((c) => (
                              <span key={`${c.kind}-${String(c.version)}`} className="block">
                                {KIND[c.kind] ?? c.kind} v{c.version}, {WIB.format(c.consentedAt)}
                                {c.ip === null ? "" : `, IP ${c.ip}`}
                                {c.uaRecorded ? ", browser recorded" : ""}
                              </span>
                            ))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
          <Card data-testid="deletion-decide">
            <CardTitle className="text-base">Decide</CardTitle>
            {s.blockers.length === 0 ? null : (
              <Notice tone="warning" testId="deletion-blocked">
                {s.blockers.join(" ")}
              </Notice>
            )}
            <ActionForm action={executeDeletionRequestAction} submitLabel="Erase this person's data" variant="destructive" testId="deletion-execute" className="flex flex-col gap-3">
              <input type="hidden" name="requestId" value={review.id} />
              <TextField
                id="deletion-confirmation"
                name="confirmation"
                label={`Type the reference ${review.ref} to confirm`}
                maxLength={8}
                hint="This cannot be undone: the person can no longer log in, and their name, contact details and devices are removed everywhere."
              />
            </ActionForm>
            <ActionForm action={rejectDeletionRequestAction} submitLabel="Reject the request" variant="outline" testId="deletion-reject" className="flex flex-col gap-3 border-t pt-3">
              <input type="hidden" name="requestId" value={review.id} />
              <TextArea id="deletion-reject-reason" name="reason" label="Why the request is rejected" rows={2} minLength={10} maxLength={500} required hint="For example: the requester could not prove it is their number. No names, phone numbers or e-mail addresses." />
            </ActionForm>
          </Card>
        </>
      )}
    </>
  );
}
