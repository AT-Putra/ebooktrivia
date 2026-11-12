import * as crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  hashMagicLinkToken,
  issueMagicLink,
  MAGIC_LINK_TTL_MS,
  verifyMagicLink,
  type MagicLinkChannel,
  type MagicLinkRecord,
} from "./magic-link.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const NOW = new Date("2027-06-01T03:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest();

describe("issueMagicLink", () => {
  it("creates a 256-bit base64url token, its SHA-256 and a 72 h expiry", () => {
    const link = issueMagicLink({ channel: "whatsapp", now: NOW });
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(link.token, "base64url")).toHaveLength(32);
    expect(link.tokenHash.equals(sha256(link.token))).toBe(true);
    expect(link.tokenHash).toHaveLength(32);
    expect(link.channel).toBe("whatsapp");
    expect(link.expiresAt).toEqual(later(72 * 60 * 60 * 1000));
    expect(MAGIC_LINK_TTL_MS).toBe(259_200_000);
  });

  it("never repeats a token", () => {
    const tokens = new Set(Array.from({ length: 2_000 }, () => issueMagicLink({ channel: "email", now: NOW }).token));
    expect(tokens.size).toBe(2_000);
  });

  it("rejects unknown channels and invalid clocks", () => {
    expect(() => issueMagicLink({ channel: "sms" as MagicLinkChannel, now: NOW })).toThrow(RangeError);
    expect(() => issueMagicLink({ channel: "email", now: new Date(Number.NaN) })).toThrow(RangeError);
  });
});

describe("verifyMagicLink", () => {
  const link = issueMagicLink({ channel: "whatsapp", now: NOW });
  const record: MagicLinkRecord = { tokenHash: link.tokenHash, expiresAt: link.expiresAt, consumedAt: null };

  it("accepts an unused, unexpired link and returns the consumption time", () => {
    expect(verifyMagicLink({ token: link.token, record, now: later(1_000) })).toEqual({ ok: true, consumedAt: later(1_000) });
  });

  it("compares the hashes in constant time", () => {
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    verifyMagicLink({ token: link.token, record, now: NOW });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("expires at exactly 72 h", () => {
    expect(verifyMagicLink({ token: link.token, record, now: new Date(link.expiresAt.getTime() - 1) }).ok).toBe(true);
    expect(verifyMagicLink({ token: link.token, record, now: link.expiresAt })).toEqual({ ok: false, reason: "expired" });
  });

  it("is single use", () => {
    expect(verifyMagicLink({ token: link.token, record: { ...record, consumedAt: later(10) }, now: later(20) })).toEqual({
      ok: false,
      reason: "consumed",
    });
  });

  it("rejects another token, a malformed token or a malformed stored hash", () => {
    const other = issueMagicLink({ channel: "whatsapp", now: NOW });
    expect(verifyMagicLink({ token: other.token, record, now: NOW })).toEqual({ ok: false, reason: "mismatch" });
    for (const token of ["", "short", `${link.token}=`, `${link.token.slice(0, 42)}+`, `${link.token.slice(0, 42)}/`, `${link.token}A`]) {
      expect(verifyMagicLink({ token, record, now: NOW })).toEqual({ ok: false, reason: "malformed" });
    }
    expect(verifyMagicLink({ token: link.token, record: { ...record, tokenHash: link.tokenHash.subarray(0, 16) }, now: NOW })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("keeps one independent token per channel", () => {
    const viaWa = issueMagicLink({ channel: "whatsapp", now: NOW });
    const viaEmail = issueMagicLink({ channel: "email", now: NOW });
    const waRecord: MagicLinkRecord = { tokenHash: viaWa.tokenHash, expiresAt: viaWa.expiresAt, consumedAt: later(5) };
    const emailRecord: MagicLinkRecord = { tokenHash: viaEmail.tokenHash, expiresAt: viaEmail.expiresAt, consumedAt: null };
    expect(verifyMagicLink({ token: viaWa.token, record: waRecord, now: later(10) }).ok).toBe(false);
    expect(verifyMagicLink({ token: viaEmail.token, record: emailRecord, now: later(10) }).ok).toBe(true);
    expect(verifyMagicLink({ token: viaWa.token, record: emailRecord, now: later(10) })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects an invalid clock", () => {
    expect(() => verifyMagicLink({ token: link.token, record, now: new Date(Number.NaN) })).toThrow(RangeError);
  });

  it("review round 3, L4: invalid stored dates fail closed (the right token is not accepted)", () => {
    const invalid: unknown[] = [new Date(Number.NaN), "2027-06-04T03:00:00.000Z", undefined, Date.now() + 60_000];
    for (const expiresAt of [...invalid, null]) {
      expect(() => verifyMagicLink({ token: link.token, record: { ...record, expiresAt: expiresAt as Date }, now: NOW })).toThrow(
        new RangeError("record.expiresAt must be a valid Date"),
      );
    }
    for (const consumedAt of invalid) {
      expect(() => verifyMagicLink({ token: link.token, record: { ...record, consumedAt: consumedAt as Date }, now: NOW })).toThrow(
        new RangeError("record.consumedAt must be a valid Date"),
      );
    }
  });
});

describe("hashMagicLinkToken", () => {
  it("hashes well-formed tokens only", () => {
    const link = issueMagicLink({ channel: "email", now: NOW });
    expect(hashMagicLinkToken(link.token)?.equals(link.tokenHash)).toBe(true);
    expect(hashMagicLinkToken("not-a-token")).toBeNull();
  });
});
