// Known-answer vectors, computed independently from the written construction (Python, pyca
// cryptography 50.0.0: X25519, HKDF-SHA256, AESGCM), not from this code. They pin the HKDF
// salt/info/length, the key/nonce split, the GCM layout, the AAD encoding and key_id, so stored
// secrets keep opening after any refactor.
import { describe, expect, it } from "vitest";
import { otpAad, secretAad } from "./aad.ts";
import { gcmEncrypt, keyIdOf, open, privateKeyObject, rawPublicKey, sealWithEphemeral } from "./sealed-box.ts";
import { createSecretOpener } from "./opener.ts";

const hex = (s: string): Buffer => Buffer.from(s, "hex");

const OTP = {
  recipientPrivateKey: "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  recipientPublicKey: "07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c",
  keyId: "aaa8fff703b50b22",
  ephemeralPrivateKey: "2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40",
  otpId: "3f1e2d4c-5b6a-4789-9abc-def012345678",
  phone: "+6281234567890",
  code: "042917",
  aad:
    "0000000b706c617965725f6f7470730000000b7365616c65645f636f64650000002433663165326434632d356236612d343738392d39616263" +
    "2d6465663031323334353637380000000e2b36323831323334353637383930",
  sealed:
    "5869aff450549732cbaaed5e5df9b30a6da31cb0e5742bad5ad4a1a768f1a67bd9a46cfc809f9f4e1201b5a940094f8db1c34f5635d7",
} as const;

const SECRET = {
  recipientPrivateKey: "4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60",
  recipientPublicKey: "64b101b1d0be5a8704bd078f9895001fc03e8e9f9522f188dd128d9846d48466",
  row: {
    id: "6b8f0a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
    scope: "payment",
    name: "midtrans.server_key",
    adnetId: null,
    boundHost: "api.midtrans.com",
    keyId: "bc841db8fea3efd8",
  },
  plaintext: "SB-Mid-server-KAT0123456789abcdef",
  aad:
    "0000001073657474696e67735f736563726574730000000a636970686572746578740000002436623866306135322d316333642d346535" +
    "662d386139622d306331643265336634613562000000077061796d656e74000000136d69647472616e732e7365727665725f6b65790000" +
    "0000000000106170692e6d69647472616e732e636f6d0000001062633834316462386665613365666438",
  dek: "8182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0",
  ephemeralPrivateKey: "6162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80",
  nonce: "a1a2a3a4a5a6a7a8a9aaabac",
  ciphertext: "8d37eb3cc4e60a8611c9abdfdcaf96bb79df3b1a8ce5bbcef03f75a5c4de09e675b5294d0bd53eb9eba95aa06bcf5e286a",
  sealedDek:
    "244fe3b963e899dd295baffce248d3530f3a9a7479ba063002680ebfe7adad49f2a5adfaa3cc92d090944c160f5ed5f527d2775bf515" +
    "1b76da96336bdb1fc7a09688ea28da2d5ffc7879d091c19572f4",
} as const;

describe("known-answer vectors (independent implementation)", () => {
  it("key ids: first 16 hex chars of SHA-256(raw public key)", () => {
    expect(rawPublicKey(privateKeyObject(hex(OTP.recipientPrivateKey))).toString("hex")).toBe(OTP.recipientPublicKey);
    expect(keyIdOf(hex(OTP.recipientPublicKey))).toBe(OTP.keyId);
    expect(keyIdOf(hex(SECRET.recipientPublicKey))).toBe(SECRET.row.keyId);
  });

  it("canonical AAD encodings", () => {
    expect(otpAad(OTP.otpId, OTP.phone).toString("hex")).toBe(OTP.aad);
    expect(secretAad(SECRET.row).toString("hex")).toBe(SECRET.aad);
  });

  it("sealed box: seal with a fixed ephemeral key gives the vector byte for byte; open reverses it", () => {
    const sealed = sealWithEphemeral(
      privateKeyObject(hex(OTP.ephemeralPrivateKey)),
      hex(OTP.recipientPublicKey),
      Buffer.from(OTP.code),
      hex(OTP.aad),
    );
    expect(sealed.toString("hex")).toBe(OTP.sealed);
    expect(open(privateKeyObject(hex(OTP.recipientPrivateKey)), hex(OTP.sealed), hex(OTP.aad)).toString()).toBe(OTP.code);
  });

  it("OTP: the worker opener opens the vector with the outbox otp_id + phone", () => {
    const opener = createSecretOpener({ messaging: hex(OTP.recipientPrivateKey) });
    expect(opener.openOtp({ otpId: OTP.otpId, phone: OTP.phone, sealed: hex(OTP.sealed) })).toBe(OTP.code);
  });

  it("secret envelope: GCM ciphertext and sealed DEK match; the opener returns the plaintext", () => {
    expect(gcmEncrypt(hex(SECRET.dek), hex(SECRET.nonce), Buffer.from(SECRET.plaintext), hex(SECRET.aad)).toString("hex")).toBe(
      SECRET.ciphertext,
    );
    const sealedDek = sealWithEphemeral(
      privateKeyObject(hex(SECRET.ephemeralPrivateKey)),
      hex(SECRET.recipientPublicKey),
      hex(SECRET.dek),
      hex(SECRET.aad),
    );
    expect(sealedDek.toString("hex")).toBe(SECRET.sealedDek);
    const opener = createSecretOpener({ payment: hex(SECRET.recipientPrivateKey) });
    const row = { ...SECRET.row, ciphertext: hex(SECRET.ciphertext), nonce: hex(SECRET.nonce), sealedDek: hex(SECRET.sealedDek) };
    expect(opener.openSecret(row)).toBe(SECRET.plaintext);
  });
});
