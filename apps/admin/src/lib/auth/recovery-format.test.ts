import { describe, expect, it } from "vitest";
import { formatRecoveryCode, generateRecoveryCodes, normalizeRecoveryCode, RECOVERY_CODE_COUNT, selectorOf } from "./recovery-format.ts";

describe("recovery codes", () => {
  it("generates 10 distinct 16-character Crockford base32 codes with distinct selectors", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(RECOVERY_CODE_COUNT).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(new Set(codes.map(selectorOf)).size).toBe(codes.length);
  });

  it("uses the whole alphabet roughly uniformly (80 random bits per code)", () => {
    const counts = new Map<string, number>();
    for (const code of generateRecoveryCodes(2000)) for (const ch of code) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(32);
    const expected = (2000 * 16) / 32;
    for (const n of counts.values()) expect(Math.abs(n - expected)).toBeLessThan(expected * 0.15);
  });

  it("formats as XXXX-XXXX-XXXX-XXXX and normalizes what users type", () => {
    const code = "ABCD0123EFGH4567";
    expect(formatRecoveryCode(code)).toBe("ABCD-0123-EFGH-4567");
    expect(normalizeRecoveryCode("ABCD-0123-EFGH-4567")).toBe(code);
    expect(normalizeRecoveryCode(" abcd 0123 efgh 4567 ")).toBe(code);
    expect(normalizeRecoveryCode("ABCD-O123-EFGH-4567")).toBe(code);
    expect(normalizeRecoveryCode("ABCD-0I23-EFGH-4567")).toBe(code);
    expect(normalizeRecoveryCode("ABCD-0l23-EFGH-4567")).toBe("ABCD0123EFGH4567");
  });

  it("rejects anything that cannot be a code", () => {
    expect(normalizeRecoveryCode("")).toBeNull();
    expect(normalizeRecoveryCode("ABCD-0123-EFGH-456")).toBeNull();
    expect(normalizeRecoveryCode("ABCD-0123-EFGH-45678")).toBeNull();
    expect(normalizeRecoveryCode("ABCD-0123-EFGH-456U")).toBeNull();
    expect(normalizeRecoveryCode("ABCD-0123-EFGH-456!")).toBeNull();
    expect(normalizeRecoveryCode("A".repeat(65))).toBeNull();
  });
});
