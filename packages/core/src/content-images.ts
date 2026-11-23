// Where the Owner's content images live under the data directory (/srv/data), shared by the admin app (which writes
// them), its maintenance CLI and the public app (which serves some of them to players). The upload policy re-encodes
// every image to WebP; the admin stores the file and its `uploads` row (kind image, type image/webp):
//
//   images/<upload id>.webp             a set's thumbnail or a prize tier's image: shown to players, so the public app
//                                       mounts this directory read-only (infra/quadlet/public@.container)
//   images/<upload id>.display.webp     the display copy of those two (a smaller WebP, DISPLAY_BOXES): what the play
//                                       pages actually load. Not an uploads row: its path is derived from the id.
//   question-images/<upload id>.webp    a question's image: NOT mounted into the public app (a question's picture is a
//                                       part of the question and must not be readable before it is served); it awaits
//                                       an encrypted, database-gated design before players can be shown it
//
// A path is always built from an upload id (a UUID) and a fixed name here, never from anything else.

/** What an uploaded content image is for. */
export type ContentImagePurpose = "thumbnail" | "prize" | "question";

/** Shown to players (mounted into the public app). */
export const CONTENT_IMAGE_DIR = "images";
/** Not shown to players, not mounted into the public app. */
export const QUESTION_IMAGE_DIR = "question-images";

/** The box a display copy fits inside (never enlarged): the play pages show a thumbnail at ~220 px wide (x2 for dense screens) and a prize at 96 px. */
export const DISPLAY_BOXES = {
  thumbnail: { width: 480, height: 600 },
  prize: { width: 256, height: 256 },
} as const;

/** The stored path (`uploads.storage_path`) of a content image of `purpose`. */
export const contentImagePath = (purpose: ContentImagePurpose, uploadId: string): string =>
  `${purpose === "question" ? QUESTION_IMAGE_DIR : CONTENT_IMAGE_DIR}/${uploadId}.webp`;

/** The display copy of a set thumbnail or prize image: a sibling of the stored file, never an `uploads` row of its own. */
export const displayImagePath = (uploadId: string): string => `${CONTENT_IMAGE_DIR}/${uploadId}.display.webp`;

/** True when `storagePath` is exactly where a set thumbnail or prize image `uploadId` is stored: the only path the play pages' route serves. */
export const isPublicImagePath = (uploadId: string, storagePath: string): boolean => storagePath === contentImagePath("thumbnail", uploadId);
