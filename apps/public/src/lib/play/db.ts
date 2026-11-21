// Better Auth's own small pool for the player instance (DATABASE_URL_PUBLIC, the same public_rw login), behind
// the drizzle wrapper its adapter needs. Kept apart from the app pool (lib/db.ts): drizzle-orm's postgres-js
// driver rewrites the client's serializers and parsers, which would silently change every app query (the
// admin app learned it, code review US-017 CM3).
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type PlayDb = PostgresJsDatabase;

export function createPlayDb(url: string, max = 3): { readonly db: PlayDb; readonly close: () => Promise<void> } {
  const authSql = postgres(url, { ...PG_CONNECTION_OPTIONS, max, onnotice: () => undefined });
  return { db: drizzle(authSql), close: () => authSql.end({ timeout: 5 }) };
}
