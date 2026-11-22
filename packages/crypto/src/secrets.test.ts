import { createHash, randomUUID } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import { canonicalAad, passwordCheckAad, secretAad, type SecretLabels } from "./aad.ts";
import { CryptoError, gcmDecrypt, generateScopeKeyPair, keyIdOf, open, privateKeyObject, seal } from "./sealed-box.ts";
import { createSecretOpener, openerFromEnv } from "./opener.ts";
import {
  assertOtpCode,
  createSecretSealer,
  last4,
  SEALED_OTP_BYTES,
  SEALED_PASSWORD_CHECK_BYTES,
  type SealedSecret,
  sealerFromEnv,
  type SecretOpener,
  type SecretSealer,
  type StoredSecretRow,
} from "./secrets.ts";

const payment = generateScopeKeyPair();
const messaging = generateScopeKeyPair();
const conversions = generateScopeKeyPair();
const b64 = (b: Buffer): string => b.toString("base64url");

/** admin.env: public keys only. */
const ADMIN_ENV = {
  SECRETS_PAYMENT_PUBLIC_KEY: b64(payment.publicKey),
  SECRETS_MESSAGING_PUBLIC_KEY: b64(messaging.publicKey),
  SECRETS_CONVERSIONS_PUBLIC_KEY: b64(conversions.publicKey),
};
/** worker.env: all three private keys. */
const WORKER_ENV = {
  SECRETS_PAYMENT_PRIVATE_KEY: b64(payment.privateKey),
  SECRETS_MESSAGING_PRIVATE_KEY: b64(messaging.privateKey),
  SECRETS_CONVERSIONS_PRIVATE_KEY: b64(conversions.privateKey),
};

const sealer = sealerFromEnv(ADMIN_ENV);
const worker = openerFromEnv(WORKER_ENV);

const ADNET = "0b9c4a61-7d2e-4f3a-9b8c-1d2e3f4a5b6c";
const HOST = "track.adnet.example";

function expectCode(fn: () => unknown, code: string): void {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(CryptoError);
  expect((error as CryptoError).code).toBe(code);
}

const flip = (bytes: Uint8Array, i: number): Buffer => {
  const out = Buffer.from(bytes);
  out[i] = (out[i] ?? 0) ^ 0x01;
  return out;
};

const conversionSecret = (): SealedSecret =>
  sealer.sealSecret({ scope: "conversions", name: "api_key", adnetId: ADNET, boundHost: HOST, plaintext: "pk_live_abcdef123456" });

describe("per-secret envelope", () => {
  it.each([
    ["payment", "midtrans.server_key", null, "api.midtrans.com", "SB-Mid-server-0123456789"],
    ["messaging", "waha.api_key", null, "waha.example.id:3000", "waha-key-0123456789"],
    ["messaging", "smtp.password", null, "smtp.example.id:587", "hunter2-but-longer"],
    ["conversions", "api_key", ADNET, HOST, "pk_live_abcdef123456"],
  ] as const)("round-trips a %s secret (%s)", (scope, name, adnetId, boundHost, plaintext) => {
    const row = sealer.sealSecret({ scope, name, adnetId, boundHost, plaintext });
    expect(row).toMatchObject({ scope, name, adnetId, boundHost, keyId: sealer.keyId(scope) });
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row.nonce.length).toBe(12);
    expect(row.sealedDek.length).toBe(32 + 32 + 16);
    expect(row.ciphertext.length).toBe(Buffer.byteLength(plaintext) + 16);
    expect(worker.openSecret(row)).toBe(plaintext);
  });

  it("keeps a given row id (re-encryption of an existing row) and round-trips non-ASCII text", () => {
    const id = randomUUID();
    const row = sealer.sealSecret({ id, scope: "payment", name: "k", adnetId: null, boundHost: null, plaintext: "kunci-rahasia-é-🔑" });
    expect(row.id).toBe(id);
    expect(worker.openSecret(row)).toBe("kunci-rahasia-é-🔑");
  });

  it("uses a fresh DEK and nonce per write: two writes of one value share no bytes", () => {
    const a = conversionSecret();
    const b = conversionSecret();
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.sealedDek.equals(b.sealedDek)).toBe(false);
    expect(a.sealedDek.subarray(0, 32).equals(b.sealedDek.subarray(0, 32))).toBe(false);
  });

  it("fails closed when any byte of ciphertext, tag, nonce, sealed_dek or eph_pub is flipped", () => {
    const row = conversionSecret();
    // ciphertext = GCM body || tag (last 16 bytes)
    for (let i = 0; i < row.ciphertext.length; i++) {
      expectCode(() => worker.openSecret({ ...row, ciphertext: flip(row.ciphertext, i) }), "decrypt_failed");
    }
    for (let i = 0; i < row.nonce.length; i++) {
      expectCode(() => worker.openSecret({ ...row, nonce: flip(row.nonce, i) }), "decrypt_failed");
    }
    // sealed_dek = eph_pub (0..31) || sealed DEK (32..63) || tag (64..79)
    for (let i = 0; i < row.sealedDek.length; i++) {
      expectCode(() => worker.openSecret({ ...row, sealedDek: flip(row.sealedDek, i) }), "decrypt_failed");
    }
    expectCode(() => worker.openSecret({ ...row, ciphertext: row.ciphertext.subarray(0, 15) }), "decrypt_failed");
    expectCode(() => worker.openSecret({ ...row, nonce: Buffer.alloc(0) }), "decrypt_failed");
    expect(worker.openSecret(row)).toBe("pk_live_abcdef123456");
  });

  // US-009 finding: a row relabelled in the DB (ciphertext kept) must not decrypt under its new
  // labels. One private key serves both scopes here, so only the AAD can catch a scope change.
  it("fails closed on an AAD swap: another row id, scope, name, adnet_id or bound_host", () => {
    const shared = generateScopeKeyPair();
    const both = createSecretSealer({ payment: shared.publicKey, conversions: shared.publicKey });
    const opener = createSecretOpener({ payment: shared.privateKey, conversions: shared.privateKey });
    const row = both.sealSecret({ scope: "payment", name: "midtrans.server_key", adnetId: null, boundHost: "api.midtrans.com", plaintext: "SB-Mid-server-0123456789" });
    expect(opener.openSecret(row)).toBe("SB-Mid-server-0123456789");
    const relabels: Partial<StoredSecretRow>[] = [
      { id: randomUUID() },
      { scope: "conversions" },
      { name: "api_key" },
      { adnetId: ADNET },
      { boundHost: "attacker.example" },
      { boundHost: "api.midtrans.com:8443" },
      { boundHost: null },
      // The relabel attack: payment row -> conversions secret of an attacker adnet and host.
      { scope: "conversions", name: "api_key", adnetId: ADNET, boundHost: "attacker.example" },
    ];
    for (const relabel of relabels) {
      expectCode(() => opener.openSecret({ ...row, ...relabel }), "decrypt_failed");
    }
  });

  it("binds key_id and the table/column name too (checked below the opener's key_id check)", () => {
    const row = conversionSecret();
    const key = privateKeyObject(conversions.privateKey);
    const labels: SecretLabels = { ...row };
    const aad = secretAad(labels);
    const dek = open(key, row.sealedDek, aad);
    expect(gcmDecrypt(dek, row.nonce, row.ciphertext, aad).toString()).toBe("pk_live_abcdef123456");
    const otherKeyId = secretAad({ ...labels, keyId: keyIdOf(payment.publicKey) });
    expectCode(() => open(key, row.sealedDek, otherKeyId), "decrypt_failed");
    expectCode(() => gcmDecrypt(dek, row.nonce, row.ciphertext, otherKeyId), "decrypt_failed");
    const fields = [row.id, row.scope, row.name, row.adnetId ?? "", row.boundHost ?? "", row.keyId];
    for (const [table, column] of [
      ["settings_secrets", "nonce"],
      ["settings_secret", "ciphertext"],
      ["player_otps", "ciphertext"],
    ]) {
      const swapped = canonicalAad([table ?? "", column ?? "", ...fields]);
      expectCode(() => open(key, row.sealedDek, swapped), "decrypt_failed");
      expectCode(() => gcmDecrypt(dek, row.nonce, row.ciphertext, swapped), "decrypt_failed");
    }
  });

  it("fails with the wrong scope's private key", () => {
    const row = sealer.sealSecret({ scope: "payment", name: "k", adnetId: null, boundHost: null, plaintext: "payment-secret-1" });
    // An opener whose "payment" key is really the conversions key: the key_id check refuses it.
    const wrong = createSecretOpener({ payment: conversions.privateKey });
    expectCode(() => wrong.openSecret(row), "key_mismatch");
    // And below that check, the sealed DEK does not open with another scope's key.
    expectCode(() => open(privateKeyObject(conversions.privateKey), row.sealedDek, secretAad(row)), "decrypt_failed");
  });

  it("picks the key by the row's scope and requires the row's key_id to be that key's id", () => {
    const row = conversionSecret();
    expectCode(() => worker.openSecret({ ...row, keyId: keyIdOf(payment.publicKey) }), "key_mismatch");
    expectCode(() => worker.openSecret({ ...row, keyId: "0000000000000000" }), "key_mismatch");
    expectCode(() => worker.openSecret({ ...row, scope: "admin" }), "scope_unavailable");
    // public.env holds the payment key only: it cannot open messaging or conversions rows.
    const publicApp = openerFromEnv({ SECRETS_PAYMENT_PRIVATE_KEY: WORKER_ENV.SECRETS_PAYMENT_PRIVATE_KEY });
    expect(publicApp.scopes).toEqual(["payment"]);
    expectCode(() => publicApp.openSecret(row), "scope_unavailable");
  });

  it("refuses labels that are not canonical, so a row has exactly one AAD", () => {
    const base = { scope: "conversions", name: "api_key", adnetId: ADNET, boundHost: HOST, plaintext: "pk_live_abcdef123456" } as const;
    for (const bad of [
      { id: "NOT-A-UUID" },
      { id: randomUUID().toUpperCase() },
      { name: "Api-Key" },
      { name: "" },
      { adnetId: "" },
      { adnetId: ADNET.toUpperCase() },
      { boundHost: "" },
      { boundHost: "Track.Adnet.Example" },
      { boundHost: "track.adnet.example:443" },
      { boundHost: "track.adnet.example/path" },
      { boundHost: "user@track.adnet.example" },
      { boundHost: "b\u{00FC}cher.example" },
      { boundHost: "[::1" },
    ]) {
      expectCode(() => sealer.sealSecret({ ...base, ...bad }), "invalid_input");
    }
    expectCode(() => sealer.sealSecret({ ...base, plaintext: "" }), "invalid_input");
    expectCode(() => sealer.sealSecret({ ...base, plaintext: "abc\u{D800}def" }), "invalid_input");
    const row = conversionSecret();
    expectCode(() => worker.openSecret({ ...row, boundHost: "" }), "invalid_input");
    expectCode(() => worker.openSecret({ ...row, keyId: "BAD" }), "key_mismatch");
    expect(sealer.sealSecret({ ...base, boundHost: "track.adnet.example:8443" }).boundHost).toBe("track.adnet.example:8443");
    expect(sealer.sealSecret({ ...base, boundHost: "[2001:db8::1]:8443" }).boundHost).toBe("[2001:db8::1]:8443");
  });
});

describe("a process with public keys only cannot decrypt", () => {
  it("type level: SecretSealer has no method that opens anything", () => {
    expectTypeOf<SecretSealer>().not.toHaveProperty("openSecret");
    expectTypeOf<SecretSealer>().not.toHaveProperty("openOtp");
    expectTypeOf<SecretSealer>().not.toHaveProperty("openPasswordCheck");
    expectTypeOf<keyof SecretSealer>().toEqualTypeOf<"scopes" | "keyId" | "sealSecret" | "sealOtp" | "sealPasswordCheck">();
    expectTypeOf<SecretOpener>().toHaveProperty("openSecret");
    // @ts-expect-error a sealer has no openSecret
    expect(sealer.openSecret).toBeUndefined();
  });

  it("runtime: the sealer exposes only sealing, and an opener cannot be built from admin.env", () => {
    expect(Object.keys(sealer).sort()).toEqual(["keyId", "scopes", "sealOtp", "sealPasswordCheck", "sealSecret"]);
    expect(Object.isFrozen(sealer)).toBe(true);
    expectCode(() => openerFromEnv(ADMIN_ENV), "invalid_key");
    expectCode(() => openerFromEnv({}), "invalid_key");
    expectCode(() => createSecretOpener({}), "invalid_key");
  });

  it("an opener reads only *_PRIVATE_KEY; a sealer only *_PUBLIC_KEY", () => {
    expect(openerFromEnv({ ...ADMIN_ENV, ...WORKER_ENV }).scopes).toEqual(["payment", "messaging", "conversions"]);
    expectCode(() => sealerFromEnv(WORKER_ENV), "invalid_key");
    expect(sealerFromEnv({ ...ADMIN_ENV, SECRETS_PAYMENT_PUBLIC_KEY: "" }).scopes).toEqual(["messaging", "conversions"]);
  });
});

describe("key configuration", () => {
  it("decodes raw 32-byte base64url keys strictly", () => {
    for (const bad of ["not base64url!", `${b64(payment.publicKey)}=`, b64(Buffer.alloc(16, 1)), b64(Buffer.alloc(48, 1))]) {
      expectCode(() => sealerFromEnv({ SECRETS_PAYMENT_PUBLIC_KEY: bad }), "invalid_key");
      expectCode(() => openerFromEnv({ SECRETS_PAYMENT_PRIVATE_KEY: bad }), "invalid_key");
    }
  });

  it("refuses a low-order scope public key at startup", () => {
    const lowOrder = Buffer.from("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", "hex");
    expectCode(() => createSecretSealer({ conversions: lowOrder }), "invalid_key");
    expectCode(() => createSecretSealer({ payment: Buffer.alloc(32) }), "invalid_key");
  });

  it("refuses unknown scopes and missing ones", () => {
    expectCode(() => createSecretSealer({ admin: payment.publicKey } as never), "invalid_key");
    expectCode(() => createSecretOpener({ admin: payment.privateKey } as never), "invalid_key");
    const onlyPayment = createSecretSealer({ payment: payment.publicKey });
    expectCode(() => onlyPayment.keyId("messaging"), "scope_unavailable");
    expectCode(
      () => onlyPayment.sealSecret({ scope: "conversions", name: "k", adnetId: null, boundHost: null, plaintext: "12345678" }),
      "scope_unavailable",
    );
    expectCode(() => onlyPayment.sealOtp({ otpId: randomUUID(), phone: "+6281234567890", code: "123456" }), "scope_unavailable");
  });
});

describe("last4", () => {
  // Security review US-011 #4: user-chosen SMTP/WAHA passwords are often 8-12 characters, so
  // showing 4 of them reveals up to half. Show last4 only for secrets of 16+ code points.
  it("shows the last 4 characters only for secrets of 16+ characters, never more than a quarter", () => {
    expect(last4("")).toBe("");
    for (const n of [1, 7, 8, 10, 12, 15]) expect(last4("x".repeat(n - 1) + "Z")).toBe("");
    expect(last4("abcdefghijklmnop")).toBe("mnop");
    expect(last4("SB-Mid-server-0123456789")).toBe("6789");
    expect(last4("abcdefghijkl🔑🔑🔑🔑")).toBe("🔑🔑🔑🔑");
    for (let n = 0; n < 40; n++) {
      const shown = Array.from(last4("s".repeat(n)));
      expect(shown.length).toBeLessThanOrEqual(Math.min(4, Math.floor(n / 4)));
    }
  });

  it("is captured at write time from the plaintext", () => {
    expect(conversionSecret().last4).toBe("3456");
    expect(sealer.sealSecret({ scope: "payment", name: "k", adnetId: null, boundHost: null, plaintext: "hunter2-pass" }).last4).toBe("");
  });
});

describe("sealSecret plaintext hygiene", () => {
  // Security review US-011 #7: a secret with CR/LF or other controls can split HTTP headers or
  // SMTP commands when the worker uses it.
  it.each([
    ["CRLF", "key\r\nX-Injected: 1"],
    ["LF", "key\nmore"],
    ["NUL", "key\u{0}tail"],
    ["TAB", "key\ttail"],
    ["ESC", "key\u{1b}[31m"],
    ["DEL", "key\u{7f}"],
  ])("rejects a plaintext containing %s", (_label, plaintext) => {
    expectCode(
      () => sealer.sealSecret({ scope: "payment", name: "midtrans.server_key", adnetId: null, boundHost: null, plaintext }),
      "invalid_input",
    );
  });

  it("still accepts printable ASCII and non-ASCII text", () => {
    const row = sealer.sealSecret({ scope: "payment", name: "k", adnetId: null, boundHost: null, plaintext: "Kunci rahasia ü 🔑 ~!@#$%^&*()" });
    expect(worker.openSecret(row)).toBe("Kunci rahasia ü 🔑 ~!@#$%^&*()");
  });
});

describe("sealed OTP codes", () => {
  const otpId = randomUUID();
  const phone = "+6281234567890";

  it("seal to exactly 54 bytes and open with the outbox otp_id + phone", () => {
    const sealed = sealer.sealOtp({ otpId, phone, code: "007123" });
    expect(SEALED_OTP_BYTES).toBe(54);
    expect(sealed.length).toBe(54);
    expect(worker.openOtp({ otpId, phone, sealed })).toBe("007123");
    expect(sealer.sealOtp({ otpId, phone, code: "007123" }).equals(sealed)).toBe(false);
  });

  it("fail closed for another otp_id or phone, a flipped byte, or the wrong length", () => {
    const sealed = sealer.sealOtp({ otpId, phone, code: "123456" });
    expectCode(() => worker.openOtp({ otpId: randomUUID(), phone, sealed }), "decrypt_failed");
    expectCode(() => worker.openOtp({ otpId, phone: "+6281234567891", sealed }), "decrypt_failed");
    for (let i = 0; i < sealed.length; i++) {
      expectCode(() => worker.openOtp({ otpId, phone, sealed: flip(sealed, i) }), "decrypt_failed");
    }
    expectCode(() => worker.openOtp({ otpId, phone, sealed: sealed.subarray(1) }), "decrypt_failed");
    expectCode(() => worker.openOtp({ otpId: otpId.toUpperCase(), phone, sealed }), "invalid_input");
    expectCode(() => worker.openOtp({ otpId, phone: "081234567890", sealed }), "invalid_input");
  });

  it("refuse anything but 6 digits, on both sides", () => {
    for (const code of ["12345", "1234567", "12345a", "١٢٣٤٥٦", " 12345"]) {
      expectCode(() => sealer.sealOtp({ otpId, phone, code }), "invalid_input");
      expectCode(() => assertOtpCode(code), "invalid_input");
    }
    // A 54-byte box that holds 6 non-digits (sealed with the public key, bypassing sealOtp).
    const aad = canonicalAad(["player_otps", "sealed_code", otpId, phone]);
    const forged = seal(messaging.publicKey, Buffer.from("12345a"), aad);
    expectCode(() => worker.openOtp({ otpId, phone, sealed: forged }), "invalid_input");
    expect(assertOtpCode("000000")).toBe("000000");
  });

  it("are not openable by the public app (payment key only) or with another scope's key", () => {
    const sealed = sealer.sealOtp({ otpId, phone, code: "123456" });
    expectCode(() => openerFromEnv({ SECRETS_PAYMENT_PRIVATE_KEY: WORKER_ENV.SECRETS_PAYMENT_PRIVATE_KEY }).openOtp({ otpId, phone, sealed }), "scope_unavailable");
    expectCode(() => createSecretOpener({ messaging: payment.privateKey }).openOtp({ otpId, phone, sealed }), "decrypt_failed");
  });

  it("the public app seals with the messaging public key only", () => {
    const publicApp = sealerFromEnv({ SECRETS_MESSAGING_PUBLIC_KEY: ADMIN_ENV.SECRETS_MESSAGING_PUBLIC_KEY });
    const sealed = publicApp.sealOtp({ otpId, phone, code: "654321" });
    expect(worker.openOtp({ otpId, phone, sealed })).toBe("654321");
  });
});

describe("sealed admin password checks (US-031, ASVS V6.2.12)", () => {
  const checkId = randomUUID();
  const adminUserId = "Ab3_dE-fGhIjKlMnOpQrStUv";
  const password = "a long and unusual passphrase 7";
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();

  it("seal the password's SHA-1, never the password, and open with the outbox check_id + admin_user_id", () => {
    const sealed = sealer.sealPasswordCheck({ checkId, adminUserId, password });
    expect(SEALED_PASSWORD_CHECK_BYTES).toBe(88);
    expect(sealed.length).toBe(88);
    expect(sealed.includes(Buffer.from(password))).toBe(false);
    expect(sealed.includes(Buffer.from(sha1))).toBe(false);
    expect(worker.openPasswordCheck({ checkId, adminUserId, sealed })).toBe(sha1);
    expect(sealer.sealPasswordCheck({ checkId, adminUserId, password }).equals(sealed)).toBe(false);
  });

  it("fail closed for another check or admin, a flipped byte, the wrong length, or anything but an uppercase SHA-1", () => {
    const sealed = sealer.sealPasswordCheck({ checkId, adminUserId, password });
    expectCode(() => worker.openPasswordCheck({ checkId: randomUUID(), adminUserId, sealed }), "decrypt_failed");
    expectCode(() => worker.openPasswordCheck({ checkId, adminUserId: "another-admin-id", sealed }), "decrypt_failed");
    expectCode(() => worker.openPasswordCheck({ checkId, adminUserId, sealed: flip(sealed, 40) }), "decrypt_failed");
    expectCode(() => worker.openPasswordCheck({ checkId, adminUserId, sealed: sealed.subarray(1) }), "decrypt_failed");
    expectCode(() => worker.openPasswordCheck({ checkId: checkId.toUpperCase(), adminUserId, sealed }), "invalid_input");
    expectCode(() => sealer.sealPasswordCheck({ checkId, adminUserId: "not an id", password }), "invalid_input");
    expectCode(() => sealer.sealPasswordCheck({ checkId, adminUserId, password: "" }), "invalid_input");
    // A box of the right size that holds a lowercase hash (sealed with the public key, bypassing sealPasswordCheck).
    const forged = seal(messaging.publicKey, Buffer.from(sha1.toLowerCase()), passwordCheckAad(checkId, adminUserId));
    expectCode(() => worker.openPasswordCheck({ checkId, adminUserId, sealed: forged }), "invalid_input");
    // An OTP box is no password check.
    const otp = sealer.sealOtp({ otpId: checkId, phone: "+6281234567890", code: "123456" });
    expectCode(() => worker.openPasswordCheck({ checkId, adminUserId, sealed: otp }), "decrypt_failed");
  });

  it("need the messaging key on both sides", () => {
    const sealed = sealer.sealPasswordCheck({ checkId, adminUserId, password });
    expectCode(() => createSecretSealer({ payment: payment.publicKey }).sealPasswordCheck({ checkId, adminUserId, password }), "scope_unavailable");
    expectCode(() => openerFromEnv({ SECRETS_PAYMENT_PRIVATE_KEY: WORKER_ENV.SECRETS_PAYMENT_PRIVATE_KEY }).openPasswordCheck({ checkId, adminUserId, sealed }), "scope_unavailable");
  });
});
