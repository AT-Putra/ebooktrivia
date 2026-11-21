// AC 4 (latency): /caddy/ask of the REAL internal process keeps p99 < 20 ms over >= 2000 requests
// while a REAL worker process is busy relaying and consuming thousands of outbox jobs.
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createCatalog, createOutboxRows, first, hostLandingPage, sql, suffix, waitFor } from "./support/db.ts";
import { PROBE_TOPIC } from "./support/probe.ts";
import { type Child, HARNESS, kill, MAIN, spawnNode, waitForLine, workerEnv } from "./support/processes.ts";
import { type Sink, startSink } from "./support/sink.ts";
import { uniquePrefix } from "./support/valkey.ts";

const JOBS = 5000;
const REQUESTS = 2500;
let sink: Sink;
let internal: Child;
let base: string;
const hosts: string[] = [];

beforeAll(async () => {
  sink = await startSink();
  const { landingPageId } = await createCatalog();
  await hostLandingPage(landingPageId);
  for (let i = 0; i < 50; i++) hosts.push(`load-${suffix()}.example.com`);
  await sql`INSERT INTO lp_domains (landing_page_id, host) SELECT ${landingPageId}, unnest(${hosts}::text[])`;
  internal = spawnNode([MAIN, "--role=internal"], {
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    DATABASE_URL_INTERNAL: inject("internalDbUrl"),
    GLITCHTIP_HOOK_TOKEN_SHA256: createHash("sha256").update("unused-token-for-load-test").digest("hex"),
    INTERNAL_PORT: "0",
  });
  base = `http://127.0.0.1:${String((await waitForLine(internal, (l) => l["msg"] === "internal listening"))["port"])}`;
});
afterAll(async () => {
  await kill(internal);
  await sink.close();
});

const percentile = (sorted: readonly number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;

describe("/caddy/ask under worker load", () => {
  it(`keeps p99 under 20 ms over ${String(REQUESTS)} requests while the worker relays and consumes ${String(JOBS)} jobs`, async () => {
    const ids = await createOutboxRows(PROBE_TOPIC, JOBS);
    const processed = async () =>
      first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE id = ANY(${ids}::uuid[]) AND processed_at IS NOT NULL`).n;
    const worker = spawnNode([HARNESS], { ...workerEnv(uniquePrefix(), { WORKER_CONCURRENCY: "16", LOG_LEVEL: "warn" }), TEST_SINK_URL: sink.url });
    try {
      await waitFor("the worker is consuming", async () => (await processed()) > 0, 30_000, 20);
      // Warm-up (JIT, connection pool, first GCs) is not part of the measurement.
      for (let i = 0; i < 200; i++) await (await fetch(`${base}/caddy/ask?domain=warmup-${String(i)}.example.com`)).arrayBuffer();
      const before = await processed();
      const latencies: number[] = [];
      for (let i = 0; i < REQUESTS; i++) {
        const domain = i % 2 === 0 ? (hosts[i % hosts.length] as string) : `miss-${String(i)}.example.com`;
        const t0 = performance.now();
        const response = await fetch(`${base}/caddy/ask?domain=${domain}`);
        await response.arrayBuffer();
        latencies.push(performance.now() - t0);
        expect(response.status).toBe(i % 2 === 0 ? 200 : 404);
      }
      const after = await processed();
      latencies.sort((a, b) => a - b);
      const p50 = percentile(latencies, 50);
      const p99 = percentile(latencies, 99);
      console.log(`caddy ask: n=${String(latencies.length)} p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${(latencies.at(-1) ?? 0).toFixed(2)}ms; jobs consumed during the run: ${String(after - before)} (${String(before)} -> ${String(after)} of ${String(JOBS)})`);
      // The worker really was busy for the whole measurement.
      expect(after - before).toBeGreaterThan(100);
      expect(before).toBeLessThan(JOBS);
      expect(latencies.length).toBeGreaterThanOrEqual(2000);
      expect(p99).toBeLessThan(20);
    } finally {
      await kill(worker);
    }
  }, 180_000);
});
