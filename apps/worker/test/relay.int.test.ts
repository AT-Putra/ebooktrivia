// AC 1: the relay moves due outbox rows of registered topics to BullMQ in one transaction
// (SELECT ... FOR UPDATE SKIP LOCKED, queue.add with jobId = outbox.id and payload {id} only, then
// relayed_at); retention is capped; a crash between add and the relayed_at commit re-adds the same
// jobId, which BullMQ dedupes.
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import type { Queue } from "bullmq";
import postgres from "postgres";
import { afterAll, afterEach, describe, expect, inject, it } from "vitest";
import { inertFailpoint } from "../src/failpoint.ts";
import { createQueue, JOB_RETENTION } from "../src/queues.ts";
import { relayOnce } from "../src/relay.ts";
import { createOutboxRows, sql } from "./support/db.ts";
import { obliterate, testValkey, uniquePrefix } from "./support/valkey.ts";

const workerSql = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 4, onnotice: () => undefined });
afterAll(async () => {
  await workerSql.end({ timeout: 5 });
});

let queues: Queue[] = [];
afterEach(async () => {
  await obliterate(queues);
  queues = [];
});

function queueFor(topic: string, prefix = uniquePrefix()): Queue {
  const queue = createQueue(topic, { valkey: testValkey(), prefix });
  queues.push(queue);
  return queue;
}

const relayedAt = async (ids: readonly string[]) =>
  (await sql<{ id: string; relayed_at: Date | null }[]>`SELECT id, relayed_at FROM outbox WHERE id = ANY(${ids as string[]}::uuid[]) ORDER BY id`).map(
    (r) => r.relayed_at,
  );

describe("relayOnce", () => {
  it("enqueues every due row of a registered topic once, id-only, with capped retention, and marks it relayed", async () => {
    const topic = "test.relay_once";
    const queue = queueFor(topic);
    const due = await createOutboxRows(topic, 3);
    const later = await createOutboxRows(topic, 1, { availableAt: new Date(Date.now() + 3_600_000) });
    const other = await createOutboxRows("test.unregistered", 1);

    const relayed = await relayOnce({ sql: workerSql, queues: new Map([[topic, queue]]), batchSize: 100, failpoint: inertFailpoint });
    expect(relayed).toBe(3);

    const jobs = await queue.getJobs(["waiting"]);
    expect(jobs.map((j) => j.id).sort()).toEqual([...due].sort());
    for (const job of jobs) {
      expect(job.name).toBe(topic);
      expect(job.data).toEqual({ id: job.id });
      expect(job.opts).toMatchObject({ attempts: 1, ...JOB_RETENTION });
    }
    expect(JOB_RETENTION).toEqual({ removeOnComplete: { age: 86_400, count: 1000 }, removeOnFail: { age: 86_400, count: 1000 } });
    expect((await relayedAt(due)).every((at) => at instanceof Date)).toBe(true);
    expect(await relayedAt([...later, ...other])).toEqual([null, null]);

    expect(await relayOnce({ sql: workerSql, queues: new Map([[topic, queue]]), batchSize: 100, failpoint: inertFailpoint })).toBe(0);
    expect(await queue.getJobCounts("waiting")).toEqual({ waiting: 3 });
  });

  it("re-adds the same jobId after a crash between add and the relayed_at commit, and BullMQ keeps one job", async () => {
    const topic = "test.relay_crash";
    const queue = queueFor(topic);
    const [id] = await createOutboxRows(topic, 1);
    const crash = new Error("simulated crash");
    await expect(
      relayOnce({
        sql: workerSql,
        queues: new Map([[topic, queue]]),
        batchSize: 10,
        failpoint: (name) => {
          if (name === "after_enqueue_before_mark") throw crash;
        },
      }),
    ).rejects.toBe(crash);
    expect(await relayedAt([id as string])).toEqual([null]);
    expect((await queue.getJobs(["waiting"])).map((j) => j.id)).toEqual([id]);

    expect(await relayOnce({ sql: workerSql, queues: new Map([[topic, queue]]), batchSize: 10, failpoint: inertFailpoint })).toBe(1);
    expect((await queue.getJobs(["waiting"])).map((j) => j.id)).toEqual([id]);
    expect((await relayedAt([id as string]))[0]).toBeInstanceOf(Date);
  });

  it("takes at most batchSize rows per pass, skips rows locked by a concurrent relay, and marks processed rows without a job", async () => {
    const topic = "test.relay_batch";
    const queue = queueFor(topic);
    const ids = await createOutboxRows(topic, 5);
    const queuesByTopic = new Map([[topic, queue]]);
    expect(await relayOnce({ sql: workerSql, queues: queuesByTopic, batchSize: 2, failpoint: inertFailpoint })).toBe(2);

    // A second relay holds the next rows: SKIP LOCKED makes this one take the rest.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = sql.begin(async (tx) => {
      await tx`SELECT id FROM outbox WHERE id = ANY(${ids}::uuid[]) AND relayed_at IS NULL ORDER BY available_at LIMIT 1 FOR UPDATE`;
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await relayOnce({ sql: workerSql, queues: queuesByTopic, batchSize: 10, failpoint: inertFailpoint })).toBe(2);
    release();
    await holder;

    const [last] = await sql<{ id: string }[]>`SELECT id FROM outbox WHERE id = ANY(${ids}::uuid[]) AND relayed_at IS NULL`;
    await sql`UPDATE outbox SET processed_at = now() WHERE id = ${last?.id ?? ""}`;
    expect(await relayOnce({ sql: workerSql, queues: queuesByTopic, batchSize: 10, failpoint: inertFailpoint })).toBe(1);
    expect(await queue.getJobCounts("waiting")).toEqual({ waiting: 4 });
    expect((await relayedAt(ids)).every((at) => at instanceof Date)).toBe(true);
  });

  it("does nothing without registered topics", async () => {
    await createOutboxRows("test.relay_none", 1);
    expect(await relayOnce({ sql: workerSql, queues: new Map(), batchSize: 10, failpoint: inertFailpoint })).toBe(0);
  });
});
