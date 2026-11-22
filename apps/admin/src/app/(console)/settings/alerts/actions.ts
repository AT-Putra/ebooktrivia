"use server";
// Owner only (alert_recipients.edit): where the worker's alert relay sends the Owner's alerts (US-015), audited; and the
// "send a test alert" button.
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { ALERT_RECIPIENT_FIELDS, parseAlertRecipients, saveAlertRecipients, sendTestAlert } from "../../../../lib/settings/alert-recipients.ts";
import { onlyFields } from "../../../../lib/settings/fields.ts";

const PATH = "/settings/alerts";

export const saveAlertRecipientsAction = adminAction({ permission: "alert_recipients.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    onlyFields(form, ALERT_RECIPIENT_FIELDS);
    await saveAlertRecipients(rt.sql, admin.userId, parseAlertRecipients(form));
    return "Alert recipients saved.";
  }),
);

export const sendTestAlertAction = adminAction({ permission: "alert_recipients.edit" }, async ({ rt, admin }): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await sendTestAlert(rt.sql, admin.userId);
    return "Test alert written: the relay sends it within a minute, whatever the lowest severity is.";
  }),
);
