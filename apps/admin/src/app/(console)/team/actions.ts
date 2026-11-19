"use server";
// Owner only (policy: admin_user.manage). Every change is audited in its transaction (lib/admin-users.ts).
import { revalidatePath } from "next/cache";
import { createAdminUser, resetAdminUser, setAdminDisabled } from "../../../lib/admin-users.ts";
import { type CreateStaffState, formText, type ResetState } from "../../../lib/form-state.ts";
import { adminAction } from "../../../lib/next/actions.ts";

export const createStaffAction = adminAction({ permission: "admin_user.manage" }, async ({ rt }, _previous: CreateStaffState, form: FormData): Promise<CreateStaffState> => {
  const result = await createAdminUser(
    rt.sql,
    { email: formText(form, "email", 320), displayName: formText(form, "displayName", 200), password: formText(form, "password", 256) },
    "staff",
    "admin_user.create",
  );
  if (result.kind === "created") {
    revalidatePath("/team");
    return { status: "created", at: Date.now() };
  }
  return { status: "error", error: result.kind === "email_taken" ? "email_taken" : result.field };
});

export const setDisabledAction = adminAction({ permission: "admin_user.manage" }, async ({ rt, admin }, form: FormData): Promise<void> => {
  const target = formText(form, "userId", 64);
  const disabled = formText(form, "disabled", 5) === "true";
  await setAdminDisabled(rt.sql, admin.userId, target, disabled);
  revalidatePath("/team");
});

/**
 * Temporary password + TOTP off + 72 h to set up again (lost authenticator, expired setup, hard
 * lock). Staff accounts only: lib/admin-users.ts refuses (and audits) an Owner target, and this
 * action reports it; the Team page shows the control for Staff rows only.
 */
export const resetAccessAction = adminAction({ permission: "admin_user.manage" }, async ({ rt, admin }, _previous: ResetState, form: FormData): Promise<ResetState> => {
  const result = await resetAdminUser(rt.sql, admin.userId, formText(form, "userId", 64), formText(form, "password", 256));
  if (result.kind === "reset") {
    revalidatePath("/team");
    return { status: "reset", at: Date.now() };
  }
  return { status: "error", error: result.kind === "invalid_password" ? "password" : result.kind };
});
