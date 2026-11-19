"use server";
// Sign-in steps (no session yet). authAction: Origin check + mutation scope; the services throttle,
// audit and decide (lib/auth/service.ts).
import { redirect } from "next/navigation";
import { type SecondFactorOutcome, signInWithPassword, verifyRecoveryCodeSignIn, verifyTotpSignIn, type WithCookies } from "../../../lib/auth/service.ts";
import { type AuthFormState, formText, lockedState } from "../../../lib/form-state.ts";
import { authAction } from "../../../lib/next/actions.ts";
import { applySetCookies } from "../../../lib/next/request.ts";

export const signInAction = authAction(async ({ rt, req }, _previous: AuthFormState, form: FormData): Promise<AuthFormState> => {
  const result = await signInWithPassword(rt, { email: formText(form, "email", 320), password: formText(form, "password", 256) }, req);
  await applySetCookies(result.setCookies);
  const outcome = result.outcome;
  if (outcome.kind === "second_factor") redirect("/login/two-factor");
  if (outcome.kind === "enroll") redirect("/enroll");
  if (outcome.kind === "locked") return lockedState(outcome);
  return { error: "invalid" };
});

async function secondFactorState(result: WithCookies<SecondFactorOutcome>): Promise<AuthFormState> {
  await applySetCookies(result.setCookies);
  const outcome = result.outcome;
  if (outcome.kind === "signed_in") redirect("/");
  if (outcome.kind === "locked") return lockedState(outcome);
  return { error: outcome.kind };
}

export const verifyTotpAction = authAction(async ({ rt, req }, _previous: AuthFormState, form: FormData): Promise<AuthFormState> =>
  secondFactorState(await verifyTotpSignIn(rt, { code: formText(form, "code", 16) }, req)),
);

export const verifyRecoveryCodeAction = authAction(async ({ rt, req }, _previous: AuthFormState, form: FormData): Promise<AuthFormState> =>
  secondFactorState(await verifyRecoveryCodeSignIn(rt, { code: formText(form, "code", 64) }, req)),
);
