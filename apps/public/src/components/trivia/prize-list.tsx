// The prize section of the banner card (live and mockup): the "Hadiah" heading and one grid of prize cards. EVERY tier is the
// same card: a square picture frame (the tier's uploaded picture shown whole, object-contain; else the built-in placeholder art,
// which fills the frame), then the rank line (medal, "Juara 2–6 · 5 pemenang"; a one-place tier is only "Juara 1", the winner
// count would repeat the rank), the name and the pills. Only the rank-1 tier is dressed up (an accent border, a soft gradient, the
// pill "Hadiah utama" before its value). One column below xl (the picture frame, the gap and the padding grow at md: 76 to 112 px,
// 12 to 16 px, 10 to 12 px, so the rank line fits one line on a phone), 1, 2, 3, 2 (four tiers: 2 + 2), then 3 columns from xl;
// cards in one row are as tall as the tallest, their contents sit in the middle, and a lone card's content is centred from md.
import { Badge } from "@ebooktrivia/ui/components/badge";
import { MedalIcon, TrophyIcon } from "@phosphor-icons/react/ssr";
import { formatRupiah } from "../../lib/format.ts";
import { prizeArt } from "../../lib/play/image-urls.ts";
import { medalTone } from "../../lib/play/prize-ranks.ts";
import { t } from "../../lib/t.ts";
import { Picture } from "../picture.tsx";
import { UploadedPicture } from "../uploaded-picture.tsx";

export interface PrizeTierView {
  readonly rankFrom: number;
  readonly rankTo: number;
  readonly name: string;
  readonly valueIdr: number;
  /** The Owner's uploaded image of the tier (a play-origin URL), or null. */
  readonly imageUrl: string | null;
}

/** The grid's columns from xl by number of tiers (full class names, so Tailwind finds them): 1, 2, 3, 4 -> 2, 5 or more -> 3. */
const COLUMNS = ["xl:grid-cols-1", "xl:grid-cols-2", "xl:grid-cols-3", "xl:grid-cols-2", "xl:grid-cols-3"] as const;
const columns = (tiers: number): string => COLUMNS[Math.min(tiers, COLUMNS.length) - 1] ?? COLUMNS[0];

const rankLabel = (tier: PrizeTierView): string => (tier.rankFrom === tier.rankTo ? t("trivia.live.prizeRank", { n: tier.rankFrom }) : t("trivia.live.prizeRanks", { from: tier.rankFrom, to: tier.rankTo }));

/** Never wraps (the text stays on one line), tabular figures. */
const PILL = "rounded-full px-2.5 text-sm tabular";

function PrizeCard({ tier, position, alone }: { readonly tier: PrizeTierView; readonly position: number; readonly alone: boolean }) {
  const top = tier.rankFrom === 1;
  const art = prizeArt(tier);
  const frame = "block size-full rounded-sm";
  return (
    <li
      className={`flex items-center gap-3 rounded-lg border-2 p-2.5 md:gap-4 md:p-3 ${alone ? "md:justify-center" : ""} ${top ? "border-accent bg-linear-to-br from-warning-soft/50 to-muted to-60%" : "border-transparent bg-muted"}`}
      data-testid="prize-card"
    >
      <div className="size-19 shrink-0 rounded-lg bg-card p-1.5 ring-1 ring-border ring-inset md:size-28" data-testid="prize-picture">
        {art.kind === "upload" ? (
          <UploadedPicture src={art.src} alt="" width={100} height={100} priority={top} className={`${frame} object-contain`} />
        ) : (
          <Picture id={art.id} alt="" priority={top} sizes="(min-width: 768px) 100px, 64px" className={`${frame} object-cover`} />
        )}
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1">
        {/* Breaks only between the two parts; the medal stays with the rank. */}
        <div className="flex flex-wrap items-center gap-x-1 text-sm font-semibold text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <MedalIcon aria-hidden="true" size={16} weight="fill" className={`shrink-0 ${medalTone(position)}`} />
            {rankLabel(tier)}
          </span>
          {tier.rankFrom === tier.rankTo ? null : (
            <>
              {" "}
              <span className="whitespace-nowrap">{t("trivia.live.prizeWinners", { n: tier.rankTo - tier.rankFrom + 1 })}</span>
            </>
          )}
        </div>
        <span className="text-lg leading-snug font-bold wrap-anywhere">{tier.name}</span>
        {top || tier.valueIdr > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {top ? (
              <Badge variant="warning" className={PILL}>
                {t("trivia.live.prizeTop")}
              </Badge>
            ) : null}
            {tier.valueIdr > 0 ? (
              <Badge variant="warning" className={PILL}>
                {formatRupiah(tier.valueIdr)}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** `headingId`: the id of this list's "Hadiah" heading, which names the list (the card chooses it, so two lists never share one). */
export function PrizeList({ tiers, headingId }: { readonly tiers: readonly PrizeTierView[]; readonly headingId: string }) {
  return (
    <>
      <h2 id={headingId} className="flex items-center gap-2 font-heading text-lg">
        <TrophyIcon aria-hidden="true" size={22} weight="duotone" className="shrink-0 text-primary" />
        {t("trivia.banner.prizes")}
      </h2>
      {tiers.length === 0 ? (
        <p className="text-base text-muted-foreground">{t("trivia.live.noPrizes")}</p>
      ) : (
        <ul role="list" aria-labelledby={headingId} className={`grid grid-cols-1 gap-3 md:gap-4 ${columns(tiers.length)}`}>
          {tiers.map((tier, position) => (
            <PrizeCard key={`${String(tier.rankFrom)}-${String(tier.rankTo)}`} tier={tier} position={position} alone={tiers.length === 1} />
          ))}
        </ul>
      )}
    </>
  );
}
