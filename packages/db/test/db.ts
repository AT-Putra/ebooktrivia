// Shared connection + helpers for the integration tests. The connection is the superuser of the
// test server; privileges are exercised with SET LOCAL ROLE inside a transaction.
import { randomBytes, randomInt } from "node:crypto";
import postgres from "postgres";
import { afterAll, inject } from "vitest";
import { PG_CONNECTION_OPTIONS } from "../src/connection.ts";

export const sql = postgres(inject("dbUrl"), { ...PG_CONNECTION_OPTIONS, max: 8, onnotice: () => undefined });
afterAll(async () => {
  await sql.end();
});

export type Tx = postgres.TransactionSql;
export type AppRole = "public_rw" | "admin_rw" | "worker_rw" | "internal_rw" | "migrator";
export const APP_ROLES = ["public_rw", "admin_rw", "worker_rw", "internal_rw"] as const;

/** Runs `fn` in a transaction as `role` (SET LOCAL ROLE) and commits. */
export async function asRole<T>(role: AppRole, fn: (tx: Tx) => Promise<T>, isolation?: string): Promise<T> {
  const body = async (tx: Tx): Promise<T> => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    return fn(tx);
  };
  return isolation === undefined ? sql.begin(body) : sql.begin(isolation, body);
}

class Rollback extends Error {}

/** Runs `fn` as `role` (or as the superuser when `role` is null) and always rolls back. */
export async function rolledBack(role: AppRole | null, fn: (tx: Tx) => Promise<unknown>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      if (role !== null) await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

/** SQLSTATE of the error `p` rejects with; throws if `p` resolves. */
export async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e.code;
    throw e;
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

export function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("query returned no row");
  return row;
}

export const uniquePhone =(): string => `+62812${randomInt(10_000_000, 99_999_999).toString()}`;
export const bytes = (n: number): Buffer => randomBytes(n);
export const suffix = (): string => randomBytes(4).toString("hex");
