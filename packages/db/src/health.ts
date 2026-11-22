// The deep health probe behind GET /healthz (public on api.<DOMAIN>, and admin): Uptime Kuma's HTTP monitor
// and the last check of a deploy (infra/deploy/remote.sh). Three dependencies, each bounded, run side by side:
//   database    one SELECT in a transaction with a short statement_timeout (also reads the heartbeat below);
//   heartbeat   the worker's heartbeats row is at most 3 minutes old (plan M4.8; the worker beats every minute);
//   valkey      PING.
// The answer carries no detail (no host, version, error text or timing): the caller turns `ok` into 200 / 503 with a
// fixed body. `failed` names the probes for the server's own log only. Every probe is cut off after `timeoutMs`, so a
// hung dependency is a 503, never a hang.
import type postgres from "postgres";

export const HEALTH_PROBE_TIMEOUT_MS = 2000;
export const WORKER_HEARTBEAT_MAX_AGE_MS = 180_000;

export type HealthProbe = "database" | "heartbeat" | "valkey";

export interface HealthDeps {
  readonly sql: postgres.Sql;
  /** Valkey PING; any resolved answer counts. */
  readonly ping: () => Promise<unknown>;
  readonly timeoutMs?: number;
  readonly maxHeartbeatAgeMs?: number;
}

export interface HealthResult {
  readonly ok: boolean;
  readonly failed: readonly HealthProbe[];
}

class ProbeTimeout extends Error {
  constructor() {
    super("health probe timed out");
    this.name = "ProbeTimeout";
  }
}

function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const cutoff = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProbeTimeout());
    }, ms);
  });
  // The abandoned work may still reject later; nothing is waiting for it then.
  work.catch(() => undefined);
  return Promise.race([work, cutoff]).finally(() => {
    clearTimeout(timer);
  });
}

/** The worker heartbeat's age in milliseconds (null: no row), read in a transaction with a statement timeout. */
async function heartbeatAgeMs(sql: postgres.Sql, timeoutMs: number): Promise<number | null> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${String(Math.max(1, Math.floor(timeoutMs)))}`);
    const [row] = await tx<{ age_ms: number | null }[]>`
      SELECT (extract(epoch FROM now() - max(beat_at)) * 1000)::float8 AS age_ms FROM public.heartbeats WHERE component = 'worker'`;
    return row?.age_ms ?? null;
  });
}

export async function checkHealth(deps: HealthDeps): Promise<HealthResult> {
  const timeoutMs = deps.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  const maxAgeMs = deps.maxHeartbeatAgeMs ?? WORKER_HEARTBEAT_MAX_AGE_MS;
  const [age, valkey] = await Promise.allSettled([bounded(heartbeatAgeMs(deps.sql, timeoutMs), timeoutMs), bounded(Promise.resolve().then(deps.ping), timeoutMs)]);
  const failed: HealthProbe[] = [];
  if (age.status === "rejected") failed.push("database");
  else if (age.value === null || !(age.value <= maxAgeMs)) failed.push("heartbeat");
  if (valkey.status === "rejected") failed.push("valkey");
  return { ok: failed.length === 0, failed };
}
