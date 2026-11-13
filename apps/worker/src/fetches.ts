// The worker's outbound HTTP clients (security review US-013 #6). The Uptime Kuma push may need the
// audited private-IP allowlist (UPTIME_KUMA_ALLOW_PRIVATE_IP, Kuma on the WAHA box's network); only
// the heartbeat's own client gets it. The shared client (for the consumers of later stories) stays
// strict, so no consumer can reach the Kuma host's private address.
import { createSafeFetch, type Resolver, type SafeFetch } from "@ebooktrivia/adapters";
import type { WorkerConfig } from "./worker-config.ts";

export interface WorkerFetches {
  readonly safeFetch: SafeFetch;
  readonly heartbeatFetch: SafeFetch;
}

export function createWorkerFetches(
  config: Pick<WorkerConfig, "dev" | "uptimeKuma">,
  testing: { readonly resolver?: Resolver; readonly timeoutMs?: number } = {},
): WorkerFetches {
  const base = { allowHttp: config.dev.allowHttp, devAllowLoopback: config.dev.allowLoopback, ...testing };
  const kuma = config.uptimeKuma;
  return {
    safeFetch: createSafeFetch(base),
    heartbeatFetch: createSafeFetch(kuma?.allowPrivateIp === true ? { ...base, allowPrivateHosts: [kuma.pushUrl.host] } : base),
  };
}
