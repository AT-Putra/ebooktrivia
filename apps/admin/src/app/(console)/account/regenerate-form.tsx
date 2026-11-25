"use client";

import { useActionState } from "react";
import { Button } from "@ebooktrivia/ui/components/button";
import { Input } from "@ebooktrivia/ui/components/input";
import { Label } from "@ebooktrivia/ui/components/label";
import { FormError, lockedMessage } from "../../../components/auth/auth-card.tsx";
import { INITIAL_CODES } from "../../../lib/form-state.ts";
import { regenerateRecoveryCodesAction } from "./actions.ts";

export function RegenerateForm() {
  const [state, action, pending] = useActionState(regenerateRecoveryCodesAction, INITIAL_CODES);
  if (state.error === null && state.recoveryCodes !== null) {
    return (
      <div className="flex flex-col gap-2">
        <p role="status" className="text-sm">
          New recovery codes. Save them now: they are shown only once, and the old codes no longer work.
        </p>
        <ol data-testid="recovery-codes" className="grid grid-cols-2 gap-1 rounded-md bg-muted px-3 py-2 font-mono text-sm select-all">
          {state.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ol>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-3 sm:max-w-xs">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="code">Current authenticator code</Label>
        <Input id="code" name="code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" className="font-mono tracking-widest" />
      </div>
      {state.error === "invalid" ? <FormError>That code is not valid.</FormError> : null}
      {state.error === "locked" ? <FormError>{lockedMessage(state)}</FormError> : null}
      <Button type="submit" variant="secondary" size="sm" disabled={pending} className="self-start">
        Create new recovery codes
      </Button>
    </form>
  );
}
