// The 404 of every route of the public app, in Bahasa Indonesia. The order origin answers an unknown order
// id and a malformed one with this same page (US-022), and the legal pages answer an unknown or draft
// version with it.
import { t } from "../lib/t.ts";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 py-6 md:py-10">
      <article className="flex w-full max-w-[480px] flex-col gap-3 rounded-2xl bg-card p-4 text-center text-card-foreground shadow-lg md:p-8">
        <h1 className="font-heading text-2xl leading-tight">{t("common.notFoundTitle")}</h1>
        <p className="text-base">{t("common.notFoundBody")}</p>
      </article>
    </main>
  );
}
