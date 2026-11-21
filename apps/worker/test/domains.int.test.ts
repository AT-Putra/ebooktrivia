// The /caddy/ask host set in process (src/domains.ts): public.lp_served_hosts(), loaded at start,
// reloaded on demand and on NOTIFY (lp_domains, and the active / hosting / current version of a
// landing page, US-023), coalesced, and EMPTIED when a reload fails (fail closed, US-023).
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { ALERT_AFTER, startDomainSet } from "../src/domains.ts";
import { createCatalog, hostLandingPage, sql, suffix, waitFor } from "./support/db.ts";
import { captureLogger } from "./support/log.ts";

const internalSql = postgres(inject("internalDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 2, onnotice: () => undefined });
const internalUser = new URL(inject("internalDbUrl")).username;
let landingPageId: string;
beforeAll(async () => {
  landingPageId = (await createCatalog()).landingPageId;
  await hostLandingPage(landingPageId);
});
afterAll(async () => {
  await internalSql.end({ timeout: 5 });
});

describe("startDomainSet", () => {
  it("loads, reloads on NOTIFY and on demand (coalesced), and refuses every host after a failed reload until one succeeds", async () => {
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

      // Fail closed: the failed reload may have been the one announcing a removal.
      await sql.unsafe(`ALTER ROLE ${internalUser} NOLOGIN`);
      try {
        await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${internalUser}`;
        await domains.reload();
        expect(domains.has(known)).toBe(false);
        expect(domains.size).toBe(0);
        expect(lines.some((l) => l["msg"] === "lp hosts reload failed; refusing every host until a reload succeeds")).toBe(true);
      } finally {
        await sql.unsafe(`ALTER ROLE ${internalUser} LOGIN`);
      }
      await waitFor("a good reload restores the set", async () => {
        await domains.reload();
        return domains.has(known);
      }, 15_000, 100);
    } finally {
      await domains.stop();
    }
  });

  it("serves only registered domains of ACTIVE zip-hosted pages with a live version, and hears every change to that by NOTIFY", async () => {
    const domains = await startDomainSet(internalSql, { reloadMs: 3_600_000, log: captureLogger().log });
    try {
      const page = (await createCatalog()).landingPageId;
      const host = `page-${suffix()}.example.com`;
      await sql`INSERT INTO lp_domains (landing_page_id, host) VALUES (${page}, ${host})`;
      await domains.reload();
      expect(domains.has(host), "external page (default hosting)").toBe(false);
      await sql`UPDATE landing_pages SET hosting = 'zip' WHERE id = ${page}`;
      await domains.reload();
      expect(domains.has(host), "zip page without a version").toBe(false);

      const v1 = await hostLandingPage(page, 1);
      await waitFor("a new version NOTIFYs", () => Promise.resolve(domains.has(host)), 5000, 10);
      await sql`UPDATE landing_pages SET active = false WHERE id = ${page}`;
      await waitFor("deactivation NOTIFYs", () => Promise.resolve(!domains.has(host)), 5000, 10);
      await sql`UPDATE landing_pages SET active = true WHERE id = ${page}`;
      await waitFor("reactivation NOTIFYs", () => Promise.resolve(domains.has(host)), 5000, 10);
      await sql`UPDATE landing_pages SET hosting = 'external' WHERE id = ${page}`;
      await waitFor("a hosting change NOTIFYs", () => Promise.resolve(!domains.has(host)), 5000, 10);
      await sql`UPDATE landing_pages SET hosting = 'zip' WHERE id = ${page}`;
      await waitFor("back to zip", () => Promise.resolve(domains.has(host)), 5000, 10);
      await sql`UPDATE landing_pages SET current_version_id = NULL WHERE id = ${page}`;
      await waitFor("no live version NOTIFYs", () => Promise.resolve(!domains.has(host)), 5000, 10);
      await sql`UPDATE landing_pages SET current_version_id = ${v1} WHERE id = ${page}`;
      await waitFor("a rollback NOTIFYs", () => Promise.resolve(domains.has(host)), 5000, 10);
      await sql`DELETE FROM landing_pages WHERE id = ${page}`;
      await waitFor("a deleted page NOTIFYs", () => Promise.resolve(!domains.has(host)), 5000, 10);
    } finally {
      await domains.stop();
    }
  });

  it(`retries a failed reload by itself with backoff, and alerts once after ${String(ALERT_AFTER)} failures in a row`, async () => {
    const host = `retry-${suffix()}.example.com`;
    await sql`INSERT INTO lp_domains (landing_page_id, host) VALUES (${landingPageId}, ${host})`;
    const alerts: number[] = [];
    const domains = await startDomainSet(internalSql, { reloadMs: 3_600_000, log: captureLogger().log, retryMs: 50, retryMaxMs: 200, onAlert: (n) => Promise.resolve(void alerts.push(n)) });
    try {
      expect(domains.has(host)).toBe(true);
      await sql.unsafe(`ALTER ROLE ${internalUser} NOLOGIN`);
      try {
        await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${internalUser}`;
        await domains.reload();
        expect(domains.has(host)).toBe(false);
        // No NOTIFY, no timer (1 h), no explicit reload: only the retries can run now.
        await waitFor("alert after repeated failures", () => Promise.resolve(alerts.length === 1), 15_000, 20);
      } finally {
        await sql.unsafe(`ALTER ROLE ${internalUser} LOGIN`);
      }
      await waitFor("a retry restores the set", () => Promise.resolve(domains.has(host)), 15_000, 20);
      expect(alerts).toEqual([ALERT_AFTER]);
    } finally {
      await domains.stop();
    }
  });
});
