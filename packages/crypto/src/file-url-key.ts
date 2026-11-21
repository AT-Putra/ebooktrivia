// The key of the signed ebook download URLs (adapters signed-url.ts; US-025). The worker mints them (WAHA fetches the
// PDF from one, and the e-mail fallback carries one) and the public app verifies them at api.<DOMAIN>/files, so
// both need the same 32 bytes. They already share one secret: the payment-scope private key, which worker.env and
// public.env both hold (public.env holds it ALONE). The URL key is derived from it with HKDF-SHA256 under its own salt and
// info strings, so it is another key than the sealed-box key (a different purpose never uses the same bytes) and nothing
// extra has to be generated, copied between the two env files or rotated: provisioning gives each file its own @GEN@
// values, so a separate FILE_URL_KEY would differ between them. Rotating the payment key also rotates this one: links
// minted before the rotation stop verifying (they live minutes, or 72 h for the e-mail fallback).
//
// What the key allows: forging a download URL for a file under /files/ (the ebook PDF). The public app that holds the
// payment key reads that file anyway (its volume is mounted for the route), so no capability is added to it.
import { hkdfSync } from "node:crypto";
import { CryptoError } from "./sealed-box.ts";
import { type Env, scopeKeysFromEnv } from "./secrets.ts";

const SALT = "ebooktrivia/file-url-key";
const INFO = "v1";
export const FILE_URL_KEY_BYTES = 32;

/** The signed-URL key derived from a payment-scope private key (X25519, 32 bytes). */
export function deriveFileUrlKey(paymentPrivateKey: Uint8Array): Buffer {
  if (paymentPrivateKey.length !== 32) throw new CryptoError("invalid_key", "the payment private key must be 32 bytes");
  return Buffer.from(hkdfSync("sha256", paymentPrivateKey, SALT, INFO, FILE_URL_KEY_BYTES));
}

/** The key from SECRETS_PAYMENT_PRIVATE_KEY, or undefined when the env holds none (no URL can then be signed or verified). */
export function fileUrlKeyFromEnv(env: Env): Buffer | undefined {
  const key = scopeKeysFromEnv(env, "PRIVATE").payment;
  return key === undefined ? undefined : deriveFileUrlKey(key);
}
