// Outbox relay (plan M3.5): every relayIntervalMs, in ONE transaction, lock due unrelayed rows of
// the topics that have a registered consumer (FOR UPDATE SKIP LOCKED, so concurrent relays never
// take the same row), add one job per row (jobId = outbox.id, data = { id }; see outboxJobId),
// then set relayed_at and commit.
//   - A crash after the add and before the commit leaves relayed_at NULL; the next pass re-adds
//     the same jobId and BullMQ dedupes it. If the job already ran, the consumer's claim finds the
//     row processed (or leased) and does nothing.
//   - Rows of topics without a consumer stay unrelayed; the outbox sweeper alerts on them.
//   - While Valkey is unreachable the add times out and the transaction rolls back.
//   - A row already processed (its consumer ran before the relay committed) is only marked.
import type { Queue } from "bullmq";
import type postgres from "postgres";
import type { Failpoint } from "./failpoint.ts";
import { JOB_OPTIONS, outboxJobId, withinValkeyTimeout } from "./queues.ts";

export interface RelayDeps {
  readonly sql: postgres.Sql;
  /** Queue per registered topic (queue name = topic). */
  readonly queues: ReadonlyMap<string, Queue>;
  readonly batchSize: number;
  readonly failpoint: Failpoint;
}

/** One relay pass; returns the number of rows it relayed (a full batch means: run again now). */
export async function relayOnce(deps: RelayDeps): Promise<number> {
  const topics = [...deps.queues.keys()];
  if (topics.length === 0) return 0;
  return deps.sql.begin(async (tx) => {
    const rows = await tx<{ id: string; topic: string; attempts: number; processed: boolean }[]>`
      SELECT id, topic, attempts, processed_at IS NOT NULL AS processed
        FROM public.outbox
       WHERE relayed_at IS NULL AND available_at <= now() AND topic = ANY(${topics}::text[])
       ORDER BY available_at
       LIMIT ${deps.batchSize}
         FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return 0;
    for (const [topic, queue] of deps.queues) {
      const jobs = rows.filter((r) => r.topic === topic && !r.processed);
      if (jobs.length === 0) continue;
      const add = queue.addBulk(jobs.map((r) => ({ name: topic, data: { id: r.id }, opts: { ...JOB_OPTIONS, jobId: outboxJobId(r.id, r.attempts) } })));
      await withinValkeyTimeout(`relay ${topic}`, add);
    }
    deps.failpoint("after_enqueue_before_mark");
    await tx`UPDATE public.outbox SET relayed_at = now() WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`;
    return rows.length;
  });
}
