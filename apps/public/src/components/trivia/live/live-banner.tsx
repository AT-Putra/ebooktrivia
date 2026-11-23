// Card 1, the banner (US-027, AC-Q2): the program, its prize tiers, the countdown to the quiz deadline (components/trivia/quiz-deadline.tsx)
// and, once the Owner has confirmed them, the masked winners (program_winners_banner). One column at every width: the title, the
// big picture, the prizes, the countdown, all on the card's left and right edges. The big picture
// is the program's uploaded banner (lib/play/images.ts), else the built-in art, in a fixed 3:1 box across the card (a picture of
// another shape is cropped from its middle, never shifting the layout). The prizes are components/trivia/prize-list.tsx: one
// card per tier, each upload shown whole (the placeholder is cropped to fill).
import { GiftIcon, TrophyIcon } from "@phosphor-icons/react/ssr";
import type { ProgramView } from "../../../lib/play/grid.ts";
import { bannerArt } from "../../../lib/play/image-urls.ts";
import type { ProgramPage } from "../../../lib/play/trivia-data.ts";
import { t } from "../../../lib/t.ts";
import { Picture } from "../../picture.tsx";
import { UploadedPicture } from "../../uploaded-picture.tsx";
import { PrizeList } from "../prize-list.tsx";
import { QuizDeadline } from "../quiz-deadline.tsx";
import { CardHeading, TriviaCard } from "../trivia-card.tsx";

export function LiveBanner({ page, view }: { readonly page: ProgramPage; readonly view: ProgramView }) {
  const secondsLeft = Math.max(0, Math.floor((view.quizEndsAt.getTime() - page.now.getTime()) / 1000));
  const banner = bannerArt(page);
  const fill = "absolute inset-0 block size-full object-cover object-center";
  return (
    <TriviaCard titleId="banner-title" className="md:gap-5">
      <CardHeading id="banner-title" level="h1" icon={<GiftIcon size={24} weight="duotone" />}>
        {page.name}
      </CardHeading>
      <div className="relative aspect-[3/1] overflow-hidden rounded-lg bg-muted" data-testid="banner-picture">
        {banner.kind === "upload" ? (
          <UploadedPicture src={banner.src} alt="" width={1344} height={448} priority className={fill} />
        ) : (
          <Picture id={banner.id} alt="" priority sizes="(min-width: 1280px) 1104px, (min-width: 768px) 624px, calc(100vw - 64px)" className={fill} />
        )}
      </div>
      <PrizeList tiers={page.tiers} headingId="banner-prizes-title" />
      {view.phase === "ended" ? (
        <div className="flex flex-col gap-2 rounded-lg bg-muted px-4 py-3">
          <p className="flex items-center gap-2 font-semibold">
            <TrophyIcon aria-hidden="true" size={22} weight="duotone" className="text-primary" />
            {t("trivia.live.ended")}
          </p>
          {page.winners.length > 0 ? (
            <section aria-labelledby="winners-title" className="flex flex-col gap-1">
              <h2 id="winners-title" className="font-heading text-lg">
                {t("trivia.live.winners")}
              </h2>
              <ol className="flex flex-col gap-1">
                {page.winners.map((w) => (
                  <li key={w.rank} className="flex flex-wrap justify-between gap-x-3 text-base">
                    <span className="font-semibold tabular">{t("trivia.live.winnerRow", { rank: w.rank, name: w.maskedName })}</span>
                    <span className="text-muted-foreground">{w.prizeName}</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            <p className="text-sm text-muted-foreground">{t("trivia.live.winnersPending")}</p>
          )}
        </div>
      ) : (
        <QuizDeadline quizEndsAt={view.quizEndsAt} secondsLeft={secondsLeft} />
      )}
    </TriviaCard>
  );
}
