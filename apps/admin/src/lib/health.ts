// The admin app's side of GET /healthz (US-015): PostgreSQL with the worker's heartbeat (the shared probe,
// @ebooktrivia/db/health) and Valkey PING as the ACL user `admin` (PING is in its allowed commands). The console has
// no other Valkey use yet, so the client lives here: created on the first probe, kept on globalThis for the process,
// bounded commands, no offline queue (a Valkey outage is an error at once, not a queue), no INFO or CLIENT SETINFO
// (not in the admin user's ACL). Never throws; a missing or unusable VALKEY_URL is a failed probe.
import { checkHealth, type HealthResult } from "@ebooktrivia/db/health";
import { Redis } from "ioredis";
import type { Env } from "./config.ts";
import type { Sql } from "./db.ts";

const KEY = Symbol.for("ebooktrivia.admin.health.valkey");
type Holder = { [KEY]?: Redis | undefined };

/** Valkey as the admin user, or throws when VALKEY_URL is missing or not a redis:// URL. */
function valkeyClient(env: Env): Redis {
  const holder = globalThis as Holder;
  const existing = holder[KEY];
  if (existing !== undefined) return existing;
  const raw = env["VALKEY_URL"];
  if (raw === undefined || raw === "") throw new Error("VALKEY_URL is not set");
  const url = new URL(raw);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("VALKEY_URL is not a redis URL");
  const username = env["VALKEY_USERNAME"];
  const password = env["VALKEY_PASSWORD"];
  const client = new Redis({
    host: url.hostname,
    port: url.port === "" ? 6379 : Number(url.port),
    db: 0,
    ...(username === undefined || username === "" || password === undefined || password === "" ? {} : { username, password }),
    ...(url.protocol === "rediss:" ? { tls: { servername: url.hostname } } : {}),
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: 1000,
    connectTimeout: 2000,
    enableReadyCheck: false,
    disableClientInfo: true,
  });
  // ioredis retries on its own; the probe reads the outcome of each PING, so the events need no handler of their own.
  client.on("error", () => undefined);
  holder[KEY] = client;
  return client;
}

async function pingValkey(env: Env): Promise<unknown> {
  const client = valkeyClient(env);
  if (client.status === "wait") await client.connect();
  return client.ping();
}

export function adminHealth(sql: Sql, env: Env = process.env): Promise<HealthResult> {
  return checkHealth({ sql, ping: () => pingValkey(env) });
}
