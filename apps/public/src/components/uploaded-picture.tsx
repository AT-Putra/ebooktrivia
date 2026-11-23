interface UploadedPictureProps {
  /** A play-origin image URL (lib/play/image-urls.ts). */
  src: string;
  /** Empty string marks the picture as decorative. */
  alt: string;
  /** The box the picture is shown in: the browser reserves it before the file arrives (no layout shift). */
  width: number;
  height: number;
  className?: string;
  /** Above the fold (loaded at once); every other picture is lazy. */
  priority?: boolean;
}

/**
 * A picture the Owner uploaded (always WebP, re-encoded by the upload policy), served by lib/play/images.ts. Unlike Picture
 * (the asset pipeline's AVIF + WebP art) it has one source and no known intrinsic size, so the width and height are
 * those of the box it fills and the caller's classes crop it to it (object-cover or object-contain).
 */
export function UploadedPicture({ src, alt, width, height, className, priority = false }: UploadedPictureProps) {
  return (
    <img
      src={src}
      width={width}
      height={height}
      style={{ aspectRatio: `${String(width)} / ${String(height)}` }}
      alt={alt}
      className={className}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
    />
  );
}
