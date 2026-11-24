// play.<DOMAIN>/ (US-027; src/proxy.ts rewrites it here, the route is internal): the player's first program, or a
// note when the player has none to play yet. Not signed in: the login page.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { hasCsContact } from "@ebooktrivia/core/cs-contact";
import { HelpBlock } from "../../../components/help/help-block.tsx";
import { LiveHeader } from "../../../components/trivia/live/live-header.tsx";
import { getCsContact } from "../../../lib/cs/contact.ts";
import { pagePlayer } from "../../../lib/play/page.ts";
import { playerPrograms } from "../../../lib/play/trivia-data.ts";
import { t } from "../../../lib/t.ts";

export const metadata: Metadata = {
  title: `${t("trivia.pageTitle")} | ${t("common.appName")}`,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default async function TriviaHome() {
  const { play, playerId } = await pagePlayer();
  const programs = await playerPrograms(play.sql, playerId);
  const first = programs[0];
  if (first !== undefined) redirect(`/${first.slug}`);
  // Not eligible (yet): the note says so, and points to the help block under it when there is one.
  const helpShown = hasCsContact(await getCsContact());
  return (
    <div className="min-h-dvh">
      <LiveHeader programs={[]} currentSlug={null} />
      <main id="konten" className="mx-auto flex max-w-[720px] flex-col gap-3 px-4 py-6">
        <h1 className="font-heading text-2xl">{t("trivia.live.noProgramTitle")}</h1>
        <p className="text-base">{t("trivia.live.noProgramBody")}</p>
        {helpShown ? <p className="text-base font-semibold">{t("help.noProgramPointer")}</p> : null}
        <HelpBlock />
      </main>
    </div>
  );
}
