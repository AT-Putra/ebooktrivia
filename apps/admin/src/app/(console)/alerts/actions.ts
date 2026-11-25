"use server";
// Owner only (alerts.resolve): marks a group of open alerts (one kind at one severity) resolved, up to the newest one the page showed; audited
// (lib/alerts/open-alerts.ts).
import { RESOLVE_ALERT_FIELDS, parseResolveRequest, resolveAlertGroup } from "../../../lib/alerts/open-alerts.ts";
import type { SaveState } from "../../../lib/form-state.ts";
import { adminAction } from "../../../lib/next/actions.ts";
import { saveResult } from "../../../lib/next/settings-result.ts";
import { onlyFields } from "../../../lib/settings/fields.ts";

export const resolveAlertsAction = adminAction({ permission: "alerts.resolve" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult("/alerts", async () => {
    onlyFields(form, RESOLVE_ALERT_FIELDS);
    const resolved = await resolveAlertGroup(rt.sql, parseResolveRequest(form));
    return `${String(resolved)} ${resolved === 1 ? "alert" : "alerts"} marked as resolved.`;
  }),
);
