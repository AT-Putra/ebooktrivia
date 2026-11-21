// The internal process (`node src/main.ts --role=internal`, plan M3.6): Caddy's on-demand TLS
// `ask` and the GlitchTip alert hook, bound to INTERNAL_HOST (default 127.0.0.1). It holds no keys
// and imports nothing that could hold one (no @ebooktrivia/crypto, no settings secrets, no
// adapters or BullMQ): the database login must be in internal_rw only (checked at startup:
// EXECUTE lp_served_hosts, INSERT alerts), and
// the hook token is known only by its SHA-256. test/internal.int.test.ts records its module graph.
import { serve } from "@hono/node-server";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { startDomainSet } from "./domains.ts";
import type { Env } from "./env.ts";
import { type InternalConfig, loadInternalConfig } from "./internal-config.ts";
import { createInternalApp } from "./internal-app.ts";
import { createLogger, type Logger } from "./log.ts";
import { assertLoginRole } from "./login-role.ts";
import { onShutdown } from "./shutdown.ts";

export interface RunningInternal {
  /** The bound port (useful with INTERNAL_PORT=0). */
  readonly port: number;
  stop(): Promise<void>;
}

export async function startInternal(config: InternalConfig, log: Logger): Promise<RunningInternal> {
  const sql = postgres(config.databaseUrl, {
    ...PG_CONNECTION_OPTIONS,
    connection: { ...PG_CONNECTION_OPTIONS.connection, application_name: "ebt-internal" },
    max: 4,
    onnotice: () => undefined,
  });
  try {
    await assertLoginRole(sql, "internal_rw", "DATABASE_URL_INTERNAL");
  } catch (error) {
    await sql.end({ timeout: 5 });
    throw error;
  }
  const domains = await startDomainSet(sql, {
    reloadMs: config.domainsReloadMs,
    log,
    // internal_rw may INSERT these columns only; if the database is what failed, this fails too (logged).
    onAlert: async (failures) => {
      await sql`
        INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload)
        VALUES ('internal', 'lp_ask_reload_failed', 'critical', 'lp_ask_reload_failed',
                ${`The Caddy ask cache could not reload ${String(failures)} times in a row: new LP certificates are refused until it does.`},
                ${JSON.stringify({ failures })}::text::jsonb)`;
    },
  });
  const app = createInternalApp({
    hasHost: (host) => domains.has(host),
    insertAlert: async (row) => {
      // No RETURNING: internal_rw may INSERT these columns and nothing else, not even SELECT.
      await sql`
        INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload)
        VALUES ('glitchtip', ${row.kind}, ${row.severity}, ${row.dedupeKey}, ${row.message}, ${JSON.stringify(row.payload)}::text::jsonb)`;
    },
    tokenSha256: config.hookTokenSha256,
    ratePerMinute: config.hookRatePerMinute,
    log,
  });
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
      resolve({ server: s, port: info.port });
    });
  });
  log.info({ host: config.host, port, domains: domains.size }, "internal listening");
  return {
    port,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await domains.stop();
      await sql.end({ timeout: 5 });
    },
  };
}

export async function runInternal(env: Env): Promise<void> {
  const config = loadInternalConfig(env);
  const log = createLogger({ level: config.logLevel, role: "internal" });
  const running = await startInternal(config, log);
  onShutdown(() => running.stop(), log);
}
