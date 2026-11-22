import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { checkHealth, HEALTH_PROBE_TIMEOUT_MS, WORKER_HEARTBEAT_MAX_AGE_MS } from "./health.ts";

/** A postgres.js stand-in: `begin` runs the callback with a transaction whose query answers `ageMs` (or throws). */
function fakeSql(answer: { ageMs: number | null } | { error: Error } | { hang: true }): { sql: postgres.Sql; statements: string[] } {
  const statements: string[] = [];
  const tx = Object.assign(
    async () => {
      if ("error" in answer) throw answer.error;
      if ("hang" in answer) return new Promise<never>(() => undefined);
      return [{ age_ms: answer.ageMs }];
    },
    {
      unsafe: (text: string) => {
        statements.push(text);
        return Promise.resolve([]);
      },
    },
  );
  const sql = { begin: (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as postgres.Sql;
  return { sql, statements };
}

const pong = () => Promise.resolve("PONG");

describe("checkHealth", () => {
  it("is ok when the database answers, the worker heartbeat is fresh and Valkey answers PING", async () => {
    const { sql, statements } = fakeSql({ ageMs: 59_000 });
    expect(await checkHealth({ sql, ping: pong })).toEqual({ ok: true, failed: [] });
    // The statement timeout is set inside the transaction, so it never outlives it.
    expect(statements).toEqual([`SET LOCAL statement_timeout = ${String(HEALTH_PROBE_TIMEOUT_MS)}`]);
  });

  it("accepts a heartbeat exactly at the limit (3 minutes) and refuses one a millisecond older", async () => {
    expect(WORKER_HEARTBEAT_MAX_AGE_MS).toBe(180_000);
    expect((await checkHealth({ sql: fakeSql({ ageMs: 180_000 }).sql, ping: pong })).ok).toBe(true);
    expect(await checkHealth({ sql: fakeSql({ ageMs: 180_001 }).sql, ping: pong })).toEqual({ ok: false, failed: ["heartbeat"] });
  });

  it("is degraded when the database is down", async () => {
    const { sql } = fakeSql({ error: Object.assign(new Error("connect ECONNREFUSED 10.89.51.2:5432"), { code: "ECONNREFUSED" }) });
    expect(await checkHealth({ sql, ping: pong })).toEqual({ ok: false, failed: ["database"] });
  });

  it("is degraded when the worker heartbeat is stale or was never written", async () => {
    expect(await checkHealth({ sql: fakeSql({ ageMs: 10 * 60_000 }).sql, ping: pong })).toEqual({ ok: false, failed: ["heartbeat"] });
    expect(await checkHealth({ sql: fakeSql({ ageMs: null }).sql, ping: pong })).toEqual({ ok: false, failed: ["heartbeat"] });
    expect(await checkHealth({ sql: fakeSql({ ageMs: Number.NaN }).sql, ping: pong })).toEqual({ ok: false, failed: ["heartbeat"] });
  });

  it("is degraded when Valkey is down, whether PING rejects or throws at once", async () => {
    const { sql } = fakeSql({ ageMs: 1000 });
    expect(await checkHealth({ sql, ping: () => Promise.reject(new Error("Connection is closed.")) })).toEqual({ ok: false, failed: ["valkey"] });
    expect(
      await checkHealth({
        sql,
        ping: () => {
          throw new Error("not connected");
        },
      }),
    ).toEqual({ ok: false, failed: ["valkey"] });
  });

  it("names every probe that failed", async () => {
    expect(await checkHealth({ sql: fakeSql({ error: new Error("down") }).sql, ping: () => Promise.reject(new Error("down")) })).toEqual({
      ok: false,
      failed: ["database", "valkey"],
    });
  });

  it("cuts a hung database or a hung Valkey off after the timeout instead of hanging", async () => {
    const started = Date.now();
    const hungDb = await checkHealth({ sql: fakeSql({ hang: true }).sql, ping: pong, timeoutMs: 50 });
    const hungValkey = await checkHealth({ sql: fakeSql({ ageMs: 1 }).sql, ping: () => new Promise(() => undefined), timeoutMs: 50 });
    expect(hungDb).toEqual({ ok: false, failed: ["database"] });
    expect(hungValkey).toEqual({ ok: false, failed: ["valkey"] });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("runs both probes at once: a hung database and a hung Valkey cost one timeout, not two", async () => {
    const started = Date.now();
    const result = await checkHealth({ sql: fakeSql({ hang: true }).sql, ping: () => new Promise(() => undefined), timeoutMs: 200 });
    expect(result).toEqual({ ok: false, failed: ["database", "valkey"] });
    expect(Date.now() - started).toBeLessThan(380);
  });

  it("is bounded by 2 seconds by default", () => {
    expect(HEALTH_PROBE_TIMEOUT_MS).toBe(2000);
  });
});
