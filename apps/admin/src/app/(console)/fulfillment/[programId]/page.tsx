import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DownloadSimpleIcon, PauseCircleIcon } from "@phosphor-icons/react/ssr";
import { isUuid } from "@ebooktrivia/core";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Button } from "@ebooktrivia/ui/components/button";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { CheckboxField, Notice, PageHeading, TextArea } from "../../../../components/settings/fields.tsx";
import { UploadFile } from "../../../../components/settings/upload-file.tsx";
import { formatRupiah } from "../../../../lib/format.ts";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { can } from "../../../../lib/policy.ts";
import { ADVANCE_LABEL, FULFILLMENT_STEPS, type FulfillmentWinner, getFulfillmentPage, HALTED, NOTES_MAX, STEP_LABEL } from "../../../../lib/settings/fulfillment.ts";
import { advanceFulfillmentAction, correctFulfillmentAction, reinstateWinnerAction, revokeWinnerAction, saveFulfillmentNotesAction } from "../actions.ts";

export const metadata: Metadata = { title: "Prize fulfilment | Admin Console" };

const WIB = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" });
const WINNER_LABEL: Readonly<Record<FulfillmentWinner["status"], string>> = {
  awaiting_confirmation: "Awaiting confirmation",
  confirmed: "Confirmed",
  flagged: "Flagged: halted",
  revoked: "Revoked",
};

/**
 * Owner only (US-030): the confirmed winners of a FINALIZED program by prize, each with its fulfilment (pending -> contacted ->
 * sent -> done, a reasoned correction one step back, done final), notes, the proof of delivery, and the revoke and re-award or
 * reinstatement of a flagged winner (a chargeback). Nothing shows before the Owner confirmed the winners (404). Times in WIB.
 */
export default async function FulfillmentPage({ params }: { params: Promise<{ programId: string }> }) {
  const admin = await requireAdmin({ permission: "prize_fulfillment.update" });
  const { programId } = await params;
  if (!isUuid(programId)) notFound();
  const { sql } = await getRuntime();
  const page = await getFulfillmentPage(sql, programId);
  if (page === null) notFound();
  const canReaward = can(admin.role, "winners.reaward");
  return (
    <>
      <p className="text-sm">
        <Link href="/fulfillment" className="underline underline-offset-4">
          Prize fulfilment
        </Link>
        {" / "}
        <Link href={`/settings/trivia/${page.programId}/results`} className="underline underline-offset-4">
          Contest results
        </Link>
      </p>
      <PageHeading
        title={`${page.name}: prize fulfilment`}
        description={`Winners confirmed ${WIB.format(page.winnersConfirmedAt)}. Contact each winner, then record each step as it happens: contacted, sent, done (delivered, final). A mistake can be moved back one step with a reason. Every change is audited.`}
      />
      {page.winners.length === 0 ? (
        <Card>
          <p className="text-sm">No player ranked inside a prize tier.</p>
        </Card>
      ) : null}
      {page.winners.map((w) => (
        <WinnerCard key={w.winnerId} winner={w} canReaward={canReaward} />
      ))}
    </>
  );
}

function WinnerCard({ winner: w, canReaward }: { winner: FulfillmentWinner; canReaward: boolean }) {
  const f = w.fulfillment;
  const step = f === null ? -1 : FULFILLMENT_STEPS.indexOf(f.status);
  const previous = step > 0 ? FULFILLMENT_STEPS[step - 1] : undefined;
  return (
    <Card data-testid={`fulfillment-rank-${String(w.rank)}`}>
      <div className="flex flex-wrap items-center gap-2">
        <CardTitle className="text-base">
          Rank {w.rank}: {w.prizeName}
        </CardTitle>
        <span className="text-sm text-muted-foreground">{formatRupiah(w.prizeValueIdr)}</span>
        <Badge variant={w.status === "confirmed" ? "success" : w.status === "flagged" ? "warning" : "secondary"}>{WINNER_LABEL[w.status]}</Badge>
        {f === null ? null : (
          <Badge variant={f.status === "done" ? "success" : "info"} data-testid="fulfillment-status">
            {STEP_LABEL[f.status]}
          </Badge>
        )}
      </div>
      {w.replacesRank === null ? null : <CardDescription>Re-awarded: the prize of the revoked winner ranked {w.replacesRank}.</CardDescription>}
      <dl className="grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4" data-testid="winner-contact">
        <dt className="text-muted-foreground">Winner</dt>
        <dd>{w.erased ? `Data deleted at the player's request (ref ${w.ref})` : `${w.name} (ref ${w.ref})`}</dd>
        {w.erased ? null : (
          <>
            <dt className="text-muted-foreground">WhatsApp</dt>
            <dd>{w.phone ?? "none"}</dd>
            <dt className="text-muted-foreground">E-mail</dt>
            <dd>{w.email ?? "none"}</dd>
          </>
        )}
        {f === null ? null : (
          <>
            <dt className="text-muted-foreground">Contacted</dt>
            <dd>{f.contactedAt === null ? "Not yet" : WIB.format(f.contactedAt)}</dd>
            <dt className="text-muted-foreground">Sent</dt>
            <dd>{f.sentAt === null ? "Not yet" : WIB.format(f.sentAt)}</dd>
            <dt className="text-muted-foreground">Done</dt>
            <dd>{f.doneAt === null ? "Not yet" : WIB.format(f.doneAt)}</dd>
          </>
        )}
      </dl>

      {w.status === "flagged" ? (
        <Notice tone="warning" testId="fulfillment-halted">
          <span className="flex items-center gap-2">
            <PauseCircleIcon aria-hidden="true" />
            {HALTED}
          </span>
        </Notice>
      ) : null}

      {f !== null && w.status === "confirmed" && f.status !== "done" ? (
        <div className="flex flex-col gap-3 border-t pt-3">
          <ActionForm action={advanceFulfillmentAction} submitLabel={ADVANCE_LABEL[f.status]} testId="fulfillment-advance">
            <input type="hidden" name="fulfillmentId" value={f.id} />
            <input type="hidden" name="from" value={f.status} />
          </ActionForm>
          {previous === undefined ? null : (
            <ActionForm action={correctFulfillmentAction} submitLabel={`Move back to ${STEP_LABEL[previous].toLowerCase()}`} variant="outline" testId="fulfillment-correct">
              <input type="hidden" name="fulfillmentId" value={f.id} />
              <input type="hidden" name="from" value={f.status} />
              <TextArea id={`correct-${f.id}`} name="reason" label="Reason for the correction" rows={2} minLength={10} maxLength={500} required hint="10 to 500 characters, with no names, phone numbers or e-mail addresses." />
            </ActionForm>
          )}
        </div>
      ) : null}

      {f === null ? null : (
        <div className="flex flex-col gap-3 border-t pt-3">
          <ActionForm action={saveFulfillmentNotesAction} submitLabel="Save notes" variant="secondary" testId="fulfillment-notes">
            <input type="hidden" name="fulfillmentId" value={f.id} />
            <TextArea
              id={`notes-${f.id}`}
              name="notes"
              label="Notes"
              rows={3}
              maxLength={NOTES_MAX}
              defaultValue={f.notes}
              hint={`Plain text, up to ${String(NOTES_MAX)} characters (e.g. the courier and tracking number). Empty clears them.`}
            />
          </ActionForm>
          <div className="flex flex-col gap-2" data-testid="fulfillment-proof">
            <p className="text-sm font-medium">Proof of delivery</p>
            {f.proof === null ? (
              <p className="text-sm text-muted-foreground">No proof yet.</p>
            ) : (
              <form method="post" action={`/fulfillment/proof?fulfillment=${f.id}`} className="flex flex-wrap items-center gap-3">
                <span className="text-sm">
                  {f.proof.contentType === "application/pdf" ? "PDF" : "Image"}, {Math.max(1, Math.round(f.proof.sizeBytes / 1024))} KB, uploaded {WIB.format(f.proof.createdAt)}
                </span>
                <Button type="submit" size="sm" variant="outline" data-testid="proof-download">
                  <DownloadSimpleIcon aria-hidden="true" />
                  Download
                </Button>
              </form>
            )}
            {w.status === "confirmed" ? (
              <UploadFile
                id={`proof-${f.id}`}
                url={`/uploads/proof?fulfillment=${f.id}`}
                label={f.proof === null ? "Upload a proof (photo or PDF, up to 4 MB)" : "Replace the proof (the old one is deleted)"}
                accept="image/jpeg,image/png,image/webp,application/pdf"
                mode="proof"
                testId="proof-upload"
              />
            ) : null}
          </div>
        </div>
      )}

      {canReaward && (w.status === "flagged" || (w.status === "confirmed" && f?.status !== "done")) ? (
        <div className="flex flex-col gap-3 border-t pt-3">
          {w.status === "flagged" ? (
            <ActionForm action={reinstateWinnerAction} submitLabel="Reinstate this winner" variant="secondary" testId="winner-reinstate">
              <input type="hidden" name="winnerId" value={w.winnerId} />
              <TextArea id={`reinstate-${w.winnerId}`} name="reason" label="Why the winner keeps the prize" rows={2} minLength={10} maxLength={500} required hint="For example: the chargeback was withdrawn. No names or contact details. The winner must still have a paid order." />
            </ActionForm>
          ) : null}
          <ActionForm action={revokeWinnerAction} submitLabel="Revoke and re-award" variant="destructive" testId="winner-revoke">
            <input type="hidden" name="winnerId" value={w.winnerId} />
            <TextArea id={`revoke-${w.winnerId}`} name="reason" label="Reason" rows={2} minLength={10} maxLength={500} required hint="10 to 500 characters, with no names, phone numbers or e-mail addresses." />
            <CheckboxField
              id={`revoke-confirm-${w.winnerId}`}
              name="confirm"
              label="Revoke this winner. The prize goes to the next eligible player of the results snapshot."
              hint="This cannot be undone. A delivered prize (done) is never revoked."
            />
          </ActionForm>
        </div>
      ) : null}
      {w.status === "revoked" ? <p className="text-xs text-muted-foreground">Revoked: kept as the record of what happened.</p> : null}
    </Card>
  );
}
