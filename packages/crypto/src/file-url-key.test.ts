import { describe, expect, it } from "vitest";
import { deriveFileUrlKey, FILE_URL_KEY_BYTES, fileUrlKeyFromEnv } from "./file-url-key.ts";
import { generateScopeKeyPair } from "./sealed-box.ts";

describe("deriveFileUrlKey", () => {
  const payment = generateScopeKeyPair();

  it("is 32 bytes, the same for the same payment key (the worker and the public app agree) and another key for another one", () => {
    const key = deriveFileUrlKey(payment.privateKey);
    expect(key).toHaveLength(FILE_URL_KEY_BYTES);
    expect(deriveFileUrlKey(payment.privateKey).equals(key)).toBe(true);
    expect(deriveFileUrlKey(generateScopeKeyPair().privateKey).equals(key)).toBe(false);
  });

  it("is not the payment private key itself", () => {
    expect(deriveFileUrlKey(payment.privateKey).equals(Buffer.from(payment.privateKey))).toBe(false);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => deriveFileUrlKey(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => deriveFileUrlKey(new Uint8Array(33))).toThrow(/32 bytes/);
  });
});

describe("fileUrlKeyFromEnv", () => {
  const payment = generateScopeKeyPair();
  const messaging = generateScopeKeyPair();
  const encoded = (key: Uint8Array): string => Buffer.from(key).toString("base64url");

  it("derives it from SECRETS_PAYMENT_PRIVATE_KEY alone, whatever other scopes the env holds", () => {
    const expected = deriveFileUrlKey(payment.privateKey);
    expect(fileUrlKeyFromEnv({ SECRETS_PAYMENT_PRIVATE_KEY: encoded(payment.privateKey) })?.equals(expected)).toBe(true);
    expect(fileUrlKeyFromEnv({ SECRETS_PAYMENT_PRIVATE_KEY: encoded(payment.privateKey), SECRETS_MESSAGING_PRIVATE_KEY: encoded(messaging.privateKey) })?.equals(expected)).toBe(true);
  });

  it("is undefined without the payment key, and a malformed key stops the caller", () => {
    expect(fileUrlKeyFromEnv({})).toBeUndefined();
    expect(fileUrlKeyFromEnv({ SECRETS_MESSAGING_PRIVATE_KEY: encoded(messaging.privateKey) })).toBeUndefined();
    expect(() => fileUrlKeyFromEnv({ SECRETS_PAYMENT_PRIVATE_KEY: "not-a-key" })).toThrow(/SECRETS_PAYMENT_PRIVATE_KEY/);
  });
});
