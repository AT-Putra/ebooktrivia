"use server";
// Ad spend (AC-A8): Owner only (ad_spend.edit). Every create, change and delete is audited in the same transaction
// (lib/reports/ad-spend.ts); the ROI report reads the rows live.
import { wibDateOf } from "@ebooktrivia/core";
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { AD_SPEND_FORM_FIELDS, createAdSpend, deleteAdSpend, parseAdSpend, updateAdSpend } from "../../../../lib/reports/ad-spend.ts";
import { formValue, onlyFields, uuid } from "../../../../lib/settings/fields.ts";

const CREATE_FIELDS = AD_SPEND_FORM_FIELDS.filter((f) => f !== "id");

export const createAdSpendAction = adminAction({ permission: "ad_spend.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult("/reports/ad-spend", async () => {
    onlyFields(form, CREATE_FIELDS);
    await createAdSpend(rt.sql, parseAdSpend(form, wibDateOf(new Date())));
    return "Ad spend saved.";
  }),
);

export const updateAdSpendAction = adminAction({ permission: "ad_spend.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult("/reports/ad-spend", async () => {
    onlyFields(form, AD_SPEND_FORM_FIELDS);
    await updateAdSpend(rt.sql, uuid(formValue(form, "id")), parseAdSpend(form, wibDateOf(new Date())));
    return "Ad spend updated.";
  }),
);

export const deleteAdSpendAction = adminAction({ permission: "ad_spend.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult("/reports/ad-spend", async () => {
    onlyFields(form, ["id"]);
    await deleteAdSpend(rt.sql, uuid(formValue(form, "id")));
    return "Ad spend deleted.";
  }),
);
