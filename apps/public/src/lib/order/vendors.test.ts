import { describe, expect, it } from "vitest";
import { parsePixelIds, vendorsOf } from "./vendors.ts";

const VALID = { meta: "1234567890123", tiktok: "ABCDEFGH12345678", gtag: "AW-123456789", gtag_label: "AbC_12-xyz" };

describe("parsePixelIds", () => {
  it("keeps valid ids of all three vendors, and Google's id with its label", () => {
    expect(parsePixelIds(VALID)).toEqual(VALID);
  });

  it("drops an id that is not in its vendor's format, so nothing odd reaches a CSP, a URL or a browser", () => {
    expect(parsePixelIds({ meta: "123", tiktok: "lowercase-not-valid!", gtag: "AW-1", gtag_label: "x" })).toEqual({});
    expect(parsePixelIds({ meta: "1234567890123; script-src *", tiktok: "ABCDEFGH12345678\n", gtag: "AW-123456789", gtag_label: "ok label" })).toEqual({});
    expect(parsePixelIds({ meta: 1234567890123, tiktok: null, gtag: ["AW-123456789"], gtag_label: {} })).toEqual({});
  });

  it("needs both Google values, or neither is used", () => {
    expect(parsePixelIds({ gtag: VALID.gtag })).toEqual({});
    expect(parsePixelIds({ gtag_label: VALID.gtag_label })).toEqual({});
  });

  it("ignores keys it does not know, and anything that is not an object", () => {
    expect(parsePixelIds({ ...VALID, evil: "x" })).toEqual(VALID);
    for (const raw of [null, undefined, "meta", 5, [VALID], true]) expect(parsePixelIds(raw)).toEqual({});
  });
});

describe("vendorsOf", () => {
  it("lists the vendors with an id in a fixed order", () => {
    expect(vendorsOf(VALID)).toEqual(["meta", "tiktok", "gtag"]);
    expect(vendorsOf({ tiktok: VALID.tiktok })).toEqual(["tiktok"]);
    expect(vendorsOf({})).toEqual([]);
  });
});
