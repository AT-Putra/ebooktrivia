// The "Mark handled" button of one `sent` delivery whose WhatsApp file arrived wrong (US-005 R11): the Owner's alone. It takes the delivery off the "Needs attention" list
// and changes nothing about it (a `sent` delivery stays final: there is no resend); the server action refuses everyone else, the page only renders what the role may do.
import { ActionForm } from "../settings/action-form.tsx";
import type { SaveState } from "../../lib/form-state.ts";

export function MarkHandledForm({ id, action }: { id: string; action: (previous: SaveState, form: FormData) => Promise<SaveState> }) {
  return (
    <ActionForm action={action} submitLabel="Mark handled" variant="outline" testId={`handled-${id}`} className="mt-2 flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
    </ActionForm>
  );
}
