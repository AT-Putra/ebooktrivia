"use client";

// What a login ends on (US-026 review L5, login CSRF): whose account the browser is now signed in to, as the
// server masked it ("Masuk sebagai 0812-3456-****"), with the way out. Someone who opened another person's forwarded
// magic link sees at once that it is not their number, and signs out instead of playing on that account.
import { Button } from "@ebooktrivia/ui/components/button";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/t.ts";
import { AFTER_LOGIN_PATH, postJson } from "./api.ts";

export function SignedInPanel({ phoneMasked }: { readonly phoneMasked: string | null }) {
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  async function signOut(): Promise<void> {
    setBusy(true);
    await postJson("/api/v1/play/auth/logout", {});
    window.location.assign("/login");
  }

  return (
    <section aria-labelledby="signed-in-title" className="flex w-full max-w-[420px] flex-col gap-4 rounded-2xl bg-card p-4 text-card-foreground shadow-lg md:p-8">
      <header className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-success-soft text-success-soft-foreground">
          <CheckCircleIcon aria-hidden="true" size={28} weight="fill" />
        </span>
        <h1 id="signed-in-title" ref={heading} tabIndex={-1} className="font-heading text-2xl leading-tight">
          {t("login.signedInTitle")}
        </h1>
        {phoneMasked === null ? null : (
          <p className="text-lg font-semibold tabular" role="status">
            {t("login.signedInAs", { phone: phoneMasked })}
          </p>
        )}
        <p className="text-base">{t("login.signedInHint")}</p>
      </header>
      <Button asChild size="lg">
        <a href={AFTER_LOGIN_PATH}>{t("login.openTrivia")}</a>
      </Button>
      <Button type="button" variant="outline" disabled={busy} aria-disabled={busy} onClick={() => void signOut()}>
        {t("login.notYou")}
      </Button>
    </section>
  );
}
