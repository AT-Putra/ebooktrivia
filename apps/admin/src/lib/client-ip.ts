// The client address the admin app keys its login throttle and audit rows on. In production the
// edge listener (packages/edge) has already replaced X-Forwarded-For with exactly one canonical
// address: Caddy's view of the TCP peer, or the socket peer for anyone but Caddy. Under `next start`
// (development, e2e) the header is whatever the client sent.
import { isIP } from "node:net";
import { canonicalIp } from "@ebooktrivia/edge";

/** The last X-Forwarded-For entry when it is an IP, else null. */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded === null) return null;
  return canonicalIp(forwarded.split(",").at(-1));
}

function ipv6Groups(ip: string): number[] {
  let text = ip;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4 !== null) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const zeros = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array.from({ length: zeros }, () => "0"), ...right].map((g) => Number.parseInt(g, 16));
}

/**
 * The throttle bucket of an address: an IPv4 address itself, an IPv6 address by its /64 (one
 * customer network; plan carry-over S16), "unknown" when there is none (all such requests share
 * one bucket).
 */
export function throttleBucket(ip: string | null): string {
  const canonical = canonicalIp(ip ?? undefined);
  if (canonical === null) return "unknown";
  if (isIP(canonical) === 4) return canonical;
  const groups = ipv6Groups(canonical).slice(0, 4);
  return `${groups.map((g) => g.toString(16)).join(":")}::/64`;
}
