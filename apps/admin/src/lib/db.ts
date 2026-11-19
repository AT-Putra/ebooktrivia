// The admin app's PostgreSQL access: one postgres.js pool (DATABASE_URL_ADMIN) with the
// connection options every app must use (@ebooktrivia/db PG_CONNECTION_OPTIONS), and a drizzle
// wrapper over it for Better Auth's adapter. App queries use the postgres.js tagged templates.
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import { isOnlyMemberOf } from "@ebooktrivia/db/login-role";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Sql = postgres.Sql;
export type Db = PostgresJsDatabase;

export function createAdminDb(url: string, max = 5): { sql: Sql; db: Db } {
  const sql = postgres(url, { ...PG_CONNECTION_OPTIONS, max, onnotice: () => undefined });
  return { sql, db: drizzle(sql) };
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
