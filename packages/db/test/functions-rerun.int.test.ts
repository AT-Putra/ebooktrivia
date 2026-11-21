// US-022: sql/functions.sql re-runs on every migrate. get_order_status's result type changed while the story
// was built, which CREATE OR REPLACE cannot do, so the file drops the function ONLY when its result differs
// from the current one. A normal re-run must never drop it (a drop is a window in which the status page 503s),
// so a second runMigrations keeps its OID; an older shape is replaced exactly once.
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PG_CONNECTION_OPTIONS } from "../src/connection.ts";
import { runMigrations } from "../src/migrate.ts";
import { databaseUrl, serverUrl } from "./env.ts";

const onnotice = (): undefined => undefined;
const FIND = "SELECT to_regprocedure('public.get_order_status(text)')::oid::text AS oid, pg_get_function_result(to_regprocedure('public.get_order_status(text)')) AS result";
const OLD_SHAPE =
  "CREATE FUNCTION public.get_order_status(p_public_id text) RETURNS TABLE (status text, buyer_name text) LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 'x'::text, 'y'::text $$";

describe("re-running sql/functions.sql (get_order_status)", () => {
  it("keeps the function (same OID) on a second runMigrations, and replaces an older shape exactly once", async () => {
    const name = `ebt_fn_${randomBytes(6).toString("hex")}`;
    const admin = postgres(serverUrl(), { max: 1, onnotice });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    try {
      await runMigrations(databaseUrl(name));
      const check = postgres(databaseUrl(name), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice });
      const find = async () => (await check.unsafe<{ oid: string; result: string }[]>(FIND))[0];
      try {
        const first = await find();
        expect(first?.oid).toBeTruthy();
        expect(first?.result).toContain("masked_name text");
        await runMigrations(databaseUrl(name));
        expect((await find())?.oid).toBe(first?.oid);

        // A database that applied an earlier shape (raw buyer_name / buyer_phone), owned by migrator like every object.
        await check.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE migrator");
          await tx.unsafe("DROP FUNCTION public.get_order_status(text)");
          await tx.unsafe(OLD_SHAPE);
        });
        const old = await find();
        expect(old?.result).not.toContain("masked_name");
        await runMigrations(databaseUrl(name));
        const replaced = await find();
        expect(replaced?.result).toBe(first?.result);
        expect(replaced?.oid).not.toBe(old?.oid);
        await runMigrations(databaseUrl(name));
        expect((await find())?.oid).toBe(replaced?.oid);
      } finally {
        await check.end();
      }
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 180_000);
});
