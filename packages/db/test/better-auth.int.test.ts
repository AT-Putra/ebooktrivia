// The player_auth / admin_auth DDL in src/schema/auth.ts matches what Better Auth 1.7.19 itself
// plans for our plugin sets: its migration planner, run against the migrated database, has
// nothing to create or add and reports no type or nullability drift.
import { getMigrations } from "better-auth/db/migration";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { adminAuthOptions, playerAuthOptions } from "../scripts/better-auth-options.ts";

const pool = new pg.Pool({ connectionString: inject("dbUrl"), max: 2 });
afterAll(async () => {
  await pool.end();
});

describe.each([
  ["player_auth", playerAuthOptions],
  ["admin_auth", adminAuthOptions],
] as const)("Better Auth schema %s", (_schema, options) => {
  it("has no pending Better Auth migration", async () => {
    const warnings: string[] = [];
    const plan = await getMigrations({
      ...options(pool),
      logger: {
        log: (level, message) => {
          if (level === "warn" || level === "error") warnings.push(message);
        },
      },
    });
    expect(plan.toBeCreated).toEqual([]);
    expect(plan.toBeAdded).toEqual([]);
    expect(plan.toBeAddedIndexes).toEqual([]);
    expect(plan.unsafeChanges).toEqual([]);
    expect(plan.schemaProblems).toEqual([]);
    expect(await plan.compileMigrations()).toBe(";");
    expect(warnings).toEqual([]);
  });
});
