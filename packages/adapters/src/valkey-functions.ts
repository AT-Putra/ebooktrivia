// The Valkey FUNCTION library of the public API (US-031: EVAL -> FUNCTION LOAD + FCALL). The `public` ACL user may
// FCALL but not EVAL, EVALSHA, SCRIPT or FUNCTION (infra/provision/files/valkey/users.acl.template), so a compromised
// public process can call only what is loaded here, never its own Lua. The worker, the trusted process, loads the
// library (FUNCTION LOAD REPLACE) at start-up, on every reconnect and when its health tick finds it missing; Valkey's
// AOF keeps it across restarts. The commands inside still run under the CALLER's ACL (public: keys rl:* and cache:public:* only).
//
// COMPATIBILITY (docs/runbooks/security-scans.md "Valkey functions"): a function's name is its contract. Never change
// the logic or the arguments of a published name: add a NEW name (ebt_rate_limit_v2) to the library, deploy the worker
// first (it loads both), then the public instances, and drop the old name only when no running public calls it. Old
// and new public instances then run side by side during a rolling deploy.
//
// Import-free, so both apps/public (the caller) and apps/worker (the loader) share one copy.

export const PUBLIC_VALKEY_LIBRARY = "ebt_public";

/**
 * ebt_rate_limit_v1: fixed-window rate limits, checked IN ORDER, stopping at the first one over its N. keys[i] is a
 * counter, args[2i-1] its N and args[2i] its window in ms. Answers {i, ttl ms} for the limit that refused (no later
 * counter was raised) or {0, 0}. INCR and the window's expiry are one atomic step (a counter found without a TTL gets
 * it back). With no keys it changes nothing and answers {0, 0}: the readiness probe of apps/public.
 */
export const RATE_LIMIT_FUNCTION = "ebt_rate_limit_v1";

/**
 * ebt_wa_read_v1: hands ONE incoming personal WhatsApp message to the worker, to be marked as read (apps/worker/src/delivery/read-marks.ts).
 * keys[1] is the chat's "a read is pending" mark, keys[2] the sequence counter of the ring of items; args: [1] the mark's life in
 * seconds, [2] the ring's size, [3] an item's life in seconds, [4] the counter's life in ms, [5] the item key prefix, [6] the item's
 * payload (opaque to the function: the session, the SEALED message id and the chat's digest, waReadPayload). A chat that already has a
 * read pending is a no-op (answers 0); otherwise the counter moves and the payload is stored at slot n mod size (a lap overwrites the
 * oldest item: the ring is capped by construction), answering n. Only SET, INCR and PEXPIRE, which `public` already has, on keys under
 * cache:public:*: no new command and no new key pattern for public. The worker alone reads the ring (waReadKeys, parseWaReadItem) and
 * deletes the chat's mark when it takes the read.
 * KEYS: the slot's key (args[5] .. n mod size) cannot be declared: it is only known from the counter the function itself moves, so it is
 * built inside from the prefix argument. That is fine on this single Valkey node, and not a hole: every command of a function runs under
 * the CALLER's ACL and the key check happens at the write, so a prefix outside public's patterns is refused (NOPERM), which
 * apps/worker/test/prod-valkey-acl.int.test.ts proves against the production ACL. (A clustered Valkey could not run it: this one is not.)
 */
export const WA_READ_FUNCTION = "ebt_wa_read_v1";
/** Everything of the read path lives under this (public's own cache:public:*); the worker's production ACL reaches exactly this pattern more. */
export const WA_READ_NAMESPACE = "cache:public:wa-read";
/** A chat has at most one read pending; the mark lives this long at most (the worker deletes it as soon as it takes the read). */
export const WA_READ_PENDING_TTL_S = 60;
/** The ring holds this many items: a lagging worker loses the oldest, never grows Valkey. */
export const WA_READ_RING_SIZE = 2000;
/** An item the worker has not taken by then is stale and is let go. */
export const WA_READ_ITEM_TTL_S = 600;
const WA_READ_SEQ_TTL_MS = 7 * 86_400_000;

export const waReadKeys = (namespace: string = WA_READ_NAMESPACE) => ({
  /** The chat's pending mark: `digest` is hex (an HMAC of session and chat: never a phone). */
  pending: (digest: string): string => `${namespace}:c:${digest}`,
  seq: `${namespace}:seq`,
  itemPrefix: `${namespace}:i:`,
  item: (n: number): string => `${namespace}:i:${String(n % WA_READ_RING_SIZE)}`,
});

const WA_READ_DIGEST = /^[0-9a-f]{32}$/;
const WA_READ_SESSION = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * The message id, SEALED to the messaging public key (@ebooktrivia/crypto wa-read.ts) and written as base64url: 49 to 176 bytes. A message id embeds the sender's chat id
 * (a phone number, a stranger's included), and Valkey keeps an AOF on disk beyond the ring's ten minutes, so the id never sits in Valkey in clear; a raw id does not even
 * match this (its `@` and `.`), so an item or a job of an older shape drives nothing.
 */
const WA_READ_SEALED = /^[A-Za-z0-9_-]{66,236}$/;

export interface WaReadItem {
  readonly session: string;
  /** The sealed message id, base64url. */
  readonly sealed: string;
  readonly digest: string;
}

/** The payload of an item: "<session>|<sealed message id>|<chat digest>" (the worker opens the id and re-fetches the message; the chat comes from that). Null when a part is not what it must be. */
export function waReadPayload(item: WaReadItem): string | null {
  if (!WA_READ_SESSION.test(item.session) || !WA_READ_SEALED.test(item.sealed) || !WA_READ_DIGEST.test(item.digest)) return null;
  return `${item.session}|${item.sealed}|${item.digest}`;
}

/** An item as stored ("<n>|<payload>"); undefined for anything else (an overwritten, expired or foreign value), so a stray key can drive nothing. */
export function parseWaReadItem(value: string | null): (WaReadItem & { readonly n: number }) | undefined {
  if (value === null) return undefined;
  const parts = value.split("|");
  if (parts.length !== 4) return undefined;
  const [n, session, sealed, digest] = parts as [string, string, string, string];
  if (!/^[1-9][0-9]{0,15}$/.test(n) || waReadPayload({ session, sealed, digest }) === null) return undefined;
  return { n: Number(n), session, sealed, digest };
}

/** The FCALL of ebt_wa_read_v1 for an item (its keys, then its arguments), or null when the item is not well formed (nothing is called then). */
export function waReadCall(namespace: string, item: WaReadItem): { readonly keys: readonly [string, string]; readonly args: readonly string[] } | null {
  const payload = waReadPayload(item);
  if (payload === null) return null;
  const keys = waReadKeys(namespace);
  return { keys: [keys.pending(item.digest), keys.seq], args: [String(WA_READ_PENDING_TTL_S), String(WA_READ_RING_SIZE), String(WA_READ_ITEM_TTL_S), String(WA_READ_SEQ_TTL_MS), keys.itemPrefix, payload] };
}

export const PUBLIC_VALKEY_LIBRARY_CODE = `#!lua name=${PUBLIC_VALKEY_LIBRARY}
local function rate_limit_v1(keys, args)
  for i, key in ipairs(keys) do
    local n = redis.call('INCR', key)
    local ttl = redis.call('PTTL', key)
    if ttl < 0 then
      redis.call('PEXPIRE', key, args[2 * i])
      ttl = tonumber(args[2 * i])
    end
    if n > tonumber(args[2 * i - 1]) then
      return {i, ttl}
    end
  end
  return {0, 0}
end
redis.register_function('${RATE_LIMIT_FUNCTION}', rate_limit_v1)
local function wa_read_v1(keys, args)
  if not redis.call('SET', keys[1], '1', 'NX', 'EX', args[1]) then
    return 0
  end
  local n = redis.call('INCR', keys[2])
  redis.call('PEXPIRE', keys[2], args[4])
  redis.call('SET', args[5] .. (n % tonumber(args[2])), string.format('%d', n) .. '|' .. args[6], 'EX', args[3])
  return n
end
redis.register_function('${WA_READ_FUNCTION}', wa_read_v1)
`;

/** The one command this module sends: ioredis' generic `call`. */
export interface ValkeyCaller {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
}

/** Loads (or replaces) the library; answers the library name Valkey reports. Throws what Valkey answers. */
export async function loadPublicValkeyFunctions(valkey: ValkeyCaller): Promise<string> {
  const reply = await valkey.call("FUNCTION", "LOAD", "REPLACE", PUBLIC_VALKEY_LIBRARY_CODE);
  if (reply !== PUBLIC_VALKEY_LIBRARY) throw new Error(`FUNCTION LOAD answered ${typeof reply === "string" ? reply.slice(0, 64) : typeof reply}`);
  return reply;
}

/** True when Valkey refused an FCALL because the function is not loaded ("ERR Function not found"). */
export function isFunctionMissing(error: unknown): boolean {
  return error instanceof Error && /\bfunction not found\b/i.test(error.message);
}

export type FunctionProbe = "ok" | "missing" | "refused" | "unreachable";

/** Every function of the library that an app calls: the worker's heartbeat finds the library intact only while ALL of them are loaded. */
export const PUBLIC_VALKEY_FUNCTIONS: readonly string[] = [RATE_LIMIT_FUNCTION, WA_READ_FUNCTION];

/** Every string anywhere in a reply (arrays, maps, sets and objects alike: RESP2 and RESP3 shape FUNCTION LIST differently). */
function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, into);
  else if (value instanceof Map) for (const [key, item] of value) stringsIn([key, item], into);
  else if (value instanceof Set) for (const item of value) stringsIn(item, into);
  else if (typeof value === "object" && value !== null) for (const [key, item] of Object.entries(value)) stringsIn([key, item], into);
  return into;
}

/**
 * Whether the whole library is loaded: FUNCTION LIST LIBRARYNAME ebt_public names EVERY function of PUBLIC_VALKEY_FUNCTIONS. A library that lost one (a worker of an older
 * release replaced it with FUNCTION LOAD REPLACE while a newer public still calls the missing function: a rollback in the wrong order) is "missing" too, so the heartbeat
 * loads the current one again and raises the alert. "refused" when the ACL denies FUNCTION LIST, "unreachable" on any other failure.
 */
export async function probePublicLibrary(valkey: ValkeyCaller): Promise<FunctionProbe> {
  try {
    const listed = new Set(stringsIn(await valkey.call("FUNCTION", "LIST", "LIBRARYNAME", PUBLIC_VALKEY_LIBRARY)));
    return PUBLIC_VALKEY_FUNCTIONS.every((name) => listed.has(name)) ? "ok" : "missing";
  } catch (error) {
    return error instanceof Error && /^NOPERM\b/.test(error.message) ? "refused" : "unreachable";
  }
}

/**
 * Whether the rate-limit function is callable: an FCALL with no keys (changes nothing, answers {0, 0}).
 * "missing" when the library is not loaded, "refused" when the ACL denies FCALL (a wrong users.acl), "unreachable" on
 * any other failure (Valkey down, a timeout).
 */
export async function probeRateLimitFunction(valkey: ValkeyCaller): Promise<FunctionProbe> {
  try {
    await valkey.call("FCALL", RATE_LIMIT_FUNCTION, 0);
    return "ok";
  } catch (error) {
    if (isFunctionMissing(error)) return "missing";
    return error instanceof Error && /^NOPERM\b/.test(error.message) ? "refused" : "unreachable";
  }
}
