import type { Metadata } from "next";
import { BannerCard } from "../../../../components/trivia/banner-card.tsx";
import { LeaderboardCard } from "../../../../components/trivia/leaderboard-card.tsx";
import { ProfileCard } from "../../../../components/trivia/profile-card.tsx";
import { SetGridCard } from "../../../../components/trivia/set-grid-card.tsx";
import { TriviaHeader } from "../../../../components/trivia/trivia-header.tsx";
import { assertMockupsEnabled } from "../../../../lib/guard.ts";
import { t } from "../../../../lib/t.ts";
import { findProgram, mockupTiers, PROGRAMS } from "../../../../lib/trivia-fixtures.ts";

export const metadata: Metadata = { title: "Trivia | Trivia Arena" };
// Per-request render: a build-time notFound() would otherwise be baked in as a static 404.
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ program?: string | string[] }>;
}

export default async function TriviaMockupPage({ searchParams }: PageProps) {
  assertMockupsEnabled();
  const { program: raw } = await searchParams;
  const program = findProgram(typeof raw === "string" ? raw : undefined);

  // DOM order is always banner, leaderboard, profile, grid. Desktop placement is CSS grid only.
  return (
    <div className="min-h-dvh">
      <a
        href="#konten"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-(--z-toast) focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:text-on-primary"
      >
        {t("common.skipToContent")}
      </a>
      <TriviaHeader programs={PROGRAMS} currentSlug={program.slug} basePath="/mockups/trivia" />
      <main
        id="konten"
        className="mx-auto grid max-w-[720px] gap-4 px-4 py-4 md:gap-6 md:px-6 md:py-6 xl:max-w-[1200px] xl:grid-cols-12"
      >
        <div className="xl:col-span-12">
          <BannerCard program={program} />
        </div>
        <div className="xl:col-span-7">
          <LeaderboardCard key={program.slug} rows={program.leaderboard} me={program.me} tiers={mockupTiers(program)} />
        </div>
        <div className="xl:col-span-5">
          <ProfileCard program={program} />
        </div>
        <div className="xl:col-span-12">
          <SetGridCard program={program} />
        </div>
      </main>
      <footer className="mx-auto max-w-[720px] px-4 pb-6 text-center text-sm text-muted-foreground md:px-6 xl:max-w-[1200px]">
        {t("common.mockupBadge")}
      </footer>
    </div>
  );
}
