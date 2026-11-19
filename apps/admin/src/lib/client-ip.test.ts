import { describe, expect, it } from "vitest";
import { clientIp, throttleBucket } from "./client-ip.ts";

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
