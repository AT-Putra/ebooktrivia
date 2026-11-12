// Client-side half of the WAHA key binding (plan M2.3 endpoint binding; security review US-011 #1).
//
// The messaging-scope WAHA API key is sealed with bound_host = waha_servers.base_url_host in its
// AAD, but the HTTP client sends to base_url. The DB CHECK waha_servers_base_url_check ties the
// two together; this check is the second, independent gate. Every WAHA request (M3 client, the
// admin test-send job) must call it with the server row and the secret row it is about to use,
// and send only to the URL it returns:
//
//   const target = assertWahaTarget(server, secretRow);   // throws CryptoError binding_mismatch
//   const key = opener.openSecret(secretRow);
//   fetch(new URL("sessions", target), { headers: { "X-Api-Key": key }, redirect: "error" });
//
// HTTPS only: the owner's WAHA box is reached over HTTPS with an API key (no WireGuard).

import { CryptoError } from "./sealed-box.ts";

export interface WahaServerTarget {
  readonly baseUrl: string;
  readonly baseUrlHost: string;
}

export interface WahaSecretBinding {
  readonly scope: string;
  readonly boundHost: string | null;
}

const mismatch = (why: string): CryptoError => new CryptoError("binding_mismatch", `WAHA target refused: ${why}`);

/** Returns the parsed base URL the WAHA key may be sent to, or throws binding_mismatch. */
export function assertWahaTarget(server: WahaServerTarget, secret: WahaSecretBinding): URL {
  if (secret.scope !== "messaging") throw mismatch("the secret is not messaging scope");
  if (secret.boundHost === null || secret.boundHost === "") throw mismatch("the secret has no bound host");
  let url: URL;
  try {
    url = new URL(server.baseUrl);
  } catch {
    throw mismatch("base_url does not parse");
  }
  if (url.protocol !== "https:") throw mismatch("base_url is not https");
  if (url.username !== "" || url.password !== "") throw mismatch("base_url carries credentials");
  // URL.host is the canonical form (lowercase, punycode, normalised IPv4, no default port); the
  // label and the bound host must both equal it exactly.
  if (url.host !== server.baseUrlHost) throw mismatch("base_url host differs from base_url_host");
  if (url.host !== secret.boundHost) throw mismatch("base_url host differs from the secret's bound host");
  return url;
}
