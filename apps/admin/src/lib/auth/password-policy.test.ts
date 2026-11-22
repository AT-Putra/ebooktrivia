// The admin password rule (US-031, ASVS V6.2.4 / V6.2.11 / V6.1.2): length only as composition, refused when common
// or built on the product's, the domain's or the e-mail's words.
import { describe, expect, it } from "vitest";
import { validateAdminUserInput } from "../admin-users.ts";
import { COMMON_PASSWORDS } from "./common-passwords.ts";
import { CONTEXT_WORDS, contextWords, passwordProblem } from "./password-policy.ts";

describe("the bundled common-password list", () => {
  it("holds 10,000 lowercased, unique entries that the length rule alone would accept", () => {
    expect(COMMON_PASSWORDS).toHaveLength(10_000);
    expect(new Set(COMMON_PASSWORDS).size).toBe(10_000);
    for (const entry of COMMON_PASSWORDS) {
      expect(entry.length, entry).toBeGreaterThanOrEqual(12);
      expect(entry, entry).toBe(entry.toLowerCase());
    }
    // The most common ones are at the top (frequency order of the source).
    expect(COMMON_PASSWORDS.slice(0, 2)).toEqual(["q1w2e3r4t5y6", "1qaz2wsx3edc"]);
  });
});

describe("passwordProblem", () => {
  it("keeps length as the only composition rule: 12 to 128 characters of any kind", () => {
    expect(passwordProblem("a".repeat(11))).toBe("length");
    expect(passwordProblem("x".repeat(129))).toBe("length");
    expect(passwordProblem("zq7 ~ é ünïcødé 🐉")).toBeNull();
    expect(passwordProblem("k".repeat(64))).toBeNull(); // at least 64 characters are allowed (V6.2.9)
  });

  it("refuses a common password whatever its case, and accepts an uncommon one", () => {
    expect(passwordProblem("q1w2e3r4t5y6")).toBe("common");
    expect(passwordProblem("1QAZ2WSX3EDC")).toBe("common");
    expect(passwordProblem(COMMON_PASSWORDS[9_999] ?? "")).toBe("common");
    expect(passwordProblem("violet-harbor-lamp-31")).toBeNull();
  });

  it("refuses a password that is the product's, the domain's or the e-mail's words plus a little", () => {
    for (const word of CONTEXT_WORDS) {
      expect(passwordProblem(`${word.toUpperCase()}${word}2026`), word).toBe("context"); // 4 characters left
      expect(passwordProblem(`${word}${word}-2026x`), word).toBeNull(); // 6 left: its own part is long enough
    }
    expect(passwordProblem("EbookTrivia2026!")).toBe("context");
    expect(passwordProblem("Rahmawati-2026", { email: "rahmawati@toko.example" })).toBe("context");
    expect(passwordProblem("tokobuku12345", { origin: "https://admin.tokobuku.example" })).toBe("context");
    // Enough of its own left over: a passphrase that merely contains one is fine.
    expect(passwordProblem("my trivia night with friends")).toBeNull();
    expect(passwordProblem("owner-trivia-e2e-1", { email: "owner-1732@example.test" })).toBeNull();
  });

  it("is the rule of a new account (an Owner bootstrap, a new Staff member)", () => {
    const input = { email: "rahmawati@toko.example", displayName: "Rahma" };
    expect(validateAdminUserInput({ ...input, password: "q1w2e3r4t5y6" })).toBe("password");
    expect(validateAdminUserInput({ ...input, password: "Rahmawati!2026" })).toBe("password");
    expect(validateAdminUserInput({ ...input, password: "violet-harbor-lamp-31" })).toBeNull();
  });

  it("derives the account's words: the e-mail's local part (split at symbols) and the domain labels but admin, www and the TLD", () => {
    const words = contextWords({ email: "Budi.Santoso@toko.example", origin: "https://admin.tokobuku.co.id" });
    expect(words).toEqual(expect.arrayContaining(["budi", "santoso", "tokobuku"]));
    expect(words).not.toContain("admin");
    expect(words).not.toContain("id");
    expect(contextWords({ origin: "not an origin" })).toEqual(CONTEXT_WORDS.filter((w) => w.length >= 4));
  });
});
