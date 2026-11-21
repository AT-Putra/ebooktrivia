// The resend button of one failed delivery (AC-A1). A failed delivery is resent as it is (Staff and Owner). An unknown one, a send that may already have reached
// the buyer, is the Owner's alone and only with the explicit confirmation. The server actions refuse everyone else; the page only renders what the role may do.
import { CheckboxField } from "../settings/fields.tsx";
import { ActionForm } from "../settings/action-form.tsx";
import type { SaveState } from "../../lib/form-state.ts";

export function ResendForm({ id, unknown, action }: { id: string; unknown: boolean; action: (previous: SaveState, form: FormData) => Promise<SaveState> }) {
  return (
    <ActionForm action={action} submitLabel="Resend" variant="outline" testId={`resend-${id}`} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      {unknown ? <CheckboxField id={`resend-confirm-${id}`} name="confirm_unknown" label="The buyer may already have it" hint="Only then: it sends the ebook a second time." /> : null}
    </ActionForm>
  );
}
