// BullMQ plumbing. PostgreSQL is the source of truth; BullMQ only accelerates delivery:
//   - every job carries `{ id }` only: consumers re-read the row and claim it there;
//   - attempts: 1, PostgreSQL owns retries (outbox available_at, conversion_events.next_attempt_at);
//   - finished jobs are kept at most 24 h AND at most 1000 per queue (diagnostics only);
//   - deterministic job ids: an outbox job is `<outbox.id>` (`<outbox.id>-<attempts>` once a claim
//     was made), a row job `<row id>-<attempts>`, so a re-add of a live job is a no-op (BullMQ
//     dedupes by id) while a retry after a crashed claim gets a fresh id instead of waiting for
//     BullMQ to notice the dead job. Ids never contain ":".
// Valkey loss or a crash never loses work: the sweepers re-enqueue from PostgreSQL. One case
// relies on BullMQ instead: a process that died after its consumer took a job but BEFORE the claim
// committed leaves that job `active` with attempts unchanged, so a re-add under the same id is a
// no-op until BullMQ's stall check re-queues it (lockDuration + stalledInterval, 60 s by default,
// shorter than the sweeper's stale window; WORKER_LOCK_DURATION_MS / WORKER_STALLED_INTERVAL_MS).
import { type JobsOptions, Queue, type RedisOptions } from "bullmq";
import type { ValkeyConfig } from "./worker-config.ts";

export const JOB_RETENTION = {
  removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
  removeOnFail: { age: 24 * 60 * 60, count: 1000 },
} as const;

export const JOB_OPTIONS = { attempts: 1, ...JOB_RETENTION } as const satisfies JobsOptions;

export interface JobData {
  readonly id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The row id of a job's data; anything but `{ id: <uuid> }` is refused. */
export function jobRowId(data: unknown): string {
  const id = typeof data === "object" && data !== null ? (data as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !UUID.test(id) || Object.keys(data as object).length !== 1) {
    throw new TypeError("job data must be { id: <uuid> }");
  }
  return id;
}

/** Job id of an outbox row: its id, attempt-scoped after a claim (a crashed claim's job may be stuck active). */
export const outboxJobId = (id: string, attempts: number): string => (attempts === 0 ? id : `${id}-${String(attempts)}`);

/** Job id of an attempt-scoped row job (conversion_events, deliveries). */
export const rowJobId = (id: string, attempts: number): string => `${id}-${String(attempts)}`;

export function redisOptions(valkey: ValkeyConfig): RedisOptions {
  return {
    host: valkey.host,
    port: valkey.port,
    db: valkey.db,
    ...(valkey.username === undefined || valkey.password === undefined ? {} : { username: valkey.username, password: valkey.password }),
    ...(valkey.tls ? { tls: { servername: valkey.host } } : {}),
  };
}

/** A producer queue: fails fast while Valkey is unreachable instead of queueing commands in memory. */
export function createQueue(name: string, options: { readonly valkey: ValkeyConfig; readonly prefix: string }): Queue {
  return new Queue(name, {
    connection: { ...redisOptions(options.valkey), enableOfflineQueue: false, commandTimeout: 5000 },
    prefix: options.prefix,
    defaultJobOptions: JOB_OPTIONS,
  });
}

/** Longest a relay or sweeper waits for Valkey while it holds row locks. */
export const VALKEY_TIMEOUT_MS = 5000;

/**
 * Bounds a Valkey call: BullMQ waits for the connection instead of failing while Valkey is
 * unreachable, which would keep the caller's transaction (and its row locks) open forever. On a
 * timeout the caller's transaction rolls back; a late add is harmless (deterministic job ids,
 * consumers claim in PostgreSQL).
 */
export async function withinValkeyTimeout<T>(what: string, call: Promise<T>, ms = VALKEY_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what}: Valkey did not answer within ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface JobSpec {
  readonly jobId: string;
  readonly data: JobData;
}

/**
 * Sweeper enqueue: like addBulk, but a FINISHED job with the same id (completed or failed, kept
 * for diagnostics) is removed first, so a row that still needs work is never blocked by its old
 * job. A live job (waiting, active, delayed) is left alone and the add is a no-op.
 */
export async function enqueueFresh(queue: Queue, jobs: readonly JobSpec[]): Promise<void> {
  for (let i = 0; i < jobs.length; i += 100) {
    const chunk = jobs.slice(i, i + 100);
    await withinValkeyTimeout(
      `enqueue ${queue.name}`,
      (async () => {
        await Promise.all(
          chunk.map(async ({ jobId }) => {
            const state = await queue.getJobState(jobId);
            if (state === "completed" || state === "failed") await queue.remove(jobId);
          }),
        );
        await queue.addBulk(chunk.map(({ jobId, data }) => ({ name: queue.name, data, opts: { ...JOB_OPTIONS, jobId } })));
      })(),
    );
  }
}
