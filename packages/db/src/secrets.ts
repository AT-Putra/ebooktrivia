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

/**
 * The sealed CAPI access token of a pixel (US-024): the conversions-scope secret with no adnet, named
 * capi.<platform>.<pixel> (@ebooktrivia/core capiSecretName) and bound to exactly the platform's API host
 * (settings_secrets_binding_check). A row of any other scope, adnet or host is never returned.
 */
export async function findCapiSecret(sql: postgres.ISql, query: { readonly name: string; readonly host: string }): Promise<SettingsSecretRow | undefined> {
  const [row] = await sql<SettingsSecretRow[]>`
    SELECT s.id, s.scope, s.name, s.adnet_id AS "adnetId", s.bound_host AS "boundHost", s.key_id AS "keyId",
           s.ciphertext, s.nonce, s.sealed_dek AS "sealedDek"
      FROM public.settings_secrets s
     WHERE s.scope = 'conversions' AND s.adnet_id IS NULL AND s.name = ${query.name} AND s.bound_host = ${query.host}`;
  return row;
}

/**
 * Names of the sealed secrets the admin app writes and the worker / public app read (US-017).
 * sql/triggers.sql settings_secrets_endpoint_binding refuses the SMTP and WAHA ones unless they are
 * bound to exactly their endpoint host. Payment secrets carry no bound host: the Midtrans hosts are
 * fixed per environment in the adapter.
 */
export const SECRET_NAMES = {
  smtpPassword: "smtp.password",
  /** The WAHA API key of one server (messaging scope, bound to waha_servers.base_url_host). */
  wahaApiKey: (serverId: string): string => `waha.${serverId.replaceAll("-", "").toLowerCase()}.api_key`,
  /** The Midtrans server key of one environment (payment scope). */
  midtransServerKey: (environment: "sandbox" | "production"): string => `midtrans.${environment}.server_key`,
} as const;
