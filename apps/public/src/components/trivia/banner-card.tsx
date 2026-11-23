import { GiftIcon } from "@phosphor-icons/react/ssr";
import { mockupTiers, type Program } from "../../lib/trivia-fixtures.ts";
import { Picture } from "../picture.tsx";
import { PrizeList } from "./prize-list.tsx";
import { QuizDeadline } from "./quiz-deadline.tsx";
import { CardHeading, TriviaCard } from "./trivia-card.tsx";

// The mockup's prizes have no uploaded pictures: every prize card shows the built-in placeholder, laid out exactly as the live
// banner (live/live-banner.tsx) does it.
export function BannerCard({ program }: { program: Program }) {
  return (
    <TriviaCard titleId="banner-title" className="md:gap-5">
      <CardHeading id="banner-title" level="h1" icon={<GiftIcon size={24} weight="duotone" />}>
        {program.name}
      </CardHeading>
      <div className="relative aspect-[3/1] overflow-hidden rounded-lg bg-muted">
        <Picture
          id="banner-program"
          alt=""
          priority
          sizes="(min-width: 1280px) 1104px, (min-width: 768px) 624px, calc(100vw - 64px)"
          className="absolute inset-0 block size-full object-cover object-center"
        />
      </div>
      <PrizeList tiers={mockupTiers(program)} headingId="banner-prizes-title" />
      <QuizDeadline quizEndsAt={program.quizEndsAt} secondsLeft={program.quizSeconds} />
    </TriviaCard>
  );
}
