// The pictures the Owner uploads for the play pages (GET play.<DOMAIN>/api/v1/play/img/...; URLs in ./image-urls.ts):
// a set's thumbnail, a prize tier's image and a program's banner. The admin console stores them as WebP (the upload policy
// re-encodes every image) in <data dir>/images/<upload id>.webp together with a smaller DISPLAY COPY images/<upload id>.display.webp
// (@ebooktrivia/core content-images.ts: thumbnails fit 480 x 600, prize images 256 x 256, banners 1344 x 448), which is what is served; an
// image without a display copy (not backfilled yet) is served in its original size, with a warning in the log.
// /srv/data/images is mounted read-only here (infra/quadlet/public@.container). A QUESTION's image is NOT served at all (it
// is stored in question-images/, which this app does not mount, and public_rw cannot read questions.image_upload_id):
// a picture is a part of the question and may not be readable before the question is served.
//
//   set/{setId}/{uploadId}.webp, prize/{tierId}/{uploadId}.webp, banner/{programId}/{uploadId}.webp   PUBLIC (no session: the grid and
//       banner ask for dozens at once, and a thumbnail or a prize picture is what the Owner shows on the sales page too), but only
//       through the owning row: the URL names the set (or tier, or program) AND the upload id, which must be that row's own thumbnail /
//       image / banner, and the program (the set's or tier's own, or the program itself) must not be a draft (published or later). An upload id alone is never a path: no arbitrary id, no other upload kind, no
//       question image. Immutable for a year: replacing the image changes the upload id, so the URL.
//
// Every refusal is the same bare 404 with no detail (an unknown id, a draft program, a question image, another upload, a file
// that is missing or a link, a malformed path), so nothing tells which. The path is matched whole against a fixed pattern and the
// file path comes from the uploads row, which must be exactly `images/<its own id>.webp` (never from the request), opened without
// following a link and streamed from the open handle (./safe-file.ts). The Content-Type is fixed (image/webp) with nosniff, a CSP
// `sandbox` and Cross-Origin-Resource-Policy same-origin. Nothing is logged but an outcome code (never an id, a path or a cookie).
//
// COST: the lookup (one joined query: owning row, its program, the upload) is cached in-process (./image-cache.ts: 2000 entries,
// 2 minutes, nothing negative). Only a cache MISS is counted against a per-client limit (Valkey, `play:img:ip:<bucket>`: 300 a
// minute per IPv6 /64 or IPv4 address, sized for carrier-grade NAT, since a grid of 90 tiles is 90 first-time lookups, and
// `play:img:net:<bucket>`: ten times that per IPv6 /48, like the other play limits); a hit touches neither Valkey nor the database. With Valkey down the limit fails OPEN (the answer is public, cached, and the lookup
// is one indexed query): the route stays up with its other protections (the owning-row check, the cache).
import { displayImagePath, isPublicImagePath } from "@ebooktrivia/core";
import { clientIp, throttleBucket, throttleBucket48 } from "@ebooktrivia/edge";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Sql } from "../db.ts";
import { openRegularFile } from "../safe-file.ts";
import { hitRateLimits, ValkeyUnavailable } from "../valkey.ts";
import type { PlayDeps } from "./handlers.ts";
import { type ImageCache, imageCache } from "./image-cache.ts";
import { IMAGE_PATH_PREFIX } from "./image-urls.ts";
import { PLAY_LIMITS } from "./limits.ts";

export type ImageDeps = Pick<PlayDeps, "sql" | "valkey" | "log" | "dataDir">;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATH = new RegExp(`^${IMAGE_PATH_PREFIX}/(set|prize|banner)/(${UUID})/(${UUID})\\.webp$`);

export type ImageKind = "set" | "prize" | "banner";

export interface ImageMissLimit {
  /** Cache misses per client (an IPv6 /64 or an IPv4 address) per window. */
  readonly perIp: number;
  /** Cache misses per IPv6 /48 (one site, up to 65536 /64 networks) per window. */
  readonly perNet: number;
  readonly windowMs: number;
}

/** Per minute: a grid of 90 tiles is 90 first lookups, and a mobile carrier's NAT shares one address among many players; a /48 gets the other play limits' factor on top. */
export const IMAGE_MISS_LIMIT: ImageMissLimit = { perIp: 300, perNet: 300 * PLAY_LIMITS.ip48Factor, windowMs: 60_000 };

/** How many uploads one instance warns about (once each) before it stops remembering which: a missing display copy is a deploy-order mistake, not a stream of events. */
const WARNED_MAX = 10_000;

/** Immutable: the URL carries the upload id. */
const IMMUTABLE = "public, max-age=31536000, immutable";

const HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
} as const;

const bare = (status: number, extra: Record<string, string> = {}): Response => new Response(null, { status, headers: { ...HEADERS, "cache-control": "no-store", ...extra } });

/** The one answer to everything that is not allowed (or not there). Not cached: a program that is published later must show. */
const notFound = (): Response => bare(404);

/** The upload the owning row points at, only for a program that is not a draft and an image the upload policy made; null otherwise. */
async function ownedImagePath(sql: Sql, kind: ImageKind, ownerId: string, uploadId: string): Promise<string | null> {
  const [row] =
    kind === "set"
      ? await sql<{ storage_path: string }[]>`
          SELECT u.storage_path
            FROM public.trivia_sets s
            JOIN public.programs p ON p.id = s.program_id
            JOIN public.uploads u ON u.id = s.thumbnail_upload_id
           WHERE s.id = ${ownerId} AND s.thumbnail_upload_id = ${uploadId} AND p.status <> 'draft' AND u.kind = 'image' AND u.content_type = 'image/webp'`
      : kind === "prize"
        ? await sql<{ storage_path: string }[]>`
          SELECT u.storage_path
            FROM public.prize_tiers t
            JOIN public.programs p ON p.id = t.program_id
            JOIN public.uploads u ON u.id = t.image_upload_id
           WHERE t.id = ${ownerId} AND t.image_upload_id = ${uploadId} AND p.status <> 'draft' AND u.kind = 'image' AND u.content_type = 'image/webp'`
        : await sql<{ storage_path: string }[]>`
          SELECT u.storage_path
            FROM public.programs p
            JOIN public.uploads u ON u.id = p.banner_upload_id
           WHERE p.id = ${ownerId} AND p.banner_upload_id = ${uploadId} AND p.status <> 'draft' AND u.kind = 'image' AND u.content_type = 'image/webp'`;
  // The path of a thumbnail, prize image or banner and no other (a question image's is question-images/..., never served here).
  return row !== undefined && isPublicImagePath(uploadId, row.storage_path) ? row.storage_path : null;
}

/** The answer's headers and the file: the display copy, else the original. HEAD gets the headers only. */
async function serve(deps: ImageDeps, request: Request, uploadId: string, storagePath: string, warned: Set<string>): Promise<Response> {
  let opened = await openRegularFile(join(deps.dataDir, displayImagePath(uploadId)));
  if (opened === null) {
    opened = await openRegularFile(join(deps.dataDir, storagePath));
    if (opened === null) {
      deps.log("warn", "play.image", { route: "play.image", outcome: "missing_file" });
      return notFound();
    }
    // Said once per upload per instance (the original is served on every request until the backfill makes the copy).
    if (!warned.has(uploadId) && warned.size < WARNED_MAX) {
      warned.add(uploadId);
      deps.log("warn", "play.image", { route: "play.image", outcome: "display_missing" });
    }
  }
  const headers = { ...HEADERS, "cache-control": IMMUTABLE, "content-type": "image/webp", "content-length": String(opened.size) };
  if (request.method === "HEAD") {
    await opened.handle.close();
    return new Response(null, { status: 200, headers });
  }
  // The stream closes the handle when it ends, fails or is cancelled.
  return new Response(Readable.toWeb(opened.handle.createReadStream()) as ReadableStream, { status: 200, headers });
}

/** Counts a cache miss against the client's budget; the refusal to send back, or null (allowed, or Valkey down: fail open). */
async function missLimit(deps: ImageDeps, request: Request, limits: ImageMissLimit): Promise<Response | null> {
  const ip = clientIp(request.headers);
  const network = throttleBucket48(ip);
  try {
    // The /48 first, then the client: a refusal by the first counts nothing for the second (hitRateLimits).
    const decision = await hitRateLimits(deps.valkey, [
      ...(network === null ? [] : [{ key: `play:img:net:${network}`, limit: limits.perNet, windowMs: limits.windowMs }]),
      { key: `play:img:ip:${throttleBucket(ip)}`, limit: limits.perIp, windowMs: limits.windowMs },
    ]);
    if (decision.allowed) return null;
    deps.log("warn", "play.refused", { route: "play.image", reason: "rate_limited" });
    return bare(429, { "retry-after": String(decision.retryAfterSeconds) });
  } catch (error) {
    if (!(error instanceof ValkeyUnavailable)) throw error;
    deps.log("warn", "play.image", { route: "play.image", reason: "valkey_unavailable" });
    return null;
  }
}

/** The public pictures of a set (its thumbnail), of a prize tier or of a program (its banner), for programs that are not drafts. */
export function ownedImageHandler(kind: ImageKind, cache: ImageCache = imageCache, limits: ImageMissLimit = IMAGE_MISS_LIMIT) {
  const warned = new Set<string>();
  return async (deps: ImageDeps, request: Request): Promise<Response> => {
    const match = PATH.exec(new URL(request.url).pathname);
    if (match === null || match[1] !== kind) return notFound();
    const ownerId = match[2] ?? "";
    const uploadId = match[3] ?? "";
    const key = `${kind}:${ownerId}:${uploadId}`;
    try {
      let storagePath = cache.get(key);
      if (storagePath === undefined) {
        const limited = await missLimit(deps, request, limits);
        if (limited !== null) return limited;
        // Through the owning row: its own image, in a program that has been published.
        const found = await ownedImagePath(deps.sql, kind, ownerId, uploadId);
        if (found === null) return notFound();
        cache.set(key, found);
        storagePath = found;
      }
      return await serve(deps, request, uploadId, storagePath, warned);
    } catch (error) {
      deps.log("error", "play.failed", { route: "play.image", reason: "internal" }, error);
      return bare(503, { "retry-after": "5" });
    }
  };
}

export const handleSetImage = ownedImageHandler("set");
export const handlePrizeImage = ownedImageHandler("prize");
export const handleBannerImage = ownedImageHandler("banner");
