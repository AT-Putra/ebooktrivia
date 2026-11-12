// The `{secret:name}` resolver for postback templates (plan M2.3 endpoint binding; core
// template.ts SecretResolver). Worker only: it needs the conversions private key.
//
//   const names = postbackSecretNames(template);
//   const resolve = await loadConversionSecretResolver(store, opener, { adnetId, host, names });
//   renderPostbackUrl(template, values, { adnetId, host }, resolve);
//
// `host` is the adnet's endpoint host in URL.host form (hostname plus any non-default port), the
// same value core compares the template against. Only conversions-scope rows with that exact
// adnet_id and bound_host are loaded, each row is checked again here (a store that returns more
// is not trusted), and every value is opened lazily with the row's own labels as AAD. core
// re-checks scope, adnetId and boundHost of what the resolver returns.
//
// Caller contracts (security review US-011):
//   - the binding is host (+ port) only, not scheme or path; core requires https for any
//     template that uses {secret:...}, and the postback sender (M7) must NOT follow redirects
//     (redirect: "error"), or a 30x from the bound host could forward the secret elsewhere;
//   - the admin "test send" (M5/M8) runs as a worker job through this same resolver, never with
//     a separately decrypted value.

import type { ResolvedSecret, SecretResolver } from "@ebooktrivia/core";
import type { SecretOpener, StoredSecretRow } from "./secrets.ts";

export interface ConversionSecretQuery {
  readonly adnetId: string;
  readonly host: string;
  readonly names: readonly string[];
}

/**
 * DB access: settings_secrets rows WHERE scope = 'conversions' AND adnet_id = adnetId AND
 * bound_host = host AND name IN names (@ebooktrivia/db conversionSecretStore).
 */
export interface ConversionSecretStore {
  findConversionSecrets(query: ConversionSecretQuery): Promise<readonly StoredSecretRow[]>;
}

export async function loadConversionSecretResolver(
  store: ConversionSecretStore,
  opener: SecretOpener,
  query: ConversionSecretQuery,
): Promise<SecretResolver> {
  const names = [...new Set(query.names)];
  const rows = names.length === 0 ? [] : await store.findConversionSecrets({ ...query, names });
  const bound = new Map<string, StoredSecretRow>();
  for (const row of rows) {
    if (
      row.scope === "conversions" &&
      row.adnetId === query.adnetId &&
      row.boundHost === query.host &&
      names.includes(row.name)
    ) {
      bound.set(row.name, row);
    }
  }
  return (request): ResolvedSecret | undefined => {
    if (request.adnetId !== query.adnetId || request.host !== query.host) return undefined;
    const row = bound.get(request.name);
    if (row === undefined) return undefined;
    return { value: opener.openSecret(row), scope: row.scope, adnetId: row.adnetId, boundHost: row.boundHost };
  };
}
