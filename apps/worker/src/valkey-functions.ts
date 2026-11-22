// The worker keeps public's Valkey FUNCTION library loaded (US-031; the library and its compatibility rule:
// @ebooktrivia/adapters/valkey-functions). The `public` ACL user may only FCALL, so the worker, which may FUNCTION
// LOAD (its grant is +@all -@dangerous -@admin; FUNCTION LOAD is @write @slow @scripting), loads it:
//   - at start-up, before the worker reports itself started;
//   - on every (re)connect of its health connection ("ready": a Valkey restart, a lost volume, a network blip);
//   - from the heartbeat when an FCALL probe finds it missing (someone flushed the functions): it reloads it and
//     raises the `valkey_function_missing` alert, since public answered 503 on its rate-limited routes meanwhile.
// Valkey's AOF keeps the library across restarts; FUNCTION LOAD REPLACE is idempotent, so a reload never hurts. A failed
// load never stops the worker: it is logged and retried on the next reconnect or heartbeat, while public fails closed.
// The public instances' readiness does NOT depend on the function (lead decision, code review US-031): Valkey is shared,
// so a missing function would take every instance out of the load balancer, webhooks included.
import { loadPublicValkeyFunctions, probeRateLimitFunction, PUBLIC_VALKEY_LIBRARY, type ValkeyCaller } from "@ebooktrivia/adapters/valkey-functions";
import type { Logger } from "./log.ts";

export interface FunctionLoaderClient extends ValkeyCaller {
  on(event: "ready", listener: () => void): unknown;
  off(event: "ready", listener: () => void): unknown;
}

export interface ValkeyFunctionLoader {
  /** Loads the library now; true when it is loaded. */
  load(reason: "start" | "reconnect" | "missing"): Promise<boolean>;
  /** The heartbeat's check: probes, and when the function is missing reloads it and reports it. True when it is callable. */
  check(): Promise<boolean>;
  stop(): void;
}

/**
 * Loads the library once (the first command also opens a lazy connection), then reloads on every later "ready".
 * `onMissing` runs when the heartbeat's probe finds the function gone (the worker raises its alert there).
 */
export async function startValkeyFunctionLoader(valkey: FunctionLoaderClient, log: Logger, onMissing: () => Promise<void> = () => Promise.resolve()): Promise<ValkeyFunctionLoader> {
  const load = async (reason: "start" | "reconnect" | "missing"): Promise<boolean> => {
    try {
      await loadPublicValkeyFunctions(valkey);
      log.info({ library: PUBLIC_VALKEY_LIBRARY, reason }, "valkey functions loaded");
      return true;
    } catch (err) {
      log.error({ library: PUBLIC_VALKEY_LIBRARY, reason, err }, "valkey functions could not be loaded: public answers 503 on its rate-limited routes");
      return false;
    }
  };
  const onReady = (): void => {
    void load("reconnect");
  };
  // After the first load: its own connect must not count as a reconnect. A Valkey that comes up after a failed start
  // load fires "ready" later, and the heartbeat check covers the rest.
  await load("start");
  valkey.on("ready", onReady);
  return {
    load,
    async check() {
      const probe = await probeRateLimitFunction(valkey);
      if (probe !== "missing") return probe === "ok";
      log.warn({ library: PUBLIC_VALKEY_LIBRARY }, "valkey function missing: reloading it");
      await onMissing().catch((err: unknown) => {
        log.error({ err }, "the valkey_function_missing alert could not be raised");
      });
      return load("missing");
    },
    stop: () => {
      valkey.off("ready", onReady);
    },
  };
}
