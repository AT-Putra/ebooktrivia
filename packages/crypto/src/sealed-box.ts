// X25519 sealed box (HPKE-style, single shot; plan M2.3). node:crypto only.
//
//   seal(recipient_pub, pt, aad):
//     eph = fresh X25519 key pair
//     shared = X25519(eph_priv, recipient_pub)            all-zero (low-order point) rejected
//     okm = HKDF-SHA256(ikm = shared, salt = eph_pub || recipient_pub,
//                       info = "ebooktrivia/sealedbox/v1", L = 44)
//     key = okm[0..32], nonce = okm[32..44]
//     out = eph_pub (32) || AES-256-GCM(key, nonce, pt, aad) || tag (16)     overhead 48 bytes
//   open(recipient_priv, sealed, aad) reverses it and fails closed (CryptoError decrypt_failed)
//   on any error: short input, low-order eph_pub, wrong key, wrong AAD, any flipped byte.
//
// Keys are raw 32-byte X25519 keys. key_id = first 16 hex chars of SHA-256(raw public key).
// The nonce is derived, never sent: every seal has a fresh ephemeral key, so (key, nonce) never
// repeats.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  timingSafeEqual,
} from "node:crypto";

export const X25519_KEY_BYTES = 32;
export const GCM_TAG_BYTES = 16;
export const GCM_NONCE_BYTES = 12;
export const SEALED_BOX_OVERHEAD = X25519_KEY_BYTES + GCM_TAG_BYTES;

const INFO = Buffer.from("ebooktrivia/sealedbox/v1", "utf8");
const OKM_BYTES = 44;
const ZERO = Buffer.alloc(X25519_KEY_BYTES);
// DER prefixes of an X25519 SubjectPublicKeyInfo / PKCS#8 PrivateKeyInfo (RFC 8410) holding a
// raw 32-byte key.
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export type CryptoErrorCode =
  | "decrypt_failed"
  | "key_mismatch"
  | "scope_unavailable"
  | "invalid_key"
  | "invalid_input"
  | "binding_mismatch";

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}

const CRYPTO_ERROR_CODES: ReadonlySet<string> = new Set<CryptoErrorCode>(["decrypt_failed", "key_mismatch", "scope_unavailable", "invalid_key", "invalid_input", "binding_mismatch"]);

/**
 * True for a CryptoError of ANY copy of this package. A Next.js app bundles a copy per bundle, and an object one bundle built (a sealer, an opener on the
 * process-wide runtime) throws its own copy's class, so `instanceof CryptoError` in another bundle is false. The name and a known code decide instead.
 */
export function isCryptoError(error: unknown): error is CryptoError {
  if (error instanceof CryptoError) return true;
  if (!(error instanceof Error) || error.name !== "CryptoError") return false;
  const code: unknown = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && CRYPTO_ERROR_CODES.has(code);
}

const decryptFailed = (): CryptoError => new CryptoError("decrypt_failed", "decryption failed");

function rawKey(key: Uint8Array, what: string): Buffer {
  if (!(key instanceof Uint8Array) || key.length !== X25519_KEY_BYTES) {
    throw new CryptoError("invalid_key", `${what} must be ${X25519_KEY_BYTES.toString()} raw bytes`);
  }
  return Buffer.from(key);
}

export function publicKeyObject(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, rawKey(raw, "X25519 public key")]), format: "der", type: "spki" });
}

export function privateKeyObject(raw: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, rawKey(raw, "X25519 private key")]),
    format: "der",
    type: "pkcs8",
  });
}

/** Raw 32-byte public key of an X25519 KeyObject (public or private). */
export function rawPublicKey(key: KeyObject): Buffer {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  return pub.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
}

/** First 16 hex chars of SHA-256(raw public key). */
export function keyIdOf(rawPublic: Uint8Array): string {
  return createHash("sha256").update(rawKey(rawPublic, "X25519 public key")).digest("hex").slice(0, 16);
}

/** A fresh scope key pair, raw bytes (for provisioning and tests). */
export function generateScopeKeyPair(): { publicKey: Buffer; privateKey: Buffer } {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: rawPublicKey(pair.publicKey),
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length),
  };
}

/** X25519 + HKDF: the AES-256-GCM key and nonce. Throws on a low-order (all-zero) result. */
function deriveKeyNonce(privateKey: KeyObject, peerPublic: KeyObject, ephPub: Buffer, recipientPub: Buffer) {
  // OpenSSL already fails the derivation for every low-order point; the zero check is the
  // construction's own rule and stays in case the backend ever stops doing so.
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey, publicKey: peerPublic });
  } catch {
    throw new CryptoError("invalid_key", "X25519 key agreement failed (low-order public key)");
  }
  if (timingSafeEqual(shared, ZERO)) throw new CryptoError("invalid_key", "X25519 shared secret is all zero");
  const okm = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephPub, recipientPub]), INFO, OKM_BYTES));
  shared.fill(0);
  return { key: okm.subarray(0, 32), nonce: okm.subarray(32, OKM_BYTES), okm };
}

/** seal() with a given ephemeral private key. Internal: only for the known-answer test. */
export function sealWithEphemeral(
  ephemeralPrivate: KeyObject,
  recipientPublic: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Buffer {
  const recipientPub = rawKey(recipientPublic, "recipient public key");
  const ephPub = rawPublicKey(ephemeralPrivate);
  const { key, nonce, okm } = deriveKeyNonce(ephemeralPrivate, publicKeyObject(recipientPub), ephPub, recipientPub);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);
  const out = Buffer.concat([ephPub, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  okm.fill(0);
  return out;
}

export function seal(recipientPublic: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  return sealWithEphemeral(generateKeyPairSync("x25519").privateKey, recipientPublic, plaintext, aad);
}

/** Opens a sealed box; any failure is CryptoError("decrypt_failed"), with no detail. */
export function open(recipientPrivate: KeyObject, sealed: Uint8Array, aad: Uint8Array): Buffer {
  if (!(sealed instanceof Uint8Array) || sealed.length < SEALED_BOX_OVERHEAD) throw decryptFailed();
  const box = Buffer.from(sealed);
  const ephPub = box.subarray(0, X25519_KEY_BYTES);
  const body = box.subarray(X25519_KEY_BYTES, box.length - GCM_TAG_BYTES);
  const tag = box.subarray(box.length - GCM_TAG_BYTES);
  let okm: Buffer | undefined;
  try {
    const derived = deriveKeyNonce(recipientPrivate, publicKeyObject(ephPub), ephPub, rawPublicKey(recipientPrivate));
    okm = derived.okm;
    const decipher = createDecipheriv("aes-256-gcm", derived.key, derived.nonce, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw decryptFailed();
  } finally {
    okm?.fill(0);
  }
}

/** AES-256-GCM: ciphertext || 16-byte tag. */
export function gcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** Reverses gcmEncrypt; any failure is CryptoError("decrypt_failed"). */
export function gcmDecrypt(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Buffer {
  if (key.length !== 32 || nonce.length !== GCM_NONCE_BYTES || sealed.length < GCM_TAG_BYTES) throw decryptFailed();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - GCM_TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - GCM_TAG_BYTES)), decipher.final()]);
  } catch {
    throw decryptFailed();
  }
}
