// @ebooktrivia/crypto: sealed secrets and sealed OTP codes (plan M2.3). node:crypto only.
export { canonicalAad, isCanonicalHost, otpAad, passwordCheckAad, SECRET_SCOPES, secretAad, type SecretLabels, type SecretScope } from "./aad.ts";
export {
  type ConversionSecretQuery,
  type ConversionSecretStore,
  loadConversionSecretResolver,
} from "./conversion-secrets.ts";
export { CryptoError, type CryptoErrorCode, generateScopeKeyPair, isCryptoError, keyIdOf, SEALED_BOX_OVERHEAD } from "./sealed-box.ts";
export {
  assertOtpCode,
  createSecretSealer,
  type Env,
  last4,
  type OtpInput,
  type PasswordCheckInput,
  type ScopeKeys,
  SEALED_OTP_BYTES,
  SEALED_PASSWORD_CHECK_BYTES,
  type SealedSecret,
  sealerFromEnv,
  type SecretInput,
  type SecretOpener,
  type SecretSealer,
  type StoredSecretRow,
} from "./secrets.ts";
export { createSecretOpener, openerFromEnv } from "./opener.ts";
export {
  createWaReadOpener,
  createWaReadSealer,
  WA_READ_SEALED_MAX_BYTES,
  waReadAad,
  type WaReadLabels,
  type WaReadOpener,
  waReadOpenerFromEnv,
  type WaReadSealer,
  waReadSealerFromEnv,
} from "./wa-read.ts";
export { deriveFileUrlKey, FILE_URL_KEY_BYTES, fileUrlKeyFromEnv } from "./file-url-key.ts";
export { assertWahaTarget, type WahaSecretBinding, type WahaServerTarget } from "./waha-target.ts";
