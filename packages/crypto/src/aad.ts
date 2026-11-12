// Associated data (AAD) binding a ciphertext to the row and labels it belongs to.
//
// Canonical encoding: for each field in order, its UTF-8 byte length as a 4-byte big-endian
// unsigned integer, then its UTF-8 bytes. Length prefixes make the encoding injective, so no two
// field lists share an AAD (e.g. name "a.b" + host "" vs name "a" + host ".b").
//
//   settings_secrets: [ "settings_secrets", "ciphertext", row_id, scope, name,
//                       adnet_id or "", bound_host or "", key_id ]
//   player_otps:      [ "player_otps", "sealed_code", otp_id, phone ]
//
// Every label is in the AAD, so a row relabelled in the DB (another scope, name, adnet, host or
// key id, or another row's id) no longer decrypts.

import { CryptoError } from "./sealed-box.ts";

export const SECRET_SCOPES = ["payment", "messaging", "conversions"] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

/** The labels of a settings_secrets row that its ciphertext is bound to. */
export interface SecretLabels {
  /** settings_secrets.id, lowercase UUID. */
  readonly id: string;
  readonly scope: SecretScope;
  readonly name: string;
  readonly adnetId: string | null;
  /** URL.host form: lowercase hostname plus ":port" when the port is not the default. */
  readonly boundHost: string | null;
  readonly keyId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Same rule as settings_secrets_name_check and core's template SECRET_NAME. */
const SECRET_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const KEY_ID = /^[0-9a-f]{16}$/;
/** Same as packages/db e164Check. */
const E164 = /^\+[1-9][0-9]{7,14}$/;

const invalid = (what: string): CryptoError => new CryptoError("invalid_input", what);

export function canonicalAad(fields: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

export const isSecretScope = (value: unknown): value is SecretScope =>
  typeof value === "string" && (SECRET_SCOPES as readonly string[]).includes(value);

/** True when `host` is exactly what URL.host gives for https://host (lowercase, no default port). */
export function isCanonicalHost(host: string): boolean {
  if (host === "" || /[/?#@\\\s]/.test(host)) return false;
  try {
    return new URL(`https://${host}`).host === host;
  } catch {
    return false;
  }
}

/** Rejects labels that are not in their canonical form (so one row has exactly one AAD). */
export function assertSecretLabels(labels: SecretLabels): void {
  if (!UUID.test(labels.id)) throw invalid("secret id must be a lowercase UUID");
  if (!isSecretScope(labels.scope)) throw invalid("unknown secret scope");
  if (!SECRET_NAME.test(labels.name)) throw invalid("invalid secret name");
  if (labels.adnetId !== null && !UUID.test(labels.adnetId)) throw invalid("adnet id must be a lowercase UUID or null");
  if (labels.boundHost !== null && !isCanonicalHost(labels.boundHost)) {
    throw invalid("bound host must be a lowercase URL host (hostname[:port]) or null");
  }
  if (!KEY_ID.test(labels.keyId)) throw invalid("key id must be 16 lowercase hex characters");
}

export function secretAad(labels: SecretLabels): Buffer {
  assertSecretLabels(labels);
  return canonicalAad([
    "settings_secrets",
    "ciphertext",
    labels.id,
    labels.scope,
    labels.name,
    labels.adnetId ?? "",
    labels.boundHost ?? "",
    labels.keyId,
  ]);
}

export function otpAad(otpId: string, phone: string): Buffer {
  if (!UUID.test(otpId)) throw invalid("otp id must be a lowercase UUID");
  if (!E164.test(phone)) throw invalid("phone must be E.164");
  return canonicalAad(["player_otps", "sealed_code", otpId, phone]);
}
