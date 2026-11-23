// Card 1, the banner (US-027, AC-Q2): the program, its prize tiers, the countdown of the current phase (sales,
// then the grace period) and, once the Owner has confirmed them, the masked winners (program_winners_banner). The prize
// picture is the rank-1 tier's uploaded image (lib/play/images.ts), else the generic placeholder; every other tier that has an
// image shows it in its own row (the rank-1 tier's is not repeated there).
import { Badge } from "@ebooktrivia/ui/components/badge";
import { GiftIcon, MedalIcon, TrophyIcon } from "@phosphor-icons/react/ssr";
import { formatRupiah } from "../../../lib/format.ts";
import type { ProgramView } from "../../../lib/play/grid.ts";
import { prizeArt, tierRowImage } from "../../../lib/play/image-urls.ts";
import type { ProgramPage } from "../../../lib/play/trivia-data.ts";
import { t } from "../../../lib/t.ts";
import { Countdown } from "../../countdown.tsx";
import { Picture } from "../../picture.tsx";
import { UploadedPicture } from "../../uploaded-picture.tsx";
import { CardHeading, TriviaCard } from "../trivia-card.tsx";

const MEDAL_TONE = ["text-accent", "text-muted-foreground", "text-warning"] as const;

export function LiveBanner({ page, view }: { readonly page: ProgramPage; readonly view: ProgramView }) {
  const secondsLeft = view.phaseEndsAt === null ? 0 : Math.max(0, Math.floor((view.phaseEndsAt.getTime() - page.now.getTime()) / 1000));
  const prize = prizeArt(page.tiers);
  const rows = page.tiers.map((tier) => ({ tier, image: tierRowImage(tier, prize) }));
  const prizeClass = "block h-16 w-24 shrink-0 rounded-lg object-cover";
  return (
    <TriviaCard titleId="banner-title">
      <CardHeading id="banner-title" level="h1" icon={<GiftIcon size={24} weight="duotone" />}>
        {page.name}
      </CardHeading>
      <div className="grid items-start gap-4 lg:grid-cols-2 lg:gap-6">
        <div className="overflow-hidden rounded-lg bg-muted">
          <Picture id="banner-program" alt="" priority sizes="(min-width: 1280px) 560px, (min-width: 768px) 672px, 100vw" className="block h-auto w-full" />
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            {prize.kind === "upload" ? (
              <UploadedPicture src={prize.src} alt={t("trivia.banner.prizeArt")} width={96} height={64} priority className={prizeClass} />
            ) : (
              <Picture id={prize.id} alt={t("trivia.banner.prizeArt")} sizes="96px" className={prizeClass} />
            )}
            <h2 className="font-heading text-lg">{t("trivia.banner.prizes")}</h2>
          </div>
          {page.tiers.length === 0 ? (
            <p className="text-base text-muted-foreground">{t("trivia.live.noPrizes")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map(({ tier, image }, i) => (
                <li key={`${String(tier.rankFrom)}-${String(tier.rankTo)}`} className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg bg-muted px-3 py-2">
                  <span className="flex min-w-0 items-center gap-2 font-semibold">
                    {image === null ? null : <UploadedPicture src={image} alt="" width={44} height={44} className="size-11 shrink-0 rounded-md object-cover" />}
                    <MedalIcon aria-hidden="true" size={24} weight="fill" className={MEDAL_TONE[i] ?? "text-primary"} />
                    <span className="flex min-w-0 flex-col">
                      <span className="break-words">{tier.name}</span>
                      <span className="text-sm font-medium text-muted-foreground">
                        {tier.rankFrom === tier.rankTo ? t("trivia.live.prizeRank", { n: tier.rankFrom }) : t("trivia.live.prizeRanks", { from: tier.rankFrom, to: tier.rankTo })}
                      </span>
                    </span>
                  </span>
                  {tier.valueIdr > 0 ? (
                    <Badge variant="accent" className="text-sm tabular">
                      {formatRupiah(tier.valueIdr)}
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
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
        <div className="flex flex-col items-start justify-between gap-1 rounded-lg bg-linear-to-r from-primary to-secondary px-4 py-3 text-on-primary sm:flex-row sm:items-center">
          <p className="text-sm font-medium">{view.phase === "sales" ? t("trivia.banner.salesEndsIn") : t("trivia.banner.graceEndsIn")}</p>
          <Countdown initialSeconds={secondsLeft} className="timer-digits text-3xl leading-none font-bold" />
        </div>
      )}
    </TriviaCard>
  );
}
