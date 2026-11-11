import { assetInfo, assetSrcSet, type AssetId } from "../lib/assets.ts";

interface PictureProps {
  id: AssetId;
  /** Empty string marks the art as decorative. */
  alt: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
}

/**
 * AVIF + WebP art with explicit width/height so the browser reserves space (CLS).
 * The inline aspect-ratio keeps the reservation when a class sets `h-auto`
 * (Chrome otherwise reports "lazy-loaded images should have explicit dimensions").
 */
export function Picture({ id, alt, className, sizes = "100vw", priority = false }: PictureProps) {
  const { width, height } = assetInfo(id);
  return (
    <picture>
      <source type="image/avif" srcSet={assetSrcSet(id, "avif")} sizes={sizes} />
      <source type="image/webp" srcSet={assetSrcSet(id, "webp")} sizes={sizes} />
      <img
        src={`/assets/${id}/${id}@1x.webp`}
        width={width}
        height={height}
        style={{ aspectRatio: `${String(width)} / ${String(height)}` }}
        alt={alt}
        sizes={sizes}
        className={className}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        decoding="async"
      />
    </picture>
  );
}
