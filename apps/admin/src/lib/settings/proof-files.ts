// Where fulfilment proofs live on disk (US-030; lib/settings/fulfillment-proof.ts stores them). Kept apart from the upload
// policy (which loads sharp), so the erasure and the sweeper can remove a proof file without it.
import { rm } from "node:fs/promises";
import { join } from "node:path";

export const PROOF_DIR = "proofs";
/** A proof's storage path under the data directory (public.fulfillment_set_proof accepts the same). */
export const PROOF_PATH = /^proofs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:webp|pdf)$/;
/** A proof's file name inside PROOF_DIR. */
export const PROOF_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:webp|pdf)$/;

/** Removes a stored proof file; a missing file, or one that cannot be removed now, is left to the upload sweeper. */
export async function removeProofFileQuietly(dataDir: string, storagePath: string): Promise<void> {
  if (!PROOF_PATH.test(storagePath)) return;
  await rm(join(dataDir, storagePath), { force: true }).catch(() => undefined);
}
