// Creates a fresh database with a random name, applies every migration + sql/ file to it TWICE
// (first run = applies cleanly on an empty PostgreSQL; second run = re-runnable), hands its URL
// to the tests and drops it afterwards.
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../src/migrate.ts";
import { databaseUrl, serverUrl } from "./env.ts";

declare module "vitest" {
  export interface ProvidedContext {
    dbUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const name = `ebt_int_${randomBytes(6).toString("hex")}`;
  const admin = postgres(serverUrl(), { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = databaseUrl(name);
  try {
    await runMigrations(url);
    await runMigrations(url);
  } catch (error) {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    throw error;
  }
  project.provide("dbUrl", url);
  return async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  };
}
