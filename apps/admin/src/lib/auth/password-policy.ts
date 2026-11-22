// The admin password rule (US-031; ASVS V6.2.1, V6.2.4, V6.2.5, V6.2.11, V6.1.2). Length is the only composition rule
// (12 to 128 characters, any characters). On top of it a password is refused when it is
//   - one of the 10,000 most common passwords of that length (common-passwords.ts, SecLists, MIT), compared
//     case-insensitively; or
//   - built on context words: the product's names (CONTEXT_WORDS), the e-mail's local part and the console's own domain
//     labels. With every such word taken out, fewer than CONTEXT_REMAINDER_MIN characters may not remain
//     ("EbookTrivia2026!" leaves "2026!": refused; a passphrase that merely contains "trivia" is fine).
// Checked where a password is set: enrolment (lib/auth/service.ts startEnrollment), a new account and an Owner reset
// (lib/admin-users.ts), and the CLI's recover. Not at sign-in: an existing password stays valid until it is changed
// (V6.2.10). The list is documented in docs/asvs-l2-checklist.md (V6.1.2). Once it is set, the worker checks it against
// known breaches (V6.2.12, lib/auth/password-check.ts): a breached password must be changed at the next sign-in.
import { COMMON_PASSWORDS } from "./common-passwords.ts";
import { PASSWORD_MAX, PASSWORD_MIN } from "./request.ts";

const COMMON: ReadonlySet<string> = new Set(COMMON_PASSWORDS);

/** The documented context-specific words (V6.1.2): the product, its parts and the services it is known with. */
export const CONTEXT_WORDS: readonly string[] = ["ebooktrivia", "ebook", "trivia", "arena", "midtrans", "whatsapp"];

/** Characters that must remain once every context word is taken out of a password. */
export const CONTEXT_REMAINDER_MIN = 6;

export type PasswordProblem = "length" | "common" | "context";

export interface PasswordContext {
  /** The account's e-mail: its local part is a context word. */
  readonly email?: string | undefined;
  /** The console's origin (ADMIN_ORIGIN): its host labels other than admin, www and the TLD are context words. */
  readonly origin?: string | undefined;
}

/** The context words of one account: the documented ones plus its e-mail's local part and the domain's labels. */
export function contextWords(context: PasswordContext): string[] {
  const words = [...CONTEXT_WORDS];
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local !== undefined) words.push(...local.split(/[^a-z0-9]+/));
  if (context.origin !== undefined) {
    try {
      const labels = new URL(context.origin).hostname.toLowerCase().split(".");
      words.push(...labels.slice(0, -1).filter((label) => label !== "admin" && label !== "www"));
    } catch {
      // not an origin: no domain words
    }
  }
  return [...new Set(words.filter((word) => word.length >= 4))];
}

/** Why `password` may not be set for this account, or null when it may. */
export function passwordProblem(password: string, context: PasswordContext = {}): PasswordProblem | null {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return "length";
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "common";
  // Longest words first, so "ebooktrivia" goes before "ebook" and "trivia" leave a part of it behind.
  let rest = lower;
  for (const word of contextWords(context).sort((a, b) => b.length - a.length)) rest = rest.split(word).join("");
  if (rest !== lower && rest.length < CONTEXT_REMAINDER_MIN) return "context";
  return null;
}

/** The console's origin for the context words, if it is configured (never throws). */
export const configuredOrigin = (): string | undefined => process.env["ADMIN_ORIGIN"] ?? undefined;
