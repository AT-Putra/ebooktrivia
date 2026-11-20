// The stored form of a landing-page host (lp_domains.host), shared by the internal process's Caddy
// `ask` check (apps/worker) and the admin's LP domain registration (apps/admin), so both accept
// exactly the same names (moved here from apps/worker in US-017).
//
// Host check for Caddy's on-demand TLS `ask` (internal process). Caddy asks with the SNI name of
// a TLS handshake that anyone on the internet can start, so the input is hostile. Only the exact
// form lp_domains stores is approved: lowercase ASCII (punycode A-labels for IDN), at least two
// labels, no trailing dot (see the lp_domains_host_check CHECK). Security review US-013 #1: no
// Unicode / UTS46 mapping and no trailing-dot variant, because every distinct name Caddy is
// allowed to ask for becomes its own certificate order, and mapped aliases (full-width letters,
// soft hyphens, U+3002, zero-width characters, U-labels) would let anyone burn the ACME rate
// limits of a registered domain.
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

const MAX_HOST = 253;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Checked on the RAW input: toLowerCase maps some non-ASCII letters onto ASCII (U+212A KELVIN SIGN -> "k"). */
const PLAIN = /^[A-Za-z0-9.-]+$/;

/**
 * `input` lowercased when it is exactly a stored-form host (ASCII letters, digits, "-" and "."),
 * else null. ASCII case is the only variation accepted; a name the URL host parser would rewrite
 * (IPv4 shorthands, invalid A-labels it normalizes) is refused.
 */
export function normalizeHost(input: string): string | null {
  if (input.length === 0 || input.length > MAX_HOST || !PLAIN.test(input)) return null;
  const host = input.toLowerCase();
  if (isIP(host) !== 0 || domainToASCII(host) !== host) return null;
  const labels = host.split(".");
  return labels.length >= 2 && labels.every((label) => LABEL.test(label)) ? host : null;
}
