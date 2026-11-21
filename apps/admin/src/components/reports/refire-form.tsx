// The Owner's re-fire button of one postback row. A failed row is re-fired as it is; a sent one only when the Owner confirms that the
// adnet never received what it acknowledged. The server action refuses everyone but the Owner (conversion.refire); the page only
// renders this for the Owner.
import { CheckboxField } from "../settings/fields.tsx";
import { ActionForm } from "../settings/action-form.tsx";
import type { SaveState } from "../../lib/form-state.ts";

export function RefireForm({ id, sent, action }: { id: string; sent: boolean; action: (previous: SaveState, form: FormData) => Promise<SaveState> }) {
  return (
    <ActionForm action={action} submitLabel={sent ? "Resend" : "Re-fire"} variant="outline" testId={`refire-${id}`} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      {sent ? <CheckboxField id={`resend-${id}`} name="resend_sent" label="The adnet did not receive it" hint="Only then: it sends the conversion a second time." /> : null}
    </ActionForm>
  );
}
