// Key material for HMAC keys (shuffle key, OTP pepper). Keys are bytes, never strings: a text
// "key" of 32 characters can hold far fewer than 256 bits. Config (env) values are decoded
// strictly: canonical hex, base64 (padded) or base64url (unpadded), no whitespace, and at least
// MIN_SECRET_KEY_BYTES bytes, so a truncated or mistyped secret fails at startup instead of
// silently weakening the key.

export const MIN_SECRET_KEY_BYTES = 32;

export type SecretKeyEncoding = "hex" | "base64" | "base64url";

const PATTERNS: Readonly<Record<SecretKeyEncoding, RegExp>> = {
  hex: /^(?:[0-9A-Fa-f]{2})+$/,
  base64: /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
  base64url: /^[A-Za-z0-9_-]+$/,
};

export function decodeSecretKey(
  value: string,
  encoding: SecretKeyEncoding,
  minBytes: number = MIN_SECRET_KEY_BYTES,
): Buffer {
  if (value === "" || !PATTERNS[encoding].test(value)) throw new RangeError(`secret key is not valid ${encoding}`);
  const bytes = Buffer.from(value, encoding);
  // Round trip rejects non-canonical encodings (e.g. stray bits in the last base64 character).
  const canonical = bytes.toString(encoding);
  if (encoding === "hex" ? canonical !== value.toLowerCase() : canonical !== value) {
    throw new RangeError(`secret key is not canonical ${encoding}`);
  }
  assertSecretKey(bytes, "secret key", minBytes);
  return bytes;
}

export function assertSecretKey(
  key: unknown,
  name: string,
  minBytes: number = MIN_SECRET_KEY_BYTES,
): asserts key is Uint8Array {
  if (!(key instanceof Uint8Array)) throw new RangeError(`${name} must be bytes (Uint8Array), not ${typeof key}`);
  if (key.length < minBytes) throw new RangeError(`${name} must be at least ${minBytes} bytes`);
}
