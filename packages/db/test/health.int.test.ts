// US-015: the deep health probe (src/health.ts) against a real database, as the login the public app uses: the
// heartbeat age is readable by public_rw (column grant on component and beat_at, never `info`), and a missing row, a
// stale row, a database that is down and a Valkey that is down are each a degraded answer.

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PG_CONNECTION_OPTIONS } from "../src/connection.ts";
import { checkHealth } from "../src/health.ts";
import { sql, sqlState } from "./db.ts";

const pong = () => Promise.resolve("PONG");
let asPublic: postgres.Sql;

beforeAll(() => {
  // A connection that starts out as public_rw, like the public app's login (a superuser may take the role at startup).
  asPublic = postgres(inject("dbUrl"), { ...PG_CONNECTION_OPTIONS, connection: { ...PG_CONNECTION_OPTIONS.connection, role: "public_rw" }, max: 2, onnotice: () => undefined });
});
afterAll(async () => {
  await asPublic.end();
});

const setBeat = async (interval: string | null): Promise<void> => {
  await sql`DELETE FROM public.heartbeats WHERE component = 'worker'`;
  if (interval !== null) {
    await sql`INSERT INTO public.heartbeats (component, beat_at, info) VALUES ('worker', now() - ${interval}::interval, '{"secret":"detail"}'::jsonb)`;
  }
};

describe("checkHealth against PostgreSQL as public_rw", () => {
  it("is ok with a fresh worker heartbeat", async () => {
    await setBeat("5 seconds");
    expect(await checkHealth({ sql: asPublic, ping: pong })).toEqual({ ok: true, failed: [] });
  });

  it("is degraded when the worker heartbeat is older than 3 minutes, and ok just inside", async () => {
    await setBeat("4 minutes");
    expect(await checkHealth({ sql: asPublic, ping: pong })).toEqual({ ok: false, failed: ["heartbeat"] });
    await setBeat("170 seconds");
    expect((await checkHealth({ sql: asPublic, ping: pong })).ok).toBe(true);
  });

  it("is degraded when no worker heartbeat was ever written", async () => {
    await setBeat(null);
    expect(await checkHealth({ sql: asPublic, ping: pong })).toEqual({ ok: false, failed: ["heartbeat"] });
  });

  it("is degraded when Valkey does not answer", async () => {
    await setBeat("1 second");
    expect(await checkHealth({ sql: asPublic, ping: () => Promise.reject(new Error("down")) })).toEqual({ ok: false, failed: ["valkey"] });
  });

  it("is degraded, quickly, when PostgreSQL cannot be reached", async () => {
    const url = new URL(inject("dbUrl"));
    url.port = "1";
    const dead = postgres(url.toString(), { ...PG_CONNECTION_OPTIONS, max: 1, connect_timeout: 1, onnotice: () => undefined });
    const started = Date.now();
    try {
      expect(await checkHealth({ sql: dead, ping: pong, timeoutMs: 1500 })).toEqual({ ok: false, failed: ["database"] });
    } finally {
      await dead.end({ timeout: 1 });
    }
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("gives public_rw the heartbeat's component and time only: not its info, and no write", async () => {
    await setBeat("1 second");
    const [row] = await asPublic<{ component: string }[]>`SELECT component FROM public.heartbeats WHERE component = 'worker'`;
    expect(row?.component).toBe("worker");
    expect(await sqlState(asPublic`SELECT info FROM public.heartbeats`)).toBe("42501");
    expect(await sqlState(asPublic`SELECT * FROM public.heartbeats`)).toBe("42501");
    expect(await sqlState(asPublic`UPDATE public.heartbeats SET beat_at = now() WHERE component = 'worker'`)).toBe("42501");
  });
});
