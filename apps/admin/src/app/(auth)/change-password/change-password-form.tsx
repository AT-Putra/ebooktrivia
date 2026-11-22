"use client";

import { useActionState } from "react";
import { Button } from "@ebooktrivia/ui/components/button";
import { Input } from "@ebooktrivia/ui/components/input";
import { Label } from "@ebooktrivia/ui/components/label";
import { FormError, lockedMessage } from "../../../components/auth/auth-card.tsx";
import { INITIAL_PASSWORD_CHANGE } from "../../../lib/form-state.ts";
import { changeBreachedPasswordAction } from "./actions.ts";

/** The current password and a new one; on success the console opens and every other session is signed out. */
export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(changeBreachedPasswordAction, INITIAL_PASSWORD_CHANGE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <p className="text-sm">
        Your password appears in a known data breach (Have I Been Pwned), so it may already be on attackers&apos; lists. Choose a new one before you continue; every other session of
        your account will be signed out.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Current password</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="newPassword">New password</Label>
        <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} />
        <p className="text-xs text-muted-foreground">12 to 128 characters, different from the current one; not a common password and not built on the site&apos;s name or your e-mail.</p>
      </div>
      {state.error === "invalid" ? <FormError>Wrong password.</FormError> : null}
      {state.error === "invalid_new_password" ? (
        <FormError>The new password needs 12 to 128 characters, must differ from the current one, and must not be a common password or contain the site&apos;s name or your e-mail&apos;s name.</FormError>
      ) : null}
      {state.error === "locked" ? <FormError>{lockedMessage(state)}</FormError> : null}
      <Button type="submit" variant="cta" disabled={pending}>
        Change password
      </Button>
    </form>
  );
}
