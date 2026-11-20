"use server";
// Owner only (adnet.edit: postback templates and their {secret:name} values, AC-A1).
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { clearAdnetSecret, createAdnet, parseAdnet, parseSecretName, setAdnetSecret, updateAdnet } from "../../../../lib/settings/adnets.ts";
import { checkbox, formValue, uuid } from "../../../../lib/settings/fields.ts";

const PATH = "/settings/adnets";

const adnetInput = (form: FormData) =>
  parseAdnet(
    {
      slug: formValue(form, "slug"),
      name: formValue(form, "name"),
      clickidParam: formValue(form, "clickidParam"),
      mo: formValue(form, "mo"),
      mt: formValue(form, "mt"),
      reversal: formValue(form, "reversal"),
      payout: formValue(form, "payoutIdr"),
    },
    checkbox(form, "active"),
  );

export const createAdnetAction = adminAction({ permission: "adnet.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await createAdnet(rt.sql, adnetInput(form));
    return "Adnet created.";
  }),
);

export const updateAdnetAction = adminAction({ permission: "adnet.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    const { secretsCleared } = await updateAdnet(rt.sql, uuid(formValue(form, "adnetId")), adnetInput(form));
    return secretsCleared > 0 ? `Adnet saved. The endpoint host changed, so ${String(secretsCleared)} secret(s) were removed: enter them again.` : "Adnet saved.";
  }),
);

export const setAdnetSecretAction = adminAction({ permission: "adnet.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await setAdnetSecret(rt.sql, rt.settings, uuid(formValue(form, "adnetId")), parseSecretName(formValue(form, "name")), formValue(form, "value"));
    return "Secret saved.";
  }),
);

export const clearAdnetSecretAction = adminAction({ permission: "adnet.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await clearAdnetSecret(rt.sql, uuid(formValue(form, "adnetId")), parseSecretName(formValue(form, "name")));
    return "Secret removed.";
  }),
);
