"use client";

// A page that could not render (the database or Valkey is down, say), in Bahasa Indonesia: the order
// status page and the legal pages read from the database on every request.
import { ContextHelpBlock } from "../components/help/cs-context.tsx";
import { t } from "../lib/t.ts";

export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 py-6 md:py-10">
      <article className="flex w-full max-w-[480px] flex-col gap-3 rounded-2xl bg-card p-4 text-center text-card-foreground shadow-lg md:p-8">
        <h1 className="font-heading text-2xl leading-tight">{t("common.errorTitle")}</h1>
        <p className="text-base">{t("common.errorBody")}</p>
        <button
          type="button"
          onClick={reset}
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-primary px-4 font-semibold text-primary transition-colors duration-(--duration-base) hover:bg-muted"
        >
          {t("common.retry")}
        </button>
      </article>
      <ContextHelpBlock className="max-w-[480px]" />
    </main>
  );
}
