import { GiftIcon, TrophyIcon } from "@phosphor-icons/react/ssr";
import { t } from "../../lib/t.ts";
import { mockupTiers, type Program } from "../../lib/trivia-fixtures.ts";
import { Picture } from "../picture.tsx";
import { PrizeList } from "./prize-list.tsx";
import { QuizDeadline } from "./quiz-deadline.tsx";
import { CardHeading, TriviaCard } from "./trivia-card.tsx";

// The mockup's prizes have no uploaded pictures: the featured tile shows the built-in placeholder and the other rows their medal,
// laid out exactly as the live banner (live/live-banner.tsx) does it.
export function BannerCard({ program }: { program: Program }) {
  return (
    <TriviaCard titleId="banner-title">
      <CardHeading id="banner-title" level="h1" icon={<GiftIcon size={24} weight="duotone" />}>
        {program.name}
      </CardHeading>
      <div className="grid items-start gap-4 lg:grid-cols-2 lg:gap-6">
        <div className="relative aspect-[3/1] overflow-hidden rounded-lg bg-muted">
          <Picture
            id="banner-program"
            alt=""
            priority
            sizes="(min-width: 1280px) 560px, (min-width: 768px) 672px, 100vw"
            className="absolute inset-0 block size-full object-cover object-center"
          />
        </div>
        <div className="flex flex-col gap-4">
          <h2 className="flex items-center gap-2 font-heading text-lg">
            <TrophyIcon aria-hidden="true" size={22} weight="duotone" className="shrink-0 text-primary" />
            {t("trivia.banner.prizes")}
          </h2>
          <PrizeList tiers={mockupTiers(program)} />
        </div>
      </div>
      <QuizDeadline quizEndsAt={program.quizEndsAt} secondsLeft={program.quizSeconds} />
    </TriviaCard>
  );
}
