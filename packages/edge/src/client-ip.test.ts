import { describe, expect, it } from "vitest";
import { canonicalIp, resolveClientIp } from "./client-ip.ts";

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
