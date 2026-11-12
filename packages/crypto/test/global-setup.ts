// A fresh database with a random name, migrated by @ebooktrivia/db, handed to the tests and
// dropped afterwards (same pattern as packages/db/test/global-setup.ts).
import { randomBytes } from "node:crypto";
import { runMigrations } from "@ebooktrivia/db/migrate";
import postgres from "postgres";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    dbUrl: string;
  }
}

// DEV ONLY default: the local dev stack (infra/dev/compose.yaml). CI sets TEST_PG_URL.
const DEFAULT_URL = "postgres://postgres:devonly@127.0.0.1:55432/postgres"; // DEV ONLY

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = process.env["TEST_PG_URL"] ?? DEFAULT_URL;
  const name = `ebt_int_${randomBytes(6).toString("hex")}`;
  const admin = postgres(server, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(server);
  url.pathname = `/${name}`;
  try {
    await runMigrations(url.toString());
  } catch (error) {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    throw error;
  }
  project.provide("dbUrl", url.toString());
  return async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  };
}
