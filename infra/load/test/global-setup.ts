// A fresh migrated database for the seed, cleanup and verifier tests, carrying the staging/dev marker the
// guard asks for (src/guard.ts). DEV ONLY default server: the local dev stack; CI sets TEST_PG_URL.
import { createTestDatabase } from "@ebooktrivia/test-support/database";
import postgres from "postgres";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    loadDbUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const db = await createTestDatabase("ebt_load", []);
  const sql = postgres(db.url, { max: 1, onnotice: () => undefined });
  try {
    await sql`INSERT INTO public.app_settings (key, value) VALUES ('deployment.environment', '"dev"')`;
  } finally {
    await sql.end({ timeout: 5 });
  }
  project.provide("loadDbUrl", db.url);
  return () => db.drop();
}
