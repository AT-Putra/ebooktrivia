// How the prize tiers shape the leaderboard (components/trivia/live/live-leaderboard.tsx and the mockup's leaderboard-card.tsx):
// the WINNERS are the ranks a prize tier covers (up to the highest rank_to of any tier), a rank gets a medal only when a tier
// covers it, in the colour of THAT tier in the prize list, and the phone shows at least the winners before "Lihat semua".
// Pure; tiers come in the order the prize list shows them (rank_from), but nothing here relies on it: the ranges never overlap
// (the admin and the database enforce it), gaps between them are possible.

/** The medal colours by tier order in the prize list: gold, silver, bronze, then the primary colour. One table for both cards. */
export const MEDAL_TONE = ["text-accent", "text-muted-foreground", "text-warning"] as const;
export const medalTone = (tierIndex: number): string => MEDAL_TONE[tierIndex] ?? "text-primary";

export interface PrizeRange {
  readonly rankFrom: number;
  readonly rankTo: number;
}

/** The leaderboard shows at least this many rows on a phone before "Lihat semua". */
export const MIN_COLLAPSED_ROWS = 5;

/** The highest rank any prize tier covers (0 with no tiers). */
export function winnersCount(tiers: readonly PrizeRange[]): number {
  return tiers.reduce((highest, tier) => Math.max(highest, tier.rankTo), 0);
}

/** The rows the phone shows before "Lihat semua": every winner, and at least MIN_COLLAPSED_ROWS (the server sends only as many as it has). */
export function collapsedRows(tiers: readonly PrizeRange[]): number {
  return Math.max(MIN_COLLAPSED_ROWS, winnersCount(tiers));
}

/** The index (in `tiers`, the order of the prize list) of the tier that covers `rank`, or null when none does. */
export function tierForRank(tiers: readonly PrizeRange[], rank: number): number | null {
  const index = tiers.findIndex((tier) => tier.rankFrom <= rank && rank <= tier.rankTo);
  return index < 0 ? null : index;
}
