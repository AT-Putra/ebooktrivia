// Write-only secrets (AC-A1/A2, plan M2.3; US-017). The admin app seals a secret with the scope's
// PUBLIC key (@ebooktrivia/crypto SecretSealer, which has no decrypt method) and stores the sealed
// row; it never reads a sealed column back (admin_rw has no SELECT on ciphertext, nonce or
// sealed_dek, sql/grants.sql). The console shows only whether a secret is set and, for secrets of
// at least 16 characters, its last 4 characters (captured at write time). The audit log records
// `{"value": {"set": true | false}}`, never the value or last4.
import { randomUUID } from "node:crypto";
import { CryptoError, type SecretScope, type SecretSealer } from "@ebooktrivia/crypto/sealer";
import type { AuditRecorder, Tx } from "../audit.ts";
import type { Sql } from "../db.ts";
import type { SettingsConfig } from "./env.ts";
import { InvalidInput } from "./fields.ts";

export interface SecretTarget {
  readonly scope: SecretScope;
  readonly name: string;
  readonly adnetId: string | null;
  readonly boundHost: string | null;
}

export interface SecretStatus {
  readonly set: boolean;
  /** "" when the secret is shorter than 16 characters (see @ebooktrivia/crypto last4). */
  readonly last4: string;
  readonly updatedAt: Date | null;
}

export const NOT_SET: SecretStatus = Object.freeze({ set: false, last4: "", updatedAt: null });
export const SECRET_MAX_LENGTH = 4096;

export function requireSealer(settings: SettingsConfig, scope: SecretScope): SecretSealer {
  const sealer = settings.sealer;
  if (sealer === null || !sealer.scopes.includes(scope)) {
    throw new InvalidInput(`Secrets of this kind cannot be saved: the ${scope} sealing key is not configured on the server.`);
  }
  return sealer;
}

const keyOf = (scope: string, name: string, adnetId: string | null): string => `${scope}|${name}|${adnetId ?? ""}`;

/** Set / last4 of the given secrets (only label columns are read). */
export async function secretStatuses(sql: Sql | Tx, targets: readonly Omit<SecretTarget, "boundHost">[]): Promise<(SecretStatus & { readonly key: string })[]> {
  if (targets.length === 0) return [];
  const rows = await sql<{ scope: string; name: string; adnet_id: string | null; last4: string; updated_at: Date }[]>`
    SELECT scope, name, adnet_id, last4, updated_at FROM public.settings_secrets
     WHERE name = ANY (${targets.map((t) => t.name)}::text[])`;
  const found = new Map(rows.map((r) => [keyOf(r.scope, r.name, r.adnet_id), r]));
  return targets.map((t) => {
    const key = keyOf(t.scope, t.name, t.adnetId);
    const row = found.get(key);
    return row === undefined ? { ...NOT_SET, key } : { key, set: true, last4: row.last4, updatedAt: row.updated_at };
  });
}

export async function secretStatus(sql: Sql | Tx, target: Omit<SecretTarget, "boundHost">): Promise<SecretStatus> {
  const [status] = await secretStatuses(sql, [target]);
  return status ?? NOT_SET;
}

/** The submitted secret, trimmed; refuses empty, overlong and control characters. */
export function parseSecret(raw: string): string {
  const value = raw.trim();
  if (value === "" || Array.from(value).length > SECRET_MAX_LENGTH) throw new InvalidInput(`Enter the secret (1 to ${String(SECRET_MAX_LENGTH)} characters).`);
  if (/\p{Cc}/u.test(value) || !value.isWellFormed()) throw new InvalidInput("The secret must not contain line breaks, tabs or other control characters.");
  return value;
}

/**
 * Seals `plaintext` and inserts or replaces the row of `target` (same id when replacing: the id is
 * part of the AAD). Records the audit entry on `audit`.
 */
export async function writeSecret(tx: Tx, audit: AuditRecorder, sealer: SecretSealer, target: SecretTarget, plaintext: string): Promise<void> {
  const [existing] = await tx<{ id: string }[]>`
    SELECT id FROM public.settings_secrets
     WHERE scope = ${target.scope} AND name = ${target.name} AND adnet_id IS NOT DISTINCT FROM ${target.adnetId}::uuid
       FOR UPDATE`;
  let sealed;
  try {
    sealed = sealer.sealSecret({ id: existing?.id ?? randomUUID(), ...target, plaintext });
  } catch (error) {
    if (error instanceof CryptoError) throw new InvalidInput("The secret could not be sealed: check it has no control characters.");
    throw error;
  }
  if (existing === undefined) {
    await tx`
      INSERT INTO public.settings_secrets (id, scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
      VALUES (${sealed.id}, ${sealed.scope}, ${sealed.name}, ${sealed.adnetId}, ${sealed.boundHost}, ${sealed.ciphertext},
              ${sealed.nonce}, ${sealed.sealedDek}, ${sealed.keyId}, ${sealed.last4})`;
  } else {
    await tx`
      UPDATE public.settings_secrets
         SET bound_host = ${sealed.boundHost}, ciphertext = ${sealed.ciphertext}, nonce = ${sealed.nonce},
             sealed_dek = ${sealed.sealedDek}, key_id = ${sealed.keyId}, last4 = ${sealed.last4}, updated_at = clock_timestamp()
       WHERE id = ${sealed.id}`;
  }
  audit({
    action: "settings_secret.set",
    entityType: "settings_secret",
    entityId: sealed.id,
    fields: { value: "secret" },
    // A replacement is recorded as set too (before / after are never compared for secrets).
    before: existing === undefined ? null : {},
    after: { value: "set" },
    facts: { scope: target.scope, name: target.name, adnet_id: target.adnetId, bound_host: target.boundHost, replaced: existing !== undefined },
  });
}

/** Deletes the secret of `target` if there is one; records `{set: false}`. */
export async function clearSecret(tx: Tx, audit: AuditRecorder, target: Omit<SecretTarget, "boundHost">): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    DELETE FROM public.settings_secrets
     WHERE scope = ${target.scope} AND name = ${target.name} AND adnet_id IS NOT DISTINCT FROM ${target.adnetId}::uuid
    RETURNING id`;
  const id = rows[0]?.id ?? null;
  audit({
    action: "settings_secret.clear",
    entityType: "settings_secret",
    entityId: id,
    fields: { value: "secret" },
    before: { value: id === null ? null : "set" },
    after: { value: null },
    facts: { scope: target.scope, name: target.name, adnet_id: target.adnetId, existed: id !== null },
  });
  return id !== null;
}
