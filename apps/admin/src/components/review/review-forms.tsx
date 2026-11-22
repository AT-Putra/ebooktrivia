"use client";

// The Owner's controls on one order of the review queue (US-033). The server actions refuse everyone but the Owner
// (order.review.resolve); the page renders this for the Owner only.
//   RevealBuyer     the buyer is shown masked; "Show buyer details" asks the server (an audited POST) for the full name, phone
//                   and e-mail and shows them in place, for this view only;
//   RequeryForm     "Re-query Midtrans now" (the worker runs the normal payment path; reload to see the answer);
//   DecisionForm    "Mark paid" or "Not paid": the order's id typed to confirm and a reason, each form with its own request key, so a
//                   double click or a re-posted form is the same request (the database answers it again and changes nothing).
import { type SubmitEvent as ReactSubmitEvent, startTransition, useActionState } from "react";
import { Button } from "@ebooktrivia/ui/components/button";
import { INITIAL_REVEAL, type RevealState, type SaveState } from "../../lib/form-state.ts";
import { FormError } from "../auth/auth-card.tsx";
import { ActionForm } from "../settings/action-form.tsx";
import { TextArea, TextField } from "../settings/fields.tsx";

export function RevealBuyer({
  id,
  masked,
  action,
}: {
  id: string;
  masked: { readonly name: string; readonly phone: string; readonly email: string };
  action: (previous: RevealState, form: FormData) => Promise<RevealState>;
}) {
  const [state, dispatch, pending] = useActionState(action, INITIAL_REVEAL);
  const onSubmit = (event: ReactSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => {
      dispatch(data);
    });
  };
  const shown = state.status === "shown" ? state : null;
  return (
    <div className="flex flex-col gap-1.5" data-testid={`buyer-${id}`}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
        <dt className="text-muted-foreground">Name</dt>
        <dd data-testid="buyer-name">{shown?.name ?? masked.name}</dd>
        <dt className="text-muted-foreground">WhatsApp</dt>
        <dd className="tabular" data-testid="buyer-phone">
          {shown?.phone ?? masked.phone}
        </dd>
        <dt className="text-muted-foreground">E-mail</dt>
        <dd className="break-all" data-testid="buyer-email">
          {shown?.email ?? masked.email}
        </dd>
      </dl>
      {shown === null ? (
        <form onSubmit={onSubmit}>
          <input type="hidden" name="id" value={id} />
          <Button type="submit" variant="ghost" size="sm" disabled={pending} data-testid={`reveal-${id}`}>
            Show buyer details
          </Button>
          <span className="text-xs text-muted-foreground"> (recorded in the audit log)</span>
        </form>
      ) : null}
      {state.status === "error" ? <FormError key={state.at}>{state.error}</FormError> : null}
    </div>
  );
}

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
