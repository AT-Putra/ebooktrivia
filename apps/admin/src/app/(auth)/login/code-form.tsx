"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@ebooktrivia/ui/components/button";
import { Input } from "@ebooktrivia/ui/components/input";
import { Label } from "@ebooktrivia/ui/components/label";
import { FormError, lockedMessage } from "../../../components/auth/auth-card.tsx";
import { INITIAL_AUTH } from "../../../lib/form-state.ts";
import { verifyRecoveryCodeAction, verifyTotpAction } from "./actions.ts";

/** The second sign-in step: an authenticator code, or a recovery code. */
export function CodeForm({ kind }: { kind: "totp" | "recovery" }) {
  const [state, action, pending] = useActionState(kind === "totp" ? verifyTotpAction : verifyRecoveryCodeAction, INITIAL_AUTH);
  const totp = kind === "totp";
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="code">{totp ? "Authenticator code" : "Recovery code"}</Label>
        <Input
          id="code"
          name="code"
          required
          autoComplete="one-time-code"
          autoFocus
          spellCheck={false}
          className="font-mono tracking-widest"
          {...(totp ? { inputMode: "numeric" as const, pattern: "[0-9]{6}", maxLength: 6, placeholder: "123456" } : { maxLength: 24, placeholder: "XXXX-XXXX-XXXX-XXXX" })}
        />
      </div>
      {state.error === "invalid" ? <FormError>{totp ? "That code is not valid. Wait for the next one and try again." : "That recovery code is not valid or was already used."}</FormError> : null}
      {state.error === "locked" ? <FormError>{lockedMessage(state)}</FormError> : null}
      {state.error === "expired" ? (
        <FormError>
          Your sign-in expired.{" "}
          <Link href="/login" className="underline underline-offset-4">
            Sign in again
          </Link>
          .
        </FormError>
      ) : null}
      <Button type="submit" variant="cta" disabled={pending}>
        {pending ? "Checking" : "Continue"}
      </Button>
      <p className="text-sm text-muted-foreground">
        {totp ? (
          <Link href="/login/recovery" className="underline underline-offset-4">
            Use a recovery code instead
          </Link>
        ) : (
          <Link href="/login/two-factor" className="underline underline-offset-4">
            Use the authenticator app instead
          </Link>
        )}
      </p>
    </form>
  );
}
