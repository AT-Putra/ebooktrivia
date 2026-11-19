// A throwaway PostgreSQL database for integration and e2e tests: created with a random name,
// migrated by @ebooktrivia/db (exactly as production), with one LOGIN role per requested app group
// (how M4 deploys ebt_admin, ebt_public, ...). `drop()` removes the database and the roles.
// DEV ONLY default server: the local dev stack (infra/dev/compose.yaml); CI sets TEST_PG_URL.
import { randomBytes } from "node:crypto";
import { runMigrations } from "@ebooktrivia/db/migrate";
import postgres from "postgres";

const DEFAULT_PG = "postgres://postgres:devonly@127.0.0.1:55432/postgres"; // DEV ONLY

export type LoginGroup = "admin_rw" | "public_rw" | "worker_rw" | "internal_rw";

export interface TestDatabase {
  /** Superuser URL of the new database (setup and inspection). */
  readonly url: string;
  /** URL of the LOGIN role created for each requested group. */
  readonly logins: Readonly<Partial<Record<LoginGroup, string>>>;
  drop(): Promise<void>;
}

export function serverUrl(): string {
  return process.env["TEST_PG_URL"] ?? DEFAULT_PG;
}

function urlFor(server: string, database: string, user?: { name: string; password: string }): string {
  const url = new URL(server);
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

export async function createTestDatabase(prefix: string, groups: readonly LoginGroup[]): Promise<TestDatabase> {
  if (!/^[a-z][a-z0-9_]{0,19}$/.test(prefix)) throw new Error("prefix must be a lower-case identifier of at most 20 characters");
  const server = serverUrl();
  const id = randomBytes(6).toString("hex");
  const database = `${prefix}_${id}`;
  const users = groups.map((group) => ({ group, name: `${prefix}_${group.replace("_rw", "")}_${id}`, password: randomBytes(18).toString("hex") }));
  const root = postgres(server, { max: 1, onnotice: () => undefined });
  const drop = async () => {
    await root.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const user of users) await root.unsafe(`DROP ROLE IF EXISTS ${user.name}`);
    await root.end({ timeout: 5 });
  };
  await root.unsafe(`CREATE DATABASE ${database}`);
  try {
    await runMigrations(urlFor(server, database));
    for (const user of users) await root.unsafe(`CREATE ROLE ${user.name} LOGIN PASSWORD '${user.password}' IN ROLE ${user.group}`);
  } catch (error) {
    await drop();
    throw error;
  }
  return {
    url: urlFor(server, database),
    logins: Object.fromEntries(users.map((user) => [user.group, urlFor(server, database, user)])),
    drop,
  };
}
