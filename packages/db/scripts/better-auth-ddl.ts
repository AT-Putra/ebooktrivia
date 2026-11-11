// Prints the DDL Better Auth 1.7.19 generates for the player_auth and admin_auth schemas.
// It runs Better Auth's own migration planner (`getMigrations`, the same plan its CLI runs)
// against a throwaway empty database and prints `compileMigrations()`; nothing is applied.
// `src/schema/auth.ts` is transcribed from this output.
//
//   pnpm --filter @ebooktrivia/db auth:ddl
//
// Uses TEST_PG_URL (a superuser URL; default: the DEV ONLY local stack).
import { randomBytes } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import pg from "pg";
import { databaseUrl, serverUrl } from "../test/env.ts";
import { adminAuthOptions, playerAuthOptions } from "./better-auth-options.ts";

const dbName = `ba_ddl_${randomBytes(6).toString("hex")}`;
const admin = new pg.Client({ connectionString: serverUrl() });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
const pool = new pg.Pool({ connectionString: databaseUrl(dbName), max: 2 });
try {
  for (const [label, options] of [
    ["player_auth", playerAuthOptions(pool)],
    ["admin_auth", adminAuthOptions(pool)],
  ] as const) {
    const { compileMigrations } = await getMigrations(options);
    process.stdout.write(`-- ${label}\n${await compileMigrations()}\n\n`);
  }
} finally {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
}
