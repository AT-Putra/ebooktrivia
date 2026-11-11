import manifest from "@ebooktrivia/ui/assets/manifest.json";

export type AssetId =
  | "banner-program"
  | "prize-placeholder"
  | "set-culture"
  | "set-geography"
  | "set-history"
  | "set-nature"
  | "set-science"
  | "set-sports"
  | "overlay-lock"
  | "overlay-unlocked-glow"
  | "overlay-completed-badge"
  | "status-pending"
  | "status-paid"
  | "status-expired";

export interface AssetInfo {
  /** 1x intrinsic size, used for width/height attributes so layout is reserved (no CLS). */
  width: number;
  height: number;
  /** 2x intrinsic width, for the srcset w-descriptor. */
  width2x: number;
}

export function assetInfo(id: AssetId): AssetInfo {
  const one = manifest.find((e) => e.id === id && e.scale === 1 && e.format === "webp");
  const two = manifest.find((e) => e.id === id && e.scale === 2 && e.format === "webp");
  if (one === undefined || two === undefined) throw new Error(`asset not in manifest: ${id}`);
  return { width: one.width, height: one.height, width2x: two.width };
}

export function assetSrcSet(id: AssetId, format: "avif" | "webp"): string {
  const { width, width2x } = assetInfo(id);
  return `/assets/${id}/${id}@1x.${format} ${width}w, /assets/${id}/${id}@2x.${format} ${width2x}w`;
}
