// Everything a request (or the CLI) needs: settings, the pool, the Better Auth instance, and the
// settings configuration (DOMAIN, data directory, PDF cap, the public-key-only secret sealer).
import { type AdminConfig, type Env, loadAdminConfig } from "../config.ts";
import { type AdminDb, assertAdminLogin, createAdminDb, type Db, type Sql } from "../db.ts";
import { loadSettingsConfig, NO_SETTINGS, type SettingsConfig } from "../settings/env.ts";
import { type AdminAuth, createAdminAuth } from "./instance.ts";

export interface AuthRuntime {
  readonly config: AdminConfig;
  readonly sql: Sql;
  readonly db: Db;
  readonly auth: AdminAuth;
  readonly settings: SettingsConfig;
  /** Ends the database pools (CLI, tests). */
  readonly close: () => Promise<void>;
}

export function runtimeFor(config: AdminConfig, pools: AdminDb, settings: SettingsConfig = NO_SETTINGS): AuthRuntime {
  const { sql, db } = pools;
  return { config, sql, db, auth: createAdminAuth({ config, sql, db }), settings, close: () => pools.close() };
}

/** Parses the environment, connects, and refuses a login outside admin_rw. */
export async function createRuntime(env: Env, poolSize = 5): Promise<AuthRuntime> {
  const config = loadAdminConfig(env);
  // Refuses a private key in the environment before anything connects (plan M2.3).
  const settings = loadSettingsConfig(env);
  const pools = createAdminDb(config.databaseUrl, poolSize);
  try {
    await assertAdminLogin(pools.sql);
  } catch (error) {
    await pools.close();
    throw error;
  }
  return runtimeFor(config, pools, settings);
}
