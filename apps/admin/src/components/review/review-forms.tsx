"use client";

// The Owner's controls on one order of the review queue (US-033). The server actions refuse everyone but the Owner
// (order.review.resolve); the page renders this for the Owner only.
//   RequeryForm     "Re-query Midtrans now" (the worker runs the normal payment path; reload to see the answer);
//   DecisionForm    "Mark paid" or "Not paid": the order's id typed to confirm and a reason, each form with its own request key, so a
//                   double click or a re-posted form is the same request (the database answers it again and changes nothing).
import type { SaveState } from "../../lib/form-state.ts";
import { ActionForm } from "../settings/action-form.tsx";
import { TextArea, TextField } from "../settings/fields.tsx";

export function RequeryForm({ id, requestKey, action }: { id: string; requestKey: string; action: (previous: SaveState, form: FormData) => Promise<SaveState> }) {
  return (
    <ActionForm action={action} submitLabel="Re-query Midtrans now" variant="outline" testId={`requery-${id}`} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="key" value={requestKey} />
    </ActionForm>
  );
}

export function DecisionForm({
  id,
  publicId,
  decision,
  requestKey,
  action,
  erased = false,
}: {
  id: string;
  publicId: string;
  decision: "paid" | "not_paid";
  requestKey: string;
  /** US-030: the buyer was erased: "mark paid" keeps the money and fulfils nothing. */
  erased?: boolean;
  action: (previous: SaveState, form: FormData) => Promise<SaveState>;
}) {
  const paid = decision === "paid";
  const prefix = `${paid ? "paid" : "notpaid"}-${id}`;
  return (
    <ActionForm action={action} submitLabel={paid ? (erased ? "Keep the money, no fulfilment" : "Mark paid") : "Mark not paid"} variant={paid ? "cta" : "destructive"} testId={`decide-${prefix}`} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="decision" value={decision} />
      <input type="hidden" name="key" value={requestKey} />
      <TextField id={`${prefix}-confirm`} name="confirm" label={`Type the order id ${publicId} to confirm`} maxLength={64} required autoComplete="off" verbatim />
      <TextArea
        id={`${prefix}-reason`}
        name="reason"
        label="Reason (kept in the audit log)"
        rows={2}
        minLength={10}
        maxLength={500}
        required
        hint="10 to 500 characters, no e-mail addresses or phone numbers."
      />
    </ActionForm>
  );
}
