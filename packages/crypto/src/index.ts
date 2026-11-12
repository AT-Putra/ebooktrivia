// @ebooktrivia/crypto: sealed secrets and sealed OTP codes (plan M2.3). node:crypto only.
export { canonicalAad, isCanonicalHost, otpAad, SECRET_SCOPES, secretAad, type SecretLabels, type SecretScope } from "./aad.ts";
export {
  type ConversionSecretQuery,
  type ConversionSecretStore,
  loadConversionSecretResolver,
} from "./conversion-secrets.ts";
export { CryptoError, type CryptoErrorCode, generateScopeKeyPair, keyIdOf, SEALED_BOX_OVERHEAD } from "./sealed-box.ts";
export {
  assertOtpCode,
  createSecretOpener,
  createSecretSealer,
  type Env,
  last4,
  type OtpInput,
  openerFromEnv,
  type ScopeKeys,
  SEALED_OTP_BYTES,
  type SealedSecret,
  sealerFromEnv,
  type SecretInput,
  type SecretOpener,
  type SecretSealer,
  type StoredSecretRow,
} from "./secrets.ts";
export { assertWahaTarget, type WahaSecretBinding, type WahaServerTarget } from "./waha-target.ts";
