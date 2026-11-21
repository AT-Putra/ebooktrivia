// The leaderboard's top N, cached in-process for LEADERBOARD_TTL_MS per program (plan M9.2: "the top-N list is
// cached for 5 s, and my rank is computed fresh on every read"). In-process on purpose: each of the two
// apps/public instances asks PostgreSQL at most once per program every 5 s, which needs no Valkey key, no new
// Valkey command for the `public` ACL user and no invalidation. A load in flight is shared (one query for a burst
// of refreshes); a failed load is not cached. The entry's load time is the "updated ... ago" of the page. Each
// instance has its own cache, so two refreshes that the load balancer sends to different instances can show
// ages that jump back and forth by up to 5 s (code review MINOR-12): harmless, the label rounds to "baru saja".
import type { LeaderRow } from "./trivia-data.ts";

export const LEADERBOARD_TTL_MS = 5_000;

export interface TopList {
  readonly rows: readonly LeaderRow[];
  /** When the rows were read (epoch ms, this instance's clock). */
  readonly loadedAt: number;
}

export interface TopCache {
  get(programId: string, load: () => Promise<readonly LeaderRow[]>): Promise<TopList>;
}

export function createTopCache(now: () => number = Date.now, ttlMs = LEADERBOARD_TTL_MS): TopCache {
  const entries = new Map<string, { readonly at: number; readonly value: Promise<TopList> }>();
  return {
    get(programId, load) {
      const at = now();
      const hit = entries.get(programId);
      if (hit !== undefined && at - hit.at < ttlMs) return hit.value;
      // Expired entries go first, so the map never outgrows the programs read in the last 5 s.
      for (const [key, entry] of entries) if (at - entry.at >= ttlMs) entries.delete(key);
      const value = load().then((rows) => ({ rows, loadedAt: at }));
      entries.set(programId, { at, value });
      value.catch(() => {
        if (entries.get(programId)?.value === value) entries.delete(programId);
      });
      return value;
    },
  };
}

/** The instance's cache, shared by the page and the API. */
export const topCache: TopCache = createTopCache();
