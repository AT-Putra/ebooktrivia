import { describe, expect, it } from "vitest";
import { normalizeHost } from "./hosts.ts";

describe("normalizeHost (Caddy ask)", () => {
  it.each([
    ["shop.example.com", "shop.example.com"],
    ["Shop.Example.COM", "shop.example.com"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["XN--BCHER-KVA.EXAMPLE", "xn--bcher-kva.example"],
    ["a-b.c-d.example", "a-b.c-d.example"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["only a dot", "."],
    ["a trailing dot", "shop.example.com."],
    ["two trailing dots", "shop.example.com.."],
    ["a port", "shop.example.com:443"],
    ["IPv4", "10.0.0.1"],
    ["IPv4 shorthand that the URL host parser rewrites", "0x7f.1"],
    ["bracketed IPv6", "[::1]"],
    ["bare IPv6", "::1"],
    ["a single label", "localhost"],
    ["a path", "shop.example.com/x"],
    ["userinfo", "u@shop.example.com"],
    ["whitespace", "shop .example.com"],
    ["a control character", "shop.example.com\u0000"],
    ["an underscore", "my_shop.example.com"],
    ["a leading hyphen label", "-shop.example.com"],
    ["an empty label", "shop..example.com"],
    ["a 64-character label", `${"a".repeat(64)}.example.com`],
    ["over 253 characters", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`],
    ["a huge input", "a".repeat(100_000)],
    // Security review US-013 #1: UTS46 mapping turned each of these into an approved alias of
    // shop.example.com / xn--bcher-kva.example (unbounded certificate orders for one domain).
    ["a full-width s (U+FF53)", "ｓhop.example.com"],
    ["a soft hyphen (U+00AD)", "sh­op.example.com"],
    ["an ideographic full stop (U+3002)", "shop。example.com"],
    ["a zero-width space (U+200B)", "sho​p.example.com"],
    ["the U-label of a stored A-label", "bücher.example"],
    ["an uppercase U-label", "BÜCHER.example"],
    // Code review US-013: characters that toLowerCase() / toUpperCase() map onto ASCII letters.
    ["a Kelvin sign (U+212A), which lowercases to k", "\u212Aey.example.com"],
    ["a dotted capital I (U+0130)", "\u0130shop.example.com"],
    ["a long s (U+017F), which uppercases to S", "\u017Fhop.example.com"],
  ])("rejects %s", (_label, input) => {
    expect(normalizeHost(input)).toBeNull();
  });

  it("accepts exactly 253 characters", () => {
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(host).toHaveLength(253);
    expect(normalizeHost(host)).toBe(host);
    expect(normalizeHost(`${host}.`)).toBeNull();
  });
});
