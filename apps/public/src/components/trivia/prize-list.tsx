// The prize list of the banner card (live and mockup): the rank-1 tier as a featured "grand prize" tile, every other tier as a compact
// row. Each tier shows its picture exactly once, in a fixed square box (nothing shifts while a picture loads), whole (object-contain) so
// a portrait phone photo is not cropped to a sliver; a compact row without a picture shows the medal in the same box, so the text
// column of every row lines up. The choice is lib/play/image-urls.ts prizeLayout.
import { Badge } from "@ebooktrivia/ui/components/badge";
import { MedalIcon } from "@phosphor-icons/react/ssr";
import { formatRupiah } from "../../lib/format.ts";
import { prizeLayout } from "../../lib/play/image-urls.ts";
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

const rankLabel = (tier: PrizeTierView): string => (tier.rankFrom === tier.rankTo ? t("trivia.live.prizeRank", { n: tier.rankFrom }) : t("trivia.live.prizeRanks", { from: tier.rankFrom, to: tier.rankTo }));

/** Never wraps (the amount stays on one line), tabular figures. */
function Value({ amount }: { readonly amount: number }) {
  return (
    <Badge variant="accent" className="text-sm tabular whitespace-nowrap">
      {formatRupiah(amount)}
    </Badge>
  );
}

export function PrizeList({ tiers }: { readonly tiers: readonly PrizeTierView[] }) {
  const { featured, rows } = prizeLayout(tiers);
  return (
    <ul className="flex flex-col gap-2">
      {featured === null ? null : (
        <li className="flex items-center gap-4 rounded-lg bg-muted p-3" data-testid="prize-featured">
          <div className="size-24 shrink-0 overflow-hidden rounded-lg bg-card p-1.5 sm:size-28" data-testid="prize-featured-box">
            {featured.art.kind === "upload" ? (
              <UploadedPicture src={featured.art.src} alt="" width={96} height={96} priority className="block size-full object-contain" />
            ) : (
              <Picture id={featured.art.id} alt="" sizes="(min-width: 640px) 112px, 96px" className="block size-full object-contain" />
            )}
          </div>
          <div className="flex min-w-0 flex-col items-start gap-1">
            <span className="text-lg font-semibold leading-tight break-words">{featured.tier.name}</span>
            <span className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
              <MedalIcon aria-hidden="true" size={18} weight="fill" className={`shrink-0 ${medalTone(featured.position)}`} />
              {rankLabel(featured.tier)}
            </span>
            {featured.tier.valueIdr > 0 ? <Value amount={featured.tier.valueIdr} /> : null}
          </div>
        </li>
      )}
      {rows.map(({ tier, position, image }) => (
        <li key={`${String(tier.rankFrom)}-${String(tier.rankTo)}`} className="flex items-start gap-3 rounded-lg bg-muted p-3 sm:items-center" data-testid="prize-row">
          <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-card" data-testid="prize-row-box">
            {image === null ? (
              <MedalIcon aria-hidden="true" size={28} weight="fill" className={medalTone(position)} />
            ) : (
              <UploadedPicture src={image} alt="" width={48} height={48} className="block size-full object-contain p-1" />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="flex min-w-0 flex-col">
              <span className="font-semibold break-words">{tier.name}</span>
              <span className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
                {image === null ? null : <MedalIcon aria-hidden="true" size={16} weight="fill" className={`shrink-0 ${medalTone(position)}`} />}
                {rankLabel(tier)}
              </span>
            </div>
            {tier.valueIdr > 0 ? <Value amount={tier.valueIdr} /> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
