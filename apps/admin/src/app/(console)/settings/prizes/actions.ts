"use server";
// Owner only (prize_tier.edit, owner decision 2026-11-18). Overlaps and edits after the results
// snapshot are refused in lib/settings/prizes.ts and by the database (ET071 / ET072).
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { formValue, onlyFields, uuid } from "../../../../lib/settings/fields.ts";
import { createPrizeTier, deletePrizeTier, parsePrizeTier, setPrizeImage, updatePrizeTier } from "../../../../lib/settings/prizes.ts";

const PATH = "/settings/prizes";
const TIER_FIELDS = ["rankFrom", "rankTo", "name", "description", "valueIdr"];

export const createPrizeTierAction = adminAction({ permission: "prize_tier.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    onlyFields(form, ["programId", ...TIER_FIELDS]);
    await createPrizeTier(rt.sql, uuid(formValue(form, "programId")), parsePrizeTier(form));
    return "Prize tier added.";
  }),
);

export const updatePrizeTierAction = adminAction({ permission: "prize_tier.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    onlyFields(form, ["programId", "tierId", ...TIER_FIELDS]);
    await updatePrizeTier(rt.sql, uuid(formValue(form, "programId")), uuid(formValue(form, "tierId")), parsePrizeTier(form));
    return "Prize tier saved.";
  }),
);

export const deletePrizeTierAction = adminAction({ permission: "prize_tier.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    onlyFields(form, ["programId", "tierId"]);
    await deletePrizeTier(rt.sql, uuid(formValue(form, "programId")), uuid(formValue(form, "tierId")));
    return "Prize tier deleted.";
  }),
);

export const removePrizeImageAction = adminAction({ permission: "prize_tier.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    onlyFields(form, ["programId", "tierId"]);
    await setPrizeImage(rt.sql, admin.userId, uuid(formValue(form, "programId")), uuid(formValue(form, "tierId")), null);
    return "Image removed.";
  }),
);
