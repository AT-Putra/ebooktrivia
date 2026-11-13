// Worker heartbeat (plan M3.5 / M4 monitoring): every heartbeatIntervalMs, upsert
// heartbeats(component, beat_at, info) (the deep /healthz checks its freshness) and, when the
// push URL is configured, GET it (Uptime Kuma push monitor on the other box). The push is sent
// only while PostgreSQL took the write AND Valkey answered a PING, so a worker that can no
// longer do its work misses pushes and Kuma alerts. The push goes through safe-fetch (https only
// in production) and its URL, which carries the push token, is never logged.
import type { SafeFetch } from "@ebooktrivia/adapters";
import type postgres from "postgres";
import type { Logger } from "./log.ts";

export interface HeartbeatDeps {
  readonly sql: postgres.Sql;
  /** Valkey PING. */
  readonly ping: () => Promise<unknown>;
  readonly push?: { readonly fetch: SafeFetch; readonly url: URL } | undefined;
  readonly log: Logger;
  readonly component?: string;
  readonly info: () => Record<string, unknown>;
}

export async function beat(deps: HeartbeatDeps): Promise<{ recorded: boolean; pushed: boolean }> {
  const valkey = await deps.ping().then(
    () => true,
    () => false,
  );
  const info = { ...deps.info(), valkey };
  try {
    await deps.sql`
      INSERT INTO public.heartbeats (component, beat_at, info)
      VALUES (${deps.component ?? "worker"}, now(), ${JSON.stringify(info)}::text::jsonb)
      ON CONFLICT (component) DO UPDATE SET beat_at = EXCLUDED.beat_at, info = EXCLUDED.info`;
  } catch (err) {
    deps.log.error({ err }, "heartbeat write failed");
    return { recorded: false, pushed: false };
  }
  if (!valkey) deps.log.warn("heartbeat: Valkey did not answer PING; push skipped");
  if (deps.push === undefined || !valkey) return { recorded: true, pushed: false };
  try {
    const response = await deps.push.fetch(deps.push.url, { method: "GET" });
    await response.cancel();
    if (response.status < 200 || response.status > 299) {
      deps.log.warn({ httpStatus: response.status }, "heartbeat push rejected");
      return { recorded: true, pushed: false };
    }
    return { recorded: true, pushed: true };
  } catch (error) {
    deps.log.warn({ code: (error as { code?: unknown }).code }, "heartbeat push failed");
    return { recorded: true, pushed: false };
  }
}
