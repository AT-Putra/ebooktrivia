// play.<DOMAIN>/{programSlug} (US-027, AC-Q2/AC-Q3; src/proxy.ts rewrites it here, the route is internal): the four
// cards of one program, in this DOM order: banner, leaderboard, profile, set grid (desktop placement is CSS grid
// only), with the program switcher in the header. Server-rendered from the database with its clock; a program the
// player may not see (unknown, a draft, not paid for) is the same 404. The leaderboard is fresh on every load (the
// top N from the 5 s cache, the player's own rank read now).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HelpBlock } from "../../../../components/help/help-block.tsx";
import { LiveBanner } from "../../../../components/trivia/live/live-banner.tsx";
import { LiveGrid } from "../../../../components/trivia/live/live-grid.tsx";
import { LiveHeader } from "../../../../components/trivia/live/live-header.tsx";
import { LiveLeaderboard } from "../../../../components/trivia/live/live-leaderboard.tsx";
import { LiveProfile } from "../../../../components/trivia/live/live-profile.tsx";
import { SlowDown } from "../../../../components/trivia/live/slow-down.tsx";
import { programView } from "../../../../lib/play/grid.ts";
import { topCache } from "../../../../lib/play/leaderboard-cache.ts";
import { pagePlayer } from "../../../../lib/play/page.ts";
import { loadStanding, loadTop, playerPrograms, programPage } from "../../../../lib/play/trivia-data.ts";
import { t } from "../../../../lib/t.ts";

export const metadata: Metadata = {
  title: `${t("trivia.pageTitle")} | ${t("common.appName")}`,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface PageProps {
  params: Promise<{ programSlug: string }>;
}

export default async function TriviaProgramPage({ params }: PageProps) {
  const { programSlug } = await params;
  if (!SLUG.test(programSlug)) notFound();
  const { play, playerId, retryAfterSeconds } = await pagePlayer({ count: true });
  if (retryAfterSeconds !== null) return <SlowDown retryAfterSeconds={retryAfterSeconds} />;
  const page = await programPage(play.sql, playerId, programSlug);
  if (page === null) notFound();
  const [programs, me, top] = await Promise.all([
    playerPrograms(play.sql, playerId),
    loadStanding(play.sql, playerId, page.id),
    topCache.get(page.id, () => loadTop(play.sql, page.id)),
  ]);
  const view = programView(page);
  return (
    <div className="min-h-dvh">
      <a
        href="#konten"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-(--z-toast) focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:text-on-primary"
      >
        {t("common.skipToContent")}
      </a>
      <LiveHeader programs={programs} currentSlug={page.slug} />
      <main id="konten" className="mx-auto grid max-w-[720px] gap-4 px-4 py-4 md:gap-6 md:px-6 md:py-6 xl:max-w-[1200px] xl:grid-cols-12">
        <div className="xl:col-span-12">
          <LiveBanner page={page} view={view} />
        </div>
        <div className="xl:col-span-7">
          <LiveLeaderboard
            key={page.id}
            programId={page.id}
            tiers={page.tiers.map(({ rankFrom, rankTo, name, valueIdr }) => ({ rankFrom, rankTo, name, valueIdr }))}
            initial={{
              top: top.rows.map((r) => ({ rank: r.rank, name: r.name, score: r.score, totalMs: r.totalMs })),
              me: { rank: me.rank, name: me.name, score: me.score, totalMs: me.totalMs, ranked: me.ranked },
              ageMs: Math.max(0, Date.now() - top.loadedAt),
            }}
          />
        </div>
        <div className="xl:col-span-5">
          <LiveProfile page={page} view={view} me={me} />
        </div>
        <div className="xl:col-span-12">
          <LiveGrid slug={page.slug} view={view} />
        </div>
        <div className="xl:col-span-12">
          <HelpBlock className="md:p-6" />
        </div>
      </main>
    </div>
  );
}
