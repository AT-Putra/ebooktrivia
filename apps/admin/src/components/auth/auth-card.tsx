import type { ReactNode } from "react";
import { ShieldCheckIcon } from "@phosphor-icons/react/ssr";
import { Card, CardContent, CardDescription } from "@ebooktrivia/ui/components/card";

/** The centered card of the sign-in and enrollment pages. */
export function AuthCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 p-4">
      <p className="flex items-center gap-2 text-base font-semibold">
        <ShieldCheckIcon aria-hidden="true" size={20} weight="duotone" className="text-accent" />
        Admin Console
      </p>
      <Card>
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl leading-tight">{title}</h1>
          {description === undefined ? null : <CardDescription>{description}</CardDescription>}
        </div>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}

/** An error line for a form, announced to screen readers. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" data-testid="form-error" className="rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm">
      {children}
    </p>
  );
}

export function lockedMessage(state: { readonly retryAfterMinutes: number; readonly permanent: boolean }): string {
  if (state.permanent) return "This account is locked after too many failed codes. Ask the Owner to restore access.";
  const n = state.retryAfterMinutes;
  return `Too many attempts. Try again in ${String(n)} minute${n === 1 ? "" : "s"}.`;
}
