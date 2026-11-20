// Address policy of every outbound connection (plan M3.1, R5), split out of safe-fetch.ts (US-017)
// so the admin app can apply the same rule to the IP-literal hosts it is given (WAHA base URLs,
// SMTP host, adnet endpoints) without loading undici. See safe-fetch.ts for what each list means.
import { BlockList, isIP } from "node:net";

const ALWAYS_BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  ALWAYS_BLOCKED.addSubnet(network, prefix, "ipv4");
}
// Cloud metadata services outside link-local, refused even for an allowlisted private host
// (US-017: the WAHA private-IP allowlist must never reach them): Alibaba Cloud 100.100.100.200
// (inside CGNAT 100.64/10, a PRIVATE network) and the AWS IMDS IPv6 range fd00:ec2::/32 (inside
// ULA fc00::/7, also PRIVATE). 169.254.169.254 (AWS, GCP, Azure, Oracle) is link-local, above.
ALWAYS_BLOCKED.addAddress("100.100.100.200", "ipv4");
ALWAYS_BLOCKED.addSubnet("fd00:ec2::", 32, "ipv6");
// The production podman networks (infra/quadlet ebt-*.network: 10.89.50.0/24 .. 10.89.53.0/24, and
// the rest of 10.89/16 podman picks from): the app's own containers (PostgreSQL, Valkey, internal,
// admin) are never an outbound target, even for an allowlisted private host (security review
// US-017 S3).
ALWAYS_BLOCKED.addSubnet("10.89.0.0", 16, "ipv4");
for (const [network, prefix] of [
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:2::", 48], // benchmarking
  ["2001:10::", 28], // ORCHID (deprecated)
  ["2001:20::", 28], // ORCHIDv2
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation (RFC 9637)
  ["5f00::", 16], // SRv6 SIDs
  ["2002::", 16], // 6to4
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  ALWAYS_BLOCKED.addSubnet(network, prefix, "ipv6");
}

// IPv4-mapped (::ffff:0:0/96) and IPv4-compatible/unspecified/loopback (::/96) IPv6. Kept apart
// and consulted only for IPv6 input: node:net BlockList treats an IPv4 address and its mapped IPv6
// form as the same, so in ALWAYS_BLOCKED the ::ffff:0:0/96 rule would block every IPv4 address.
const EMBEDDED_IPV4 = new BlockList();
EMBEDDED_IPV4.addSubnet("::", 96, "ipv6");
EMBEDDED_IPV4.addSubnet("::ffff:0:0", 96, "ipv6");
EMBEDDED_IPV4.addSubnet("::ffff:0:0:0", 96, "ipv6"); // SIIT (RFC 6052 / 7915)

/** IPv6 global unicast; everything outside it (and not allowlisted ULA) is refused. */
const GLOBAL_UNICAST = new BlockList();
GLOBAL_UNICAST.addSubnet("2000::", 3, "ipv6");

const PRIVATE_NETWORKS = new BlockList();
for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  PRIVATE_NETWORKS.addSubnet(network, prefix, "ipv4");
}
PRIVATE_NETWORKS.addSubnet("fc00::", 7, "ipv6");

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

export interface AddressPolicy {
  /** The URL host is on the audited private-IP allowlist. */
  readonly allowPrivate: boolean;
  /** Dev/test only: loopback is allowed too (local stubs). */
  readonly allowLoopback: boolean;
}

/** True when a connection to `address` must be refused under `policy`. Non-IP input is refused. */
export function isBlockedAddress(address: string, policy: AddressPolicy = { allowPrivate: false, allowLoopback: false }): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  const type = family === 4 ? "ipv4" : "ipv6";
  // Embedded-IPv4 IPv6 forms are always refused (even ::1 and ::ffff:127.0.0.1 in dev): a
  // connection should use the plain IPv4 address instead.
  if (family === 6 && EMBEDDED_IPV4.check(address, "ipv6")) return !(policy.allowLoopback && address === "::1");
  if (policy.allowLoopback && LOOPBACK.check(address, type)) return false;
  if (ALWAYS_BLOCKED.check(address, type)) return true;
  if (PRIVATE_NETWORKS.check(address, type)) return !policy.allowPrivate;
  return family === 6 && !GLOBAL_UNICAST.check(address, "ipv6");
}
