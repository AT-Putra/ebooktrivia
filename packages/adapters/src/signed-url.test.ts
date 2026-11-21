import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FILE_URL_TTL_SECONDS, MAX_FILE_URL_TTL_SECONDS, signFileUrl, verifyFileUrl } from "./signed-url.ts";

const key = randomBytes(32);
const now = new Date("2027-04-01T03:00:00Z");
const PATH = "/files/products/1f2e/ebook-trivia.pdf";

function parts(href: string) {
  const url = new URL(href);
  return { path: url.pathname, exp: url.searchParams.get("exp"), sig: url.searchParams.get("sig"), nonce: url.searchParams.get("n") };
}

describe("signed file URLs (WAHA sendFile)", () => {
  it("are valid for 10 minutes and can be used several times", () => {
    const href = signFileUrl({ origin: "https://api.example.id", path: PATH, key, now });
    expect(href).toMatch(/^https:\/\/api\.example\.id\/files\/products\/1f2e\/ebook-trivia\.pdf\?exp=\d+&sig=[A-Za-z0-9_-]{43}&n=[A-Za-z0-9_-]{22}$/);
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
    // The nonce is part of what is signed: a missing, another or malformed one does not verify.
    expect(verifyFileUrl({ ...p, nonce: null, key, now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyFileUrl({ ...p, nonce: "short", key, now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyFileUrl({ ...p, nonce: randomBytes(16).toString("base64url"), key, now })).toEqual({ ok: false, reason: "bad_signature" });
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

  it("refuses a URL whose expiry is further out than the longest one we mint, even with a valid signature", () => {
    const max = MAX_FILE_URL_TTL_SECONDS;
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const forge = (exp: number) => {
      const href = signFileUrl({ origin: "https://api.example.id", path: PATH, key, now: new Date(exp * 1000 - 600_000) });
      return parts(href);
    };
    // The longest legal URL verifies at the moment it was minted, one second further does not.
    const longest = parts(signFileUrl({ origin: "https://api.example.id", path: PATH, key, now, ttlSeconds: max }));
    expect(verifyFileUrl({ ...longest, key, now })).toEqual({ ok: true, path: PATH });
    expect(verifyFileUrl({ ...forge(nowSeconds + max + 700), key, now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyFileUrl({ ...forge(nowSeconds + 600), key, now })).toEqual({ ok: true, path: PATH });
  });

  it("LOW-2: every URL carries its own random nonce, even two minted in the same second for the same file (so a download counter keyed on it is never shared)", () => {
    const urls = Array.from({ length: 50 }, () => parts(signFileUrl({ origin: "https://api.example.id", path: PATH, key, now })));
    expect(new Set(urls.map((u) => u.nonce)).size).toBe(50);
    expect(new Set(urls.map((u) => u.exp)).size).toBe(1);
    expect(new Set(urls.map((u) => u.sig)).size).toBe(50);
    for (const u of urls) expect(verifyFileUrl({ ...u, key, now })).toEqual({ ok: true, path: PATH });
    // A non-canonical spelling of the nonce (the last character carries 4 unused bits) is not another valid URL.
    const first = parts(signFileUrl({ origin: "https://api.example.id", path: PATH, key, now }));
    const nonce = first.nonce ?? "";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const variant = `${nonce.slice(0, -1)}${alphabet[alphabet.indexOf(nonce.slice(-1)) ^ 1] ?? ""}`;
    expect(Buffer.from(variant, "base64url").equals(Buffer.from(nonce, "base64url"))).toBe(true);
    expect(verifyFileUrl({ ...first, nonce: variant, key, now })).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses unsafe inputs when signing", () => {
    expect(() => signFileUrl({ origin: "http://api.example.id", path: PATH, key, now })).toThrow(RangeError);
    expect(() => signFileUrl({ origin: "https://api.example.id", path: "/files/../secret", key, now })).toThrow(RangeError);
    expect(() => signFileUrl({ origin: "https://api.example.id", path: "/other/x.pdf", key, now })).toThrow(RangeError);
    expect(() => signFileUrl({ origin: "https://api.example.id", path: PATH, key: randomBytes(16), now })).toThrow(RangeError);
    expect(() => signFileUrl({ origin: "https://api.example.id", path: PATH, key, now, ttlSeconds: 0 })).toThrow(RangeError);
    expect(() => signFileUrl({ origin: "https://api.example.id", path: PATH, key, now, ttlSeconds: 72 * 3600 + 1 })).toThrow(RangeError);
    expect(signFileUrl({ origin: "https://api.example.id", path: PATH, key, now, ttlSeconds: 72 * 3600 })).toContain("exp=");
  });
});
