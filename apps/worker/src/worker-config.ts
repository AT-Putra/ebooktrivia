// Worker role configuration (worker.env). The worker connects as a login role in group worker_rw
// (DATABASE_URL_WORKER) and as the Valkey ACL user `worker`.
//
// A9: the adapters' dev-only switches (safe-fetch allowHttp / devAllowLoopback, SMTP
// devAllowPlaintext) are reachable only through the WORKER_DEV_* flags below, and the chaos-test
// failpoint only through WORKER_FAILPOINT. With NODE_ENV=production every one of them is refused,
// whatever its value, so a stray dev line in worker.env stops the process. NODE_ENV itself is
// required, so the guard cannot fail open on a missing value.
import { bool, ConfigError, type Env, int, type LogLevel, logLevel, nodeEnv, type NodeEnv, oneOf, optional, postgresUrl, required } from "./env.ts";
import { FAILPOINTS, type FailpointName } from "./failpoint.ts";

export const DEV_FLAG_ENV = [
  "WORKER_DEV_ALLOW_HTTP",
  "WORKER_DEV_ALLOW_LOOPBACK",
  "WORKER_DEV_ALLOW_PLAINTEXT_SMTP",
  "WORKER_FAILPOINT",
] as const;

export interface ValkeyConfig {
  readonly host: string;
  readonly port: number;
  readonly db: number;
  readonly username: string | undefined;
  readonly password: string | undefined;
  readonly tls: boolean;
}

export interface WorkerConfig {
  readonly nodeEnv: NodeEnv;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly valkey: ValkeyConfig;
  /** BullMQ key prefix (Valkey keys `<prefix>:<queue>:...`). */
  readonly prefix: string;
  readonly uptimeKuma: { readonly pushUrl: URL; readonly allowPrivateIp: boolean } | undefined;
  /** Dev-only adapter switches (A9); all false in production. */
  readonly dev: { readonly allowHttp: boolean; readonly allowLoopback: boolean; readonly allowPlaintextSmtp: boolean };
  readonly failpoint: FailpointName | undefined;
  readonly relayIntervalMs: number;
  readonly sweepIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  /** A relayed outbox row unprocessed for this long is re-relayed (Valkey loss). */
  readonly outboxStaleMs: number;
  readonly conversionLeaseMs: number;
  /** Whole-request timeout of a conversion fire; must be shorter than the lease (core). */
  readonly conversionTimeoutMs: number;
  /** Jobs processed in parallel per queue. */
  readonly concurrency: number;
  /** BullMQ job lock; a job whose process died is re-queued after it lapses (stall check). */
  readonly lockDurationMs: number;
  readonly stalledIntervalMs: number;
}

function valkey(env: Env, production: boolean): ValkeyConfig {
  const raw = required(env, "VALKEY_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("VALKEY_URL must be redis://host:port[/db] or rediss://");
  }
  if ((url.protocol !== "redis:" && url.protocol !== "rediss:") || url.hostname === "") {
    throw new ConfigError("VALKEY_URL must be redis://host:port[/db] or rediss://");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("VALKEY_URL must not carry credentials: use VALKEY_USERNAME and VALKEY_PASSWORD");
  }
  if (url.search !== "" || url.hash !== "") throw new ConfigError("VALKEY_URL must not have a query or fragment");
  const path = url.pathname.replace(/^\//, "");
  if (path !== "" && !/^\d{1,2}$/.test(path)) throw new ConfigError("VALKEY_URL path must be a database index");
  const username = optional(env, "VALKEY_USERNAME");
  const password = optional(env, "VALKEY_PASSWORD");
  if ((username === undefined) !== (password === undefined)) {
    throw new ConfigError("VALKEY_USERNAME and VALKEY_PASSWORD go together");
  }
  if (production && username === undefined) throw new ConfigError("VALKEY_USERNAME and VALKEY_PASSWORD are required in production");
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port === "" ? 6379 : Number(url.port),
    db: path === "" ? 0 : Number(path),
    username,
    password,
    tls: url.protocol === "rediss:",
  };
}

function uptimeKuma(env: Env, allowHttp: boolean): WorkerConfig["uptimeKuma"] {
  const raw = optional(env, "UPTIME_KUMA_PUSH_URL");
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("UPTIME_KUMA_PUSH_URL must be an http(s) URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowHttp)) {
    throw new ConfigError("UPTIME_KUMA_PUSH_URL must be https (http only with WORKER_DEV_ALLOW_HTTP outside production)");
  }
  return { pushUrl: url, allowPrivateIp: bool(env, "UPTIME_KUMA_ALLOW_PRIVATE_IP") };
}

export function loadWorkerConfig(env: Env): WorkerConfig {
  const mode = nodeEnv(env);
  const production = mode === "production";
  if (production) {
    for (const name of DEV_FLAG_ENV) {
      if (optional(env, name) !== undefined) throw new ConfigError(`${name} is a dev-only flag and is refused with NODE_ENV=production`);
    }
  }
  const dev = {
    allowHttp: bool(env, "WORKER_DEV_ALLOW_HTTP"),
    allowLoopback: bool(env, "WORKER_DEV_ALLOW_LOOPBACK"),
    allowPlaintextSmtp: bool(env, "WORKER_DEV_ALLOW_PLAINTEXT_SMTP"),
  };
  const failpoint = optional(env, "WORKER_FAILPOINT") === undefined ? undefined : oneOf(env, "WORKER_FAILPOINT", FAILPOINTS, FAILPOINTS[0]);
  const prefix = optional(env, "BULLMQ_PREFIX") ?? "ebt";
  if (!/^[a-z0-9_-]{1,32}$/.test(prefix)) throw new ConfigError("BULLMQ_PREFIX must be 1-32 of a-z 0-9 _ -");
  const conversionLeaseMs = int(env, "WORKER_CONVERSION_LEASE_MS", 60_000, 1000, 3_600_000);
  const conversionTimeoutMs = int(env, "WORKER_CONVERSION_TIMEOUT_MS", 5000, 100, 60_000);
  // conversion-fire.ts fires only while timeout + 1 s still fit in the lease: leave at least 2 s.
  if (conversionLeaseMs - conversionTimeoutMs < 2000) {
    throw new ConfigError("WORKER_CONVERSION_TIMEOUT_MS must be at least 2000 ms shorter than WORKER_CONVERSION_LEASE_MS");
  }
  return {
    nodeEnv: mode,
    logLevel: logLevel(env),
    databaseUrl: postgresUrl(env, "DATABASE_URL_WORKER"),
    valkey: valkey(env, production),
    prefix,
    uptimeKuma: uptimeKuma(env, dev.allowHttp),
    dev,
    failpoint,
    relayIntervalMs: int(env, "WORKER_RELAY_INTERVAL_MS", 500, 50, 10_000),
    sweepIntervalMs: int(env, "WORKER_SWEEP_INTERVAL_MS", 60_000, 100, 600_000),
    heartbeatIntervalMs: int(env, "WORKER_HEARTBEAT_INTERVAL_MS", 60_000, 100, 600_000),
    outboxStaleMs: int(env, "WORKER_OUTBOX_STALE_MS", 120_000, 500, 3_600_000),
    conversionLeaseMs,
    conversionTimeoutMs,
    concurrency: int(env, "WORKER_CONCURRENCY", 4, 1, 64),
    lockDurationMs: int(env, "WORKER_LOCK_DURATION_MS", 30_000, 1000, 600_000),
    stalledIntervalMs: int(env, "WORKER_STALLED_INTERVAL_MS", 30_000, 1000, 600_000),
  };
}
