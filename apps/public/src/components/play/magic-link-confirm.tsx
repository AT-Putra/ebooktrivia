"use client";

// The magic link's confirm page (US-026; plan M8.4, §10 item 4): https://play.<DOMAIN>/masuk#c=<channel>&t=<token>.
// Opening the link (a GET, also by a link scanner or a chat preview) changes nothing: the token is in the
// fragment, which no server ever receives, and this page only reads it, removes it from the address bar and
// history, and waits for the player's click. Only that click POSTs the token (single use, 72 h, bound to its
// channel); the server then sets the session cookie, and the page shows whose account it opened (masked).
import { type MagicLinkTarget, parseMagicLinkFragment } from "@ebooktrivia/core/magic-link-url";
import { Button } from "@ebooktrivia/ui/components/button";
import { CircleNotchIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { t } from "../../lib/t.ts";
import { useHelpShown } from "../help/cs-context.tsx";
import { postJson } from "./api.ts";
import { SignedInPanel } from "./signed-in-panel.tsx";

type State =
  | { readonly kind: "reading" }
  | { readonly kind: "ready"; readonly target: MagicLinkTarget }
  | { readonly kind: "invalid" }
  | { readonly kind: "signedIn"; readonly phoneMasked: string | null };

export function MagicLinkConfirm() {
  const helpShown = useHelpShown();
  const [state, setState] = useState<State>({ kind: "reading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const target = parseMagicLinkFragment(window.location.hash);
    // The token leaves the address bar and the history entry at once (screenshots, shared screens, back).
    if (window.location.hash !== "") window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setState(target === null ? { kind: "invalid" } : { kind: "ready", target });
  }, []);

  async function confirm(target: MagicLinkTarget): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    const answer = await postJson("/api/v1/play/auth/magic-link", { channel: target.channel, token: target.token });
    if (answer.status === 200) {
      const masked = answer.body["phone_masked"];
      setState({ kind: "signedIn", phoneMasked: typeof masked === "string" ? masked : null });
      return;
    }
    setBusy(false);
    if (answer.status === 400) {
      setState({ kind: "invalid" });
      return;
    }
    setError(
      answer.status === 0
        ? t("login.errors.network")
        : answer.status === 429
          ? t("login.errors.rateLimited", { seconds: Math.max(answer.retryAfterSeconds, 1) })
          : t("login.errors.unavailable"),
    );
  }

  if (state.kind === "reading") {
    return (
      <section aria-busy="true" className="flex w-full max-w-[420px] flex-col gap-4 rounded-2xl bg-card p-4 text-card-foreground shadow-lg md:p-8">
        <h1 className="font-heading text-2xl leading-tight">{t("magicLink.title")}</h1>
        <noscript>
          <p className="text-base">{t("magicLink.noScript")}</p>
        </noscript>
      </section>
    );
  }

  if (state.kind === "signedIn") return <SignedInPanel phoneMasked={state.phoneMasked} />;

  if (state.kind === "invalid") {
    return (
      <section aria-labelledby="magic-title" className="flex w-full max-w-[420px] flex-col gap-4 rounded-2xl bg-card p-4 text-card-foreground shadow-lg md:p-8">
        <h1 id="magic-title" className="font-heading text-2xl leading-tight">
          {t("magicLink.invalidTitle")}
        </h1>
        <p className="text-base" role="status">
          {t("magicLink.invalidBody")}{helpShown ? ` ${t("help.pointer")}` : ""}
        </p>
        <Button asChild size="lg">
          <a href="/login">{t("magicLink.toLogin")}</a>
        </Button>
      </section>
    );
  }

  const { target } = state;
  return (
    <section aria-labelledby="magic-title" className="flex w-full max-w-[420px] flex-col gap-4 rounded-2xl bg-card p-4 text-card-foreground shadow-lg md:p-8">
      <h1 id="magic-title" className="font-heading text-2xl leading-tight">
        {t("magicLink.title")}
      </h1>
      <p className="text-base">{t("magicLink.body")}</p>
      <Button type="button" variant="cta" size="lg" disabled={busy} aria-disabled={busy} aria-describedby={error === null ? undefined : "magic-error"} onClick={() => void confirm(target)}>
        {busy ? <CircleNotchIcon aria-hidden="true" size={18} weight="bold" className="motion-safe:animate-spin" /> : null}
        {busy ? t("magicLink.confirming") : t("magicLink.confirm")}
      </Button>
      {error === null ? null : (
        <p id="magic-error" role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <a href="/login" className="text-sm text-primary underline underline-offset-4">
        {t("magicLink.toLogin")}
      </a>
    </section>
  );
}
