"use server";
// Owner only (app_settings.edit, owner decision 2026-11-18): OTP and rate-limit parameters, bounded
// in lib/settings/limits.ts, audited per key.
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { onlyFields } from "../../../../lib/settings/fields.ts";
import { LIMIT_FIELDS, parseLimits, saveLimits } from "../../../../lib/settings/limits.ts";

export const saveLimitsAction = adminAction({ permission: "app_settings.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult("/settings/limits", async () => {
    onlyFields(form, LIMIT_FIELDS);
    const changed = await saveLimits(rt.sql, admin.userId, parseLimits(form));
    return `${String(changed)} limit${changed === 1 ? "" : "s"} saved.`;
  }),
);
