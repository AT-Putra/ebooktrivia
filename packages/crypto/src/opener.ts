// The opening side of sealed secrets (split from secrets.ts in US-017, code review L7): only the
// worker and the public app (payment scope) import it; the admin app imports the sealer subpath
// (@ebooktrivia/crypto/sealer) and never this module (apps/admin/src/app/guards.test.ts).
import type { KeyObject } from "node:crypto";
import { isSecretScope, otpAad, passwordCheckAad, secretAad, type SecretScope } from "./aad.ts";
import { CryptoError, gcmDecrypt, keyIdOf, open, privateKeyObject, rawPublicKey } from "./sealed-box.ts";
import {
  assertOtpCode,
  assertPasswordSha1,
  configuredScopes,
  DEK_BYTES,
  type Env,
  type OtpInput,
  type PasswordCheckInput,
  type ScopeKeys,
  scopeKeysFromEnv,
  scopeUnavailable,
  SEALED_OTP_BYTES,
  SEALED_PASSWORD_CHECK_BYTES,
  type SecretOpener,
  type StoredSecretRow,
} from "./secrets.ts";

export function createSecretOpener(privateKeys: ScopeKeys): SecretOpener {
  const scopes = configuredScopes(privateKeys);
  if (scopes.length === 0) throw new CryptoError("invalid_key", "an opener needs at least one scope private key");
  const keys = new Map<SecretScope, { key: KeyObject; keyId: string }>();
  for (const scope of scopes) {
    const key = privateKeyObject(privateKeys[scope] ?? new Uint8Array());
    keys.set(scope, { key, keyId: keyIdOf(rawPublicKey(key)) });
  }
  const keyFor = (scope: SecretScope) => {
    const key = keys.get(scope);
    if (key === undefined) throw scopeUnavailable(scope, "private");
    return key;
  };

  return Object.freeze({
    scopes: Object.freeze([...scopes]),
    openSecret(row: StoredSecretRow): string {
      const scope = row.scope;
      // The key is picked by the ROW's scope, and must be the very key the row was sealed to.
      if (!isSecretScope(scope)) throw scopeUnavailable(scope, "private");
      const { key, keyId } = keyFor(scope);
      if (row.keyId !== keyId) {
        throw new CryptoError("key_mismatch", `secret key_id does not match the configured ${scope} key`);
      }
      const { id, name, adnetId, boundHost } = row;
      const aad = secretAad({ id, scope, name, adnetId, boundHost, keyId: row.keyId });
      const dek = open(key, row.sealedDek, aad);
      try {
        if (dek.length !== DEK_BYTES) throw new CryptoError("decrypt_failed", "decryption failed");
        return gcmDecrypt(dek, row.nonce, row.ciphertext, aad).toString("utf8");
      } finally {
        dek.fill(0);
      }
    },
    openOtp(input: OtpInput & { readonly sealed: Uint8Array }): string {
      const { key } = keyFor("messaging");
      const aad = otpAad(input.otpId, input.phone);
      if (input.sealed.length !== SEALED_OTP_BYTES) throw new CryptoError("decrypt_failed", "decryption failed");
      return assertOtpCode(open(key, input.sealed, aad).toString("latin1"));
    },
    openPasswordCheck(input: PasswordCheckInput & { readonly sealed: Uint8Array }): string {
      const { key } = keyFor("messaging");
      const aad = passwordCheckAad(input.checkId, input.adminUserId);
      if (input.sealed.length !== SEALED_PASSWORD_CHECK_BYTES) throw new CryptoError("decrypt_failed", "decryption failed");
      return assertPasswordSha1(open(key, input.sealed, aad).toString("latin1"));
    },
  });
}

/** Opener from SECRETS_<SCOPE>_PRIVATE_KEY only; throws when none is set (e.g. admin.env). */
export function openerFromEnv(env: Env): SecretOpener {
  return createSecretOpener(scopeKeysFromEnv(env, "PRIVATE"));
}
