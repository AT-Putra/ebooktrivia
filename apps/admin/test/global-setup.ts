// A fresh migrated database with a LOGIN role in admin_rw (how M4 deploys ebt_admin) and one in
// public_rw (denial checks), dropped afterwards (@ebooktrivia/test-support/database).
import { createTestDatabase } from "@ebooktrivia/test-support/database";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    dbUrl: string;
    adminDbUrl: string;
    publicDbUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const db = await createTestDatabase("ebt_adm", ["admin_rw", "public_rw"]);
  project.provide("dbUrl", db.url);
  project.provide("adminDbUrl", db.logins.admin_rw ?? "");
  project.provide("publicDbUrl", db.logins.public_rw ?? "");
  return () => db.drop();
}
