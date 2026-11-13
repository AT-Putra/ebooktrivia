// AC 3: chaos tests with REAL worker processes, REAL PostgreSQL and REAL Valkey. The invariant:
// PostgreSQL is the source of truth; losing Valkey or a crash at any point never loses or
// duplicates a side effect. Side effects are requests to a real local HTTP sink that counts them.
// Workers run test/support/worker-harness.ts (the production composition plus test ports, see
// there); crashes are WORKER_FAILPOINT self-kills (SIGKILL / TerminateProcess) at exact points.
import { NEEDS_MANUAL_REFIRE } from "@ebooktrivia/core";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import { Redis } from "ioredis";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { CONVERSION_QUEUE } from "../src/conversion-fire.ts";
import { inertFailpoint } from "../src/failpoint.ts";
import { createLogger } from "../src/log.ts";
import { createQueue, rowJobId } from "../src/queues.ts";
import { relayOnce } from "../src/relay.ts";
import { sweepDueConversions } from "../src/sweepers.ts";
import { createCatalog, createConversionEvents, createOrders, createOutboxRows, type Catalog, first, sleep, sql, waitFor } from "./support/db.ts";
import { startThrowawayValkey } from "./support/docker.ts";
import { type Child, HARNESS, kill, spawnNode, waitForLine, workerEnv } from "./support/processes.ts";
import { type Sink, startSink } from "./support/sink.ts";
import { obliterate, testValkey, uniquePrefix } from "./support/valkey.ts";
import { PROBE_TOPIC } from "./support/probe.ts";

let sink: Sink;
let catalog: Catalog;
const children: Child[] = [];
/** BullMQ prefixes these tests used on the shared Valkey; their keys are removed afterwards. */
const sharedPrefixes: string[] = [];
beforeAll(async () => {
  sink = await startSink({ delayMs: 20 });
  catalog = await createCatalog();
});
afterAll(async () => {
  await Promise.all(children.map(kill));
  await sink.close();
  await obliterate(sharedPrefixes.flatMap((prefix) => [PROBE_TOPIC, CONVERSION_QUEUE].map((name) => createQueue(name, { valkey: testValkey(), prefix }))));
});

/** A fresh prefix on the shared (ACL) Valkey. */
function sharedPrefix(): string {
  const prefix = uniquePrefix();
  sharedPrefixes.push(prefix);
  return prefix;
}

function worker(prefix: string, overrides: Record<string, string> = {}, sinkUrl = sink.url): Child {
  const child = spawnNode([HARNESS], { ...workerEnv(prefix, overrides), TEST_SINK_URL: sinkUrl });
  children.push(child);
  return child;
}

const throwawayEnv = (valkey: { host: string; port: number }) => ({
  VALKEY_URL: `redis://${valkey.host}:${String(valkey.port)}`,
  VALKEY_USERNAME: "",
  VALKEY_PASSWORD: "",
});

const started = (child: Child) => waitForLine(child, (l) => l["msg"] === "worker started");

async function outboxState(ids: readonly string[]) {
  return sql<{ id: string; attempts: number; relayed: boolean; processed: boolean }[]>`
    SELECT id, attempts, relayed_at IS NOT NULL AS relayed, processed_at IS NOT NULL AS processed
      FROM outbox WHERE id = ANY(${ids as string[]}::uuid[])`;
}

const allProcessed = (ids: readonly string[]) => async () => (await outboxState(ids)).every((r) => r.processed);

async function conversionState(ids: readonly string[]) {
  return sql<{ id: string; status: string; attempts: number; last_error: string | null; logged: number }[]>`
    SELECT e.id, e.status::text, e.attempts, e.last_error,
           (SELECT count(*)::int FROM conversion_attempts a WHERE a.conversion_event_id = e.id) AS logged
      FROM conversion_events e WHERE e.id = ANY(${ids as string[]}::uuid[])`;
}

/** Fires the sink saw for one event, any attempt. */
const firesOf = (id: string): number => sink.total(`/conv/${id}?`);
const effectsOf = (id: string): number => sink.counts.get(`/outbox/${id}`) ?? 0;

describe("chaos", () => {
  it("kill the worker between commit and relay: every job still runs exactly once", async () => {
    const prefix = sharedPrefix();
    const ids = await createOutboxRows(PROBE_TOPIC, 5); // the producer's committed intents
    const crashing = worker(prefix, { WORKER_FAILPOINT: "after_enqueue_before_mark" });
    await crashing.exited;
    expect(crashing.lines.some((l) => l["msg"] === "worker started")).toBe(true);
    // The relay transaction died with the process: nothing is marked relayed, but the jobs are in Valkey.
    expect((await outboxState(ids)).every((r) => !r.relayed && !r.processed && r.attempts === 0)).toBe(true);
    // A job its own consumer took just before the kill is left `active` (its claim was blocked by
    // the relay's row lock, so no effect ran); BullMQ re-queues it after the lock lapses (stall
    // check; the harness uses a 2 s lock and a 1 s check instead of 30 s + 30 s).
    const queue = createQueue(PROBE_TOPIC, { valkey: testValkey(), prefix });
    const counts = await queue.getJobCounts("waiting", "active");
    expect((counts["waiting"] ?? 0) + (counts["active"] ?? 0)).toBe(5);
    await queue.close();
    expect(ids.map(effectsOf)).toEqual([0, 0, 0, 0, 0]);

    const healthy = worker(prefix);
    await started(healthy);
    // A row the healthy consumer claimed before its relay pass is marked relayed once its lease
    // (5 s) is over: wait for that rather than a fixed time.
    await waitFor("all probe rows processed and relayed", async () => (await outboxState(ids)).every((r) => r.processed && r.relayed), 30_000);
    await sleep(2500); // several more relay passes and sweeps (stale window 1 s): nothing may run again
    expect(ids.map(effectsOf)).toEqual([1, 1, 1, 1, 1]);
    expect((await outboxState(ids)).map((r) => r.attempts)).toEqual([1, 1, 1, 1, 1]);
    await kill(healthy);
  });

  it("FLUSHALL Valkey: all pending work (outbox and conversions) completes from PostgreSQL", async () => {
    const valkey = await startThrowawayValkey();
    try {
      const prefix = uniquePrefix();
      const config = { host: valkey.host, port: valkey.port, db: 0, username: undefined, password: undefined, tls: false };
      const outboxIds = await createOutboxRows(PROBE_TOPIC, 10);
      const eventIds = await createConversionEvents(await createOrders(catalog, 10));
      // The work reached Valkey: relayed (relayed_at set) and enqueued, nothing consumed yet ...
      const probeQueue = createQueue(PROBE_TOPIC, { valkey: config, prefix });
      const conversionQueue = createQueue(CONVERSION_QUEUE, { valkey: config, prefix });
      const workerSql = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 2, onnotice: () => undefined });
      try {
        while ((await relayOnce({ sql: workerSql, queues: new Map([[PROBE_TOPIC, probeQueue]]), batchSize: 200, failpoint: inertFailpoint })) > 0);
        expect(await sweepDueConversions({ sql: workerSql, log: createLogger({ level: "silent", role: "worker" }), conversionQueue })).toBeGreaterThanOrEqual(10);
      } finally {
        await workerSql.end({ timeout: 5 });
      }
      expect((await outboxState(outboxIds)).every((r) => r.relayed && !r.processed)).toBe(true);
      expect((await probeQueue.getJobCounts("waiting")).waiting).toBeGreaterThanOrEqual(10);
      await Promise.all([probeQueue.close(), conversionQueue.close()]);

      // ... and then Valkey loses everything.
      const admin = new Redis({ host: valkey.host, port: valkey.port });
      expect(await admin.flushall()).toBe("OK");
      expect(await admin.dbsize()).toBe(0);
      admin.disconnect();

      const healthy = worker(prefix, throwawayEnv(valkey));
      await started(healthy);
      await waitFor("outbox rows processed after FLUSHALL", allProcessed(outboxIds));
      await waitFor("conversions sent after FLUSHALL", async () => (await conversionState(eventIds)).every((r) => r.status === "sent"));
      await sleep(1500);
      expect(outboxIds.map(effectsOf)).toEqual(outboxIds.map(() => 1));
      expect(eventIds.map(firesOf)).toEqual(eventIds.map(() => 1));
      expect((await conversionState(eventIds)).map((r) => [r.attempts, r.logged])).toEqual(eventIds.map(() => [1, 1]));
      await kill(healthy);
    } finally {
      await valkey.stop();
    }
  });

  // Code review US-013 #6: Valkey loses its keys while a worker has jobs waiting AND in flight.
  it("FLUSHALL while a worker has waiting and active jobs: every job still completes exactly once", async () => {
    const valkey = await startThrowawayValkey();
    const slow = await startSink({ delayMs: 400 });
    let busy: Child | undefined;
    try {
      const prefix = uniquePrefix();
      const config = { host: valkey.host, port: valkey.port, db: 0, username: undefined, password: undefined, tls: false };
      const outboxIds = await createOutboxRows(PROBE_TOPIC, 12);
      const eventIds = await createConversionEvents(await createOrders(catalog, 8));
      busy = worker(prefix, { ...throwawayEnv(valkey), WORKER_CONCURRENCY: "2" }, slow.url);
      await started(busy);
      await waitFor("requests in flight", () => Promise.resolve(slow.total("/outbox/") + slow.total("/conv/") >= 2), 20_000, 10);
      const probeQueue = createQueue(PROBE_TOPIC, { valkey: config, prefix });
      const counts = await probeQueue.getJobCounts("waiting", "active");
      await probeQueue.close();
      const admin = new Redis({ host: valkey.host, port: valkey.port });
      expect(await admin.flushall()).toBe("OK");
      admin.disconnect();
      // Both kinds of loss happened: jobs that were queued and jobs a consumer was running.
      expect(counts["active"] ?? 0).toBeGreaterThan(0);
      expect(counts["waiting"] ?? 0).toBeGreaterThan(0);

      await waitFor("outbox rows processed after FLUSHALL", allProcessed(outboxIds), 40_000);
      await waitFor("conversions sent after FLUSHALL", async () => (await conversionState(eventIds)).every((r) => r.status === "sent"), 40_000);
      await sleep(2500);
      expect(outboxIds.map((id) => slow.counts.get(`/outbox/${id}`) ?? 0)).toEqual(outboxIds.map(() => 1));
      expect(eventIds.map((id) => slow.total(`/conv/${id}?`))).toEqual(eventIds.map(() => 1));
      expect((await conversionState(eventIds)).map((r) => [r.attempts, r.logged])).toEqual(eventIds.map(() => [1, 1]));
    } finally {
      if (busy !== undefined) await kill(busy);
      await slow.close();
      await valkey.stop();
    }
  });

  it("consumer crash mid-claim: no double side effect (after the fire, before the fire, before an outbox effect)", async () => {
    const prefix = sharedPrefix();
    // A: the worker fires the conversion and dies before recording the outcome.
    const [eventA] = await createConversionEvents(await createOrders(catalog, 1));
    const crashA = worker(prefix, { WORKER_FAILPOINT: "conversion_after_fire" });
    await crashA.exited;
    expect(firesOf(eventA as string)).toBe(1);
    expect(first(await conversionState([eventA as string]))).toMatchObject({ status: "sending", attempts: 1, logged: 0 });

    // B: the worker claims the conversion and dies before sending it.
    const [eventB] = await createConversionEvents(await createOrders(catalog, 1));
    const crashB = worker(prefix, { WORKER_FAILPOINT: "conversion_after_claim" });
    await waitFor("event B claimed", async () => first(await conversionState([eventB as string])).status === "sending");
    await crashB.exited;
    expect(firesOf(eventB as string)).toBe(0);

    // C: the worker claims an outbox row (lease) and dies before its effect.
    const [rowC] = await createOutboxRows(PROBE_TOPIC, 1);
    const crashC = worker(prefix, { WORKER_FAILPOINT: "after_claim_before_effect" });
    await crashC.exited;
    expect(first(await outboxState([rowC as string]))).toMatchObject({ attempts: 1, processed: false });
    expect(effectsOf(rowC as string)).toBe(0);

    // A healthy worker: the lease sweeper settles A and B without a resend (the send may have
    // counted), the outbox sweeper re-relays C once its lease is over and it runs exactly once.
    const healthy = worker(prefix);
    await started(healthy);
    const settled = (status: string) => status === "failed" || status === "sent";
    await waitFor("A and B settled", async () => (await conversionState([eventA as string, eventB as string])).every((r) => settled(r.status)), 20_000);
    await waitFor("C processed", allProcessed([rowC as string]), 20_000);
    await sleep(2500);
    expect([firesOf(eventA as string), firesOf(eventB as string)]).toEqual([1, 0]);
    for (const row of await conversionState([eventA as string, eventB as string])) {
      expect(row).toMatchObject({ status: "failed", attempts: 1 });
      expect(row.last_error?.startsWith(NEEDS_MANUAL_REFIRE)).toBe(true);
    }
    expect(effectsOf(rowC as string)).toBe(1);
    expect(first(await outboxState([rowC as string]))).toMatchObject({ attempts: 2, processed: true });
    await kill(healthy);
  });

  it("concurrent sweepers plus a retry give a single conversion fire per attempt", async () => {
    const prefix = sharedPrefix();
    // 30 events whose first attempt failed; the retry (attempt 2) is due now.
    const ids = await createConversionEvents(await createOrders(catalog, 30), { attempts: 1, nextAttemptAt: new Date(Date.now() - 1000) });
    const fast = { WORKER_SWEEP_INTERVAL_MS: "100", WORKER_CONCURRENCY: "8" };
    const a = worker(prefix, fast);
    const b = worker(prefix, fast);
    // Meanwhile the same retry arrives again, next to each other in the queue so the consumers of
    // both workers take them at the same moment: the same job id (deduped by BullMQ) and two
    // re-delivered jobs with other ids, racing both workers' sweepers.
    const queue = createQueue(CONVERSION_QUEUE, { valkey: testValkey(), prefix });
    await Promise.all([
      queue.addBulk(
        ids.flatMap((id) => [rowJobId(id, 1), `${id}-retry-a`, `${id}-retry-b`, rowJobId(id, 1)].map((jobId) => ({ name: CONVERSION_QUEUE, data: { id }, opts: { jobId } }))),
      ),
      started(a),
      started(b),
    ]);
    await waitFor("all retries sent", async () => (await conversionState(ids)).every((r) => r.status === "sent"), 30_000);
    await sleep(1500);
    expect(ids.map((id) => sink.counts.get(`/conv/${id}?attempt=2`) ?? 0)).toEqual(ids.map(() => 1));
    expect(ids.map(firesOf)).toEqual(ids.map(() => 1));
    expect((await conversionState(ids)).map((r) => [r.attempts, r.logged])).toEqual(ids.map(() => [2, 1]));
    await obliterate([queue]);
    await Promise.all([kill(a), kill(b)]);
  });
});
