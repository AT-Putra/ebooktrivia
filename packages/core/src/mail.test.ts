import { describe, expect, it } from "vitest";
import { isUuid } from "./ids.ts";
import { isPlainAddress, isSafeDisplayName, isSafeFileName } from "./mail.ts";
import { TEST_SEND_SAMPLE_VALUES } from "./test-send.ts";
import { MESSAGE_VARIABLES } from "./template.ts";

describe("mail rules", () => {
  it("plain addresses", () => {
    expect(isPlainAddress("name@example.test")).toBe(true);
    for (const bad of ["name", "@example.test", "a@b@example.test", "a b@example.test", "a@example", `${"a".repeat(65)}@example.test`, `a@${"b".repeat(250)}.test`, "Toko <a@example.test>"]) {
      expect(isPlainAddress(bad), bad).toBe(false);
    }
  });

  it("display names", () => {
    expect(isSafeDisplayName("Toko Ebook")).toBe(true);
    for (const bad of ["", 'A "B"', "a,b", "a\r\nBcc: x", "x".repeat(65)]) expect(isSafeDisplayName(bad), bad).toBe(false);
  });

  it("file names", () => {
    expect(isSafeFileName("Ebook Musim 1.pdf")).toBe(true);
    for (const bad of ["", ".hidden.pdf", "a/b.pdf", "a\b.pdf", 'a"b.pdf', "a\nb.pdf", "x".repeat(129), "a:b.pdf"]) expect(isSafeFileName(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe("ids and test-send samples", () => {
  it("uuid", () => {
    expect(isUuid("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
    for (const bad of ["0F8FAD5B-D9CB-469F-A165-70867728950E", "x", 5, null]) expect(isUuid(bad)).toBe(false);
  });

  it("has a sample for every message variable", () => {
    expect(Object.keys(TEST_SEND_SAMPLE_VALUES).sort()).toEqual([...MESSAGE_VARIABLES].sort());
  });
});
