// Sealed secrets (settings_secrets) and sealed OTP codes (player_otps.sealed_code); plan M2.3.
//
// Per-secret envelope (one fresh DEK per write):
//   aad        = secretAad(id, scope, name, adnet_id, bound_host, key_id)       (aad.ts)
//   ciphertext = AES-256-GCM(DEK, nonce, plaintext UTF-8, aad) || tag (16)    settings_secrets.ciphertext
//   nonce      = 12 random bytes                                             settings_secrets.nonce
//   sealed_dek = seal(scope public key, DEK, aad)  = 32 + 32 + 16 = 80 bytes  settings_secrets.sealed_dek
//   key_id     = keyIdOf(scope public key)                                    settings_secrets.key_id
// OTP: player_otps.sealed_code = seal(messaging public key, "NNNNNN", otpAad(otp_id, phone)),
// exactly 6 + 48 = 54 bytes.
//
// Two separate capabilities:
//   SecretSealer  built from PUBLIC keys only (admin.env: all scopes; public.env: messaging, to
//                 seal OTPs). It has no method that decrypts.
//   SecretOpener  (opener.ts) built from PRIVATE keys (public.env: payment; worker.env: payment, messaging,
//                 conversions). It picks the key by the ROW's scope and requires the row's key_id
//                 to equal that key's id; anything else fails closed.
// Env: SECRETS_<SCOPE>_PUBLIC_KEY / SECRETS_<SCOPE>_PRIVATE_KEY, raw 32-byte X25519 keys as
// base64url (decodeSecretKey). The opener reads only *_PRIVATE_KEY, the sealer only *_PUBLIC_KEY.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { decodeSecretKey } from "@ebooktrivia/core";
import { isSecretScope, otpAad, passwordCheckAad, SECRET_SCOPES, secretAad, type SecretLabels, type SecretScope } from "./aad.ts";
import {
  CryptoError,
  GCM_NONCE_BYTES,
  gcmEncrypt,
  keyIdOf,
  publicKeyObject,
  seal,
  SEALED_BOX_OVERHEAD,
  X25519_KEY_BYTES,
} from "./sealed-box.ts";

export const DEK_BYTES = 32;
const OTP_CODE = /^[0-9]{6}$/;
export const SEALED_OTP_BYTES = 6 + SEALED_BOX_OVERHEAD;

export type ScopeKeys = Readonly<Partial<Record<SecretScope, Uint8Array>>>;
export type Env = Readonly<Record<string, string | undefined>>;

/** A settings_secrets row as read from the DB (labels not yet validated; bytea as bytes). */
export interface StoredSecretRow {
  readonly id: string;
  readonly scope: string;
  readonly name: string;
  readonly adnetId: string | null;
  readonly boundHost: string | null;
  readonly keyId: string;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly sealedDek: Uint8Array;
}

/** What the admin app INSERTs / UPDATEs: the sealed row plus last4 for display. */
export interface SealedSecret extends SecretLabels {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly sealedDek: Buffer;
  readonly last4: string;
}

export interface SecretInput {
  /** Existing row id when re-encrypting; a new random UUID otherwise. */
  readonly id?: string;
  readonly scope: SecretScope;
  readonly name: string;
  readonly adnetId: string | null;
  readonly boundHost: string | null;
  readonly plaintext: string;
}

export interface OtpInput {
  readonly otpId: string;
  /** E.164, as in player_otps.phone and the outbox payload. */
  readonly phone: string;
}

/** The labels of an admin password's breached-password check (outbox payload check_id + admin_user_id). */
export interface PasswordCheckInput {
  readonly checkId: string;
  readonly adminUserId: string;
}

export interface SecretSealer {
  readonly scopes: readonly SecretScope[];
  keyId(scope: SecretScope): string;
  sealSecret(input: SecretInput): SealedSecret;
  sealOtp(input: OtpInput & { readonly code: string }): Buffer;
  /**
   * US-031 (ASVS V6.2.12): the SHA-1 of an admin password (40 uppercase hex), sealed to the messaging key for the worker's
   * breached-password check. The password is hashed here and goes nowhere else.
   */
  sealPasswordCheck(input: PasswordCheckInput & { readonly password: string }): Buffer;
}

export interface SecretOpener {
  readonly scopes: readonly SecretScope[];
  openSecret(row: StoredSecretRow): string;
  /** Opens a sealed OTP from the outbox (`sealed`, payload otp_id + phone); returns the 6 digits. */
  openOtp(input: OtpInput & { readonly sealed: Uint8Array }): string;
  /** Opens a sealed password check from the outbox (`sealed`, payload check_id + admin_user_id); returns the SHA-1. */
  openPasswordCheck(input: PasswordCheckInput & { readonly sealed: Uint8Array }): string;
}

const SHA1_HEX = /^[0-9A-F]{40}$/;
export const SEALED_PASSWORD_CHECK_BYTES = 40 + SEALED_BOX_OVERHEAD;

/** Worker-side check of an opened password check: exactly 40 uppercase hex characters. */
export function assertPasswordSha1(sha1: string): string {
  if (!SHA1_HEX.test(sha1)) throw new CryptoError("invalid_input", "password check must be a SHA-1 in uppercase hex");
  return sha1;
}

/**
 * What the admin UI shows: the last 4 characters of a secret of at least 16 characters, else ""
 * (never more than 4 characters, never more than a quarter of the secret). Counts code points.
 * 16, not 8: user-chosen SMTP/WAHA passwords are often 8-12 characters, where 4 would reveal up
 * to half (security review US-011 #4).
 */
export function last4(plaintext: string): string {
  const chars = Array.from(plaintext);
  return chars.length >= 16 ? chars.slice(-4).join("") : "";
}

/** C0 controls (incl. CR, LF, TAB, NUL) and DEL: they could split HTTP headers or SMTP commands. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Worker-side check of an opened OTP: exactly 6 ASCII digits. */
export function assertOtpCode(code: string): string {
  if (!OTP_CODE.test(code)) throw new CryptoError("invalid_input", "OTP code must be 6 digits");
  return code;
}

export function configuredScopes(keys: ScopeKeys): SecretScope[] {
  for (const scope of Object.keys(keys)) {
    if (!isSecretScope(scope)) throw new CryptoError("invalid_key", `unknown secret scope ${scope}`);
  }
  return SECRET_SCOPES.filter((scope) => keys[scope] !== undefined);
}

export function scopeUnavailable(scope: string, what: string): CryptoError {
  return new CryptoError("scope_unavailable", `no ${what} key configured for scope ${scope}`);
}

export function createSecretSealer(publicKeys: ScopeKeys): SecretSealer {
  const scopes = configuredScopes(publicKeys);
  if (scopes.length === 0) throw new CryptoError("invalid_key", "a sealer needs at least one scope public key");
  const keys = new Map<SecretScope, { raw: Buffer; keyId: string }>();
  for (const scope of scopes) {
    const raw = Buffer.from(publicKeys[scope] ?? []);
    publicKeyObject(raw); // validates the length
    // A low-order key would make every seal fail; refuse it at startup instead.
    seal(raw, Buffer.alloc(0), Buffer.alloc(0));
    keys.set(scope, { raw, keyId: keyIdOf(raw) });
  }
  const keyFor = (scope: SecretScope) => {
    const key = keys.get(scope);
    if (key === undefined) throw scopeUnavailable(scope, "public");
    return key;
  };

  return Object.freeze({
    scopes: Object.freeze([...scopes]),
    keyId: (scope: SecretScope) => keyFor(scope).keyId,
    sealSecret(input: SecretInput): SealedSecret {
      const key = keyFor(input.scope);
      if (typeof input.plaintext !== "string" || input.plaintext === "" || !input.plaintext.isWellFormed()) {
        throw new CryptoError("invalid_input", "secret must be a non-empty, well-formed string");
      }
      if (hasControlChar(input.plaintext)) {
        throw new CryptoError("invalid_input", "secret must not contain control characters (CR, LF, TAB, NUL, ...)");
      }
      const labels: SecretLabels = {
        id: input.id ?? randomUUID(),
        scope: input.scope,
        name: input.name,
        adnetId: input.adnetId,
        boundHost: input.boundHost,
        keyId: key.keyId,
      };
      const aad = secretAad(labels);
      const dek = randomBytes(DEK_BYTES);
      const nonce = randomBytes(GCM_NONCE_BYTES);
      try {
        return {
          ...labels,
          ciphertext: gcmEncrypt(dek, nonce, Buffer.from(input.plaintext, "utf8"), aad),
          nonce,
          sealedDek: seal(key.raw, dek, aad),
          last4: last4(input.plaintext),
        };
      } finally {
        dek.fill(0);
      }
    },
    sealOtp(input: OtpInput & { readonly code: string }): Buffer {
      const key = keyFor("messaging");
      const code = assertOtpCode(input.code);
      return seal(key.raw, Buffer.from(code, "ascii"), otpAad(input.otpId, input.phone));
    },
    sealPasswordCheck(input: PasswordCheckInput & { readonly password: string }): Buffer {
      const key = keyFor("messaging");
      if (typeof input.password !== "string" || input.password === "") throw new CryptoError("invalid_input", "password must be a non-empty string");
      const sha1 = createHash("sha1").update(input.password, "utf8").digest("hex").toUpperCase();
      return seal(key.raw, Buffer.from(sha1, "ascii"), passwordCheckAad(input.checkId, input.adminUserId));
    },
  });
}

export function scopeKeysFromEnv(env: Env, kind: "PUBLIC" | "PRIVATE"): ScopeKeys {
  const keys: Partial<Record<SecretScope, Uint8Array>> = {};
  for (const scope of SECRET_SCOPES) {
    const name = `SECRETS_${scope.toUpperCase()}_${kind}_KEY`;
    const value = env[name];
    if (value === undefined || value === "") continue;
    let raw: Buffer;
    try {
      raw = decodeSecretKey(value, "base64url", X25519_KEY_BYTES);
    } catch {
      throw new CryptoError("invalid_key", `${name} is not a base64url X25519 key`);
    }
    if (raw.length !== X25519_KEY_BYTES) throw new CryptoError("invalid_key", `${name} must decode to 32 bytes`);
    keys[scope] = raw;
  }
  return keys;
}

/** Sealer from SECRETS_<SCOPE>_PUBLIC_KEY (admin.env, public.env). */
export function sealerFromEnv(env: Env): SecretSealer {
  return createSecretSealer(scopeKeysFromEnv(env, "PUBLIC"));
}
