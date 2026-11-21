"use server";
// The resend of a delivery (AC-A1: Staff may manage resends). Two actions, because the permission differs (lib/policy.ts):
//   resendDeliveryAction         delivery.resend           Staff and Owner: a FAILED delivery (nothing reached the buyer for sure). It never confirms
//                                                          anything: the database refuses an unknown delivery without the confirmation (ET132), so a
//                                                          forged form from a Staff session cannot resend one.
//   resendUnknownDeliveryAction  delivery.resend_unknown   Owner only: an UNKNOWN delivery (a send that may have gone out), only with the explicit
//                                                          confirmation ticked.
//   markWrongFileHandledAction   delivery.wrong_file_handled   Owner only: a `sent` delivery whose WhatsApp file arrived wrong (US-005 R11) leaves "Needs attention".
//                                                          Display only, audited: it changes nothing about the delivery (no resend: `sent` stays final).
// The database function public.resend_delivery decides what may be resent and the audit entry is written in the same transaction (lib/settings/deliveries.ts).
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { markWrongFileHandled, resendDelivery } from "../../../../lib/settings/deliveries.ts";
import { checkbox, formValue, onlyFields, uuid } from "../../../../lib/settings/fields.ts";

const QUEUED = "Resent: an e-mail goes out within a minute; a WhatsApp ebook goes out when the buyer writes to one of the numbers (or taps the button on the order page).";

export const resendDeliveryAction = adminAction({ permission: "delivery.resend" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult("/reports/delivery", async () => {
    onlyFields(form, ["id"]);
    await resendDelivery(rt.sql, uuid(formValue(form, "id")));
    return QUEUED;
  }),
);

export const markWrongFileHandledAction = adminAction({ permission: "delivery.wrong_file_handled" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult("/reports/delivery", async () => {
    onlyFields(form, ["id"]);
    await markWrongFileHandled(rt.sql, uuid(formValue(form, "id")));
    return "Marked as handled: it is off the Needs attention list.";
  }),
);

export const resendUnknownDeliveryAction = adminAction({ permission: "delivery.resend_unknown" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult("/reports/delivery", async () => {
    onlyFields(form, ["id", "confirm_unknown"]);
    await resendDelivery(rt.sql, uuid(formValue(form, "id")), { confirmUnknown: checkbox(form, "confirm_unknown") });
    return QUEUED;
  }),
);
