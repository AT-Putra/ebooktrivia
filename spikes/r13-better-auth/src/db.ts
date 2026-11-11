import pg from "pg";
import { PG } from "./env.ts";

/** Drops and recreates database `name`, returns a pool connected to it. */
export async function freshDb(name: string): Promise<pg.Pool> {
  const admin = new pg.Pool({ ...PG, database: "postgres", max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return new pg.Pool({ ...PG, database: name, max: 5 });
}

export async function rows(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const res = await pool.query<Record<string, unknown>>(sql, params);
  return res.rows;
}
