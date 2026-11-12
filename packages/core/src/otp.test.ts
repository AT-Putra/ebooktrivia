import * as crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { generateOtpCode, issueOtp, OTP_MAX_ATTEMPTS, OTP_TTL_MS, otpMac, verifyOtp, type OtpRecord } from "./otp.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomInt: vi.fn(actual.randomInt) as unknown as typeof actual.randomInt,
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
  };
});

const PEPPER_TEXT = "a-test-pepper-that-is-at-least-32-bytes!";
const PEPPER = Buffer.from(PEPPER_TEXT, "utf8");
const PHONE = "+628123456789";
const NOW = new Date("2027-06-01T03:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("generateOtpCode", () => {
  it("draws uniformly from crypto.randomInt(0, 10^6) and keeps leading zeros", () => {
    const randomInt = vi.mocked(crypto.randomInt) as unknown as ReturnType<typeof vi.fn>;
    randomInt.mockClear();
    randomInt.mockReturnValueOnce(42);
    expect(generateOtpCode()).toBe("000042");
    expect(randomInt).toHaveBeenCalledWith(0, 1_000_000);
  });

  it("maps the whole range 0..999999 to 6 digits", () => {
    const randomInt = vi.mocked(crypto.randomInt) as unknown as ReturnType<typeof vi.fn>;
    randomInt.mockReturnValueOnce(0).mockReturnValueOnce(999_999);
    expect([generateOtpCode(), generateOtpCode()]).toEqual(["000000", "999999"]);
    for (let i = 0; i < 1_000; i++) expect(generateOtpCode()).toMatch(/^[0-9]{6}$/);
  });
});

describe("otpMac (R13: HMAC-SHA256(pepper, phone:code))", () => {
  it("matches an independent HMAC computation", () => {
    const expected = crypto.createHmac("sha256", PEPPER).update(`${PHONE}:042917`).digest();
    expect(otpMac(PEPPER, PHONE, "042917").equals(expected)).toBe(true);
    expect(crypto.createHmac("sha256", PEPPER_TEXT).update(`${PHONE}:042917`).digest().equals(expected)).toBe(true);
    expect(otpMac(PEPPER, PHONE, "042917")).toHaveLength(32);
  });

  it("binds the code to the phone", () => {
    expect(otpMac(PEPPER, PHONE, "042917").equals(otpMac(PEPPER, "+628123456780", "042917"))).toBe(false);
  });

  it("rejects short peppers, non-E.164 phones and malformed codes", () => {
    expect(() => otpMac(Buffer.alloc(31), PHONE, "042917")).toThrow(RangeError);
    expect(() => otpMac(PEPPER, "08123456789", "042917")).toThrow(RangeError);
    expect(() => otpMac(PEPPER, PHONE, "42917")).toThrow(RangeError);
  });
});

describe("issueOtp / verifyOtp", () => {
  const issued = issueOtp({ pepper: PEPPER, phone: PHONE, now: NOW });
  const record: OtpRecord = { mac: issued.mac, expiresAt: issued.expiresAt, attempts: 0 };
  const verify = (code: string, over: Partial<OtpRecord> = {}, now = later(1_000)) =>
    verifyOtp({ pepper: PEPPER, phone: PHONE, code, record: { ...record, ...over }, now });

  it("issues a 6-digit code, stores only its MAC, expires after 5 minutes", () => {
    expect(issued.code).toMatch(/^[0-9]{6}$/);
    expect(issued.mac.equals(otpMac(PEPPER, PHONE, issued.code))).toBe(true);
    expect(issued.mac.toString("hex")).not.toContain(Buffer.from(issued.code).toString("hex"));
    expect(issued.expiresAt).toEqual(later(5 * 60 * 1000));
    expect(OTP_TTL_MS).toBe(300_000);
    expect(issueOtp({ pepper: PEPPER, phone: PHONE, now: NOW, ttlMs: 60_000 }).expiresAt).toEqual(later(60_000));
  });

  it("accepts the right code and compares in constant time", () => {
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    expect(verify(issued.code)).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrong code, a malformed code, or the right code for another phone", () => {
    const wrong = issued.code === "000000" ? "000001" : "000000";
    expect(verify(wrong)).toEqual({ ok: false, reason: "mismatch" });
    for (const code of ["", "12345", "1234567", "12345a", " 123456"]) {
      expect(verify(code)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(verifyOtp({ pepper: PEPPER, phone: "+628123456780", code: issued.code, record, now: later(1) })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(verify(issued.code, { mac: issued.mac.subarray(0, 31) })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("expires at exactly 5 minutes", () => {
    expect(verify(issued.code, {}, later(OTP_TTL_MS - 1)).ok).toBe(true);
    expect(verify(issued.code, {}, later(OTP_TTL_MS))).toEqual({ ok: false, reason: "expired" });
  });

  it("allows at most 5 attempts, even with the right code", () => {
    expect(OTP_MAX_ATTEMPTS).toBe(5);
    expect(verify(issued.code, { attempts: 4 }).ok).toBe(true);
    expect(verify(issued.code, { attempts: 5 })).toEqual({ ok: false, reason: "too_many_attempts" });
    expect(
      verifyOtp({ pepper: PEPPER, phone: PHONE, code: issued.code, record: { ...record, attempts: 2 }, now: NOW, maxAttempts: 2 }),
    ).toEqual({ ok: false, reason: "too_many_attempts" });
  });

  it("rejects invalid parameters", () => {
    expect(() => issueOtp({ pepper: PEPPER, phone: PHONE, now: NOW, ttlMs: 0 })).toThrow(RangeError);
    expect(() => issueOtp({ pepper: PEPPER, phone: PHONE, now: new Date(Number.NaN) })).toThrow(RangeError);
    expect(() => issueOtp({ pepper: Buffer.alloc(31), phone: PHONE, now: NOW })).toThrow(RangeError);
    expect(() => verify(issued.code, { attempts: -1 })).toThrow(RangeError);
    expect(() => verify(issued.code, { attempts: 1.5 })).toThrow(RangeError);
    expect(() => verify(issued.code, {}, new Date(Number.NaN))).toThrow(RangeError);
    expect(() =>
      verifyOtp({ pepper: PEPPER, phone: PHONE, code: issued.code, record, now: NOW, maxAttempts: 0 }),
    ).toThrow(RangeError);
  });

  it("review round 3, L4: an invalid stored expiry fails closed (the right code is not accepted)", () => {
    for (const expiresAt of [new Date(Number.NaN), "2027-06-01T03:05:00.000Z", null, undefined, Date.now() + 60_000]) {
      expect(() => verify(issued.code, { expiresAt: expiresAt as unknown as Date })).toThrow(
        new RangeError("record.expiresAt must be a valid Date"),
      );
    }
  });
});

describe("review item 12: the pepper must be bytes", () => {
  it("refuses a string pepper, even a long one", () => {
    expect(() => otpMac(PEPPER_TEXT as unknown as Uint8Array, PHONE, "042917")).toThrow(RangeError);
    expect(() => issueOtp({ pepper: PEPPER_TEXT as unknown as Uint8Array, phone: PHONE, now: NOW })).toThrow(RangeError);
  });
});
