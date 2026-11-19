// Everything a request (or the CLI) needs: settings, the pool, the Better Auth instance.
import { type AdminConfig, type Env, loadAdminConfig } from "../config.ts";
import { assertAdminLogin, createAdminDb, type Db, type Sql } from "../db.ts";
import { type AdminAuth, createAdminAuth } from "./instance.ts";

export interface AuthRuntime {
  readonly config: AdminConfig;
  readonly sql: Sql;
  readonly db: Db;
  readonly auth: AdminAuth;
}

export function runtimeFor(config: AdminConfig, sql: Sql, db: Db): AuthRuntime {
  return { config, sql, db, auth: createAdminAuth({ config, sql, db }) };
}

/** Parses the environment, connects, and refuses a login outside admin_rw. */
export async function createRuntime(env: Env, poolSize = 5): Promise<AuthRuntime> {
  const config = loadAdminConfig(env);
  const { sql, db } = createAdminDb(config.databaseUrl, poolSize);
  try {
    await assertAdminLogin(sql);
  } catch (error) {
    await sql.end({ timeout: 5 });
    throw error;
  }
  return runtimeFor(config, sql, db);
}
