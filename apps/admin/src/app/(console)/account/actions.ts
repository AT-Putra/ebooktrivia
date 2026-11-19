"use server";
// The signed-in user's own account (policy: account.manage_own).
import { regenerateRecoveryCodes } from "../../../lib/auth/service.ts";
import { type CodesState, formText, lockedState } from "../../../lib/form-state.ts";
import { adminAction } from "../../../lib/next/actions.ts";

export const regenerateRecoveryCodesAction = adminAction({ permission: "account.manage_own" }, async ({ rt, req, admin }, _previous: CodesState, form: FormData): Promise<CodesState> => {
  const outcome = await regenerateRecoveryCodes(rt, admin, { code: formText(form, "code", 16) }, req);
  if (outcome.kind === "codes") return { error: null, recoveryCodes: outcome.recoveryCodes };
  if (outcome.kind === "locked") return lockedState(outcome);
  return { error: "invalid" };
});
