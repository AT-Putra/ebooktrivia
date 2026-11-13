// Upgrade paths of existing databases.
//   - Security review US-011 #15: migration 0001 pins player_otps.sealed_code to exactly 54
//     bytes. A dev/staging database created before US-011 can still hold short-lived OTP rows
//     sealed under the old 48..128-byte rule; 0001 must delete those rows first instead of failing
//     the whole migration on ADD CONSTRAINT.
//   - US-013: 0003 adds the lp_domains NOTIFY trigger to a database deployed at 0002.
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PG_CONNECTION_OPTIONS } from "../src/connection.ts";
import { runMigrations } from "../src/migrate.ts";
import { databaseUrl, serverUrl } from "./env.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const onnotice = (): undefined => undefined;

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** A migrations folder holding migrations 0000..`last` only, i.e. the schema of an older deploy. */
function migrationsUpTo(last: number): string {
  const dir = mkdtempSync(join(tmpdir(), "ebt-mig-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(packageRoot, "migrations", "meta", "_journal.json"), "utf8")) as Journal;
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  for (const { tag } of journal.entries) cpSync(join(packageRoot, "migrations", `${tag}.sql`), join(dir, `${tag}.sql`));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  return dir;
}

/** Creates a database and applies roles, preflight and the drizzle migrations in `folder` as migrator. */
async function deployOld(name: string, folder: string, seed: (sql: postgres.Sql) => Promise<void> = () => Promise.resolve()): Promise<void> {
  const old = postgres(databaseUrl(name), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice });
  try {
    await old.unsafe(readFileSync(join(packageRoot, "sql", "roles.sql"), "utf8"));
    await old.unsafe(readFileSync(join(packageRoot, "sql", "preflight.sql"), "utf8"));
    await old.unsafe("SET ROLE migrator");
    await old.unsafe("SET search_path = public");
    await migrate(drizzle(old), { migrationsFolder: folder });
    await old.unsafe("RESET ROLE");
    await seed(old);
  } finally {
    await old.end();
  }
}

describe("upgrading a pre-US-011 database", () => {
  it("0001 deletes OTP rows that are not 54 bytes instead of failing, and keeps valid ones", async () => {
    const name = `ebt_mig_${randomBytes(6).toString("hex")}`;
    const admin = postgres(serverUrl(), { max: 1, onnotice });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const folder = migrationsUpTo(0);
    try {
      // The first deploy, exactly as src/migrate.ts ran it at the time: roles, preflight, then
      // the drizzle migrations as migrator (owner of every object).
      await deployOld(name, folder, async (old) => {
        // 72 and 128 bytes were valid under 0000 (48..128); 54 is the post-US-011 size.
        for (const [phone, size] of [
          ["+6281234567890", 72],
          ["+6281234567891", 128],
          ["+6281234567892", 54],
        ] as const) {
          await old`
            INSERT INTO player_otps (phone, mac, sealed_code, expires_at)
            VALUES (${phone}, ${randomBytes(32)}, ${randomBytes(size)}, now() + interval '5 minutes')`;
        }
      });

      await runMigrations(databaseUrl(name)); // applies 0001, 0002, ... and the sql/ files

      const check = postgres(databaseUrl(name), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice });
      try {
        const rows = await check<{ phone: string; n: number }[]>`
          SELECT phone, octet_length(sealed_code) AS n FROM player_otps ORDER BY phone`;
        expect(rows).toEqual([{ phone: "+6281234567892", n: 54 }]);
      } finally {
        await check.end();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});

describe("upgrading a pre-US-013 database", () => {
  it("0003 adds the lp_domains NOTIFY trigger, enabled ALWAYS, to a database deployed at 0002", async () => {
    const name = `ebt_mig_${randomBytes(6).toString("hex")}`;
    const admin = postgres(serverUrl(), { max: 1, onnotice });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const folder = migrationsUpTo(2);
    try {
      await deployOld(name, folder);
      const check = postgres(databaseUrl(name), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice });
      const triggers = () =>
        check<{ name: string; enabled: string }[]>`
          SELECT tgname AS name, tgenabled AS enabled FROM pg_trigger
          WHERE tgrelid = 'public.lp_domains'::regclass AND NOT tgisinternal`;
      try {
        expect(await triggers()).toEqual([]);
        await runMigrations(databaseUrl(name)); // applies 0003 and the sql/ files
        expect(await triggers()).toEqual([{ name: "lp_domains_notify", enabled: "A" }]);
        await runMigrations(databaseUrl(name)); // and stays re-runnable
        expect(await triggers()).toEqual([{ name: "lp_domains_notify", enabled: "A" }]);
      } finally {
        await check.end();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});
