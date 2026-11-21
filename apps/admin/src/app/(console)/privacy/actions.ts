"use server";
// UU PDP deletion requests (US-030), Owner-only (deletion_request.process): record, execute (the typed reference confirms it),
// reject. lib/settings/privacy.ts; the erasure itself is the database's (sql/privacy.sql). Every form field is known.
import { redirect } from "next/navigation";
import type { SaveState } from "../../../lib/form-state.ts";
import { adminAction } from "../../../lib/next/actions.ts";
import { saveResult } from "../../../lib/next/settings-result.ts";
import { formValue, onlyFields, uuid } from "../../../lib/settings/fields.ts";
import {
  createDeletionRequest,
  executeDeletionRequest,
  parseConfirmation,
  parseDeletionRequest,
  parseRejection,
  rejectDeletionRequest,
} from "../../../lib/settings/privacy.ts";

const PATH = "/privacy";

/** Records a request and opens its review page. */
export const createDeletionRequestAction = adminAction({ permission: "deletion_request.process" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> => {
  const created: { id?: string } = {};
  const state = await saveResult(PATH, async () => {
    onlyFields(form, ["kind", "value", "reason"]);
    created.id = await createDeletionRequest(rt.sql, parseDeletionRequest(form));
    return "Request recorded.";
  });
  if (state.status === "saved" && created.id !== undefined) redirect(`${PATH}/${created.id}`);
  return state;
});

export const executeDeletionRequestAction = adminAction({ permission: "deletion_request.process" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["requestId", "confirmation"]);
      const { erased, orders } = await executeDeletionRequest(rt.sql, rt.settings, uuid(formValue(form, "requestId")), parseConfirmation(form));
      return erased ? `Erased: the person's data is anonymized (${String(orders)} order${orders === 1 ? "" : "s"} kept as anonymous records).` : "This request was already completed.";
    },
    "layout",
  ),
);

export const rejectDeletionRequestAction = adminAction({ permission: "deletion_request.process" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(
    PATH,
    async () => {
      onlyFields(form, ["requestId", "reason"]);
      await rejectDeletionRequest(rt.sql, uuid(formValue(form, "requestId")), parseRejection(form));
      return "Request rejected.";
    },
    "layout",
  ),
);
