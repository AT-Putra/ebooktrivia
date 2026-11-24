// The sealed message id of the read marks (wa-read.ts): sealed to the messaging public key, opened with the private one, bound to session and chat digest.
import { describe, expect, it } from "vitest";
import { CryptoError, generateScopeKeyPair, SEALED_BOX_OVERHEAD } from "./index.ts";
import { seal } from "./sealed-box.ts";
import {
  createWaReadOpener,
  createWaReadSealer,
  WA_READ_SEALED_MAX_BYTES,
  waReadAad,
  waReadOpenerFromEnv,
  waReadSealerFromEnv,
} from "./wa-read.ts";

const messaging = generateScopeKeyPair();
const other = generateScopeKeyPair();
const labels = { session: "default", digest: "0123456789abcdef0123456789abcdef" };
const messageId = "false_628123456789@c.us_3EB0AAAA0001";

describe("a sealed WAHA message id", () => {
  it("is sealed to the messaging public key and opened by the worker; the blob holds no part of the id", () => {
    const sealed = createWaReadSealer(messaging.publicKey).seal({ ...labels, messageId });
    expect(sealed.length).toBe(Buffer.byteLength(messageId) + SEALED_BOX_OVERHEAD);
    expect(createWaReadOpener(messaging.privateKey).open({ ...labels, sealed })).toBe(messageId);
    for (const form of [sealed.toString("hex"), sealed.toString("base64url"), sealed.toString("base64"), sealed.toString("latin1")]) {
      expect(form).not.toContain("628123456789");
      expect(form).not.toContain("3EB0AAAA0001");
    }
    // A fresh ephemeral key every time: the same id seals to another blob.
    expect(createWaReadSealer(messaging.publicKey).seal({ ...labels, messageId }).equals(sealed)).toBe(false);
  });

  it("is bound to its session and chat digest, its key and every byte of it: anything else is decrypt_failed with no detail", () => {
    const sealed = createWaReadSealer(messaging.publicKey).seal({ ...labels, messageId });
    const opener = createWaReadOpener(messaging.privateKey);
    const fails = (run: () => unknown): void => {
      expect(run).toThrow(CryptoError);
      expect(run).toThrow("decryption failed");
    };
    fails(() => opener.open({ ...labels, session: "another", sealed }));
    fails(() => opener.open({ ...labels, digest: "f".repeat(32), sealed }));
    fails(() => createWaReadOpener(other.privateKey).open({ ...labels, sealed }));
    for (const i of [0, 31, 32, sealed.length - 1]) {
      const flipped = Buffer.from(sealed);
      flipped[i] = (flipped[i] ?? 0) ^ 1;
      fails(() => opener.open({ ...labels, sealed: flipped }));
    }
    fails(() => opener.open({ ...labels, sealed: Buffer.alloc(0) }));
    fails(() => opener.open({ ...labels, sealed: Buffer.alloc(SEALED_BOX_OVERHEAD) }));
    fails(() => opener.open({ ...labels, sealed: Buffer.alloc(WA_READ_SEALED_MAX_BYTES + 1) }));
  });

  it("refuses an id, a session or a digest that is not what WAHA and the webhook make, and a plaintext that is no id even when sealed with the right key", () => {
    const sealer = createWaReadSealer(messaging.publicKey);
    for (const bad of ["", "has space", "a|b", "x".repeat(129), "é"]) expect(() => sealer.seal({ ...labels, messageId: bad }), bad).toThrow(CryptoError);
    expect(() => sealer.seal({ session: "bad session", digest: labels.digest, messageId })).toThrow(CryptoError);
    expect(() => sealer.seal({ session: "x".repeat(65), digest: labels.digest, messageId })).toThrow(CryptoError);
    expect(() => sealer.seal({ session: "default", digest: "ABC", messageId })).toThrow(CryptoError);
    expect(() => waReadAad({ session: "default", digest: "g".repeat(32) })).toThrow(CryptoError);
    // Something sealed under the same AAD with the right key that is not an id (a bug elsewhere) is not handed on as one.
    const notAnId = seal(messaging.publicKey, Buffer.from("has a space"), waReadAad(labels));
    expect(() => createWaReadOpener(messaging.privateKey).open({ ...labels, sealed: notAnId })).toThrow("decryption failed");
  });

  it("refuses a key that is not a usable X25519 key, at start", () => {
    expect(() => createWaReadSealer(new Uint8Array(31))).toThrow(CryptoError);
    expect(() => createWaReadSealer(new Uint8Array(32))).toThrow(CryptoError); // the all-zero (low-order) key
    expect(() => createWaReadOpener(new Uint8Array(31))).toThrow(CryptoError);
  });

  it("is built from the messaging key of the environment, and from nothing when it is not set", () => {
    const sealer = waReadSealerFromEnv({ SECRETS_MESSAGING_PUBLIC_KEY: messaging.publicKey.toString("base64url") });
    const opener = waReadOpenerFromEnv({ SECRETS_MESSAGING_PRIVATE_KEY: messaging.privateKey.toString("base64url") });
    if (sealer === undefined || opener === undefined) throw new Error("both are built from their key");
    expect(opener.open({ ...labels, sealed: sealer.seal({ ...labels, messageId }) })).toBe(messageId);
    expect(waReadSealerFromEnv({})).toBeUndefined();
    expect(waReadOpenerFromEnv({ SECRETS_PAYMENT_PRIVATE_KEY: other.privateKey.toString("base64url") })).toBeUndefined();
    expect(() => waReadSealerFromEnv({ SECRETS_MESSAGING_PUBLIC_KEY: "not-a-key" })).toThrow(CryptoError);
  });
});
