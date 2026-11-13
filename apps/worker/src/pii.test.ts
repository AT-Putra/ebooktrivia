import { describe, expect, it } from "vitest";
import { maskPii } from "./pii.ts";

describe("maskPii", () => {
  it.each([
    ["send to +6281234567890 failed", "send to [number] failed"],
    ["msisdn 6281234567890", "msisdn [number]"],
    ["order 12345678 and 1234567", "order [number] and 1234567"],
    ["mail Buyer.Name+tag@Example.co.id bounced", "mail [email] bounced"],
    ["two: a@b.example, c.d@e.example", "two: [email], [email]"],
    ["nothing personal here", "nothing personal here"],
    // Security re-check US-013: formatted phone numbers.
    ["call +62 812-3456-7890 now", "call [number] now"],
    ["call 0812 3456 7890 now", "call [number] now"],
    ["call 0812-3456-7890 or 0812.3456.7890", "call [number] or [number]"],
    ["wa 62 812 3456 7890", "wa [number]"],
    // ... while dates, times, prices, IPs and order codes stay readable.
    ["expired at 2026-11-13 10:00:00 WIB", "expired at 2026-11-13 10:00:00 WIB"],
    ["at 2026-11-13T10:00:00.123Z", "at 2026-11-13T10:00:00.123Z"],
    ["price Rp 49.000 and Rp 12.500.000", "price Rp 49.000 and Rp 12.500.000"],
    ["peer 192.168.100.200 refused", "peer 192.168.100.200 refused"],
    ["order 7ZK4M2QH9R code 1A2B3C4D5E", "order 7ZK4M2QH9R code 1A2B3C4D5E"],
    ["ids 1 2 3 4", "ids 1 2 3 4"],
  ])("%s", (input, expected) => {
    expect(maskPii(input)).toBe(expected);
  });

  // An unbounded email pattern backtracked quadratically: 64 KB of letters (one GlitchTip body)
  // took about 3 s per string.
  it("stays linear on a 64 KB input without an @", () => {
    const started = performance.now();
    expect(maskPii("x".repeat(64 * 1024))).toHaveLength(64 * 1024);
    expect(maskPii("a@" + "a.".repeat(30_000))).toContain("a.");
    expect(maskPii("1-".repeat(32 * 1024))).toBe("[number]-");
    expect(maskPii("1".repeat(64 * 1024))).toBe("[number]");
    expect(maskPii("12.".repeat(20_000))).toBe("[number].");
    expect(performance.now() - started).toBeLessThan(250);
  });
});
