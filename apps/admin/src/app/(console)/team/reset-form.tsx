"use client";

import { useActionState } from "react";
import { Button } from "@ebooktrivia/ui/components/button";
import { Input } from "@ebooktrivia/ui/components/input";
import { Label } from "@ebooktrivia/ui/components/label";
import { FormError } from "../../../components/auth/auth-card.tsx";
import { INITIAL_RESET } from "../../../lib/form-state.ts";
import { resetAccessAction } from "./actions.ts";

const ERRORS = {
  password: "The temporary password needs 12 to 128 characters, and must not be a common password or contain the site's name.",
  not_found: "That account no longer exists.",
  self: "Use the recovery CLI for your own account.",
  owner: "Owner accounts are recovered with the VM CLI only.",
} as const;

/** Resets one account: a temporary password, two-factor off, 72 hours to set it up again. */
export function ResetAccessForm({ userId, name }: { userId: string; name: string }) {
  const [state, action, pending] = useActionState(resetAccessAction, INITIAL_RESET);
  const id = `reset-${userId}`;
  return (
    <form action={action} key={state.status === "reset" ? state.at : "form"} className="flex flex-wrap items-end justify-end gap-2">
      <input type="hidden" name="userId" value={userId} />
      <div className="flex flex-col gap-1 text-left">
        <Label htmlFor={id} className="text-xs">
          Temporary password for {name}
        </Label>
        <Input id={id} name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" className="min-h-9 w-44 text-sm" />
      </div>
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        Reset access
      </Button>
      {state.status === "reset" ? (
        <p role="status" className="w-full text-xs">
          Reset. They sign in with the temporary password and set up two-factor within 72 hours.
        </p>
      ) : null}
      {state.status === "error" ? (
        <div className="w-full">
          <FormError>{ERRORS[state.error]}</FormError>
        </div>
      ) : null}
    </form>
  );
}
