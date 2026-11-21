import { describe, expect, it } from "vitest";
import { deliveryFilename, extractOrderCodes, MAX_CODE_CANDIDATES, senderVerdict } from "./buyer-first.ts";
import { newOrderCode, ORDER_CODE_PATTERN } from "./ids.ts";

describe("extractOrderCodes", () => {
  it("finds the code in the text the order page prefilled", () => {
    expect(extractOrderCodes("Halo, ini kode pesanan saya 7K3M9XQ2PA untuk Ebook Trivia Nusantara.")).toEqual(["7K3M9XQ2PA"]);
  });

  it("is case-insensitive and reads the Crockford look-alikes as their digits", () => {
    expect(extractOrderCodes("kode 7k3m9xq2pa")).toEqual(["7K3M9XQ2PA"]);
    expect(extractOrderCodes("O7K3M9XQ2P")).toEqual(["07K3M9XQ2P"]);
    expect(extractOrderCodes("IL7K3M9XQ2")).toEqual(["117K3M9XQ2"]);
    expect(extractOrderCodes("kode: 7K3M9XQ2PU")).toEqual([]);
  });

  it("only takes a whole word of exactly the code length", () => {
    expect(extractOrderCodes("7K3M9XQ2P")).toEqual([]);
    expect(extractOrderCodes("7K3M9XQ2PAB")).toEqual([]);
    expect(extractOrderCodes("7K3M9 XQ2PA")).toEqual([]);
    expect(extractOrderCodes("7K3M9-XQ2PA")).toEqual([]);
    expect(extractOrderCodes("")).toEqual([]);
    expect(extractOrderCodes("!!!")).toEqual([]);
  });

  it("returns each distinct candidate once, at most MAX_CODE_CANDIDATES", () => {
    expect(extractOrderCodes("7K3M9XQ2PA 7k3m9xq2pa")).toEqual(["7K3M9XQ2PA"]);
    const many = Array.from({ length: 9 }, () => newOrderCode()).join(" ");
    const found = extractOrderCodes(many);
    expect(found.length).toBeLessThanOrEqual(MAX_CODE_CANDIDATES);
    for (const code of found) expect(ORDER_CODE_PATTERN.test(code)).toBe(true);
  });

  it("round-trips real order codes", () => {
    for (let i = 0; i < 50; i++) {
      const code = newOrderCode();
      expect(extractOrderCodes(`kode pesanan ${code}!`)).toEqual([code]);
    }
  });
});

describe("senderVerdict: who wrote decides", () => {
  const orderPhone = "+6281234567890";
  it("verifies a phone chat that is the order's phone, and refuses another phone", () => {
    expect(senderVerdict({ orderPhone, sender: { kind: "phone", phone: orderPhone }, resolvedPhone: null })).toBe("verified");
    expect(senderVerdict({ orderPhone, sender: { kind: "phone", phone: "+6281111111111" }, resolvedPhone: orderPhone })).toBe("mismatch");
  });

  it("resolves an @lid sender through its number, and sends the PDF without a link when there is none", () => {
    expect(senderVerdict({ orderPhone, sender: { kind: "lid" }, resolvedPhone: orderPhone })).toBe("verified");
    expect(senderVerdict({ orderPhone, sender: { kind: "lid" }, resolvedPhone: "+6281111111111" })).toBe("mismatch");
    expect(senderVerdict({ orderPhone, sender: { kind: "lid" }, resolvedPhone: null })).toBe("unresolved");
  });

  it("ignores everything that is not a person's chat", () => {
    expect(senderVerdict({ orderPhone, sender: { kind: "other" }, resolvedPhone: orderPhone })).toBe("ignore");
  });
});

describe("deliveryFilename", () => {
  it("is the title as letters, digits and single hyphens, then .pdf", () => {
    expect(deliveryFilename("Ebook Trivia Nusantara")).toBe("Ebook-Trivia-Nusantara.pdf");
    expect(deliveryFilename("  Kuis: 100 Pertanyaan!! (Edisi 2)  ")).toBe("Kuis-100-Pertanyaan-Edisi-2.pdf");
    expect(deliveryFilename("Café Über")).toBe("Cafe-Uber.pdf");
  });

  it("falls back when nothing usable is left, and stays inside the file name limit", () => {
    expect(deliveryFilename("")).toBe("ebook.pdf");
    expect(deliveryFilename("???")).toBe("ebook.pdf");
    expect(deliveryFilename("日本語")).toBe("ebook.pdf");
    const long = deliveryFilename(`${"a".repeat(100)} ${"b".repeat(100)}`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith("-.pdf")).toBe(false);
    expect(deliveryFilename(`${"a".repeat(115)} bbbbbb`)).toBe(`${"a".repeat(115)}.pdf`);
  });
});
