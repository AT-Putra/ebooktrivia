"use server";
// The Owner's manual re-fire of a conversion (AC-T3, AC-A7): conversion.refire is Owner-only. The database function
// public.refire_conversion decides what may be re-fired (a failed row; a sent one only when `resend_sent` is confirmed; never the
// MT of an unpaid order) and the audit entry is written in the same transaction (lib/settings/conversions.ts).
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { refireConversion } from "../../../../lib/settings/conversions.ts";
import { checkbox, formValue, onlyFields, uuid } from "../../../../lib/settings/fields.ts";

export const refireConversionAction = adminAction({ permission: "conversion.refire" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult("/reports/postbacks", async () => {
    onlyFields(form, ["id", "resend_sent"]);
    await refireConversion(rt.sql, uuid(formValue(form, "id")), { resendSent: checkbox(form, "resend_sent") });
    return "Queued: the worker sends it again within a minute.";
  }),
);
