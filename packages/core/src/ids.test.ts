import { describe, expect, it } from "vitest";
import {
  isUuid,
  MIDTRANS_ORDER_ID_MAX,
  midtransOrderId,
  newOrderCode,
  newPublicId,
  ORDER_CODE_LENGTH,
  ORDER_CODE_PATTERN,
  PUBLIC_ID_LENGTH,
  PUBLIC_ID_PATTERN,
} from "./ids.ts";

describe("order ids", () => {
  it("draws public ids that satisfy orders_public_id_check and do not repeat", () => {
    const ids = Array.from({ length: 2000 }, newPublicId);
    for (const id of ids) {
      expect(id).toHaveLength(PUBLIC_ID_LENGTH);
      expect(id).toMatch(PUBLIC_ID_PATTERN);
    }
    expect(new Set(ids).size).toBe(ids.length);
    // Every base62 character turns up (no truncated alphabet).
    expect(new Set(ids.join("")).size).toBe(62);
  });

  it("draws order codes in Crockford base32 (no I, L, O, U) that satisfy orders_order_code_check", () => {
    const codes = Array.from({ length: 2000 }, newOrderCode);
    for (const code of codes) {
      expect(code).toHaveLength(ORDER_CODE_LENGTH);
      expect(code).toMatch(ORDER_CODE_PATTERN);
      expect(code).not.toMatch(/[ILOU]/);
    }
    expect(new Set(codes.join("")).size).toBe(32);
  });

  it("builds the Midtrans order id of attempt n as {publicId}-{n}", () => {
    const publicId = newPublicId();
    expect(midtransOrderId(publicId, 1)).toBe(`${publicId}-1`);
    expect(midtransOrderId(publicId, 12)).toBe(`${publicId}-12`);
  });

  it("refuses a bad public id, a non-positive or fractional n, and an id over 50 characters", () => {
    expect(() => midtransOrderId("short", 1)).toThrow(RangeError);
    expect(() => midtransOrderId("x".repeat(16).replace(/x/g, "-"), 1)).toThrow(RangeError);
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => midtransOrderId(newPublicId(), n)).toThrow(RangeError);
    expect(() => midtransOrderId("a".repeat(40), 1234567890)).toThrow(/too long/);
    expect(midtransOrderId("a".repeat(40), 123456789)).toHaveLength(MIDTRANS_ORDER_ID_MAX);
  });

  it("isUuid accepts lowercase UUIDs only", () => {
    expect(isUuid("6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b")).toBe(true);
    expect(isUuid("6F1D2C3B-4A5E-4F60-8A7B-9C0D1E2F3A4B")).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});
