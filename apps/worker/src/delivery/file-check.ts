// Checks of the ebook PDF around a WhatsApp sendFile (US-005, R11). The Owner's WEBJS instance does NOT refuse a file URL it cannot fetch: it takes the answer page
// (a 404's HTML, 21 KB) as the document, sends it under the requested file name and answers 201. So a send that "worked" can put a garbage file in the buyer's chat, and
// neither the answer nor the ack tells. Two checks, both on our side:
//   before  the worker fetches the first bytes of its own signed URL (EbookFiles.preflight) and does not send unless it answers the stored file;
//   after   the sent message is read back (getMessage) and the size WAHA delivered (mediaSize, WEBJS _data.size) is compared with the stored file's size.
// A wrong size is NEVER resent (the buyer already has the message): the delivery is marked and the Owner is alerted.
import type { WahaClient } from "@ebooktrivia/adapters";
import { DELIVERED_WRONG_FILE } from "@ebooktrivia/core";
import type { Logger } from "../log.ts";
import { READBACK_TIMEOUT_MS } from "./config.ts";

/** last_error of a delivery whose file arrived with the wrong size: the delivery is `sent`, and it needs a person (the console lists it under "Needs attention"). */
export { DELIVERED_WRONG_FILE };
/** The not_attempted code of a send that was not made because the signed file URL did not answer the stored file. */
export const FILE_UNAVAILABLE = "file_unavailable";

export interface WrongFile {
  readonly expected: number;
  readonly delivered: number;
}

/**
 * The size WAHA delivered for the message just sent, or undefined when it cannot be known (the read failed or ran out of its budget, or the engine does not say): an
 * unknown size is NOT an error and never marks a delivery, it is logged at debug (a code only). The read has a budget of its own (READBACK_TIMEOUT_MS, counted in the
 * lease floor): it runs after the send, inside the claim's lease, and must never wait out the client's whole-request timeout.
 */
export async function deliveredSize(client: WahaClient, session: string, messageId: string, log: Logger): Promise<number | undefined> {
  try {
    const message = await client.getMessage(session, messageId, { timeoutMs: READBACK_TIMEOUT_MS });
    if (message?.mediaSize === undefined) log.debug({ known: message !== null }, "the delivered size of the file is not known; nothing to compare");
    return message?.mediaSize;
  } catch (error) {
    log.debug({ code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "failed" }, "the sent file could not be read back; nothing to compare");
    return undefined;
  }
}

/** The comparison: a known delivered size that is not the stored file's size. */
export const wrongFile = (expected: number, delivered: number | undefined): WrongFile | undefined => (delivered === undefined || delivered === expected ? undefined : { expected, delivered });
