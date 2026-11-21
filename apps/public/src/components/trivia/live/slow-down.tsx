// What a trivia page shows when it was loaded too often (lib/play/page.ts, PAGE_LIMITS): nothing was read.
import { HourglassIcon } from "@phosphor-icons/react/ssr";
import { t } from "../../../lib/t.ts";

export function SlowDown({ retryAfterSeconds }: { readonly retryAfterSeconds: number }) {
  return (
    <main id="konten" className="mx-auto flex min-h-dvh max-w-[640px] flex-col items-center justify-center gap-3 px-4 py-6 text-center">
      <HourglassIcon aria-hidden="true" size={48} weight="duotone" className="text-primary" />
      <h1 className="font-heading text-2xl">{t("trivia.live.slowDownTitle")}</h1>
      <p className="text-base">{t("trivia.live.slowDownBody", { seconds: retryAfterSeconds })}</p>
    </main>
  );
}
