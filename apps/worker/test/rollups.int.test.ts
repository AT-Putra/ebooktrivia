// US-029: the report rollup job (src/rollups.ts) as the worker_rw login: it refreshes the rollups, a second
// refresh (or many at once) counts nothing twice, a failure rolls back whole, and the worker composition runs it
// every rollupIntervalMs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../src/log.ts";
import { refreshReportRollups, ROLLUP_STATEMENT_TIMEOUT_MS } from "../src/rollups.ts";
import { startWorker } from "../src/worker.ts";
import { loadWorkerConfig } from "../src/worker-config.ts";
import { captureLogger } from "./support/log.ts";
import { workerEnv } from "./support/processes.ts";
import { type Catalog, createCatalog, createOrders, first, sleep, sql, waitFor } from "./support/db.ts";
import { workerPool } from "./support/midtrans.ts";
import { uniquePrefix } from "./support/valkey.ts";

const silent = createLogger({ level: "silent", role: "worker" });
const workerSql = workerPool(8);
let catalog: Catalog;
beforeAll(async () => {
  catalog = await createCatalog();
});
afterAll(async () => {
  await workerSql.end({ timeout: 5 });
});

/** What the rollup must add up to, read from the raw table. */
const raw = async () =>
  first(await sql<{ orders: string; paid: string; revenue: string }[]>`
    SELECT count(*)::text AS orders, count(*) FILTER (WHERE status = 'paid')::text AS paid, coalesce(sum(amount_idr) FILTER (WHERE status = 'paid'), 0)::text AS revenue FROM orders`);
const rolled = async () =>
  first(await sql<{ orders: string; paid: string; revenue: string }[]>`
    SELECT coalesce(sum(orders), 0)::text AS orders, coalesce(sum(mt), 0)::text AS paid, coalesce(sum(revenue_idr), 0)::text AS revenue FROM report_orders_daily`);

describe("refreshReportRollups as worker_rw", () => {
  it("recomputes the rollups from the raw tables, and records when", async () => {
    await createOrders(catalog, 3, { status: "paid" });
    await createOrders(catalog, 2, { status: "pending" });
    const outcome = await refreshReportRollups(workerSql, silent);
    expect(outcome).toMatchObject({ refreshed: true });
    expect(await rolled()).toEqual(await raw());
    const state = first(await sql<{ as_of: Date; order_rows: number }[]>`SELECT as_of, order_rows FROM report_rollup_state`);
    expect(Math.abs(Date.now() - state.as_of.getTime())).toBeLessThan(60_000);
    expect(outcome).toMatchObject({ refreshed: true, orderRows: state.order_rows });
    expect(state.order_rows).toBeGreaterThan(0);
  });

  it("counts nothing twice when workers refresh at once: whoever wins, the figures equal the raw tables", async () => {
    await createOrders(catalog, 4, { status: "paid" });
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => refreshReportRollups(workerSql, silent)));
    expect(outcomes.some((o) => o.refreshed)).toBe(true);
    // Whatever interleaving: one state row, and no group twice (the UNIQUE key would have refused it).
    expect(first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM report_rollup_state`).n).toBe(1);
    expect(first(await sql<{ dup: number }[]>`SELECT count(*)::int AS dup FROM (SELECT 1 FROM report_orders_daily GROUP BY day, landing_page_id, program_id, adnet_id, utm_campaign, status HAVING count(*) > 1) d`).dup).toBe(0);
    expect(await rolled()).toEqual(await raw());
    // And again, sequentially: idempotent.
    await refreshReportRollups(workerSql, silent);
    expect(await rolled()).toEqual(await raw());
  });

  it("rolls back whole when the refresh fails: the previous figures stay", async () => {
    const before = await rolled();
    const asOf = first(await sql<{ as_of: Date }[]>`SELECT as_of FROM report_rollup_state`).as_of;
    // Two orders whose amounts add up past bigint: the grouped SUM fails in the middle of the refresh, after the old rows were deleted.
    const huge = await createOrders(catalog, 2, { status: "pending" });
    await sql`UPDATE orders SET amount_idr = 5000000000000000000 WHERE id = ANY(${huge}::uuid[])`;
    try {
      await expect(refreshReportRollups(workerSql, silent)).rejects.toMatchObject({ code: "22003" });
      expect(await rolled()).toEqual(before);
      expect(first(await sql<{ as_of: Date }[]>`SELECT as_of FROM report_rollup_state`).as_of).toEqual(asOf);
    } finally {
      await sql`DELETE FROM orders WHERE id = ANY(${huge}::uuid[])`;
    }
    expect(ROLLUP_STATEMENT_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
    await refreshReportRollups(workerSql, silent);
    expect(await rolled()).toEqual(await raw());
  });

  it("logs a skipped refresh and a done one", async () => {
    const { log, lines } = captureLogger("debug");
    await refreshReportRollups(workerSql, log);
    expect(lines.some((l) => l["msg"] === "report rollups refreshed")).toBe(true);
    // Hold the lock in another transaction: this worker's refresh is skipped.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = workerSql.begin(async (tx) => {
      await tx`SELECT public.refresh_report_rollups()`;
      entered();
      await held;
    });
    await inside;
    expect(await refreshReportRollups(workerSql, log)).toEqual({ refreshed: false });
    expect(lines.some((l) => l["msg"] === "report rollups: another worker is refreshing, skipped")).toBe(true);
    release();
    await holder;
  });
});

describe("the worker composition", () => {
  it("refreshes the rollups every rollupIntervalMs, from its first tick", async () => {
    await sql`DELETE FROM report_rollup_state`;
    const config = loadWorkerConfig(workerEnv(uniquePrefix(), { WORKER_ROLLUP_INTERVAL_MS: "1000" }));
    const running = await startWorker(config, {}, silent);
    try {
      await waitFor("the first refresh", async () => (await sql`SELECT 1 FROM report_rollup_state`).length === 1, 20_000);
      const firstAsOf = first(await sql<{ as_of: Date }[]>`SELECT as_of FROM report_rollup_state`).as_of;
      await sleep(10);
      await waitFor("a later refresh", async () => first(await sql<{ as_of: Date }[]>`SELECT as_of FROM report_rollup_state`).as_of.getTime() > firstAsOf.getTime(), 20_000);
    } finally {
      await running.stop();
    }
  });
});
