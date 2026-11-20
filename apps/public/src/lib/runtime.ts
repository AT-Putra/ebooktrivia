// The process-wide runtime of the public API, created on the first API request (not at import, so
// `next build` and the pages need no database, Valkey or keys). A failed start is retried on the next
// request; until then the API answers 503. Kept on globalThis so `next dev` module reloads reuse it.
import { createSafeFetch, type HttpFetch } from "@ebooktrivia/adapters";
import { openerFromEnv } from "@ebooktrivia/crypto";
import { capProviders, type CapRouteDeps } from "./cap-routes.ts";
import { type CheckoutDeps, SNAP_TIMEOUT_MS } from "./checkout/handler.ts";
import { type Env, loadPublicConfig, PublicConfigError } from "./config.ts";
import { assertPublicLogin, createPublicSql } from "./db.ts";
import { logEvent } from "./log.ts";
import { createValkey } from "./valkey.ts";

export interface PublicRuntime {
  readonly checkout: CheckoutDeps;
  readonly cap: CapRouteDeps;
  readonly close: () => Promise<void>;
}

const SANDBOX_HOSTS = /^https:\/\/(?:app|api)\.sandbox\.midtrans\.com(?=\/)/;

/**
 * How Snap is reached: safe-fetch bounded by `timeoutMs` (whole request). With `stubUrl` (dev / test
 * only, refused in production by config.ts) the sandbox hosts go to the local midtrans-stub.
 */
export function createMidtransFetch(options: { readonly stubUrl: string | null; readonly timeoutMs?: number }): { readonly fetch: HttpFetch; readonly close: () => Promise<void> } {
  const { stubUrl } = options;
  const safeFetch = createSafeFetch({ timeoutMs: options.timeoutMs ?? SNAP_TIMEOUT_MS, ...(stubUrl === null ? {} : { allowHttp: true, devAllowLoopback: true }) });
  return {
    fetch: stubUrl === null ? safeFetch : (url, init) => safeFetch(url.replace(SANDBOX_HOSTS, stubUrl), init),
    close: () => safeFetch.close(),
  };
}

export async function createRuntime(env: Env): Promise<PublicRuntime> {
  const config = loadPublicConfig(env);
  const opener = openerFromEnv(env);
  if (opener.scopes.length !== 1 || opener.scopes[0] !== "payment") throw new PublicConfigError("public.env must hold SECRETS_PAYMENT_PRIVATE_KEY and no other private key");
  const sql = createPublicSql(config.databaseUrl);
  const valkey = createValkey(config.valkey, (error) => {
    logEvent("warn", "valkey.connection_error", {}, error);
  });
  const midtrans = createMidtransFetch({ stubUrl: config.midtransStubUrl });
  const close = async (): Promise<void> => {
    valkey.disconnect();
    await Promise.all([sql.end({ timeout: 5 }), midtrans.close()]);
  };
  try {
    await assertPublicLogin(sql);
    await valkey.connect();
  } catch (error) {
    await close();
    throw error;
  }
  const capFor = capProviders(valkey, config.captchaKey);
  return {
    checkout: { sql, valkey, capFor, opener, midtransFetch: midtrans.fetch, domain: config.domain, log: logEvent },
    cap: { sql, valkey, capFor, log: logEvent },
    close,
  };
}

const KEY = Symbol.for("ebooktrivia.public.runtime");
type Holder = { [KEY]?: Promise<PublicRuntime> | undefined };

export function getRuntime(): Promise<PublicRuntime> {
  const holder = globalThis as Holder;
  holder[KEY] ??= createRuntime(process.env).catch((error: unknown) => {
    holder[KEY] = undefined;
    throw error;
  });
  return holder[KEY];
}

/** The runtime, or the 503 every API route answers while it cannot start (no CORS: no origin was checked). */
export async function runtimeOrUnavailable(route: string): Promise<PublicRuntime | Response> {
  try {
    return await getRuntime();
  } catch (error) {
    // A configuration message names the variable, never its value.
    logEvent("error", "runtime.unavailable", { route, ...(error instanceof PublicConfigError ? { reason: error.message } : {}) }, error);
    return new Response(JSON.stringify({ v: 1, error: "unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", vary: "Origin" },
    });
  }
}
