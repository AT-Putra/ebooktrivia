// Migration runner (`pnpm --filter @ebooktrivia/db db:migrate`, env DATABASE_URL).
//
// Order, on one connection:
//   1. sql/roles.sql as the connecting role (needs superuser, or CREATEROLE + ADMIN on the roles):
//      resets database/schema privileges, role memberships, per-role settings and parameter
//      privileges, and sets the database default search_path to public. Commits on its own;
//   2. sql/preflight.sql, same role: refuses to continue on a foreign schema or a foreign-owned
//      object (ET090) or a login in two group roles (ET091). The reset in 1 stays committed;
//   3. SET ROLE migrator, so migrator owns every object created below;
//   4. drizzle migrations from ./migrations (journal in drizzle.__drizzle_migrations), with
//      search_path = public: the generated DDL names public tables unqualified, and "$user"
//      must never be on the path;
//   5. sql/functions.sql, sql/triggers.sql, sql/grants.sql, sql/seed.sql.
// Every sql/ file first sets search_path = pg_catalog, pg_temp for the session. Every step is
// re-runnable on an existing database. Each SQL file runs as one simple-protocol query, i.e. as
// a single implicit transaction.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { PG_CONNECTION_OPTIONS } from "./connection.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsFolder = join(packageRoot, "migrations");
const sqlDir = join(packageRoot, "sql");
const POST_MIGRATION_SQL = ["functions.sql", "triggers.sql", "grants.sql", "seed.sql"] as const;

export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { ...PG_CONNECTION_OPTIONS, max: 1, onnotice: () => undefined });
  const runFile = async (file: string) => sql.unsafe(await readFile(join(sqlDir, file), "utf8"));
  try {
    await runFile("roles.sql");
    await runFile("preflight.sql");
    await sql.unsafe("SET ROLE migrator");
    await sql.unsafe("SET search_path = public");
    await migrate(drizzle(sql), { migrationsFolder });
    for (const file of POST_MIGRATION_SQL) await runFile(file);
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    process.stderr.write("DATABASE_URL is required\n");
    process.exit(1);
  }
  await runMigrations(url);
  process.stdout.write("migrations applied\n");
}
