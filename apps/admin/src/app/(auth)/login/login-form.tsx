"use client";

import { useActionState } from "react";
import { Button } from "@ebooktrivia/ui/components/button";
import { Input } from "@ebooktrivia/ui/components/input";
import { Label } from "@ebooktrivia/ui/components/label";
import { FormError, lockedMessage } from "../../../components/auth/auth-card.tsx";
import { INITIAL_AUTH } from "../../../lib/form-state.ts";
import { signInAction } from "./actions.ts";

export function LoginForm() {
  const [state, action, pending] = useActionState(signInAction, INITIAL_AUTH);
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">E-mail</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required maxLength={320} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} />
      </div>
      {state.error === "invalid" ? <FormError>Wrong e-mail or password.</FormError> : null}
      {state.error === "expired" ? <FormError>Your sign-in expired. Sign in again.</FormError> : null}
      {state.error === "locked" ? <FormError>{lockedMessage(state)}</FormError> : null}
      <Button type="submit" variant="cta" disabled={pending}>
        {pending ? "Signing in" : "Sign in"}
      </Button>
    </form>
  );
}
