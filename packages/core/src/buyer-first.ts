// Buyer-first inbound WhatsApp (plan M8.3, spec AC-D8, plan §10 item 23): reading the order code a buyer wrote and
// deciding whether the sender is the buyer. Pure; the worker feeds it the message it re-fetched from WAHA.
//
//   order code  10 Crockford base32 characters (core ORDER_CODE_LENGTH). A buyer types or pastes it, so it is
//               found case-insensitively inside the text, and the characters Crockford treats as look-alikes
//               are read as their digits (O -> 0, I and L -> 1); a code that is not exactly that shape is not
//               one. At most MAX_CODE_CANDIDATES distinct candidates are looked up per message.
//   sender      who wrote decides everything, never the code alone (a stranger who knows an order code must
//               never get the PDF or a login link):
//                 phone chat    the number must equal the order's phone: verified, or mismatch;
//                 @lid chat     WAHA resolves it to a number (the worker asked): the same comparison; no number
//                               behind the @lid: unresolved, the PDF without the login link (plan §10 item 23);
//                 anything else (a group, a broadcast, a foreign number): ignore, no reply at all.
import { ORDER_CODE_LENGTH, ORDER_CODE_PATTERN } from "./ids.ts";

export const MAX_CODE_CANDIDATES = 5;

/** A run of letters and digits, the only place a code can sit (the code is not split by spaces or punctuation). */
const WORD = /[0-9A-Za-z]+/g;
const LOOK_ALIKES: Readonly<Record<string, string>> = { O: "0", I: "1", L: "1" };

/** The distinct order-code candidates in `text`, in order of appearance (at most MAX_CODE_CANDIDATES). */
export function extractOrderCodes(text: string): string[] {
  const found: string[] = [];
  for (const word of text.match(WORD) ?? []) {
    if (word.length !== ORDER_CODE_LENGTH) continue;
    const code = word.toUpperCase().replace(/[OIL]/g, (c) => LOOK_ALIKES[c] ?? c);
    if (!ORDER_CODE_PATTERN.test(code) || found.includes(code)) continue;
    found.push(code);
    if (found.length === MAX_CODE_CANDIDATES) break;
  }
  return found;
}

/** The sender of an inbound message, as the worker read it (adapters ChatRef, structurally). */
export type InboundSender = { readonly kind: "phone"; readonly phone: string } | { readonly kind: "lid" } | { readonly kind: "other" };

export type SenderVerdict = "verified" | "unresolved" | "mismatch" | "ignore";

/** `resolvedPhone`: what WAHA's LID lookup answered for an @lid sender (null: it has no number behind it, or the lookup found none). */
export function senderVerdict(input: { readonly orderPhone: string; readonly sender: InboundSender; readonly resolvedPhone: string | null }): SenderVerdict {
  const { sender } = input;
  if (sender.kind === "other") return "ignore";
  if (sender.kind === "phone") return sender.phone === input.orderPhone ? "verified" : "mismatch";
  if (input.resolvedPhone === null) return "unresolved";
  return input.resolvedPhone === input.orderPhone ? "verified" : "mismatch";
}

const FILE_NAME_MAX = 120;
const FALLBACK_FILE_NAME = "ebook.pdf";

/**
 * The name the PDF travels under (WhatsApp file name, e-mail attachment): the product title cut down to letters,
 * digits and single hyphens, then ".pdf". The unknown-send lookup matches on it, so it is always the same
 * function of the title.
 */
export function deliveryFilename(title: string): string {
  const stem = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^0-9A-Za-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, FILE_NAME_MAX - ".pdf".length)
    .replace(/-+$/g, "");
  return stem === "" ? FALLBACK_FILE_NAME : `${stem}.pdf`;
}
