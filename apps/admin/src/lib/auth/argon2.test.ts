import { describe, expect, it } from "vitest";
import { ARGON2_OPTIONS, hashSecret, MAX_SECRET_LENGTH, verifySecret } from "./argon2.ts";

describe("argon2id", () => {
  it("hashes with argon2id and the pinned parameters, salted per hash", async () => {
    const a = await hashSecret("correct horse battery staple");
    const b = await hashSecret("correct horse battery staple");
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(ARGON2_OPTIONS.memoryCost).toBeGreaterThanOrEqual(19_456);
    expect(a).not.toBe(b);
  });

  it("verifies the right secret only", async () => {
    const phc = await hashSecret("s3cret-value-123");
    expect(await verifySecret(phc, "s3cret-value-123")).toBe(true);
    expect(await verifySecret(phc, "s3cret-value-124")).toBe(false);
    expect(await verifySecret(phc, "")).toBe(false);
  });

  it("never throws on malformed hashes, other algorithms or over-long input", async () => {
    expect(await verifySecret("not-a-hash", "x")).toBe(false);
    expect(await verifySecret("$argon2id$garbage", "x")).toBe(false);
    expect(await verifySecret("$argon2i$v=19$m=4096,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA", "x")).toBe(false);
    const phc = await hashSecret("y");
    expect(await verifySecret(phc, "y".repeat(MAX_SECRET_LENGTH + 1))).toBe(false);
    await expect(hashSecret("y".repeat(MAX_SECRET_LENGTH + 1))).rejects.toThrow(RangeError);
  });
});
