// Client address behind Caddy (plan M4.3: "the apps trust X-Forwarded-For only from Caddy's pinned
// IP"). Caddy is the only ingress and sets X-Forwarded-For to the TCP peer it accepted (the real
// client: its listeners are socket-activated in the host network namespace). Any other peer (another
// container on the podman network, a misrouted connection) is taken at its socket address and its
// forwarding headers are dropped, so a spoofed X-Forwarded-For never reaches the app.
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

/**
 * Headers a framework or library might read a client address or origin from. All are removed and
 * only `x-forwarded-for` is set again, to the one resolved address (Next.js keeps an existing value
 * and Better Auth reads it, see docs/spikes/R13.md).
 */
export const CLIENT_IP_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "x-forwarded",
  "forwarded-for",
  "x-client-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "fastly-client-ip",
  "x-cluster-client-ip",
] as const;

/** Kept from the trusted proxy (Caddy sets them); removed from anyone else. */
export const PROXY_ONLY_HEADERS = ["x-forwarded-proto", "x-forwarded-host", "x-forwarded-port"] as const;

const STRIPPED = new Set<string>([...CLIENT_IP_HEADERS, ...PROXY_ONLY_HEADERS]);

/** An IP in canonical text form ("::ffff:10.0.0.1" -> "10.0.0.1", IPv6 lowercased), else null. */
export function canonicalIp(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  const v4mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  if (v4mapped?.[1] !== undefined) return isIP(v4mapped[1]) === 4 ? v4mapped[1] : null;
  if (trimmed.includes("%")) return null; // zone ids are never a client address
  const kind = isIP(trimmed);
  if (kind === 4) return trimmed;
  if (kind === 6) return trimmed.toLowerCase();
  return null;
}

export interface ClientIp {
  /** The address the app may rely on; null only when the socket has no address (closed). */
  readonly ip: string | null;
  /** True when the peer is the trusted proxy (its forwarding headers were believed). */
  readonly viaProxy: boolean;
}

/**
 * The client address of a request. From the trusted proxy: the LAST X-Forwarded-For entry (the
 * one the proxy wrote; Caddy trusts no proxy in front of it, so it writes exactly one), or the peer
 * when that entry is missing or not an IP. From anyone else: the peer, whatever the headers say.
 */
export function resolveClientIp(peer: string | undefined, forwardedFor: string | readonly string[] | undefined, trustedProxy: string | null): ClientIp {
  const peerIp = canonicalIp(peer);
  if (trustedProxy === null || peerIp === null || peerIp !== trustedProxy) return { ip: peerIp, viaProxy: false };
  const joined = typeof forwardedFor === "string" ? forwardedFor : (forwardedFor ?? []).join(",");
  const last = joined.split(",").at(-1);
  return { ip: canonicalIp(last) ?? peerIp, viaProxy: true };
}

/**
 * Rewrites the request's headers in place before the app sees them: every client-address header
 * is removed, `x-forwarded-for` is set to the resolved address, and the forwarded proto / host /
 * port headers survive only from the trusted proxy. Both `headers` and `rawHeaders` are rewritten,
 * so no reader of either can see the original values.
 */
export function applyClientIp(req: IncomingMessage, trustedProxy: string | null): ClientIp {
  const client = resolveClientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"], trustedProxy);
  const kept: Record<string, string> = {};
  if (client.viaProxy) {
    for (const name of PROXY_ONLY_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") kept[name] = value;
    }
  }
  for (const name of STRIPPED) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- fixed allowlist of header names
    delete req.headers[name];
  }
  const raw: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i] ?? "";
    if (!STRIPPED.has(name.toLowerCase())) raw.push(name, req.rawHeaders[i + 1] ?? "");
  }
  const set = (name: string, value: string) => {
    req.headers[name] = value;
    raw.push(name, value);
  };
  if (client.ip !== null) set("x-forwarded-for", client.ip);
  for (const [name, value] of Object.entries(kept)) set(name, value);
  req.rawHeaders = raw;
  return client;
}
