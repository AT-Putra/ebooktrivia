import { describe, expect, it } from "vitest";
import { checkLpDomain } from "./lp-domains.ts";

// DOMAIN in these tests is a reserved name (RFC 2606 / 6761), never a real deployment value.
const APP = "example.test";

describe("checkLpDomain (risk R4: LP hosts never share a site with the app)", () => {
  it.each([
    ["shop.brand.example", "shop.brand.example"],
    ["Shop.Brand.Example", "shop.brand.example"],
    ["brand.co.id", "brand.co.id"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["user.github.io", "user.github.io"],
    ["  promo.brand.example  ", "promo.brand.example"],
  ])("accepts %s as %s", (input, host) => {
    expect(checkLpDomain(input, APP)).toEqual({ ok: true, host });
  });

  it.each([
    ["the app's own domain", "example.test"],
    ["an app subdomain", "admin.example.test"],
    ["the api origin", "api.example.test"],
    ["a deep app subdomain", "a.b.c.example.test"],
    ["mixed case of the app domain", "ExAmPlE.TeSt"],
    ["mixed case of an app subdomain", "PLAY.Example.Test"],
  ])("refuses %s (%s) as own_domain", (_what, input) => {
    expect(checkLpDomain(input, APP)).toEqual({ ok: false, reason: "own_domain" });
  });

  it("refuses a sibling under the app's registrable domain when DOMAIN is itself a subdomain", () => {
    expect(checkLpDomain("lp.example.test", "shop.example.test")).toEqual({ ok: false, reason: "own_domain" });
    expect(checkLpDomain("other.test", "shop.example.test")).toEqual({ ok: true, host: "other.test" });
  });

  it.each(["co.id", "github.io", "vercel.app", "web.id", "or.id"])("refuses the public suffix %s", (input) => {
    expect(checkLpDomain(input, APP)).toEqual({ ok: false, reason: "public_suffix" });
  });

  it.each([
    ["a trailing dot", "shop.brand.example."],
    ["a trailing dot on the app domain", "example.test."],
    ["two trailing dots", "shop.brand.example.."],
    ["an IPv4 literal", "203.0.113.7"],
    ["an IPv4 shorthand", "127.1"],
    ["an IPv6 literal", "[2001:db8::1]"],
    ["a bare IPv6", "2001:db8::1"],
    ["a port", "shop.brand.example:443"],
    // Only a bare host is ever registered, so a landing page's origin is always `https://<host>`
    // (the checkout API's CORS origin, US-020): no http origin, and no origin with a port, can be registered.
    ["a scheme", "https://shop.brand.example"],
    ["a plain-http scheme", "http://shop.brand.example"],
    ["a protocol-relative URL", "//shop.brand.example"],
    ["a path", "shop.brand.example/x"],
    ["a single label", "localhost"],
    ["a bare TLD", "com"],
    ["an underscore", "shop_1.brand.example"],
    ["an empty label", "shop..brand.example"],
    ["a leading hyphen", "-shop.brand.example"],
    ["an invalid A-label", "xn--.brand.example"],
    ["empty", ""],
  ])("refuses %s as invalid", (_what, input) => {
    expect(checkLpDomain(input, APP)).toEqual({ ok: false, reason: "invalid" });
  });

  it.each([
    ["a U-label", "bücher.example"],
    ["full-width letters", "ｅｘａｍｐｌｅ.test"],
    ["the Kelvin sign (folds to k)", "Kaos.example"],
    ["an ideographic full stop", "shop。brand.example"],
    ["a zero-width space", "sh​op.brand.example"],
    ["a soft hyphen", "sh­op.brand.example"],
  ])("refuses %s: Unicode must be entered as A-labels", (_what, input) => {
    expect(checkLpDomain(input, APP)).toEqual({ ok: false, reason: "unicode" });
  });

  it("refuses an A-label mixing Latin and Cyrillic letters (lookalike of a Latin name)", () => {
    // "pаypal" with a Cyrillic а (U+0430).
    const lookalike = new URL("https://pаypal.example").hostname;
    expect(lookalike.startsWith("xn--")).toBe(true);
    expect(checkLpDomain(lookalike, APP)).toEqual({ ok: false, reason: "mixed_script" });
  });

  it("accepts a single-script IDN A-label (Cyrillic only)", () => {
    const host = new URL("https://пример.example").hostname;
    expect(checkLpDomain(host, APP)).toEqual({ ok: true, host });
  });

  it("refuses everything when DOMAIN is not configured", () => {
    expect(checkLpDomain("shop.brand.example", null)).toEqual({ ok: false, reason: "no_app_domain" });
  });
});
