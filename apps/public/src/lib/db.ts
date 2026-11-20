// The public app's PostgreSQL pool (DATABASE_URL_PUBLIC), with the connection options every app must
// use (@ebooktrivia/db PG_CONNECTION_OPTIONS). Least privilege (plan M2.2, US-009 carry-over R3): the
// login must be in group public_rw only, and not a superuser (shared check, @ebooktrivia/db/login-role).
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import { isOnlyMemberOf } from "@ebooktrivia/db/login-role";
import postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

/** A checkout transaction never waits on anything outside PostgreSQL; 30 s idle means a stuck request. */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

export function createPublicSql(url: string, max = 10): Sql {
  return postgres(url, {
    ...PG_CONNECTION_OPTIONS,
    connection: { ...PG_CONNECTION_OPTIONS.connection, idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS },
    max,
    onnotice: () => undefined,
  });
}

export class LoginRoleError extends Error {
  constructor() {
    super("DATABASE_URL_PUBLIC must be a login in group public_rw only (not a superuser)");
    this.name = "LoginRoleError";
  }
}

export async function assertPublicLogin(sql: Sql): Promise<void> {
  if (!(await isOnlyMemberOf(sql, "public_rw"))) throw new LoginRoleError();
}
