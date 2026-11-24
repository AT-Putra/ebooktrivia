import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CryptoError,
  gcmDecrypt,
  gcmEncrypt,
  generateScopeKeyPair,
  isCryptoError,
  keyIdOf,
  open,
  privateKeyObject,
  publicKeyObject,
  rawPublicKey,
  seal,
  SEALED_BOX_OVERHEAD,
} from "./sealed-box.ts";

/** The 32-byte encodings of the X25519 points of small order (and their non-canonical twins). */
const LOW_ORDER_POINTS = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map((h) => Buffer.from(h, "hex"));

const pair = generateScopeKeyPair();
const priv = privateKeyObject(pair.privateKey);
const aad = Buffer.from("table|column|row");
const plaintext = Buffer.from("the midtrans server key");

function expectCode(fn: () => unknown, code: string): void {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(CryptoError);
  expect((error as CryptoError).code).toBe(code);
}

describe("sealed box", () => {
  it("round-trips and adds exactly 48 bytes (eph_pub 32 + tag 16)", () => {
    const sealed = seal(pair.publicKey, plaintext, aad);
    expect(SEALED_BOX_OVERHEAD).toBe(48);
    expect(sealed.length).toBe(plaintext.length + 48);
    expect(open(priv, sealed, aad).equals(plaintext)).toBe(true);
    expect(seal(pair.publicKey, Buffer.alloc(0), aad).length).toBe(48);
    expect(open(priv, seal(pair.publicKey, Buffer.alloc(0), aad), aad).length).toBe(0);
  });

  it("two seals of the same plaintext differ (fresh ephemeral key, so fresh key and nonce)", () => {
    const a = seal(pair.publicKey, plaintext, aad);
    const b = seal(pair.publicKey, plaintext, aad);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(0, 32).equals(b.subarray(0, 32))).toBe(false);
    expect(a.subarray(32).equals(b.subarray(32))).toBe(false);
  });

  it("fails closed when any single byte (eph_pub, ciphertext or tag) is flipped", () => {
    const sealed = seal(pair.publicKey, plaintext, aad);
    for (let i = 0; i < sealed.length; i++) {
      const tampered = Buffer.from(sealed);
      tampered[i] = (tampered[i] ?? 0) ^ 0x01;
      expectCode(() => open(priv, tampered, aad), "decrypt_failed");
    }
  });

  it("fails closed on a wrong AAD, a wrong key, truncation or extension", () => {
    const sealed = seal(pair.publicKey, plaintext, aad);
    expectCode(() => open(priv, sealed, Buffer.from("table|column|other")), "decrypt_failed");
    expectCode(() => open(priv, sealed, Buffer.alloc(0)), "decrypt_failed");
    expectCode(() => open(privateKeyObject(generateScopeKeyPair().privateKey), sealed, aad), "decrypt_failed");
    expectCode(() => open(priv, sealed.subarray(0, sealed.length - 1), aad), "decrypt_failed");
    expectCode(() => open(priv, Buffer.concat([sealed, Buffer.of(0)]), aad), "decrypt_failed");
    expectCode(() => open(priv, sealed.subarray(0, 47), aad), "decrypt_failed");
  });

  it("rejects every low-order recipient public key, and an opened box with a low-order eph_pub", () => {
    for (const point of LOW_ORDER_POINTS) {
      expectCode(() => seal(point, plaintext, aad), "invalid_key");
      const forged = Buffer.concat([point, randomBytes(plaintext.length + 16)]);
      expectCode(() => open(priv, forged, aad), "decrypt_failed");
    }
  });

  it("refuses keys that are not 32 raw bytes", () => {
    expectCode(() => seal(Buffer.alloc(31, 9), plaintext, aad), "invalid_key");
    expectCode(() => publicKeyObject(Buffer.alloc(33, 9)), "invalid_key");
    expectCode(() => privateKeyObject(Buffer.alloc(16, 9)), "invalid_key");
    expectCode(() => keyIdOf(Buffer.alloc(31, 9)), "invalid_key");
  });

  it("key_id = first 16 hex chars of SHA-256(raw public key); the private key derives the public key", () => {
    expect(keyIdOf(pair.publicKey)).toBe(createHash("sha256").update(pair.publicKey).digest("hex").slice(0, 16));
    expect(rawPublicKey(priv).equals(pair.publicKey)).toBe(true);
    expect(rawPublicKey(publicKeyObject(pair.publicKey)).equals(pair.publicKey)).toBe(true);
  });
});

describe("AES-256-GCM helpers", () => {
  const key = randomBytes(32);
  const nonce = randomBytes(12);

  it("round-trip, and fail closed on any flipped byte, a wrong nonce, key or AAD", () => {
    const ct = gcmEncrypt(key, nonce, plaintext, aad);
    expect(ct.length).toBe(plaintext.length + 16);
    expect(gcmDecrypt(key, nonce, ct, aad).equals(plaintext)).toBe(true);
    for (let i = 0; i < ct.length; i++) {
      const tampered = Buffer.from(ct);
      tampered[i] = (tampered[i] ?? 0) ^ 0x80;
      expectCode(() => gcmDecrypt(key, nonce, tampered, aad), "decrypt_failed");
    }
    expectCode(() => gcmDecrypt(key, randomBytes(12), ct, aad), "decrypt_failed");
    expectCode(() => gcmDecrypt(randomBytes(32), nonce, ct, aad), "decrypt_failed");
    expectCode(() => gcmDecrypt(key, nonce, ct, Buffer.from("x")), "decrypt_failed");
  });

  it("refuses malformed inputs instead of passing them to the cipher", () => {
    const ct = gcmEncrypt(key, nonce, plaintext, aad);
    expectCode(() => gcmDecrypt(key.subarray(0, 16), nonce, ct, aad), "decrypt_failed");
    expectCode(() => gcmDecrypt(key, nonce.subarray(0, 8), ct, aad), "decrypt_failed");
    expectCode(() => gcmDecrypt(key, nonce, ct.subarray(0, 15), aad), "decrypt_failed");
  });
});

describe("isCryptoError", () => {
  /** A CryptoError as ANOTHER copy of this package throws it (a Next.js app has one copy per bundle): the same name and shape, not this module's class. */
  class OtherCopyCryptoError extends Error {
    readonly code: string;
    constructor(code: string) {
      super("refused");
      this.name = "CryptoError";
      this.code = code;
    }
  }

  it("is true for this copy's CryptoError and for another copy's (same name, a known code)", () => {
    expect(isCryptoError(new CryptoError("invalid_input", "x"))).toBe(true);
    expect(isCryptoError(new OtherCopyCryptoError("invalid_input"))).toBe(true);
    expect(isCryptoError(new OtherCopyCryptoError("decrypt_failed"))).toBe(true);
  });

  it("is false for anything else: other errors, an unknown code, a look-alike object that is not an Error", () => {
    expect(isCryptoError(new Error("x"))).toBe(false);
    expect(isCryptoError(new TypeError("x"))).toBe(false);
    expect(isCryptoError(new OtherCopyCryptoError("not_a_code"))).toBe(false);
    expect(isCryptoError({ name: "CryptoError", code: "invalid_input" })).toBe(false);
    expect(isCryptoError(undefined)).toBe(false);
    expect(isCryptoError("CryptoError")).toBe(false);
  });
});
