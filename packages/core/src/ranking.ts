// Leaderboard ordering (spec AC-Q10, plan M2.4): score desc, then total server-measured answer
// time asc, then earliest finish asc with NULLS LAST (same order as the
// player_program_stats_ranking_idx index).
//
// Exact ties (equal score, total_ms and finished_at) share a rank, standard competition
// ranking "1224": the spec defines no fourth key, so core never splits a tie arbitrarily. A tie
// across a prize-tier boundary yields more candidates than slots and goes to the Owner, who
// confirms winners before they are published (AC-A9). Eligibility filtering (refunded players
// are excluded, AC-Q11) is the caller's job: pass only eligible entries.

export interface RankingEntry {
  readonly score: number;
  readonly totalMs: number;
  /** null or undefined = not finished (sorted last, NULLS LAST). */
  readonly finishedAt?: Date | null | undefined;
}

function assertEntry(entry: RankingEntry): void {
  if (!Number.isSafeInteger(entry.score) || entry.score < 0) {
    throw new RangeError("score must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(entry.totalMs) || entry.totalMs < 0) {
    throw new RangeError("totalMs must be a non-negative safe integer");
  }
  if (entry.finishedAt != null && Number.isNaN(entry.finishedAt.getTime())) {
    throw new RangeError("finishedAt must be a valid Date, null or undefined");
  }
}

/** Negative when `a` ranks ahead of `b`, positive when behind, 0 for an exact tie. */
export function compareRanking(a: RankingEntry, b: RankingEntry): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.totalMs !== b.totalMs) return a.totalMs - b.totalMs;
  const fa = a.finishedAt ?? null;
  const fb = b.finishedAt ?? null;
  if (fa === null || fb === null) {
    if (fa === fb) return 0;
    return fa === null ? 1 : -1;
  }
  return fa.getTime() - fb.getTime();
}

/**
 * Sorts (stable, so equal entries keep the caller's order) and assigns competition ranks:
 * rank = 1 + number of entries strictly ahead.
 */
export function assignRanks<T extends RankingEntry>(entries: readonly T[]): (T & { readonly rank: number })[] {
  entries.forEach(assertEntry);
  const sorted = [...entries].sort(compareRanking);
  const ranked: (T & { readonly rank: number })[] = [];
  sorted.forEach((entry, index) => {
    const previous = ranked[index - 1];
    const rank = previous !== undefined && compareRanking(previous, entry) === 0 ? previous.rank : index + 1;
    ranked.push({ ...entry, rank });
  });
  return ranked;
}
