import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, isSafeMethod, newNonce, originAllowed } from "./http-security.ts";

const ORIGIN = "https://admin.example.test"; // reserved TLD, test value only

describe("originAllowed", () => {
  it.each(["GET", "HEAD", "get", "head"])("lets the safe method %s through without an Origin", (method) => {
    expect(originAllowed(method, null, ORIGIN)).toBe(true);
    expect(originAllowed(method, "https://elsewhere.example.test", ORIGIN)).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "post"])("requires the exact admin Origin for %s", (method) => {
    expect(originAllowed(method, ORIGIN, ORIGIN)).toBe(true);
    expect(originAllowed(method, null, ORIGIN)).toBe(false);
    expect(originAllowed(method, "null", ORIGIN)).toBe(false);
    expect(originAllowed(method, "", ORIGIN)).toBe(false);
    expect(originAllowed(method, "https://admin.example.test.evil.example.test", ORIGIN)).toBe(false);
    expect(originAllowed(method, "http://admin.example.test", ORIGIN)).toBe(false);
    expect(originAllowed(method, "https://admin.example.test:443", ORIGIN)).toBe(false);
    expect(originAllowed(method, "https://ADMIN.example.test", ORIGIN)).toBe(false);
    expect(originAllowed(method, `${ORIGIN}/`, ORIGIN)).toBe(false);
  });

  it("refuses every state change when the admin origin is not configured", () => {
    expect(originAllowed("POST", ORIGIN, null)).toBe(false);
    expect(originAllowed("POST", "null", null)).toBe(false);
  });

  it("treats only GET and HEAD as safe", () => {
    expect(isSafeMethod("OPTIONS")).toBe(false);
    expect(isSafeMethod("TRACE")).toBe(false);
  });
});

describe("contentSecurityPolicy", () => {
  it("allows scripts only by nonce, with no unsafe-inline or unsafe-eval in production", () => {
    const csp = contentSecurityPolicy({ nonce: "abc123==", dev: false, https: true });
    const script = csp.split("; ").find((d) => d.startsWith("script-src "));
    expect(script).toBe("script-src 'self' 'nonce-abc123==' 'strict-dynamic'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("adds unsafe-eval only in development and upgrade-insecure-requests only on https", () => {
    const csp = contentSecurityPolicy({ nonce: "n", dev: true, https: false });
    expect(csp).toContain("script-src 'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval'");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
});

describe("newNonce", () => {
  it("is 128 random bits in base64, different every time", () => {
    const nonces = new Set(Array.from({ length: 100 }, () => newNonce()));
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(Buffer.from(nonce, "base64")).toHaveLength(16);
    }
  });
});
