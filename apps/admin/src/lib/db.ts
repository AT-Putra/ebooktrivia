// The admin app's PostgreSQL access (DATABASE_URL_ADMIN, with the connection options every app must
// use, @ebooktrivia/db PG_CONNECTION_OPTIONS): the app pool for our own postgres.js queries, and a
// SEPARATE small pool behind the drizzle wrapper that Better Auth's adapter needs. drizzle-orm's
// postgres-js driver rewrites the client's serializers and parsers (date / time values stay text in
// both directions, json is sent unserialised), so sharing one pool silently changed every app query
// (code review US-017 CM3); the app pool keeps postgres.js defaults (real Dates, json serialised).
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import { isOnlyMemberOf } from "@ebooktrivia/db/login-role";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Sql = postgres.Sql;
export type Db = PostgresJsDatabase;

export interface AdminDb {
  readonly sql: Sql;
  readonly db: Db;
  /** Ends both pools. */
  readonly close: () => Promise<void>;
}

export function createAdminDb(url: string, max = 5): AdminDb {
  const sql = postgres(url, { ...PG_CONNECTION_OPTIONS, max, onnotice: () => undefined });
  const authSql = postgres(url, { ...PG_CONNECTION_OPTIONS, max: 3, onnotice: () => undefined });
  return {
    sql,
    db: drizzle(authSql),
    close: async () => {
      await Promise.all([sql.end({ timeout: 5 }), authSql.end({ timeout: 5 })]);
    },
  };
}

export class LoginRoleError extends Error {
  constructor() {
    super("DATABASE_URL_ADMIN must be a login in group admin_rw only (not a superuser)");
    this.name = "LoginRoleError";
  }
}

/**
 * Least privilege (plan M2.2, US-009 carry-over R3): the admin app must connect as a login whose
 * only group is admin_rw; a superuser is refused too. The check is shared with apps/worker
 * (@ebooktrivia/db/login-role).
 */
export async function assertAdminLogin(sql: Sql): Promise<void> {
  if (!(await isOnlyMemberOf(sql, "admin_rw"))) throw new LoginRoleError();
}
