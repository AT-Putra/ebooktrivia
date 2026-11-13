// SSRF-safe HTTP client for every outbound request the system makes (plan M3.1): WAHA, Midtrans,
// SMTP-over-HTTP APIs, S2S postbacks and CAPI calls all go through it.
//
//   - The IP is validated AT CONNECT TIME: undici's connect.lookup hook resolves the name once and
//     the socket connects to exactly the address that was checked, so DNS rebinding between a
//     check and the connect is impossible. IP-literal URLs never reach the lookup hook, so they
//     are checked before the request.
//   - Every resolved address must pass; one blocked answer refuses the whole request (fail closed).
//   - Redirects are never followed (a 30x is an error carrying its status), the whole request
//     (connect, headers AND body) has a 5 s timeout.
//   - Bodies are capped (maxBodyBytes, default 1 MiB) counting DECODED bytes, because undici
//     decompresses transparently (a 200 KB gzip body became 200 MB). The response is a SafeResponse
//     whose text()/json()/bytes() read through the cap and textPrefix() reads a bounded prefix;
//     the raw stream is not exposed, so no caller can read unbounded. Body-read failures are
//     SafeFetchErrors too (timeout / request_failed), never a raw DOMException.
//   - https only, unless a caller passes allowHttp (dev stubs).
//   - A9: allowHttp / devAllowLoopback are dev-only. The worker config loader refuses its dev
//     flags when NODE_ENV=production (apps/worker/src/worker-config.ts); every other caller must
//     do the same.
//   - A10: close() closes the two undici Agents (waits for in-flight requests; afterwards every
//     request fails with request_failed), for graceful shutdown.
//
// Address policy:
//   ALWAYS blocked: unspecified, loopback, link-local (incl. 169.254.169.254 metadata), 0/8,
//     TEST-NETs, benchmarking 198.18/15, multicast, reserved, broadcast, IPv4-mapped/-compatible
//     and SIIT (::ffff:0:0:0/96) IPv6, NAT64 64:ff9b::/96 and /48, 6to4 2002::/16, Teredo
//     2001::/32, discard 100::/64, documentation 2001:db8::/32 and 3fff::/20, benchmarking
//     2001:2::/48, ORCHID 2001:10::/28 and 2001:20::/28, SRv6 SIDs 5f00::/16, site-local fec0::/10.
//     Beyond that, IPv6 must be global unicast 2000::/3 (ULA only via the private allowlist).
//   PRIVATE networks (RFC 1918, CGNAT 100.64/10, IPv6 ULA fc00::/7): blocked unless the URL host
//     is on the caller's allowPrivateHosts list - the explicit, audited admin allowlist for a WAHA
//     host on a private IP (waha_servers.allow_private_ip; changes are audit-logged by the admin).
//   devAllowLoopback (dev/test only, never in production): also lets loopback through, for the
//     local WAHA mock / Midtrans stub.

import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit, type Response } from "undici";

export type SafeFetchErrorCode =
  | "invalid_url"
  | "scheme_not_allowed"
  | "blocked_address"
  | "dns_failed"
  | "redirect_refused"
  | "timeout"
  | "request_failed"
  | "response_too_large";

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  /** The HTTP status when there was a response (redirect_refused). */
  readonly httpStatus: number | undefined;
  constructor(code: SafeFetchErrorCode, message: string, options?: { cause?: unknown; httpStatus?: number }) {
    super(message, options);
    this.name = "SafeFetchError";
    this.code = code;
    this.httpStatus = options?.httpStatus;
  }
}

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

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Name resolution; injectable so tests can simulate rebinding and private answers. */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, order: "verbatim" }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });

export type LookupCallback = (error: Error | null, address: string | readonly ResolvedAddress[], family?: number) => void;

/**
 * The connect-time lookup: resolve once, refuse if any answer is blocked, connect to what was
 * checked. Exported for socket clients that do not go through undici (the SMTP adapter passes it
 * as net/tls `lookup`), so they get the same SSRF policy.
 */
export function connectLookup(resolver: Resolver, policy: AddressPolicy) {
  return (hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback): void => {
    resolver(hostname).then(
      (answers) => {
        if (answers.length === 0) {
          callback(new SafeFetchError("dns_failed", `${hostname} did not resolve`), "");
          return;
        }
        const blocked = answers.find((a) => isBlockedAddress(a.address, policy));
        if (blocked !== undefined) {
          callback(new SafeFetchError("blocked_address", `${hostname} resolves to a blocked address (${blocked.address})`), "");
          return;
        }
        const usable = options.family === 4 || options.family === 6 ? answers.filter((a) => a.family === options.family) : answers;
        const first = usable[0];
        if (first === undefined) {
          callback(new SafeFetchError("dns_failed", `${hostname} has no IPv${String(options.family)} address`), "");
          return;
        }
        if (options.all === true) callback(null, usable);
        else callback(null, first.address, first.family);
      },
      (error: unknown) => {
        callback(new SafeFetchError("dns_failed", `${hostname} did not resolve`, { cause: error }), "");
      },
    );
  };
}

export interface SafeFetchOptions {
  /**
   * URL.host values (lowercase, punycode, port only if non-default) allowed to resolve to a
   * PRIVATE network: the audited admin allowlist for WAHA hosts on private IPs. Never loopback,
   * link-local or metadata addresses.
   */
  readonly allowPrivateHosts?: Iterable<string>;
  readonly resolver?: Resolver;
  /** Whole-request timeout (connect, headers and body). Default 5000 ms. */
  readonly timeoutMs?: number;
  /** Allow http: URLs. Dev stubs only. */
  readonly allowHttp?: boolean;
  /** Dev/test only: allow loopback addresses (local stubs). Never set in production. */
  readonly devAllowLoopback?: boolean;
  /** Largest DECODED response body text()/json()/bytes() will read. Default 1 MiB. */
  readonly maxBodyBytes?: number;
}

/** A response whose body can only be read through the size cap. */
export interface SafeResponse {
  readonly status: number;
  readonly headers: Response["headers"];
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  /** JSON.parse of text(); a body that is not JSON rejects with the SyntaxError. */
  json(): Promise<unknown>;
  /** At most `maxBytes` decoded bytes of the body as UTF-8; the rest is cancelled unread. */
  textPrefix(maxBytes: number): Promise<string>;
  /** Discards the body. */
  cancel(): Promise<void>;
}

export interface SafeFetch {
  (url: string | URL, init?: Omit<RequestInit, "dispatcher" | "redirect">): Promise<SafeResponse>;
  /** Closes the connection pools once in-flight requests finish; later requests fail. Idempotent. */
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Reads up to `limit` decoded bytes. Past the limit: truncate (textPrefix) or cancel and throw
 * response_too_large. A failing read becomes a SafeFetchError (timeout when the request's own
 * timeout fired, request_failed otherwise).
 */
async function readBody(body: ReadableStream<Uint8Array> | null, limit: number, truncate: boolean, timedOut: () => boolean): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      if (total + value.byteLength > limit) {
        if (!truncate) throw new SafeFetchError("response_too_large", `response body over ${String(limit)} bytes`);
        chunks.push(value.subarray(0, limit - total));
        await reader.cancel();
        return Buffer.concat(chunks, limit);
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    if (error instanceof SafeFetchError) throw error;
    if (timedOut()) throw new SafeFetchError("timeout", "the response body did not arrive in time", { cause: error });
    throw new SafeFetchError("request_failed", "the response body could not be read", { cause: error });
  }
}

function safeResponse(response: Response, maxBodyBytes: number, timedOut: () => boolean): SafeResponse {
  const body = response.body as ReadableStream<Uint8Array> | null;
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const text = async () => decode(await readBody(body, maxBodyBytes, false, timedOut));
  return {
    status: response.status,
    headers: response.headers,
    bytes: () => readBody(body, maxBodyBytes, false, timedOut),
    text,
    json: async () => JSON.parse(await text()) as unknown,
    textPrefix: async (maxBytes) => decode(await readBody(body, Math.min(maxBytes, maxBodyBytes), true, timedOut)),
    cancel: async () => {
      await body?.cancel().catch(() => undefined);
    },
  };
}

function safeFetchErrorIn(error: unknown): SafeFetchError | undefined {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth++) {
    if (current instanceof SafeFetchError) return current;
  }
  return undefined;
}

/** Builds a fetch that enforces the address policy, no redirects and a timeout on every request. */
export function createSafeFetch(options: SafeFetchOptions = {}): SafeFetch {
  const resolver = options.resolver ?? systemResolver;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new RangeError("maxBodyBytes must be a positive integer");
  const allowLoopback = options.devAllowLoopback === true;
  const privateHosts = new Set(options.allowPrivateHosts ?? []);
  const agentOptions = (allowPrivate: boolean) => ({
    connect: { lookup: connectLookup(resolver, { allowPrivate, allowLoopback }), timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  const publicAgent = new Agent(agentOptions(false));
  const privateAgent = new Agent(agentOptions(true));
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= Promise.all([publicAgent.close(), privateAgent.close()]).then(() => undefined));

  const safeFetch = async (input: string | URL, init: Omit<RequestInit, "dispatcher" | "redirect"> = {}): Promise<SafeResponse> => {
    let url: URL;
    try {
      url = new URL(input);
    } catch (error) {
      throw new SafeFetchError("invalid_url", "the URL does not parse", { cause: error });
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && options.allowHttp === true)) {
      throw new SafeFetchError("scheme_not_allowed", `${url.protocol} is not allowed`);
    }
    if (url.username !== "" || url.password !== "") throw new SafeFetchError("invalid_url", "credentials in the URL are not allowed");
    const allowPrivate = privateHosts.has(url.host);
    // IP-literal hosts skip the lookup hook entirely, so check them here.
    const literal = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if (isIP(literal) !== 0 && isBlockedAddress(literal, { allowPrivate, allowLoopback })) {
      throw new SafeFetchError("blocked_address", `${literal} is a blocked address`);
    }

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await undiciFetch(url, { ...init, signal, redirect: "manual", dispatcher: allowPrivate ? privateAgent : publicAgent });
    } catch (error) {
      const own = safeFetchErrorIn(error);
      if (own !== undefined) throw own;
      if (timeout.aborted) throw new SafeFetchError("timeout", `no complete response within ${String(timeoutMs)} ms`, { cause: error });
      throw new SafeFetchError("request_failed", "the request failed", { cause: error });
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new SafeFetchError("redirect_refused", `redirect (${String(response.status)}) refused`, { httpStatus: response.status });
    }
    return safeResponse(response, maxBodyBytes, () => timeout.aborted);
  };
  return Object.assign(safeFetch, { close });
}
