"use server";
// The forced change of a password found in a known breach (US-031, ASVS V6.2.12): reachable only by a session whose
// password the worker flagged (requireAdmin({ passwordChange: true }), lib/access.ts).
import { redirect } from "next/navigation";
import { changeBreachedPassword } from "../../../lib/auth/service.ts";
import { formText, lockedState, type PasswordChangeState } from "../../../lib/form-state.ts";
import { adminAction } from "../../../lib/next/actions.ts";

export const changeBreachedPasswordAction = adminAction({ passwordChange: true }, async ({ rt, req, admin }, _previous: PasswordChangeState, form: FormData): Promise<PasswordChangeState> => {
  const outcome = await changeBreachedPassword(rt, admin, { password: formText(form, "password", 256), newPassword: formText(form, "newPassword", 256) }, req);
  if (outcome.kind === "changed") redirect("/");
  if (outcome.kind === "locked") return lockedState(outcome);
  return { error: outcome.kind };
});
