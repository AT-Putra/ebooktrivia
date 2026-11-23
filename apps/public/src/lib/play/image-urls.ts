// The URLs of the pictures the Owner uploads, as the play pages show them, and the choice between an uploaded picture
// and the generic art of the asset pipeline. Pure (no server module), so the server components
// and their tests share it. The route that answers these URLs is lib/play/images.ts, on the play origin only (src/proxy.ts passes
// /api/v1/play/* through for that host alone):
//   /api/v1/play/img/set/{setId}/{uploadId}.webp      a set's thumbnail      (public, programs that are not drafts)
//   /api/v1/play/img/prize/{tierId}/{uploadId}.webp   a prize tier's image   (public, programs that are not drafts)
// The upload id is a version: replacing an image makes a new URL, so the old one may be cached for good. A question's image has
// no URL: question images are not shown to players (they await an encrypted, database-gated design).
import type { AssetId } from "../assets.ts";

export const IMAGE_PATH_PREFIX = "/api/v1/play/img";

export const setImageUrl = (setId: string, uploadId: string): string => `${IMAGE_PATH_PREFIX}/set/${setId}/${uploadId}.webp`;
export const prizeImageUrl = (tierId: string, uploadId: string): string => `${IMAGE_PATH_PREFIX}/prize/${tierId}/${uploadId}.webp`;

/** The generic art a set tile rotates through when the Owner has uploaded no thumbnail. */
export const SET_ART: readonly AssetId[] = ["set-history", "set-science", "set-nature", "set-geography", "set-culture", "set-sports"];

export type Art = { readonly kind: "upload"; readonly src: string } | { readonly kind: "generic"; readonly id: AssetId };

/** The picture of tile `n` (1..S): the set's uploaded thumbnail, else the generic art in rotation. */
export function setArt(set: { readonly thumbnailUrl: string | null }, n: number): Art {
  return set.thumbnailUrl === null ? { kind: "generic", id: SET_ART[(n - 1) % SET_ART.length] ?? "set-history" } : { kind: "upload", src: set.thumbnailUrl };
}

/** The banner's prize slot: the image of the tier that ranks first (rank 1), else the generic placeholder. */
export function prizeArt(tiers: readonly { readonly rankFrom: number; readonly imageUrl: string | null }[]): Art {
  const src = tiers.find((tier) => tier.rankFrom === 1)?.imageUrl ?? null;
  return src === null ? { kind: "generic", id: "prize-placeholder" } : { kind: "upload", src };
}

/** A tier row's own thumbnail: its image, unless the prize slot above already shows that very image (it is not repeated). */
export function tierRowImage(tier: { readonly imageUrl: string | null }, slot: Art): string | null {
  return tier.imageUrl === null || (slot.kind === "upload" && slot.src === tier.imageUrl) ? null : tier.imageUrl;
}
