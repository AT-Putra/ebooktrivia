// Valkey for the public API (US-020), as the ACL user `public`: keys rl:* and cache:public:* only, and
// only the commands this file sends (infra/provision/files/valkey/users.acl.template: -@all +ping
// +fcall +incr +pttl +pexpire +set; the rate-limit function's INCR / PTTL / PEXPIRE are ACL-checked too).
// No INFO: the ready check is off, `connect()` at start-up is the gate. Every key carries a TTL (Valkey
// runs noeviction).
//
//   - Rate limits: fixed windows, one FCALL of the worker-loaded function ebt_rate_limit_v1 per call
//     (@ebooktrivia/adapters/valkey-functions; US-031: public may not EVAL, so a compromised process
//     cannot run its own Lua). The limits are checked IN ORDER and the function stops at the first one
//     over its N: a request refused by an earlier limit never raises a later counter. INCR and the
//     window's expiry are one atomic step (a counter found without a TTL gets it back). A missing
//     function (the worker has not loaded it yet) fails closed like an outage, on the rate-limited
//     routes only, and is logged as `public.valkey_function_missing`; the worker reloads it and
//     raises an alert (apps/worker/src/valkey-functions.ts).
//   - Cap token marks: SET NX PX, the one atomic "first time" mark of the stateless Cap provider
//     (packages/adapters captcha.ts): a redeemed token verifies once across both apps/public
//     instances. Cap challenges and redeems store nothing at all (Owner decision, US-020), so this is
//     the only Cap memory, gated by a solved proof of work and the checkout's per-IP limit.
//
// FAILURE POLICY: fail CLOSED. The client never queues commands while Valkey is unreachable
// (enableOfflineQueue false) and every command is bounded (commandTimeout), so a Valkey outage turns
// into ValkeyUnavailable at once, and the checkout and Cap routes answer 503 `unavailable`: without
// Valkey neither the rate limits nor the single use of a Cap token can be enforced.
import { createHash } from "node:crypto";
import type { ReplayStore } from "@ebooktrivia/adapters";
import { isFunctionMissing, RATE_LIMIT_FUNCTION } from "@ebooktrivia/adapters/valkey-functions";
import { Redis } from "ioredis";
import type { ValkeyConfig } from "./config.ts";
import { logEvent } from "./log.ts";

export type Valkey = Redis;

export const VALKEY_COMMAND_TIMEOUT_MS = 1000;

export class ValkeyUnavailable extends Error {
  constructor(cause: unknown) {
    super("Valkey is unavailable", { cause });
    this.name = "ValkeyUnavailable";
  }
}

/** A connection error is reported at most once per this interval (ioredis retries forever, silently). */
export const VALKEY_ERROR_REPORT_MS = 30_000;

export function createValkey(config: ValkeyConfig, onError: (error: unknown) => void = () => undefined): Valkey {
  const valkey = new Redis({
    host: config.host,
    port: config.port,
    db: 0,
    ...(config.username === undefined || config.password === undefined ? {} : { username: config.username, password: config.password }),
    ...(config.tls ? { tls: { servername: config.host } } : {}),
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: VALKEY_COMMAND_TIMEOUT_MS,
    connectTimeout: 2000,
    // Neither INFO (the ready check) nor CLIENT SETINFO is in the `public` ACL allowlist.
    enableReadyCheck: false,
    disableClientInfo: true,
  });
  let reported = Number.NEGATIVE_INFINITY;
  valkey.on("error", (error: unknown) => {
    const now = Date.now();
    if (now - reported < VALKEY_ERROR_REPORT_MS) return;
    reported = now;
    onError(error);
  });
  return valkey;
}

async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    // Its own line (docs/runbooks/security-scans.md): the worker has not loaded the library, not an outage.
    if (isFunctionMissing(error)) logEvent("error", "public.valkey_function_missing", { kind: RATE_LIMIT_FUNCTION });
    throw new ValkeyUnavailable(error);
  }
}

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------------------------------------
// Rate limits

export interface RateLimit {
  /** Under rl:, e.g. "checkout:ip:203.0.113.7". */
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
}

export type RateDecision =
  | { readonly allowed: true }
  /** `index`: the position in the list of the limit that refused (no later one was counted). */
  | { readonly allowed: false; readonly index: number; readonly retryAfterSeconds: number };

/** Counts one request against the limits in order, atomically, up to and including the first one that is over. */
export async function hitRateLimits(valkey: Valkey, limits: readonly RateLimit[]): Promise<RateDecision> {
  if (limits.length === 0) return { allowed: true };
  for (const l of limits) {
    if (!Number.isSafeInteger(l.limit) || l.limit < 1 || !Number.isSafeInteger(l.windowMs) || l.windowMs < 1) throw new RangeError("rate limits need a positive N and window");
  }
  const reply = await guarded(() => valkey.fcall(RATE_LIMIT_FUNCTION, limits.length, ...limits.map((l) => `rl:${l.key}`), ...limits.flatMap((l) => [String(l.limit), String(l.windowMs)])));
  if (!Array.isArray(reply) || reply.length !== 2) throw new ValkeyUnavailable(new Error("unexpected rate-limit reply"));
  const index = Number(reply[0]);
  const ttl = Number(reply[1]);
  const refused = limits[index - 1];
  if (index === 0 || refused === undefined) return { allowed: true };
  return { allowed: false, index: index - 1, retryAfterSeconds: Math.max(1, Math.ceil((ttl > 0 ? ttl : refused.windowMs) / 1000)) };
}

/**
 * The rate-limit key part for a phone: never the number itself (PII in Valkey). `label` keeps each use's hashes
 * apart (the checkout's, the player login's "otp-phone/v1"), so one key part never names a phone in two places.
 */
export const phoneKey = (e164: string, label = "checkout-phone/v1"): string => sha256Hex(`ebooktrivia/${label}|${e164}`).slice(0, 32);

// ---------------------------------------------------------------------------------------------
// The single-use marks of redeemed Cap tokens (captcha.ts ReplayStore)

/** A token's nonce, base64url (16 bytes). */
const NONCE_KEY = /^[A-Za-z0-9_-]{22}$/;

/** cache:public:cap:t:<base64url nonce>, SET NX PX for the token's remaining life. */
export function valkeyCapTokenMarks(valkey: Valkey): ReplayStore {
  return {
    async markUsed(key, ttlMs) {
      if (!NONCE_KEY.test(key) || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new RangeError("a Cap token mark is a base64url nonce with a positive ttl");
      const reply = await guarded(() => valkey.set(`cache:public:cap:t:${key}`, "1", "PX", ttlMs, "NX"));
      return reply === "OK";
    },
  };
}
