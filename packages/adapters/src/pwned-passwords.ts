// The breached-password check (US-031, ASVS V6.2.12): Have I Been Pwned's Pwned Passwords range API, k-anonymity.
// Only the first 5 hex characters of the password's SHA-1 leave the process (GET /range/<prefix>); the API answers
// every suffix it knows for that prefix, and the match is made here. `Add-Padding: true` makes the API pad each answer
// with random suffixes of count 0, so the response size does not tell an observer which prefix was asked for.
// https://haveibeenpwned.com/API/v3#PwnedPasswords (no API key; the range API is free to use).
//
// It never throws: a timeout (3 s), a network error, a refusal or an answer that is not a range list is "unavailable",
// never "breached"; the caller decides what that means (the worker retries, then gives up and fails open, the Owner's
// decision: apps/worker/src/password-check.ts). It takes the SHA-1, not the password: the admin app seals that hash to
// the worker and never calls the API itself (it has no egress). Requests go through safe-fetch (connect-time address
// checks, no redirects, a body cap) to this one fixed origin; tests inject `fetch`.
import { createHash } from "node:crypto";
import { createSafeFetch, SafeFetchError } from "./safe-fetch.ts";

export const PWNED_PASSWORDS_ORIGIN = "https://api.pwnedpasswords.com";
export const PWNED_PASSWORDS_TIMEOUT_MS = 3000;
/** A padded range answer is about 800 to 1,000 lines of 40 bytes; far below this. */
const MAX_BODY_BYTES = 256 * 1024;

export type PwnedResult =
  | { readonly status: "breached"; readonly count: number }
  | { readonly status: "clean" }
  | { readonly status: "unavailable"; readonly reason: string };

/** The part of safe-fetch the lookup needs (a SafeFetch is one). */
export type RangeFetch = (url: string, init: { readonly method: "GET"; readonly headers: Readonly<Record<string, string>> }) => Promise<{ readonly status: number; text(): Promise<string> }>;

/** Looks up a password by its SHA-1 (40 hex characters, any case): the worker never sees the password itself. */
export type PwnedLookup = (sha1: string) => Promise<PwnedResult>;

const RANGE_LINE = /^([0-9A-F]{35}):(\d+)$/;
const SHA1_HEX = /^[0-9A-F]{40}$/;

/** The SHA-1 the lookup takes, of a password (uppercase hex). */
export const passwordSha1 = (password: string): string => createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();

/** A lookup over `fetch` (default: a safe-fetch with the 3 s timeout and the body cap). */
export function createPwnedPasswordsLookup(fetch?: RangeFetch): PwnedLookup {
  const get: RangeFetch = fetch ?? createSafeFetch({ timeoutMs: PWNED_PASSWORDS_TIMEOUT_MS, maxBodyBytes: MAX_BODY_BYTES });
  return async (sha1) => {
    const hash = sha1.toUpperCase();
    if (!SHA1_HEX.test(hash)) return { status: "unavailable", reason: "bad_hash" };
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    let body: string;
    try {
      const response = await get(`${PWNED_PASSWORDS_ORIGIN}/range/${prefix}`, { method: "GET", headers: { "Add-Padding": "true" } });
      if (response.status !== 200) return { status: "unavailable", reason: `http_${String(response.status)}` };
      body = await response.text();
    } catch (error) {
      return { status: "unavailable", reason: error instanceof SafeFetchError ? error.code : "request_failed" };
    }
    let lines = 0;
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      const match = RANGE_LINE.exec(line);
      if (match === null) return { status: "unavailable", reason: "bad_body" };
      lines++;
      // A padding line has count 0: it is not a breached password.
      if (match[1] === suffix && Number(match[2]) > 0) return { status: "breached", count: Number(match[2]) };
    }
    return lines === 0 ? { status: "unavailable", reason: "bad_body" } : { status: "clean" };
  };
}
