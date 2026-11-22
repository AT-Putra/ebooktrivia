// The buyer generator of orders-50pm.js must make VALID Indonesian mobile numbers (the checkout rejects any other) that are
// unique for every order of a run, and click ids and e-mails the checkout's own shapes accept.
import { normalizeIdMobile } from "@ebooktrivia/core/phone";
import { SDK_LIMITS, SDK_PATTERNS } from "@ebooktrivia/core/sdk-contract";
import { describe, expect, it } from "vitest";
import { between, buyerFor, phoneFor } from "../k6/lib.js";

describe("k6 lib: buyers", () => {
  it("makes a unique, valid E.164 mobile number for each of 5000 orders, at the edges of the seed range too", () => {
    for (const seed of [0, 1, 89_999_998, 89_999_999, 79_999_999]) {
      const phones = new Set<string>();
      for (let i = 0; i < 5000; i++) {
        const phone = phoneFor(seed, i);
        const normalized = normalizeIdMobile(phone);
        expect(normalized.ok, `${phone} (seed ${String(seed)}, order ${String(i)})`).toBe(true);
        if (normalized.ok) expect(normalized.e164).toBe(phone);
        phones.add(phone);
      }
      expect(phones.size).toBe(5000);
    }
  });

  it("makes click ids, names and e-mails within the SDK contract", () => {
    const buyer = buyerFor(12_345_678, "345678", 42, "load.example.test");
    expect(buyer.email).toBe("lt345678.42@load.example.test");
    expect(buyer.clickid.length).toBeLessThanOrEqual(SDK_LIMITS.clickid);
    expect(new RegExp(SDK_PATTERNS.token).test(buyer.clickid)).toBe(true);
    // A click id that looks like a phone number or an e-mail address is dropped by the checkout (the order would be organic).
    expect(normalizeIdMobile(buyer.clickid).ok).toBe(false);
    expect(buyer.clickid).not.toContain("@");
    expect(buyer.name.length).toBeLessThanOrEqual(SDK_LIMITS.name);
  });

  it("picks a whole number inside the inclusive range for any random in [0, 1)", () => {
    expect(between(1000, 3000, 0)).toBe(1000);
    expect(between(1000, 3000, 0.999_999)).toBe(3000);
    expect(between(0, 3, 0.5)).toBe(2);
    expect(between(5, 5, 0.7)).toBe(5);
  });
});
