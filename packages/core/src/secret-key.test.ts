import { describe, expect, it } from "vitest";
import { assertSecretKey, decodeSecretKey, MIN_SECRET_KEY_BYTES } from "./secret-key.ts";

const BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256));

describe("review item 12: decodeSecretKey", () => {
  it("decodes canonical hex, base64 and base64url config values", () => {
    expect(decodeSecretKey(BYTES.toString("hex"), "hex").equals(BYTES)).toBe(true);
    expect(decodeSecretKey(BYTES.toString("hex").toUpperCase(), "hex").equals(BYTES)).toBe(true);
    expect(decodeSecretKey(BYTES.toString("base64"), "base64").equals(BYTES)).toBe(true);
    expect(decodeSecretKey(BYTES.toString("base64url"), "base64url").equals(BYTES)).toBe(true);
    expect(MIN_SECRET_KEY_BYTES).toBe(32);
  });

  it("rejects malformed, non-canonical or short values", () => {
    const hex = BYTES.toString("hex");
    const b64 = BYTES.toString("base64");
    for (const [value, encoding] of [
      [hex.slice(1), "hex"], // odd length
      [`${hex.slice(0, -2)}zz`, "hex"],
      [` ${hex}`, "hex"],
      [`${hex}\n`, "hex"],
      [b64.replace(/=$/, ""), "base64"], // missing padding
      [`${b64.slice(0, -2)}B=`, "base64"], // non-canonical trailing bits
      [b64.replace(/[A-Za-z]/, "-"), "base64"],
      [BYTES.toString("base64url").replace(/^./, "+"), "base64url"],
      [`${BYTES.toString("base64url")}=`, "base64url"],
      [Buffer.alloc(31, 1).toString("hex"), "hex"], // 31 bytes
      ["", "base64"],
    ] as const) {
      expect(() => decodeSecretKey(value, encoding), `${encoding}: ${JSON.stringify(value)}`).toThrow(RangeError);
    }
    expect(decodeSecretKey(Buffer.alloc(16, 1).toString("hex"), "hex", 16)).toHaveLength(16);
  });
});

describe("review item 12: assertSecretKey", () => {
  it("accepts only Uint8Array keys of at least the minimum length", () => {
    expect(() => {
      assertSecretKey(BYTES, "key");
    }).not.toThrow();
    expect(() => {
      assertSecretKey(new Uint8Array(32), "key");
    }).not.toThrow();
    for (const bad of ["x".repeat(64), new Uint8Array(31), null, undefined, 42, Array.from({ length: 32 }, () => 1)]) {
      expect(() => {
        assertSecretKey(bad, "key");
      }).toThrow(RangeError);
    }
  });
});
