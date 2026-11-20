// Outbound endpoints the Owner configures (WAHA servers, SMTP, adnet postback hosts; US-017,
// plan M3.1 / R5). The worker's safe-fetch policy validates every address again at connect time
// (DNS names included); here the admin refuses what can already be refused from the text:
//   - hosts must be in canonical form: lowercase ASCII DNS names (punycode for IDN, no trailing dot)
//     or dotted-quad IPv4 (no shorthands such as 127.1 or 0x7f.1, which URL parsers rewrite);
//   - an IPv4 literal must pass the same address policy as safe-fetch (@ebooktrivia/adapters
//     address-policy). A private network address (RFC 1918, CGNAT) is accepted only with the
//     explicit private-IP allowlist flag of that endpoint (audited); loopback, link-local and the
//     cloud metadata addresses (169.254.169.254, 100.100.100.200, fd00:ec2::/32) never;
//   - IPv6 literals are refused (waha_servers_base_url_check allows DNS names and IPv4 only);
//   - the allowlist flag is valid for an IPv4 literal only (security review US-017 S3: a host name
//     allowed to reach private addresses could later resolve to any internal service). The DB
//     refuses the combination too (waha_servers / smtp_settings *_allow_private_ip_check), and
//     10.89.0.0/16 (the podman networks) is refused even with the flag (address-policy.ts).
import { isIP } from "node:net";
import { isBlockedAddress } from "@ebooktrivia/adapters/address-policy";
import { normalizeHost } from "@ebooktrivia/core";

export type EndpointRefusal = "invalid" | "not_https" | "credentials" | "ipv6" | "private_needs_allowlist" | "private_only_for_ip" | "blocked_address";

export const ENDPOINT_MESSAGES: Readonly<Record<EndpointRefusal, string>> = {
  invalid: "Enter a valid address: a lowercase host name (punycode for IDN) or an IPv4 address, without a trailing dot, query or fragment.",
  not_https: "The address must start with https://.",
  credentials: "Do not put a user name or password in the address.",
  ipv6: "IPv6 addresses are not supported here; use a host name.",
  private_needs_allowlist: "This is a private network address. Allow private IP for this endpoint to use it.",
  private_only_for_ip: "Allow private IP applies to an IPv4 address only. Enter the server's private IPv4 address, or turn the option off for a host name.",
  blocked_address: "This address is never allowed (loopback, link-local, cloud metadata or reserved).",
};

type Checked<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: EndpointRefusal };

/** A hostname (no port) in canonical form, with the address policy applied to IPv4 literals. */
export function checkHostname(hostname: string, allowPrivateIp: boolean): Checked<{ readonly hostname: string }> {
  if (hostname.startsWith("[") || isIP(hostname) === 6) return { ok: false, reason: "ipv6" };
  if (isIP(hostname) === 4) {
    // Dotted quad only: URL normalises "127.1" to "127.0.0.1", isIP("127.1") is 0 (handled below).
    if (isBlockedAddress(hostname, { allowPrivate: allowPrivateIp, allowLoopback: false })) {
      const privateOnly = !allowPrivateIp && !isBlockedAddress(hostname, { allowPrivate: true, allowLoopback: false });
      return { ok: false, reason: privateOnly ? "private_needs_allowlist" : "blocked_address" };
    }
    return { ok: true, hostname };
  }
  if (normalizeHost(hostname) !== hostname) return { ok: false, reason: "invalid" };
  return allowPrivateIp ? { ok: false, reason: "private_only_for_ip" } : { ok: true, hostname };
}

/** A WAHA base URL: what waha_servers.base_url / base_url_host store. */
export function checkWahaBaseUrl(raw: string, allowPrivateIp: boolean): Checked<{ readonly baseUrl: string; readonly host: string }> {
  const input = raw.trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  if (url.search !== "" || url.hash !== "" || /[?#\\\s]/.test(input)) return { ok: false, reason: "invalid" };
  // The authority as typed must already be canonical (the URL parser would silently rewrite
  // shorthand IPv4, upper case, an explicit :443 or percent-encoding).
  const typed = /^https:\/\/([^/?#\\]*)/i.exec(input)?.[1] ?? "";
  if (url.hostname.startsWith("[")) return { ok: false, reason: "ipv6" };
  if (typed !== url.host) return { ok: false, reason: "invalid" };
  const host = checkHostname(url.hostname, allowPrivateIp);
  if (!host.ok) return host;
  return { ok: true, baseUrl: url.href, host: url.host };
}

/** An SMTP host name (no port, no scheme). */
export function checkSmtpHost(raw: string, allowPrivateIp: boolean): Checked<{ readonly host: string }> {
  const input = raw.trim();
  if (input === "" || /[:/@\s]/.test(input)) return { ok: false, reason: input.includes(":") && isIP(input) === 6 ? "ipv6" : "invalid" };
  const host = checkHostname(input, allowPrivateIp);
  return host.ok ? { ok: true, host: host.hostname } : host;
}
