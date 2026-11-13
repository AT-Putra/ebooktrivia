// The worker process (`node src/main.ts`, plan M3.5): outbox relay (every relayIntervalMs),
// consumers (BullMQ Workers), the minute sweepers and the heartbeat. Composition only: the
// behaviour lives in relay.ts, outbox-consumer.ts, conversion-fire.ts, sweepers.ts, heartbeat.ts.
//
// Ports are what later stories plug in (the worker registers nothing it cannot run):
//   outboxConsumers  payment.notification (US-021), conversion attribution of conversion.mo
//                    (US-024), otp.send / waha.inbound / deliveries (US-025). Only topics listed
//                    here are relayed.
//   fireConversion   the real S2S / CAPI requests (US-024). Without it no conversion.fire queue
//                    exists and the conversions sweeper enqueues nothing.
//   deliverDelivery  the delivery consumer (US-025). Without it no delivery.send queue exists and
//                    the deliveries sweeper does not run.
//   graceEnd         finalize / snapshot / winners (US-028), run before a program moves to
//                    awaiting_confirmation. Without it the grace-end sweeper does not run: the worker
//                    cannot move a program back, so it never ends a grace period it cannot finish.
// The production entry (main.ts) passes no ports yet; test/support/worker-harness.ts runs this
// same composition with test ports for the chaos tests.
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import { type Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import postgres from "postgres";
import { CONVERSION_QUEUE, createConversionProcessor, type FireConversion, type SinkDedupePolicy } from "./conversion-fire.ts";
import type { Env } from "./env.ts";
import { createFailpoint } from "./failpoint.ts";
import { createWorkerFetches } from "./fetches.ts";
import { beat } from "./heartbeat.ts";
import { createLogger, type Logger } from "./log.ts";
import { assertLoginRole } from "./login-role.ts";
import { type Loop, startLoop } from "./loop.ts";
import { createOutboxProcessor, type OutboxConsumer } from "./outbox-consumer.ts";
import { createQueue, JOB_RETENTION, redisOptions } from "./queues.ts";
import { relayOnce } from "./relay.ts";
import { onShutdown } from "./shutdown.ts";
import { type GraceEndHook, runSweeps } from "./sweepers.ts";
import { loadWorkerConfig, type WorkerConfig } from "./worker-config.ts";

export const RELAY_BATCH = 200;
export const DELIVERY_QUEUE = "delivery.send";

export interface WorkerPorts {
  readonly outboxConsumers?: readonly OutboxConsumer[];
  readonly fireConversion?: FireConversion;
  readonly sinkDedupesByTxid?: SinkDedupePolicy;
  /** US-025: processes one delivery.send job ({ id: deliveries.id }); claim and lease per core delivery-machine. */
  readonly deliverDelivery?: (data: unknown) => Promise<string>;
  readonly graceEnd?: GraceEndHook;
}

export interface RunningWorker {
  stop(): Promise<void>;
}

export async function startWorker(config: WorkerConfig, ports: WorkerPorts, log: Logger): Promise<RunningWorker> {
  const consumers = ports.outboxConsumers ?? [];
  const topics = consumers.map((c) => c.topic);
  if (new Set(topics).size !== topics.length) throw new Error("two outbox consumers registered for one topic");

  // One connection per job that can run at once (each BullMQ Worker runs `concurrency` jobs, and a
  // job holds at most one connection at a time), plus the relay, sweeper and heartbeat loops and
  // one spare.
  const jobQueues = consumers.length + (ports.fireConversion === undefined ? 0 : 1) + (ports.deliverDelivery === undefined ? 0 : 1);
  const sql = postgres(config.databaseUrl, {
    ...PG_CONNECTION_OPTIONS,
    connection: { ...PG_CONNECTION_OPTIONS.connection, application_name: "ebt-worker" },
    max: jobQueues * config.concurrency + 4,
    onnotice: () => undefined,
  });
  try {
    await assertLoginRole(sql, "worker_rw", "DATABASE_URL_WORKER");
  } catch (error) {
    await sql.end({ timeout: 5 });
    throw error;
  }
  const failpoint = createFailpoint(config);
  // safeFetch: strict, for the consumers of later stories. heartbeatFetch: may reach the Kuma host.
  const { safeFetch, heartbeatFetch } = createWorkerFetches(config);
  const redis = new Redis({ ...redisOptions(config.valkey), maxRetriesPerRequest: 1, commandTimeout: 2000, lazyConnect: true });
  redis.on("error", (err: Error) => {
    log.warn({ err }, "valkey health connection error");
  });

  const queueOptions = { valkey: config.valkey, prefix: config.prefix };
  const workers: Worker[] = [];
  const queues: Queue[] = [];
  const consume = (name: string, process: (data: unknown) => Promise<string>): Queue => {
    const queue = createQueue(name, queueOptions);
    queue.on("error", (err) => {
      log.warn({ queue: name, err }, "queue connection error");
    });
    const worker = new Worker(name, (job) => process(job.data), {
      connection: redisOptions(config.valkey),
      prefix: config.prefix,
      concurrency: config.concurrency,
      lockDuration: config.lockDurationMs,
      stalledInterval: config.stalledIntervalMs,
      ...JOB_RETENTION,
    });
    worker.on("error", (err) => {
      log.warn({ queue: name, err }, "worker connection error");
    });
    worker.on("failed", (job, err) => {
      log.warn({ queue: name, jobId: job?.id, err }, "job failed");
    });
    queues.push(queue);
    workers.push(worker);
    return queue;
  };

  const outboxQueues = new Map<string, Queue>();
  for (const consumer of consumers) {
    outboxQueues.set(consumer.topic, consume(consumer.topic, createOutboxProcessor(consumer, { sql, failpoint, log })));
  }
  const conversionQueue =
    ports.fireConversion === undefined
      ? undefined
      : consume(
          CONVERSION_QUEUE,
          createConversionProcessor({
            sql,
            fire: ports.fireConversion,
            failpoint,
            log,
            leaseMs: config.conversionLeaseMs,
            requestTimeoutMs: config.conversionTimeoutMs,
            ...(ports.sinkDedupesByTxid === undefined ? {} : { sinkDedupesByTxid: ports.sinkDedupesByTxid }),
          }),
        );
  const deliveryQueue = ports.deliverDelivery === undefined ? undefined : consume(DELIVERY_QUEUE, ports.deliverDelivery);

  const started = Date.now();
  const loops: Loop[] = [
    startLoop({ name: "relay", intervalMs: config.relayIntervalMs, log }, async () => {
      return (await relayOnce({ sql, queues: outboxQueues, batchSize: RELAY_BATCH, failpoint })) === RELAY_BATCH;
    }),
    startLoop({ name: "sweepers", intervalMs: config.sweepIntervalMs, log }, async () => {
      await runSweeps({
        sql,
        log,
        outboxQueues,
        outboxStaleMs: config.outboxStaleMs,
        ...(ports.graceEnd === undefined ? {} : { graceEnd: ports.graceEnd }),
        ...(conversionQueue === undefined ? {} : { conversionQueue }),
        ...(deliveryQueue === undefined ? {} : { deliveryQueue }),
        ...(ports.sinkDedupesByTxid === undefined ? {} : { sinkDedupesByTxid: ports.sinkDedupesByTxid }),
      });
      return false;
    }),
    startLoop({ name: "heartbeat", intervalMs: config.heartbeatIntervalMs, log }, async () => {
      await beat({
        sql,
        ping: () => redis.ping(),
        push: config.uptimeKuma === undefined ? undefined : { fetch: heartbeatFetch, url: config.uptimeKuma.pushUrl },
        log,
        info: () => ({ pid: process.pid, uptimeS: Math.round((Date.now() - started) / 1000), topics }),
      });
      return false;
    }),
  ];
  log.info(
    { topics, conversions: conversionQueue !== undefined, deliveries: deliveryQueue !== undefined, graceEnd: ports.graceEnd !== undefined, prefix: config.prefix },
    "worker started",
  );

  return {
    stop: async () => {
      await Promise.all(loops.map((l) => l.stop()));
      // Graceful close waits for the jobs in flight; BullMQ cannot finish that while Valkey is
      // unreachable, so then close at once (claims and leases in PostgreSQL cover those jobs).
      const valkeyUp = await redis.ping().then(
        () => true,
        () => false,
      );
      if (!valkeyUp) log.warn("Valkey unreachable at shutdown: closing consumers without waiting for jobs in flight");
      await Promise.all(workers.map((w) => w.close(!valkeyUp)));
      await Promise.all(queues.map((q) => q.close()));
      redis.disconnect();
      await sql.end({ timeout: 5 });
      await Promise.all([safeFetch.close(), heartbeatFetch.close()]);
    },
  };
}

export async function runWorker(env: Env, ports: WorkerPorts = {}): Promise<void> {
  const config = loadWorkerConfig(env);
  const log = createLogger({ level: config.logLevel, role: "worker" });
  const running = await startWorker(config, ports, log);
  onShutdown(() => running.stop(), log);
}
