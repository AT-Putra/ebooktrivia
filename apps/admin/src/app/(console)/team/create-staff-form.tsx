"use client";

import { useActionState } from "react";
import { Button } from "@ebooktrivia/ui/components/button";
import { Input } from "@ebooktrivia/ui/components/input";
import { Label } from "@ebooktrivia/ui/components/label";
import { FormError } from "../../../components/auth/auth-card.tsx";
import { INITIAL_CREATE } from "../../../lib/form-state.ts";
import { createStaffAction } from "./actions.ts";

const ERRORS = {
  email: "Enter a valid e-mail address.",
  display_name: "Enter a name (up to 100 characters).",
  password: "The password needs 12 to 128 characters, and must not be a common password or contain the site's name or the e-mail's name.",
  email_taken: "An admin with this e-mail already exists.",
} as const;

export function CreateStaffForm() {
  const [state, action, pending] = useActionState(createStaffAction, INITIAL_CREATE);
  return (
    <form action={action} key={state.status === "created" ? state.at : "form"} className="grid gap-3 sm:grid-cols-3 sm:items-end">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="staff-email">E-mail</Label>
        <Input id="staff-email" name="email" type="email" required maxLength={320} autoComplete="off" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="staff-name">Name</Label>
        <Input id="staff-name" name="displayName" required maxLength={100} autoComplete="off" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="staff-password">Temporary password</Label>
        <Input id="staff-password" name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
        <Button type="submit" variant="cta" size="sm" disabled={pending}>
          Add Staff
        </Button>
        {state.status === "created" ? (
          <p role="status" className="text-sm">
            Staff account created. They set up two-factor at their first sign-in.
          </p>
        ) : null}
      </div>
      {state.status === "error" ? (
        <div className="sm:col-span-3">
          <FormError>{ERRORS[state.error]}</FormError>
        </div>
      ) : null}
    </form>
  );
}
