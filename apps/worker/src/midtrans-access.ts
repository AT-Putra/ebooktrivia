// How the worker reaches Midtrans (US-021). The worker holds the payment private key by design (plan §3:
// worker.env carries the payment, messaging and conversions keys; the internal process holds none), so
// it opens the deployment's sealed server key itself:
//   - the environment is app_settings midtrans.environment (never a per-landing-page setting);
//   - the key is the payment-scope secret midtrans.<environment>.server_key, opened with
//     SECRETS_PAYMENT_PRIVATE_KEY on every use (an Owner key rotation applies at once);
//   - requests go through a strict safe-fetch; WORKER_DEV_MIDTRANS_STUB_URL (dev / test only, refused in
//     production by worker-config.ts) sends the sandbox hosts to infra/midtrans-stub.
// The key is only ever placed in Midtrans' Basic auth header; it is never logged or part of an error.
import { createSafeFetch, type HttpFetch, MIDTRANS_ENDPOINTS } from "@ebooktrivia/adapters";
import { CryptoError, openerFromEnv, type SecretOpener } from "@ebooktrivia/crypto";
import { SECRET_NAMES, type SettingsSecretRow } from "@ebooktrivia/db";
import { type Env, optional } from "./env.ts";
import type { MidtransSource } from "./payments.ts";
import type { WorkerConfig } from "./worker-config.ts";

export class MidtransKeyUnavailable extends Error {
  constructor(reason: "environment" | "missing" | "unreadable") {
    super(`the Midtrans server key is unavailable (${reason})`);
    this.name = "MidtransKeyUnavailable";
  }
}

export function midtransSource(opener: SecretOpener, fetch: HttpFetch): MidtransSource {
  return async (sql) => {
    const [setting] = await sql<{ value: unknown }[]>`SELECT value FROM public.app_settings WHERE key = 'midtrans.environment'`;
    const environment = setting?.value;
    if (environment !== "sandbox" && environment !== "production") throw new MidtransKeyUnavailable("environment");
    const [row] = await sql<SettingsSecretRow[]>`
      SELECT id, scope, name, adnet_id AS "adnetId", bound_host AS "boundHost", key_id AS "keyId", ciphertext, nonce, sealed_dek AS "sealedDek"
        FROM public.settings_secrets WHERE scope = 'payment' AND name = ${SECRET_NAMES.midtransServerKey(environment)} AND adnet_id IS NULL`;
    if (row === undefined) throw new MidtransKeyUnavailable("missing");
    let serverKey: string;
    try {
      serverKey = opener.openSecret(row);
    } catch (error) {
      if (error instanceof CryptoError) throw new MidtransKeyUnavailable("unreadable");
      throw error;
    }
    return { serverKey, ...MIDTRANS_ENDPOINTS[environment], fetch };
  };
}

const SANDBOX_HOSTS = /^https:\/\/(?:app|api)\.sandbox\.midtrans\.com(?=\/)/;

/** The payment port of the production worker. */
export interface PaymentPort {
  readonly midtrans: MidtransSource;
  /** AC-D8 proactive WhatsApp delay when the admin setting delivery.wa_delay_seconds is missing (WORKER_WA_DELAY_MS; the SQL public.proactive_delay_ms). */
  readonly waDelayMs: number;
  /** When the nightly reconciliation is due (tests); default the system clock. */
  readonly clock?: () => Date;
  readonly close?: () => Promise<void>;
}

/**
 * The payment port when worker.env holds SECRETS_PAYMENT_PRIVATE_KEY (a malformed key stops the worker),
 * otherwise none: then payment.notification is not relayed and no reconciliation runs.
 */
export function paymentsFromEnv(env: Env, config: Pick<WorkerConfig, "dev" | "midtransStubUrl" | "waDelayMs">): PaymentPort | undefined {
  if (optional(env, "SECRETS_PAYMENT_PRIVATE_KEY") === undefined) return undefined;
  const opener = openerFromEnv(env);
  const stub = config.midtransStubUrl;
  const safeFetch = createSafeFetch(stub === null ? { allowHttp: config.dev.allowHttp, devAllowLoopback: config.dev.allowLoopback } : { allowHttp: true, devAllowLoopback: true });
  const fetch: HttpFetch = stub === null ? safeFetch : (url, init) => safeFetch(url.replace(SANDBOX_HOSTS, stub), init);
  return { midtrans: midtransSource(opener, fetch), waDelayMs: config.waDelayMs, close: () => safeFetch.close() };
}
