import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FILE_URL_TTL_SECONDS, signFileUrl, verifyFileUrl } from "./signed-url.ts";

const key = randomBytes(32);
const now = new Date("2027-04-01T03:00:00Z");
const PATH = "/files/products/1f2e/ebook-trivia.pdf";

function parts(href: string) {
  const url = new URL(href);
  return { path: url.pathname, exp: url.searchParams.get("exp"), sig: url.searchParams.get("sig") };
}

describe("signed file URLs (WAHA sendFile)", () => {
  it("are valid for 10 minutes and can be used several times", () => {
    const href = signFileUrl({ origin: "https://api.example.id", path: PATH, key, now });
    expect(href).toMatch(/^https:\/\/api\.example\.id\/files\/products\/1f2e\/ebook-trivia\.pdf\?exp=\d+&sig=[A-Za-z0-9_-]{43}$/);
    const p = parts(href);
    expect(verifyFileUrl({ ...p, key, now })).toEqual({ ok: true, path: PATH });
    expect(verifyFileUrl({ ...p, key, now: new Date(now.getTime() + 60_000) })).toEqual({ ok: true, path: PATH });
    expect(verifyFileUrl({ ...p, key, now: new Date(now.getTime() + FILE_URL_TTL_SECONDS * 1000) })).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses another path, another expiry, another key or a malformed query", () => {
    const p = parts(signFileUrl({ origin: "https://api.example.id", path: PATH, key, now }));
    expect(verifyFileUrl({ ...p, path: "/files/products/1f2e/other.pdf", key, now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyFileUrl({ ...p, exp: String(Number(p.exp) + 3600), key, now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyFileUrl({ ...p, key: randomBytes(32), now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyFileUrl({ ...p, sig: "short", key, now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyFileUrl({ ...p, sig: "A".repeat(43), key, now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyFileUrl({ ...p, sig: null, key, now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyFileUrl({ ...p, exp: "1e9", key, now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyFileUrl({ ...p, path: "/files/../etc/passwd", key, now })).toEqual({ ok: false, reason: "malformed" });
  });

  it("A3: refuses non-canonical base64url spellings of a valid signature", () => {
    const p = parts(signFileUrl({ origin: "https://api.example.id", path: PATH, key, now }));
    const sig = p.sig ?? "";
    expect(verifyFileUrl({ ...p, key, now })).toEqual({ ok: true, path: PATH });
    // The 43rd character carries 2 unused bits: flipping one decodes to the same 32 bytes.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastBits = `${sig.slice(0, -1)}${alphabet[alphabet.indexOf(sig.slice(-1)) ^ 1] ?? ""}`;
    expect(Buffer.from(lastBits, "base64url").equals(Buffer.from(sig, "base64url"))).toBe(true);
    for (const variant of [`${sig}=`, `${sig}!!`, ` ${sig}`, lastBits, sig.replace(/-/g, "+").replace(/_/g, "/")]) {
      if (variant === sig) continue;
      expect(verifyFileUrl({ ...p, sig: variant, key, now })).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("refuses unsafe inputs when signing", () => {
    expect(() => signFileUrl({ origin: "http://api.example.id", path: PATH, key, now })).toThrow(RangeError);
    expect(() => signFileUrl({ origin: "https://api.example.id", path: "/files/../secret", key, now })).toThrow(RangeError);
    expect(() => signFileUrl({ origin: "https://api.example.id", path: "/other/x.pdf", key, now })).toThrow(RangeError);
    expect(() => signFileUrl({ origin: "https://api.example.id", path: PATH, key: randomBytes(16), now })).toThrow(RangeError);
    expect(() => signFileUrl({ origin: "https://api.example.id", path: PATH, key, now, ttlSeconds: 0 })).toThrow(RangeError);
    expect(() => signFileUrl({ origin: "https://api.example.id", path: PATH, key, now, ttlSeconds: 7200 })).toThrow(RangeError);
  });
});
