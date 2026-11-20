"use server";
// Owner only (midtrans.edit: gateway secrets and fees, AC-A1).
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { formValue, InvalidInput } from "../../../../lib/settings/fields.ts";
import { clearServerKey, type MidtransEnvironment, parseMethodsAndFees, setEnvironment, setServerKey, updateMethodsAndFees } from "../../../../lib/settings/midtrans.ts";

const PATH = "/settings/midtrans";

function environment(form: FormData): MidtransEnvironment {
  const value = formValue(form, "environment");
  if (value !== "sandbox" && value !== "production") throw new InvalidInput("Choose sandbox or production.");
  return value;
}

export const updateMidtransMethodsAction = adminAction({ permission: "midtrans.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await updateMethodsAndFees(rt.sql, admin.userId, parseMethodsAndFees(form));
    return "Payment methods and fees saved.";
  }),
);

export const setMidtransEnvironmentAction = adminAction({ permission: "midtrans.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    const env = environment(form);
    if (formValue(form, "confirm") !== env) throw new InvalidInput(`Type ${env} to confirm the switch.`);
    await setEnvironment(rt.sql, admin.userId, env);
    return `Midtrans now runs in ${env}.`;
  }),
);

export const setMidtransKeyAction = adminAction({ permission: "midtrans.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await setServerKey(rt.sql, rt.settings, environment(form), formValue(form, "serverKey"));
    return "Server key saved.";
  }),
);

export const clearMidtransKeyAction = adminAction({ permission: "midtrans.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await clearServerKey(rt.sql, environment(form));
    return "Server key removed.";
  }),
);
