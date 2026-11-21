// The proof of a prize fulfilment (US-030): a photo, a screenshot or a PDF receipt the Owner uploads.
//
// The upload policy (@ebooktrivia/uploads checkUpload, kind "proof") decides from the BYTES: JPEG, PNG, WebP or PDF only (SVG
// and everything else refused), the declared name and type must agree; an image is decoded under a pixel limit and re-encoded to
// WebP with every metadata block (EXIF incl. GPS, XMP, IPTC, ICC) dropped, so a phone photo keeps no location; a PDF is stored as
// it is (it is only ever downloaded as an attachment). Cap: PROOF_MAX_BYTES as uploaded, one request (Caddy's 30 s body timeout:
// 4 MiB is ~32 s at 1 Mbit/s, ~4 s at 10 Mbit/s), checked before anything is parsed.
//
// Stored PRIVATELY: <ADMIN_DATA_DIR>/proofs/<upload id>.webp|.pdf, mode 0640, written exclusively ("wx") before the transaction
// that inserts its uploads row (kind proof; the original file name is NOT kept: it may name the winner) and links it through
// public.fulfillment_set_proof (owner prize_fulfillment, which audits it), and removed again if that transaction fails. Only the
// admin container mounts /srv/data whole (the public and worker containers mount deliverables/ only), and no route serves the
// directory: the Owner downloads a proof through the audited POST route (lib/next/proof-routes.ts). A REPLACED proof is deleted
// (its row by the function, its file here right after the commit); the upload sweeper removes a proof file left without a row.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkUpload, DEFAULT_UPLOAD_LIMITS, UploadRejected } from "@ebooktrivia/uploads";
import { currentMutationScope, NoMutationScopeError } from "../audit.ts";
import type { Sql } from "../db.ts";
import { bounded } from "./contest.ts";
import type { SettingsConfig } from "./env.ts";
import { InvalidInput } from "./fields.ts";
import { HALTED } from "./fulfillment.ts";
import { PROOF_DIR, removeProofFileQuietly } from "./proof-files.ts";
import { BUSY } from "./trivia.ts";

export const PROOF_MAX_BYTES = 4 * 1024 * 1024;

const PROOF_LIMITS = Object.freeze({ ...DEFAULT_UPLOAD_LIMITS, proofMaxBytes: PROOF_MAX_BYTES, imageMaxDimension: 2048, imageMaxInputPixels: 16_000_000 });

const REJECTIONS: Readonly<Partial<Record<UploadRejected["code"], string>>> = {
  too_large: "The proof is larger than 4 MB.",
  svg_not_allowed: "SVG files are not accepted: use a JPEG, PNG or WebP photo, or a PDF.",
  extension_mismatch: "The file name's extension does not match the file (use .jpg, .png, .webp or .pdf).",
  mime_mismatch: "The file type does not match the file.",
  invalid_image: "The image cannot be read. Save it again as JPEG, PNG or WebP and retry.",
};

const MESSAGES: Readonly<Record<string, string>> = {
  ET170: "The request could not run safely. Try again.",
  ET171: "Only an active Owner can do this, with a valid file. Reload the page and try again.",
  ET172: "Only a confirmed winner of a finalized program gets a proof.",
  ET082: HALTED,
  "55P03": BUSY,
  "57014": BUSY,
};

export interface ProofUpload {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
}

/** Checks the file, stores it and makes it the fulfilment's proof (the previous one is deleted). */
export async function storeProof(sql: Sql, settings: SettingsConfig, fulfillmentId: string, file: ProofUpload): Promise<void> {
  if (settings.dataDir === null) throw new InvalidInput("Uploads are not configured on the server (ADMIN_DATA_DIR).");
  const scope = currentMutationScope();
  if (scope === undefined || scope.actor.kind !== "admin") throw new NoMutationScopeError();
  const actorId = scope.actor.userId;
  let accepted: Awaited<ReturnType<typeof checkUpload>>;
  try {
    accepted = await checkUpload({ kind: "proof", bytes: file.bytes, filename: file.filename, mimeType: file.mimeType }, PROOF_LIMITS);
  } catch (error) {
    if (!(error instanceof UploadRejected)) throw error;
    throw new InvalidInput(REJECTIONS[error.code] ?? "This file is not a JPEG, PNG or WebP image or a PDF.");
  }
  const uploadId = randomUUID();
  const storagePath = `${PROOF_DIR}/${uploadId}${accepted.type === "pdf" ? ".pdf" : ".webp"}`;
  const path = join(settings.dataDir, storagePath);
  await mkdir(join(settings.dataDir, PROOF_DIR), { recursive: true });
  await writeFile(path, accepted.bytes, { flag: "wx", mode: 0o640 });
  let replaced: string | null;
  try {
    replaced = await bounded(sql, MESSAGES, async (tx) => {
      await tx`
        INSERT INTO public.uploads (id, kind, storage_path, original_filename, content_type, size_bytes, sha256, created_by_admin_user_id)
        VALUES (${uploadId}, 'proof', ${storagePath}, NULL, ${accepted.contentType}, ${accepted.bytes.length}, ${createHash("sha256").update(accepted.bytes).digest()}, ${actorId})`;
      const [row] = await tx<{ s: { replaced_storage_path?: string | null } }[]>`
        SELECT public.fulfillment_set_proof(${fulfillmentId}::uuid, ${uploadId}::uuid, ${actorId}, ${scope.requestId}, ${scope.ip}::inet) AS s`;
      return row?.s.replaced_storage_path ?? null;
    });
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  if (replaced !== null) await removeProofFileQuietly(settings.dataDir, replaced);
}
