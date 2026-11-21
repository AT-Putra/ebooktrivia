// Signed file URLs for WAHA sendFile (plan M3.3): minted at send time, valid 10 minutes, usable
// several times (WAHA may retry the download), bound to one path. The api app's /files route
// verifies them; the PDF itself is never public.
//
//   url = https://api.<domain>/files/<path>?exp=<unix seconds>&sig=<base64url HMAC-SHA256>
//   sig = HMAC-SHA256(key, "ebooktrivia/files/v1\n" + path + "\n" + exp)

import { createHmac, timingSafeEqual } from "node:crypto";
import { assertSecretKey } from "@ebooktrivia/core";

export const FILE_URL_TTL_SECONDS = 600;
/**
 * The longest a URL may live: the 72-hour link of the e-mail fallback for an ebook the SMTP server refused to carry
 * (US-025) fits; WAHA gets the default 10 minutes. Signing refuses a longer one, and so does verifying (a URL whose expiry is
 * further out than this, signed by whoever held the key, is not one of ours).
 */
export const MAX_FILE_URL_TTL_SECONDS = 72 * 3600;

const DOMAIN = "ebooktrivia/files/v1";
const SAFE_PATH = /^\/files\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
/** base64url (no padding) of a 32-byte HMAC-SHA256. */
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

/** Under /files/, plain segments only, no "." or ".." (signing and verifying use the same rule). */
const isSafePath = (path: string): boolean => SAFE_PATH.test(path) && !path.split("/").some((s) => s === "." || s === "..");

function signature(key: Uint8Array, path: string, exp: number): Buffer {
  return createHmac("sha256", key).update(`${DOMAIN}\n${path}\n${String(exp)}`).digest();
}

/** Mints a signed URL for `path` (e.g. "/files/products/abc/ebook.pdf") under `origin`. */
export function signFileUrl(input: { origin: string; path: string; key: Uint8Array; now: Date; ttlSeconds?: number }): string {
  assertSecretKey(input.key, "file URL key");
  if (!isSafePath(input.path)) throw new RangeError("invalid file path");
  const ttl = input.ttlSeconds ?? FILE_URL_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_FILE_URL_TTL_SECONDS) throw new RangeError(`ttlSeconds must be 1..${String(MAX_FILE_URL_TTL_SECONDS)}`);
  const exp = Math.floor(input.now.getTime() / 1000) + ttl;
  const url = new URL(input.path, input.origin);
  if (url.protocol !== "https:") throw new RangeError("file URLs must be https");
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", signature(input.key, input.path, exp).toString("base64url"));
  return url.href;
}

export type FileUrlCheck = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: "malformed" | "bad_signature" | "expired" };

/** Verifies a signed file URL (path + query) in constant time; multi-use until it expires. */
export function verifyFileUrl(input: { path: string; exp: string | null; sig: string | null; key: Uint8Array; now: Date }): FileUrlCheck {
  assertSecretKey(input.key, "file URL key");
  if (input.exp === null || input.sig === null || !/^[0-9]{1,12}$/.test(input.exp) || !isSafePath(input.path)) return { ok: false, reason: "malformed" };
  // Only the canonical spelling: 43 base64url characters that re-encode to themselves (Node's
  // decoder ignores padding, junk and the last character's 2 unused bits).
  if (!SIGNATURE.test(input.sig)) return { ok: false, reason: "malformed" };
  const given = Buffer.from(input.sig, "base64url");
  if (given.toString("base64url") !== input.sig) return { ok: false, reason: "malformed" };
  const exp = Number(input.exp);
  const expected = signature(input.key, input.path, exp);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (nowSeconds >= exp) return { ok: false, reason: "expired" };
  if (exp > nowSeconds + MAX_FILE_URL_TTL_SECONDS) return { ok: false, reason: "malformed" };
  return { ok: true, path: input.path };
}
