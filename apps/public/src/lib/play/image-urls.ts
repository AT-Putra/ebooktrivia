// The URLs of the pictures the Owner uploads, as the play pages show them, and the choice between an uploaded picture
// and the generic art of the asset pipeline. Pure (no server module), so the server components
// and their tests share it. The route that answers these URLs is lib/play/images.ts, on the play origin only (src/proxy.ts passes
// /api/v1/play/* through for that host alone):
//   /api/v1/play/img/set/{setId}/{uploadId}.webp          a set's thumbnail      (public, programs that are not drafts)
//   /api/v1/play/img/prize/{tierId}/{uploadId}.webp       a prize tier's image   (public, programs that are not drafts)
//   /api/v1/play/img/banner/{programId}/{uploadId}.webp   a program's banner     (public, programs that are not drafts)
// The upload id is a version: replacing an image makes a new URL, so the old one may be cached for good. A question's image has
// no URL: question images are not shown to players (they await an encrypted, database-gated design).
import type { AssetId } from "../assets.ts";

export const IMAGE_PATH_PREFIX = "/api/v1/play/img";

export const setImageUrl = (setId: string, uploadId: string): string => `${IMAGE_PATH_PREFIX}/set/${setId}/${uploadId}.webp`;
export const prizeImageUrl = (tierId: string, uploadId: string): string => `${IMAGE_PATH_PREFIX}/prize/${tierId}/${uploadId}.webp`;
export const bannerImageUrl = (programId: string, uploadId: string): string => `${IMAGE_PATH_PREFIX}/banner/${programId}/${uploadId}.webp`;

/** The generic art a set tile rotates through when the Owner has uploaded no thumbnail. */
export const SET_ART: readonly AssetId[] = ["set-history", "set-science", "set-nature", "set-geography", "set-culture", "set-sports"];

export type Art = { readonly kind: "upload"; readonly src: string } | { readonly kind: "generic"; readonly id: AssetId };

/** The picture of tile `n` (1..S): the set's uploaded thumbnail, else the generic art in rotation. */
export function setArt(set: { readonly thumbnailUrl: string | null }, n: number): Art {
  return set.thumbnailUrl === null ? { kind: "generic", id: SET_ART[(n - 1) % SET_ART.length] ?? "set-history" } : { kind: "upload", src: set.thumbnailUrl };
}

/** The big picture of the banner card: the program's uploaded banner, else the built-in art every program shared before. */
export function bannerArt(program: { readonly bannerUrl: string | null }): Art {
  return program.bannerUrl === null ? { kind: "generic", id: "banner-program" } : { kind: "upload", src: program.bannerUrl };
}

/** A prize tier as the banner card needs it to choose its pictures. */
interface TierPicture {
  readonly rankFrom: number;
  readonly imageUrl: string | null;
}

/**
 * The prize list of the banner card: the tier that starts at rank 1 is the FEATURED grand prize (a large tile: its uploaded
 * image, else the generic placeholder); every other tier is a compact row with ONE leading visual (its uploaded image, else
 * null: the medal icon stands in the same box). Each tier's picture is shown exactly once. `position` is the tier's place in
 * the whole list (the medal's tone: gold, silver, bronze). With no tier at rank 1 there is no featured tile.
 */
export interface PrizeLayout<T extends TierPicture> {
  readonly featured: { readonly tier: T; readonly position: number; readonly art: Art } | null;
  readonly rows: readonly { readonly tier: T; readonly position: number; readonly image: string | null }[];
}

export function prizeLayout<T extends TierPicture>(tiers: readonly T[]): PrizeLayout<T> {
  const first = tiers.findIndex((tier) => tier.rankFrom === 1);
  const entries = tiers.map((tier, position) => ({ tier, position }));
  const featured = first < 0 ? undefined : entries[first];
  return {
    featured: featured === undefined ? null : { ...featured, art: featured.tier.imageUrl === null ? { kind: "generic", id: "prize-placeholder" } : { kind: "upload", src: featured.tier.imageUrl } },
    rows: entries.filter((entry) => entry !== featured).map((entry) => ({ ...entry, image: entry.tier.imageUrl })),
  };
}
