// The rank of a leaderboard row (live and mockup): the visible number, and a medal only when a prize tier covers the rank, in the
// colour of that tier in the prize list (lib/play/prize-ranks.ts). A screen reader hears the rank and the prize ("Peringkat 2,
// hadiah Saldo e-wallet Rp 500.000"); the visible number is hidden from it then, so the rank is not read twice.
import { MedalIcon } from "@phosphor-icons/react";
import { formatRupiah } from "../../lib/format.ts";
import { type PrizeRange, medalTone, tierForRank } from "../../lib/play/prize-ranks.ts";
import { t } from "../../lib/t.ts";

/** What the leaderboard needs of a prize tier. */
export interface LeaderboardTier extends PrizeRange {
  readonly name: string;
  readonly valueIdr: number;
}

const prizeLabel = (tier: LeaderboardTier): string => (tier.valueIdr > 0 ? `${tier.name} ${formatRupiah(tier.valueIdr)}` : tier.name);

export function RankCell({ rank, tiers }: { readonly rank: number | null; readonly tiers: readonly LeaderboardTier[] }) {
  if (rank === null) return <>-</>;
  const index = tierForRank(tiers, rank);
  const tier = index === null ? undefined : tiers[index];
  if (index === null || tier === undefined) return <span className="flex items-center gap-1">{rank}</span>;
  return (
    <span className="flex items-center gap-1" data-testid="rank-medal">
      <MedalIcon aria-hidden="true" size={20} weight="fill" className={medalTone(index)} />
      <span className="sr-only">{t("leaderboard.rankPrize", { n: rank, prize: prizeLabel(tier) })}</span>
      <span aria-hidden="true">{rank}</span>
    </span>
  );
}
