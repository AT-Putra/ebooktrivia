"use server";
// Forced TOTP enrollment (plan M5a.1): reachable only by a signed-in user without TOTP
// (requireAdmin({ enrollment: true })).
import { redirect } from "next/navigation";
import { completeEnrollment, startEnrollment } from "../../../lib/auth/service.ts";
import { type AuthFormState, type EnrollStartState, formText, lockedState } from "../../../lib/form-state.ts";
import { adminAction } from "../../../lib/next/actions.ts";
import { applySetCookies } from "../../../lib/next/request.ts";

export const startEnrollmentAction = adminAction({ enrollment: true }, async ({ rt, req, admin }, _previous: EnrollStartState, form: FormData): Promise<EnrollStartState> => {
  const outcome = await startEnrollment(rt, admin, { password: formText(form, "password", 256), newPassword: formText(form, "newPassword", 256) }, req);
  if (outcome.kind === "verify") {
    return { stage: "verify", secret: outcome.secret, uri: outcome.uri, qrSvgDataUrl: outcome.qrSvgDataUrl, recoveryCodes: outcome.recoveryCodes };
  }
  if (outcome.kind === "locked") return { stage: "password", ...lockedState(outcome) };
  return { stage: "password", error: outcome.kind };
});

export const completeEnrollmentAction = adminAction({ enrollment: true }, async ({ rt, req, admin }, _previous: AuthFormState, form: FormData): Promise<AuthFormState> => {
  const result = await completeEnrollment(rt, admin, { code: formText(form, "code", 16) }, req);
  await applySetCookies(result.setCookies);
  const outcome = result.outcome;
  if (outcome.kind === "enrolled") redirect("/");
  if (outcome.kind === "locked") return lockedState(outcome);
  return { error: "invalid" };
});
