// Reads of sealed settings_secrets rows (worker_rw has SELECT). Decryption happens in
// @ebooktrivia/crypto; this module only selects rows, still sealed.
import type postgres from "postgres";

/** A settings_secrets row as stored; matches @ebooktrivia/crypto StoredSecretRow. */
export interface SettingsSecretRow {
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

/**
 * The store behind the `{secret:name}` resolver (@ebooktrivia/crypto loadConversionSecretResolver):
 * conversions-scope secrets bound to exactly this adnet and endpoint host.
 */
export function conversionSecretStore(sql: postgres.ISql) {
  return {
    async findConversionSecrets(query: {
      readonly adnetId: string;
      readonly host: string;
      readonly names: readonly string[];
    }): Promise<SettingsSecretRow[]> {
      return sql<SettingsSecretRow[]>`
        SELECT s.id, s.scope, s.name, s.adnet_id AS "adnetId", s.bound_host AS "boundHost", s.key_id AS "keyId",
               s.ciphertext, s.nonce, s.sealed_dek AS "sealedDek"
          FROM public.settings_secrets s
         WHERE s.scope = 'conversions'
           AND s.adnet_id = ${query.adnetId}::uuid
           AND s.bound_host = ${query.host}
           AND s.name = ANY (${[...query.names]}::text[])`;
    },
  };
}
