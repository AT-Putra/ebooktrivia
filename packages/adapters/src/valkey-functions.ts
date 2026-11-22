// The Valkey FUNCTION library of the public API (US-031: EVAL -> FUNCTION LOAD + FCALL). The `public` ACL user may
// FCALL but not EVAL, EVALSHA, SCRIPT or FUNCTION (infra/provision/files/valkey/users.acl.template), so a compromised
// public process can call only what is loaded here, never its own Lua. The worker, the trusted process, loads the
// library (FUNCTION LOAD REPLACE) at start-up, on every reconnect and when its health tick finds it missing; Valkey's
// AOF keeps it across restarts. The commands inside still run under the CALLER's ACL (public: keys rl:* only).
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
