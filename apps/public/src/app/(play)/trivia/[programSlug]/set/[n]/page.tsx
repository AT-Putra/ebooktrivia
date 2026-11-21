// play.<DOMAIN>/{programSlug}/set/{n} (US-027; src/proxy.ts rewrites it here, the route is internal): the question
// screen of set n (1..S) of the program. The page carries NO question: the client asks the server for the current
// one (POST /api/v1/play/attempts/current), so nothing of a question, let alone its answer, is in this HTML. A set
// that is locked for the player goes back to the grid; a program the player may not see is the same 404.
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PlaySet } from "../../../../../../components/trivia/live/play-set.tsx";
import { SlowDown } from "../../../../../../components/trivia/live/slow-down.tsx";
import { programView } from "../../../../../../lib/play/grid.ts";
import { pagePlayer } from "../../../../../../lib/play/page.ts";
import { programPage } from "../../../../../../lib/play/trivia-data.ts";
import { t } from "../../../../../../lib/t.ts";

export const metadata: Metadata = {
  title: `${t("trivia.pageTitle")} | ${t("common.appName")}`,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface PageProps {
  params: Promise<{ programSlug: string; n: string }>;
}

export default async function TriviaSetPage({ params }: PageProps) {
  const { programSlug, n } = await params;
  const number = /^[1-9][0-9]{0,3}$/.test(n) ? Number(n) : 0;
  if (!SLUG.test(programSlug) || number === 0) notFound();
  const { play, playerId, retryAfterSeconds } = await pagePlayer({ count: true });
  if (retryAfterSeconds !== null) return <SlowDown retryAfterSeconds={retryAfterSeconds} />;
  const page = await programPage(play.sql, playerId, programSlug);
  if (page === null) notFound();
  const tile = programView(page).tiles[number - 1];
  if (tile === undefined) notFound();
  // Only an open or started set is played here; a completed one shows its result on the grid.
  if (tile.state === "locked" || tile.state === "completed") redirect(`/${page.slug}`);
  return (
    <main id="konten" className="mx-auto min-h-dvh max-w-[640px] px-4 py-4 md:py-8">
      <PlaySet
        programId={page.id}
        programSlug={page.slug}
        setId={tile.set.id}
        setNumber={tile.n}
        setTitle={tile.set.title}
        questionCount={tile.set.questionCount}
        attemptId={tile.set.attempt?.id ?? null}
      />
    </main>
  );
}
