import { describe, expect, it } from "vitest";
import { base32Decode, freshTotp, hotp, totp, wrongTotp } from "./totp.ts";

// RFC 6238 appendix B, SHA-1 key "12345678901234567890", 8 digits.
const RFC_KEY = Buffer.from("12345678901234567890");
const RFC_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp (RFC 6238 test vectors)", () => {
  it.each([
    [59, "94287082"],
    [1_111_111_109, "07081804"],
    [1_111_111_111, "14050471"],
    [1_234_567_890, "89005924"],
    [2_000_000_000, "69279037"],
  ])("T=%i -> %s", (seconds, code) => {
    expect(hotp(RFC_KEY, Math.floor(seconds / 30), 8)).toBe(code);
  });

  it("decodes base32 and uses the same key", () => {
    expect(base32Decode(RFC_BASE32)).toEqual(RFC_KEY);
    expect(totp(RFC_BASE32, 0, 59_000)).toBe("287082");
    expect(() => base32Decode("not!base32")).toThrow();
  });

  it("hands out distinct accepted codes and a never-valid wrong one", async () => {
    const used = new Set<string>();
    const a = await freshTotp(RFC_BASE32, used);
    const b = await freshTotp(RFC_BASE32, used);
    expect(a).not.toBe(b);
    expect([-1, 0, 1].map((o) => totp(RFC_BASE32, o))).toEqual(expect.arrayContaining([a, b]));
    expect([-2, -1, 0, 1, 2].map((o) => totp(RFC_BASE32, o))).not.toContain(wrongTotp(RFC_BASE32));
  });
});
