// The sealing side only (code review US-017 L7): what a process that may write secrets but never
// read them (apps/admin) imports. No function here can decrypt.
export { CryptoError, type CryptoErrorCode, isCryptoError } from "./sealed-box.ts";
export { SECRET_SCOPES, type SecretScope } from "./aad.ts";
export { createSecretSealer, last4, type SealedSecret, type SecretInput, type SecretSealer, sealerFromEnv } from "./secrets.ts";
