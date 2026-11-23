// The play origin's image route (./images.ts) remembers WHICH FILE a set thumbnail, prize image or program banner is, in-process, so a
// grid of 90 tiles costs one lookup per image per instance per 2 minutes instead of one query per request (each of the
// two apps/public instances has its own cache, like the leaderboard's: no Valkey key, no invalidation).
//   - key `${kind}:${ownerId}:${uploadId}` -> the upload's storage path; only what the database allowed is stored, so a
//     hit is exactly as allowed as the query was, at most IMAGE_CACHE_TTL_MS ago. ACCEPTED STALENESS, up to 120 s per instance:
//     an Owner can move a published program back to draft while it has no paid orders (the admin's unpublish), and its
//     thumbnails, prize images and banner stay served from the cache until their entries expire; and a replaced image has a new
//     upload id, so a stale entry only serves the old file under its old URL for that long. Both are low risk (these are
//     pictures the Owner showed on the sales page, nothing of a player or a question);
//   - at most IMAGE_CACHE_MAX entries, the least recently used one leaves first;
//   - NO negative entries: a miss is cheap (one indexed query, and the per-IP limit of the route counts it), while
//     remembering "not found" would let anyone who invents ids push the real entries out of a cache this small.
export const IMAGE_CACHE_MAX = 2000;
export const IMAGE_CACHE_TTL_MS = 120_000;

export interface ImageCache {
  get(key: string): string | undefined;
  set(key: string, storagePath: string): void;
}

export function createImageCache(options: { readonly max?: number; readonly ttlMs?: number; readonly now?: () => number } = {}): ImageCache {
  const max = options.max ?? IMAGE_CACHE_MAX;
  const ttlMs = options.ttlMs ?? IMAGE_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  // A Map keeps insertion order: the first key is the least recently used (a hit moves its entry to the end).
  const entries = new Map<string, { readonly path: string; readonly expires: number }>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      entries.delete(key);
      if (hit.expires <= now()) return undefined;
      entries.set(key, hit);
      return hit.path;
    },
    set(key, storagePath) {
      entries.delete(key);
      entries.set(key, { path: storagePath, expires: now() + ttlMs });
      for (const oldest of entries.keys()) {
        if (entries.size <= max) break;
        entries.delete(oldest);
      }
    },
  };
}

/** The instance's cache. */
export const imageCache: ImageCache = createImageCache();
