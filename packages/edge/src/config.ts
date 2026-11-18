// Edge listener settings, from the app's env file (/etc/ebooktrivia/{public,admin}.env) and the
// quadlet. Fails fast on a bad value; messages name the variable only.
//
//   TRUSTED_PROXY_IP  Caddy's pinned IP on the podman edge network (infra/quadlet/caddy.container).
//                     Required with NODE_ENV=production; elsewhere it may be unset, and then no
//                     peer's X-Forwarded-For is believed.
//   EDGE_HOST         listen address. Required with NODE_ENV=production (the app's own address on
//                     the network it shares with Caddy, so no other container network reaches it);
//                     elsewhere it defaults to 0.0.0.0. Not HOSTNAME: podman sets that to the
//                     container name.
//   EDGE_PORT         listen port (default 3000).
//   EDGE_DRAIN_MS     wait between "start draining" and "stop accepting" (default 5000; it must
//                     exceed Caddy's health_interval + health_timeout, 2 s + 1 s).
//   EDGE_DRAIN_FILE   optional: while this file exists, /livez answers 503 (manual drain).
import { isAbsolute } from "node:path";
import { canonicalIp } from "./client-ip.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export class EdgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeConfigError";
  }
}

export interface EdgeConfig {
  readonly production: boolean;
  readonly host: string;
  readonly port: number;
  readonly trustedProxy: string | null;
  readonly drainMs: number;
  readonly drainFile: string | undefined;
  readonly closeTimeoutMs: number;
}

const value = (env: Env, name: string): string | undefined => {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
};

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new EdgeConfigError(`${name} must be an integer in ${String(min)}..${String(max)}`);
  return n;
}

export function loadEdgeConfig(env: Env): EdgeConfig {
  const nodeEnv = value(env, "NODE_ENV");
  if (nodeEnv === undefined) throw new EdgeConfigError("NODE_ENV is required");
  const production = nodeEnv === "production";
  const rawProxy = value(env, "TRUSTED_PROXY_IP");
  const trustedProxy = rawProxy === undefined ? null : canonicalIp(rawProxy);
  if (rawProxy !== undefined && trustedProxy === null) throw new EdgeConfigError("TRUSTED_PROXY_IP must be an IP address");
  if (production && trustedProxy === null) throw new EdgeConfigError("TRUSTED_PROXY_IP is required with NODE_ENV=production");
  const rawHost = value(env, "EDGE_HOST");
  if (production && rawHost === undefined) throw new EdgeConfigError("EDGE_HOST is required with NODE_ENV=production");
  const host = rawHost ?? "0.0.0.0";
  if (canonicalIp(host) === null) throw new EdgeConfigError("EDGE_HOST must be an IP address");
  const drainFile = value(env, "EDGE_DRAIN_FILE");
  if (drainFile !== undefined && !isAbsolute(drainFile)) throw new EdgeConfigError("EDGE_DRAIN_FILE must be an absolute path");
  return {
    production,
    host,
    port: int(env, "EDGE_PORT", 3000, 0, 65_535),
    trustedProxy,
    drainMs: int(env, "EDGE_DRAIN_MS", 5000, 0, 120_000),
    drainFile,
    closeTimeoutMs: int(env, "EDGE_CLOSE_TIMEOUT_MS", 15_000, 0, 120_000),
  };
}
