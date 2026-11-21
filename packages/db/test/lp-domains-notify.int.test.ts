// Migration 0003 (US-013): every committed write to lp_domains NOTIFYs `lp_domains_changed`, so
// the internal process (apps/worker --role=internal) reloads its in-memory /caddy/ask host set.
// One notification per statement (statement-level trigger), INSERT / UPDATE / DELETE / TRUNCATE,
// delivered only on commit, and the trigger fires ALWAYS (also under session_replication_role).
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PG_CONNECTION_OPTIONS } from "../src/connection.ts";
import { asRole, first, rolledBack, sql, suffix } from "./db.ts";
import { createLandingPage, createProgram } from "./fixtures.ts";

const CHANNEL = "lp_domains_changed";

const listener = postgres(inject("dbUrl"), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice: () => undefined });
const received: string[] = [];
let landingPageId: string;

beforeAll(async () => {
  await listener.listen(CHANNEL, (payload) => received.push(payload));
  const { programId } = await createProgram();
  landingPageId = await createLandingPage(programId);
});
afterAll(async () => {
  await listener.end();
});

/** Runs `write`, then returns the notifications it caused (after a no-op round trip settles). */
async function notificationsOf(write: () => Promise<unknown>): Promise<string[]> {
  received.length = 0;
  await write();
  // NOTIFY is delivered asynchronously after commit; a marker notification sent afterwards on
  // the same server arrives after it, so waiting for the marker drains everything before it.
  const marker = `marker-${suffix()}`;
  await sql`SELECT pg_notify(${CHANNEL}, ${marker})`;
  const deadline = Date.now() + 5000;
  while (!received.includes(marker)) {
    if (Date.now() > deadline) throw new Error("marker notification never arrived");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return received.filter((p) => p !== marker);
}

const host = () => `lp-${suffix()}.example.com`;

describe("lp_domains NOTIFY trigger (migration 0003)", () => {
  it("notifies once per committed INSERT, UPDATE and DELETE statement, as the admin app writes them", async () => {
    const [a, b] = [host(), host()];
    expect(
      await notificationsOf(() =>
        asRole("admin_rw", (tx) => tx`INSERT INTO public.lp_domains (landing_page_id, host) VALUES (${landingPageId}, ${a}), (${landingPageId}, ${b})`),
      ),
    ).toEqual(["INSERT"]);
    const renamed = host();
    expect(
      await notificationsOf(() => asRole("admin_rw", (tx) => tx`UPDATE public.lp_domains SET host = ${renamed} WHERE host = ${a}`)),
    ).toEqual(["UPDATE"]);
    expect(
      await notificationsOf(() => asRole("admin_rw", (tx) => tx`DELETE FROM public.lp_domains WHERE host IN (${renamed}, ${b})`)),
    ).toEqual(["DELETE"]);
  });

  it("notifies on TRUNCATE", async () => {
    // Through notificationsOf, so the setup's own INSERT notification is drained before TRUNCATE.
    expect(await notificationsOf(() => sql`INSERT INTO lp_domains (landing_page_id, host) VALUES (${landingPageId}, ${host()})`)).toEqual([
      "INSERT",
    ]);
    expect(await notificationsOf(() => sql`TRUNCATE lp_domains`)).toEqual(["TRUNCATE"]);
    expect(first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM lp_domains`).n).toBe(0);
  });

  it("sends nothing for a rolled-back write", async () => {
    expect(
      await notificationsOf(() =>
        rolledBack("admin_rw", (tx) => tx`INSERT INTO public.lp_domains (landing_page_id, host) VALUES (${landingPageId}, ${host()})`),
      ),
    ).toEqual([]);
  });

  it("still notifies under session_replication_role = replica (ENABLE ALWAYS)", async () => {
    const replicaHost = host();
    expect(
      await notificationsOf(() =>
        sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL session_replication_role = replica");
          await tx`INSERT INTO public.lp_domains (landing_page_id, host) VALUES (${landingPageId}, ${replicaHost})`;
        }),
      ),
    ).toEqual(["INSERT"]);
  });

  it("is one statement-level AFTER trigger for all four events, enabled ALWAYS, with a pinned search_path", async () => {
    const rows = await sql<{ name: string; enabled: string; type: number; config: string[] | null; definer: boolean }[]>`
      SELECT t.tgname AS name, t.tgenabled AS enabled, t.tgtype::int AS type, p.proconfig AS config, p.prosecdef AS definer
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'public.lp_domains'::regclass AND NOT t.tgisinternal`;
    // tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE.
    expect(rows).toEqual([
      { name: "lp_domains_notify", enabled: "A", type: 4 | 8 | 16 | 32, config: ["search_path=pg_catalog, pg_temp"], definer: false },
    ]);
  });
});

// US-023: the ask set is public.lp_served_hosts(), so a landing page's active / hosting / current
// version change and its deletion NOTIFY the same channel; ET160 keeps a page's current version its own.
describe("landing page hosting (US-023)", () => {
  async function version(lp: string, n: number): Promise<string> {
    const upload = first(await sql<{ id: string }[]>`
      INSERT INTO uploads (kind, storage_path, content_type, size_bytes, sha256)
      VALUES ('lp_zip', ${`lp-zips/${suffix()}.zip`}, 'application/zip', 1, sha256('x'::bytea)) RETURNING id`);
    return first(await sql<{ id: string }[]>`
      INSERT INTO lp_versions (landing_page_id, version, upload_id, file_count, uncompressed_bytes)
      VALUES (${lp}, ${n}, ${upload.id}, 1, 1) RETURNING id`).id;
  }
  const served = async () => (await asRole("internal_rw", (tx) => tx<{ host: string; landing_page_id: string; version: number }[]>`SELECT * FROM public.lp_served_hosts()`)).filter((r) => r.landing_page_id === landingPageId);

  it("NOTIFYs once per statement on active / hosting / current version changes and on delete, not on other columns", async () => {
    const v1 = await version(landingPageId, 1);
    expect(await notificationsOf(() => sql`UPDATE landing_pages SET current_version_id = ${v1}, hosting = 'zip' WHERE id = ${landingPageId}`)).toEqual(["UPDATE"]);
    expect(await notificationsOf(() => sql`UPDATE landing_pages SET active = false WHERE id = ${landingPageId}`)).toEqual(["UPDATE"]);
    expect(await notificationsOf(() => sql`UPDATE landing_pages SET active = true WHERE id = ${landingPageId}`)).toEqual(["UPDATE"]);
    expect(await notificationsOf(() => sql`UPDATE landing_pages SET name = 'renamed' WHERE id = ${landingPageId}`)).toEqual([]);
    const { programId } = await createProgram();
    const other = await createLandingPage(programId);
    expect(await notificationsOf(() => sql`DELETE FROM landing_pages WHERE id = ${other}`)).toEqual(["DELETE"]);
  });

  it("serves exactly the registered hosts of an active zip page with a live version, to internal_rw, which cannot read the tables", async () => {
    const h = host();
    await sql`INSERT INTO lp_domains (landing_page_id, host) VALUES (${landingPageId}, ${h})`;
    const v2 = await version(landingPageId, 2);
    await sql`UPDATE landing_pages SET current_version_id = ${v2}, hosting = 'zip', active = true WHERE id = ${landingPageId}`;
    expect((await served()).find((r) => r.host === h)).toEqual({ host: h, landing_page_id: landingPageId, version: 2 });
    await sql`UPDATE landing_pages SET active = false WHERE id = ${landingPageId}`;
    expect(await served()).toEqual([]);
    await sql`UPDATE landing_pages SET active = true, hosting = 'external' WHERE id = ${landingPageId}`;
    expect(await served()).toEqual([]);
    await sql`UPDATE landing_pages SET hosting = 'zip' WHERE id = ${landingPageId}`;
    for (const table of ["lp_domains", "landing_pages", "lp_versions"]) {
      await expect(asRole("internal_rw", (tx) => tx.unsafe(`SELECT 1 FROM public.${table} LIMIT 1`)), table).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asRole("public_rw", (tx) => tx`SELECT * FROM public.lp_served_hosts()`)).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses another page's version as the current one (ET160)", async () => {
    const { programId } = await createProgram();
    const other = await createLandingPage(programId);
    const foreign = await version(other, 1);
    await expect(sql`UPDATE landing_pages SET current_version_id = ${foreign} WHERE id = ${landingPageId}`).rejects.toMatchObject({ code: "ET160" });
  });
});
