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
