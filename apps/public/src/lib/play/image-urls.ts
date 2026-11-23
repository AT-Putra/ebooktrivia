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

/** The picture of a prize tier in the banner card: its uploaded image, else the built-in placeholder, so every prize card has one. */
export function prizeArt(tier: { readonly imageUrl: string | null }): Art {
  return tier.imageUrl === null ? { kind: "generic", id: "prize-placeholder" } : { kind: "upload", src: tier.imageUrl };
}
