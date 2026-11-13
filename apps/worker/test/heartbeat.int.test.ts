// AC 5: the heartbeat upserts heartbeats(component, beat_at, info) and pushes to the configured
// Uptime Kuma push URL through safe-fetch, but only while PostgreSQL and Valkey both answer, so a
// silent stop of either shows up as a missed push.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSafeFetch } from "@ebooktrivia/adapters";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { beat } from "../src/heartbeat.ts";
import { first, sql } from "./support/db.ts";
import { captureLogger } from "./support/log.ts";

const workerSql = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 2, onnotice: () => undefined });
const internalSql = postgres(inject("internalDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice: () => undefined });
const safeFetch = createSafeFetch({ allowHttp: true, devAllowLoopback: true, timeoutMs: 1000 });
const pushes: string[] = [];
let kuma: Server;
let kumaUrl: string;

beforeAll(async () => {
  kuma = createServer((req, res) => {
    pushes.push(req.url ?? "");
    res.writeHead(req.url?.includes("broken") === true ? 500 : 200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => kuma.listen(0, "127.0.0.1", resolve));
  kumaUrl = `http://127.0.0.1:${String((kuma.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await Promise.all([workerSql.end({ timeout: 5 }), internalSql.end({ timeout: 5 }), safeFetch.close()]);
  await new Promise((resolve) => kuma.close(resolve));
});

const row = async (component: string) =>
  first(await sql<{ beat_at: Date; info: Record<string, unknown> }[]>`SELECT beat_at, info FROM heartbeats WHERE component = ${component}`);

describe("heartbeat", () => {
  it("upserts the heartbeats row and pushes to Uptime Kuma (the push URL is never logged)", async () => {
    const { log, lines } = captureLogger();
    const push = { fetch: safeFetch, url: new URL(`${kumaUrl}/api/push/tok3n?status=up&msg=OK&ping=`) };
    pushes.length = 0;
    expect(await beat({ sql: workerSql, ping: () => Promise.resolve("PONG"), push, log, component: "worker-test", info: () => ({ pid: 1 }) })).toEqual({
      recorded: true,
      pushed: true,
    });
    const before = await row("worker-test");
    expect(before.info).toEqual({ pid: 1, valkey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await beat({ sql: workerSql, ping: () => Promise.resolve("PONG"), push, log, component: "worker-test", info: () => ({ pid: 2 }) })).toEqual({
      recorded: true,
      pushed: true,
    });
    const after = await row("worker-test");
    expect(after.beat_at.getTime()).toBeGreaterThan(before.beat_at.getTime());
    expect(after.info).toEqual({ pid: 2, valkey: true });
    expect(pushes).toEqual(["/api/push/tok3n?status=up&msg=OK&ping=", "/api/push/tok3n?status=up&msg=OK&ping="]);
    expect(JSON.stringify(lines)).not.toContain("tok3n");
  });

  it("records the row but does not push while Valkey is down", async () => {
    pushes.length = 0;
    const { log } = captureLogger();
    const push = { fetch: safeFetch, url: new URL(`${kumaUrl}/api/push/x`) };
    expect(await beat({ sql: workerSql, ping: () => Promise.reject(new Error("ECONNREFUSED")), push, log, component: "worker-test", info: () => ({}) })).toEqual({
      recorded: true,
      pushed: false,
    });
    expect((await row("worker-test")).info).toEqual({ valkey: false });
    expect(pushes).toEqual([]);
  });

  it("does not push when the database write fails (internal_rw cannot write heartbeats)", async () => {
    pushes.length = 0;
    const { log, lines } = captureLogger();
    const push = { fetch: safeFetch, url: new URL(`${kumaUrl}/api/push/x`) };
    expect(await beat({ sql: internalSql, ping: () => Promise.resolve("PONG"), push, log, component: "worker-test", info: () => ({}) })).toEqual({
      recorded: false,
      pushed: false,
    });
    expect(pushes).toEqual([]);
    expect(lines.some((l) => l["level"] === 50)).toBe(true);
  });

  it("logs a failed push without the URL and without throwing; works without a push URL", async () => {
    const { log, lines } = captureLogger();
    const push = { fetch: safeFetch, url: new URL(`${kumaUrl}/api/push/broken-secret`) };
    expect(await beat({ sql: workerSql, ping: () => Promise.resolve("PONG"), push, log, component: "worker-test", info: () => ({}) })).toEqual({
      recorded: true,
      pushed: false,
    });
    const unreachable = { fetch: safeFetch, url: new URL("http://127.0.0.1:1/api/push/also-secret") };
    expect(await beat({ sql: workerSql, ping: () => Promise.resolve("PONG"), push: unreachable, log, component: "worker-test", info: () => ({}) })).toEqual({
      recorded: true,
      pushed: false,
    });
    expect(lines.filter((l) => l["level"] === 40)).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toMatch(/secret/);
    expect(await beat({ sql: workerSql, ping: () => Promise.resolve("PONG"), log, component: "worker-test", info: () => ({}) })).toEqual({
      recorded: true,
      pushed: false,
    });
  });
});
