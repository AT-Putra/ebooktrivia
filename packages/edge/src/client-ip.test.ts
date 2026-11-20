import { describe, expect, it } from "vitest";
import { canonicalIp, clientIp, resolveClientIp, throttleBucket, throttleBucket48 } from "./client-ip.ts";

const CADDY = "10.89.50.2";

describe("canonicalIp", () => {
  it("accepts IPv4 and IPv6 in canonical text form", () => {
    expect(canonicalIp("192.0.2.7")).toBe("192.0.2.7");
    expect(canonicalIp(" 192.0.2.7 ")).toBe("192.0.2.7");
    expect(canonicalIp("2001:DB8::1")).toBe("2001:db8::1");
    expect(canonicalIp("::ffff:10.89.50.2")).toBe("10.89.50.2");
    expect(canonicalIp("::FFFF:192.0.2.1")).toBe("192.0.2.1");
  });

  it("refuses anything that is not a single address", () => {
    for (const bad of [undefined, "", "unknown", "192.0.2.7:443", "[2001:db8::1]", "fe80::1%eth0", "192.0.2.256", "::ffff:999.1.1.1", "example.test"]) {
      expect(canonicalIp(bad)).toBeNull();
    }
  });
});

describe("resolveClientIp", () => {
  it("believes the last X-Forwarded-For entry from the trusted proxy", () => {
    expect(resolveClientIp(CADDY, "198.51.100.7", CADDY)).toEqual({ ip: "198.51.100.7", viaProxy: true });
    expect(resolveClientIp(`::ffff:${CADDY}`, "198.51.100.7", CADDY)).toEqual({ ip: "198.51.100.7", viaProxy: true });
    // A client-supplied entry in front of the proxy's own is ignored.
    expect(resolveClientIp(CADDY, "203.0.113.9, 198.51.100.7", CADDY)).toEqual({ ip: "198.51.100.7", viaProxy: true });
    expect(resolveClientIp(CADDY, ["203.0.113.9", "2001:DB8::7"], CADDY)).toEqual({ ip: "2001:db8::7", viaProxy: true });
  });

  it("falls back to the proxy's address when its header is missing or not an IP", () => {
    expect(resolveClientIp(CADDY, undefined, CADDY)).toEqual({ ip: CADDY, viaProxy: true });
    expect(resolveClientIp(CADDY, "198.51.100.7, garbage", CADDY)).toEqual({ ip: CADDY, viaProxy: true });
    expect(resolveClientIp(CADDY, "", CADDY)).toEqual({ ip: CADDY, viaProxy: true });
  });

  it("ignores X-Forwarded-For from any other peer", () => {
    expect(resolveClientIp("10.89.50.14", "198.51.100.7", CADDY)).toEqual({ ip: "10.89.50.14", viaProxy: false });
    expect(resolveClientIp("192.0.2.50", CADDY, CADDY)).toEqual({ ip: "192.0.2.50", viaProxy: false });
    expect(resolveClientIp("192.0.2.50", "198.51.100.7", null)).toEqual({ ip: "192.0.2.50", viaProxy: false });
  });

  it("has no address for a socket without one", () => {
    expect(resolveClientIp(undefined, "198.51.100.7", CADDY)).toEqual({ ip: null, viaProxy: false });
  });
});


describe("clientIp", () => {
  it("takes the last X-Forwarded-For entry when it is an IP", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.1, 198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(new Headers({ "x-forwarded-for": "2001:DB8::1" }))).toBe("2001:db8::1");
    expect(clientIp(new Headers({ "x-forwarded-for": "::ffff:198.51.100.7" }))).toBe("198.51.100.7");
  });

  it("is null without the header or when the entry is not an IP", () => {
    expect(clientIp(new Headers())).toBeNull();
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.7, garbage" }))).toBeNull();
    expect(clientIp(new Headers({ "x-forwarded-for": "fe80::1%eth0" }))).toBeNull();
  });
});

describe("throttleBucket", () => {
  it("keys IPv4 by the address", () => {
    expect(throttleBucket("198.51.100.7")).toBe("198.51.100.7");
    expect(throttleBucket("::ffff:198.51.100.7")).toBe("198.51.100.7");
  });

  it("keys IPv6 by the /64, whatever the spelling", () => {
    const bucket = "2001:db8:1:2::/64";
    expect(throttleBucket("2001:db8:1:2::1")).toBe(bucket);
    expect(throttleBucket("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(bucket);
    expect(throttleBucket("2001:0db8:0001:0002:0:0:0:9")).toBe(bucket);
    expect(throttleBucket("2001:DB8:1:2::abcd")).toBe(bucket);
    expect(throttleBucket("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(throttleBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(throttleBucket("::1")).toBe("0:0:0:0::/64");
    expect(throttleBucket("::")).toBe("0:0:0:0::/64");
    expect(throttleBucket("64:ff9b::198.51.100.7")).toBe("64:ff9b:0:0::/64");
    expect(throttleBucket("2001:db8:1:2:3:4:198.51.100.7")).toBe(bucket);
  });

  it("puts requests without a usable address into one shared bucket", () => {
    expect(throttleBucket(null)).toBe("unknown");
    expect(throttleBucket("not-an-ip")).toBe("unknown");
  });
});

describe("throttleBucket48", () => {
  it("keys IPv6 by the /48 and has no bucket for IPv4 or no address", () => {
    expect(throttleBucket48("2001:db8:1:2::1")).toBe("2001:db8:1::/48");
    expect(throttleBucket48("2001:db8:1:ffff::1")).toBe("2001:db8:1::/48");
    expect(throttleBucket48("2001:DB8:2::1")).toBe("2001:db8:2::/48");
    expect(throttleBucket48("198.51.100.7")).toBeNull();
    expect(throttleBucket48("::ffff:198.51.100.7")).toBeNull();
    expect(throttleBucket48(null)).toBeNull();
    expect(throttleBucket48("nope")).toBeNull();
  });
});
