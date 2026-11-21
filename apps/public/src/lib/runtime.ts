// The process-wide runtime of the public API, created on the first API request (not at import, so
// `next build` and the pages need no database, Valkey or keys). A failed start is retried on the next
// request; until then the API answers 503. Kept on globalThis so `next dev` module reloads reuse it.
import { createSafeFetch, type HttpFetch } from "@ebooktrivia/adapters";
import { openerFromEnv, sealerFromEnv, type SecretSealer } from "@ebooktrivia/crypto";
import { capProviders, type CapRouteDeps } from "./cap-routes.ts";
import { createMidtransKeyCache } from "./checkout/data.ts";
import { type CheckoutDeps, SNAP_TIMEOUT_MS } from "./checkout/handler.ts";
import { type Env, loadPublicConfig, PublicConfigError } from "./config.ts";
import { assertPublicLogin, createPublicSql } from "./db.ts";
import { logEvent } from "./log.ts";
import type { OrderDeps } from "./order/handler.ts";
import { CONFIG_BUCKET, createConfigCache, createTokenBuckets, type SdkRouteDeps } from "./sdk-routes.ts";
import { createPlayAuth } from "./play/auth.ts";
import { createPlayDb } from "./play/db.ts";
import { loadOtpSettings, type PlayDeps } from "./play/handlers.ts";
import { createValkey } from "./valkey.ts";
import type { MidtransWebhookDeps } from "./webhooks/midtrans.ts";

export interface PublicRuntime {
  readonly checkout: CheckoutDeps;
  readonly cap: CapRouteDeps;
  /** The SDK's config and visit beacon (US-024). */
  readonly sdk: SdkRouteDeps;
  /** The Midtrans notification inbox (US-021). */
  readonly webhooks: MidtransWebhookDeps;
  /** The order status page (US-022): its routes, the proxy's lookups and the legal pages. */
  readonly order: OrderDeps;
  /**
   * The player login on play.<DOMAIN> (US-026); `defer` is supplied per request by the route. Null when its
   * configuration is missing or malformed: then only the play routes answer 503 (lib/play/route.ts), and
   * checkout, Cap and the Midtrans webhook are unaffected; the start logs `play.disabled` with the reason.
   */
  readonly play: Omit<PlayDeps, "defer"> | null;
  readonly close: () => Promise<void>;
}

/** The OTP sealer (messaging PUBLIC key), or why there is none (the variable is named, never its value). */
function playSealer(env: Env): { readonly sealer: SecretSealer } | { readonly reason: string } {
  if ((env["SECRETS_MESSAGING_PUBLIC_KEY"] ?? "") === "") return { reason: "SECRETS_MESSAGING_PUBLIC_KEY is not set (OTP codes are sealed to it)" };
  try {
    const sealer = sealerFromEnv(env);
    return sealer.scopes.includes("messaging") ? { sealer } : { reason: "SECRETS_MESSAGING_PUBLIC_KEY is not usable" };
  } catch {
    return { reason: "SECRETS_MESSAGING_PUBLIC_KEY (or another SECRETS_*_PUBLIC_KEY) is not a base64url X25519 key" };
  }
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
  // OTP codes are sealed to the messaging PUBLIC key (US-026); only the worker can open them.
  const sealing = playSealer(env);
  const playReason = config.playUnavailable ?? ("reason" in sealing ? sealing.reason : null);
  const sql = createPublicSql(config.databaseUrl);
  const playDb = playReason === null ? createPlayDb(config.databaseUrl) : null;
  const valkey = createValkey(config.valkey, (error) => {
    logEvent("warn", "valkey.connection_error", {}, error);
  });
  const midtrans = createMidtransFetch({ stubUrl: config.midtransStubUrl });
  const close = async (): Promise<void> => {
    valkey.disconnect();
    await Promise.all([sql.end({ timeout: 5 }), playDb?.close(), midtrans.close()]);
  };
  try {
    await assertPublicLogin(sql);
    await valkey.connect();
  } catch (error) {
    await close();
    throw error;
  }
  const capFor = capProviders(valkey, config.captchaKey);
  let play: Omit<PlayDeps, "defer"> | null = null;
  if (config.play !== null && playDb !== null && "sealer" in sealing) {
    const auth = createPlayAuth({
      config: config.play,
      sql,
      db: playDb.db,
      log: logEvent,
      maxAttempts: async () => (await loadOtpSettings(sql))["otp.max_attempts"],
    });
    play = { sql, valkey, auth, capFor, sealer: sealing.sealer, otpPepper: config.play.otpPepper, playOrigin: config.play.playOrigin, log: logEvent };
  } else {
    logEvent("warn", "play.disabled", { reason: playReason ?? "configuration" });
  }
  return {
    checkout: { sql, valkey, capFor, opener, midtransFetch: midtrans.fetch, domain: config.domain, log: logEvent },
    cap: { sql, valkey, capFor, log: logEvent },
    sdk: { sql, valkey, domain: config.domain, configCache: createConfigCache(), configLimit: createTokenBuckets(CONFIG_BUCKET), log: logEvent },
    webhooks: { sql, valkey, opener, serverKey: createMidtransKeyCache(), log: logEvent },
    order: { sql, valkey, domain: config.domain, log: logEvent },
    play,
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
