"use client";

import { useActionState } from "react";
import { Button } from "@ebooktrivia/ui/components/button";
import { Input } from "@ebooktrivia/ui/components/input";
import { Label } from "@ebooktrivia/ui/components/label";
import { FormError, lockedMessage } from "../../../components/auth/auth-card.tsx";
import { INITIAL_AUTH, INITIAL_ENROLL } from "../../../lib/form-state.ts";
import { completeEnrollmentAction, startEnrollmentAction } from "./actions.ts";

/** The secret in groups of 4, as authenticator apps show it for manual entry. */
const grouped = (secret: string): string => secret.replace(/(.{4})(?=.)/g, "$1 ");

/**
 * 1. the current (temporary) password and a new one; 2. add the key to the authenticator app (QR
 * code or the text key) and save the recovery codes; 3. the first 6-digit code turns two-factor
 * on (and signs every other session out).
 */
export function EnrollFlow() {
  const [start, startAction, starting] = useActionState(startEnrollmentAction, INITIAL_ENROLL);
  const [verify, verifyAction, verifying] = useActionState(completeEnrollmentAction, INITIAL_AUTH);

  if (start.stage === "password") {
    return (
      <form action={startAction} className="flex flex-col gap-3">
        <p className="text-sm">Two-factor authentication is required for every admin account. Confirm your password and choose a new one to start.</p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Current password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="newPassword">New password</Label>
          <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} />
          <p className="text-xs text-muted-foreground">12 to 128 characters, different from the current one; not a common password and not built on the site's name or your e-mail.</p>
        </div>
        {start.error === "invalid" ? <FormError>Wrong password.</FormError> : null}
        {start.error === "invalid_new_password" ? <FormError>The new password needs 12 to 128 characters, must differ from the current one, and must not be a common password or contain the site's name or your e-mail's name.</FormError> : null}
        {start.error === "locked" ? <FormError>{lockedMessage(start)}</FormError> : null}
        <Button type="submit" variant="cta" disabled={starting}>
          Start setup
        </Button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="key-heading" className="flex flex-col gap-2">
        <h2 id="key-heading" className="text-sm font-semibold">
          1. Add this account to your authenticator app
        </h2>
        <p className="text-sm text-muted-foreground">Scan the QR code, or choose &quot;enter a setup key&quot; (time based) and type the key.</p>
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          {/* Server-rendered SVG (lib/auth/service.ts totpQrDataUrl); a data: image runs no script. */}
          <img data-testid="totp-qr" src={start.qrSvgDataUrl} alt="QR code of the authenticator setup key" width={180} height={180} className="rounded-md bg-white" />
          <p data-testid="totp-secret" className="rounded-md bg-muted px-3 py-2 font-mono text-base break-all select-all">
            {grouped(start.secret)}
          </p>
        </div>
        <a href={start.uri} className="text-sm underline underline-offset-4">
          Open in an authenticator app on this device
        </a>
      </section>
      <section aria-labelledby="codes-heading" className="flex flex-col gap-2">
        <h2 id="codes-heading" className="text-sm font-semibold">
          2. Save your 10 recovery codes
        </h2>
        <p className="text-sm text-muted-foreground">Each one signs you in once if you lose the authenticator. They are shown only now.</p>
        <ol data-testid="recovery-codes" className="grid grid-cols-2 gap-1 rounded-md bg-muted px-3 py-2 font-mono text-sm select-all">
          {start.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ol>
      </section>
      <form action={verifyAction} className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">3. Enter the 6-digit code the app shows</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="code">Authenticator code</Label>
          <Input id="code" name="code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" className="font-mono tracking-widest" />
        </div>
        {verify.error === "invalid" ? <FormError>That code is not valid. Check the key and the time on your phone.</FormError> : null}
        {verify.error === "locked" ? <FormError>{lockedMessage(verify)}</FormError> : null}
        <Button type="submit" variant="cta" disabled={verifying}>
          Turn on two-factor
        </Button>
      </form>
    </div>
  );
}
