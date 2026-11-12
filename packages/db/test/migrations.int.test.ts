// Upgrade path of an existing database (security review US-011 #15): migration 0001 pins
// player_otps.sealed_code to exactly 54 bytes. A dev/staging database created before US-011 can
// still hold short-lived OTP rows sealed under the old 48..128-byte rule; 0001 must delete those
// rows first instead of failing the whole migration on ADD CONSTRAINT.
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
  entries: { idx: number }[];
}

/** A migrations folder holding only 0000_init, i.e. the schema as it was before US-011. */
function migrationsUpTo0000(): string {
  const dir = mkdtempSync(join(tmpdir(), "ebt-mig-"));
  mkdirSync(join(dir, "meta"));
  cpSync(join(packageRoot, "migrations", "0000_init.sql"), join(dir, "0000_init.sql"));
  const journal = JSON.parse(readFileSync(join(packageRoot, "migrations", "meta", "_journal.json"), "utf8")) as Journal;
  journal.entries = journal.entries.filter((entry) => entry.idx === 0);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  return dir;
}

describe("upgrading a pre-US-011 database", () => {
  it("0001 deletes OTP rows that are not 54 bytes instead of failing, and keeps valid ones", async () => {
    const name = `ebt_mig_${randomBytes(6).toString("hex")}`;
    const admin = postgres(serverUrl(), { max: 1, onnotice });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const folder = migrationsUpTo0000();
    try {
      // The first deploy, exactly as src/migrate.ts ran it at the time: roles, preflight, then
      // the drizzle migrations as migrator (owner of every object).
      const old = postgres(databaseUrl(name), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice });
      try {
        await old.unsafe(readFileSync(join(packageRoot, "sql", "roles.sql"), "utf8"));
        await old.unsafe(readFileSync(join(packageRoot, "sql", "preflight.sql"), "utf8"));
        await old.unsafe("SET ROLE migrator");
        await old.unsafe("SET search_path = public");
        await migrate(drizzle(old), { migrationsFolder: folder });
        await old.unsafe("RESET ROLE");
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
      } finally {
        await old.end();
      }

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
