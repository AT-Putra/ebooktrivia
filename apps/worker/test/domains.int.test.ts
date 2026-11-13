// The /caddy/ask host set in process (src/domains.ts): loaded at start, reloaded on demand and on
// NOTIFY, coalesced, and kept as it was when a reload fails.
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { startDomainSet } from "../src/domains.ts";
import { createCatalog, sql, suffix, waitFor } from "./support/db.ts";
import { captureLogger } from "./support/log.ts";

const internalSql = postgres(inject("internalDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 2, onnotice: () => undefined });
const internalUser = new URL(inject("internalDbUrl")).username;
let landingPageId: string;
beforeAll(async () => {
  landingPageId = (await createCatalog()).landingPageId;
});
afterAll(async () => {
  await internalSql.end({ timeout: 5 });
});

describe("startDomainSet", () => {
  it("loads, reloads on NOTIFY and on demand (coalesced), and keeps the last set when a reload fails", async () => {
    const known = `known-${suffix()}.example.com`;
    await sql`INSERT INTO lp_domains (landing_page_id, host) VALUES (${landingPageId}, ${known})`;
    const { log, lines } = captureLogger();
    const domains = await startDomainSet(internalSql, { reloadMs: 3_600_000, log });
    try {
      expect(domains.has(known)).toBe(true);
      expect(domains.size).toBeGreaterThanOrEqual(1);

      const added = `added-${suffix()}.example.com`;
      await sql`INSERT INTO lp_domains (landing_page_id, host) VALUES (${landingPageId}, ${added})`;
      await waitFor("NOTIFY reload", () => Promise.resolve(domains.has(added)), 5000, 10);

      await Promise.all(Array.from({ length: 20 }, () => domains.reload()));
      expect(domains.has(added)).toBe(true);

      // A NOTIFY sent while the listener is down is lost; the reload on re-LISTEN catches up.
      const missed = `missed-${suffix()}.example.com`;
      await sql.unsafe(`ALTER ROLE ${internalUser} NOLOGIN`);
      try {
        await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${internalUser}`;
        await waitFor("internal backends gone", async () => (await sql`SELECT 1 FROM pg_stat_activity WHERE usename = ${internalUser}`).length === 0, 5000);
        await sql`INSERT INTO lp_domains (landing_page_id, host) VALUES (${landingPageId}, ${missed})`;
        expect(domains.has(missed)).toBe(false);
      } finally {
        await sql.unsafe(`ALTER ROLE ${internalUser} LOGIN`);
      }
      await waitFor("reload after re-LISTEN", () => Promise.resolve(domains.has(missed)), 15_000, 20);

      await sql.unsafe(`ALTER ROLE ${internalUser} NOLOGIN`);
      try {
        await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${internalUser}`;
        await domains.reload();
        expect(domains.has(known)).toBe(true);
        expect(lines.some((l) => l["msg"] === "lp_domains reload failed; keeping the previous set")).toBe(true);
      } finally {
        await sql.unsafe(`ALTER ROLE ${internalUser} LOGIN`);
      }
    } finally {
      await domains.stop();
    }
  });
});
