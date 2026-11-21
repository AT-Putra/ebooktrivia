// The worker process (`node src/main.ts`, plan M3.5): outbox relay (every relayIntervalMs),
// consumers (BullMQ Workers), the minute sweepers and the heartbeat. Composition only: the
// behaviour lives in relay.ts, outbox-consumer.ts, conversion-fire.ts, sweepers.ts, heartbeat.ts.
//
// Ports are what later stories plug in (the worker registers nothing it cannot run):
//   outboxConsumers  waha.inbound / deliveries (US-025). Only topics listed here (and the ones
//                    the ports below add: payment.notification, template.test_send, conversion.mo, order.paid)
//                    are relayed.
//   fireConversion   a conversion fire port (tests). Without one no conversion.fire queue exists and the
//                    conversions sweeper enqueues nothing.
//   conversions      the real S2S / Meta CAPI / TikTok requests (US-024, conversions.ts). runWorker wires it
//                    when worker.env holds SECRETS_CONVERSIONS_PRIVATE_KEY (it IS the fire port, plus the sinks'
//                    dedupe policy), and then also registers the conversion.mo consumer (the MO rows); without the
//                    key it does not run and no conversion is sent (in production the worker raises a critical
//                    `conversions_disabled` alert at start).
//   orderPaidNudges  what a PAID order's effects need to be hurried along: one nudge per port that has a queue to
//                    put them on (the conversion queue, and since US-025 the delivery nudge of `deliveries`). The
//                    order.paid consumer is registered when there is at least one nudge, key or no key.
//   otp              the otp.send consumer (US-026, otp-send.ts): the messaging private key opens the
//                    sealed codes, the OtpSender sends them (since US-025 through the delivery pool). runWorker wires it
//                    when worker.env holds SECRETS_MESSAGING_PRIVATE_KEY; without it otp.send is not relayed.
//   deliveries       deliveries over WhatsApp and e-mail (US-025, delivery/index.ts): the delivery.send and delivery.send.wa
//                    consumers, the waha.inbound consumer (buyer-first), the delivery nudge, the pool's status poll and the
//                    unknown-send lookup. runWorker builds it from SECRETS_MESSAGING_PRIVATE_KEY and `magicLinks`.
//   deliverDelivery  a bare delivery.send processor (tests). Without `deliveries` or it no delivery.send queue exists
//                    and the deliveries sweeper does not run.
//   testSend         the senders of admin template test-sends (US-017, template-test-send.ts).
//                    runWorker wires the real SMTP / WAHA senders when worker.env holds
//                    SECRETS_MESSAGING_PRIVATE_KEY; without it template.test_send is not relayed.
//   payments         Midtrans access (US-021, payments.ts, reconciliation.ts): the payment.notification
//                    consumer and the nightly reconciliation loop. runWorker wires it when worker.env
//                    holds SECRETS_PAYMENT_PRIVATE_KEY (midtrans-access.ts); without it neither runs.
// The grace-end sweeper needs no port: its work is the SECURITY DEFINER SQL function
// public.create_leaderboard_snapshot (US-028, sweepers.ts), so it always runs. So does the report rollup (US-029,
// rollups.ts): every rollupIntervalMs it calls public.refresh_report_rollups, which is safe to call from every worker.
// The production entry (main.ts) passes no ports: runWorker wires the ones worker.env enables
// (template test-sends, OTPs, payments); test/support/worker-harness.ts runs this same composition with
// test ports for the chaos tests.
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
import { createQueue, enqueueFresh, JOB_RETENTION, redisOptions } from "./queues.ts";
import { relayOnce } from "./relay.ts";
import { onShutdown } from "./shutdown.ts";
import { createTemplateTestSendConsumer, type TestSender } from "./template-test-send.ts";
import { testSendFromEnv } from "./test-send-senders.ts";
import { raiseAlert, runSweeps } from "./sweepers.ts";
import { loadWorkerConfig, type WorkerConfig } from "./worker-config.ts";
import { type PaymentPort, paymentsFromEnv } from "./midtrans-access.ts";
import { createPaymentNotificationConsumer, ORDER_PAID_TOPIC, PAYMENT_TOPIC } from "./payments.ts";
import { type ConversionPort, conversionsFromEnv } from "./conversions.ts";
import { createMoConsumer, createOrderPaidConsumer, MO_TOPIC, nudgeConversions, type OrderPaidNudge } from "./conversion-outbox.ts";
import { createOtpSendConsumer, OTP_TOPIC } from "./otp-send.ts";
import { otpFromEnv, type OtpPort } from "./otp-senders.ts";
import { reconcileIfDue } from "./reconciliation.ts";
import { refreshReportRollups } from "./rollups.ts";
import { DELIVERY_QUEUE, DELIVERY_WA_QUEUE, type DeliveryPort, deliveriesFromEnv } from "./delivery/index.ts";
import { createDatabaseMagicLinks } from "./delivery/magic-links.ts";
import type { MagicLinksFactory } from "./delivery/ports.ts";

export const RELAY_BATCH = 200;
export { DELIVERY_QUEUE };

export interface WorkerPorts {
  readonly outboxConsumers?: readonly OutboxConsumer[];
  readonly fireConversion?: FireConversion;
  readonly sinkDedupesByTxid?: SinkDedupePolicy;
  /** US-024: the real conversion sinks (the fire port and the MO consumer). */
  readonly conversions?: ConversionPort;
  /** Nudges of a PAID order beyond the conversion queue's own (a later story's delivery nudge): they get the order.paid consumer. */
  readonly orderPaidNudges?: readonly OrderPaidNudge[];
  /** A bare delivery.send processor ({ id: deliveries.id }); tests. The real one is `deliveries`. */
  readonly deliverDelivery?: (data: unknown) => Promise<string>;
  /**
   * US-025: deliveries over WhatsApp and e-mail (delivery/index.ts): the delivery.send consumer, the waha.inbound consumer (buyer-first),
   * the delivery nudge of the order.paid consumer, the pool's status poll and the unknown-send lookup. runWorker wires it when worker.env
   * holds SECRETS_MESSAGING_PRIVATE_KEY.
   */
  readonly deliveries?: DeliveryPort;
  /**
   * How a player's login link is issued (delivery/ports.ts MagicLinks), as a factory over the worker's pool and the play origin (like testSend);
   * runWorker builds `deliveries` from it. Default: the database's issue_magic_link (US-026; delivery/magic-links.ts). Tests pass a fake.
   */
  readonly magicLinks?: MagicLinksFactory;
  /** US-017: the senders of template.test_send (given the worker's pool). */
  readonly testSend?: (sql: postgres.Sql) => TestSender;
  /** US-021: Midtrans re-queries (payment.notification consumer, nightly reconciliation). */
  readonly payments?: PaymentPort;
  /** US-026: the otp.send consumer's key and sender. */
  readonly otp?: OtpPort;
}

export interface RunningWorker {
  stop(): Promise<void>;
}

export async function startWorker(config: WorkerConfig, ports: WorkerPorts, log: Logger): Promise<RunningWorker> {
  const consumers = [...(ports.outboxConsumers ?? [])];
  // The order.paid nudges come from ONE list: its topic, its consumer and the nudges the consumer runs are all derived
  // from it, so they cannot disagree. One source per port that has a queue to put the effects of a PAID order on, with
  // or without the conversions key; a source makes its nudge once the queues exist.
  type NudgeSource = (queues: { readonly sql: postgres.Sql; readonly conversionQueue: Queue | undefined; readonly deliveryNudge: OrderPaidNudge | undefined }) => OrderPaidNudge;
  const conversionNudge: NudgeSource = ({ sql: pool, conversionQueue }) => {
    if (conversionQueue === undefined) throw new Error("a conversion nudge needs the conversion queue");
    return nudgeConversions(pool, conversionQueue);
  };
  // US-025: the delivery nudge is appended to the same list (never a second order.paid consumer).
  const deliveryNudge: NudgeSource = ({ deliveryNudge: nudge }) => {
    if (nudge === undefined) throw new Error("a delivery nudge needs the delivery runtime");
    return nudge;
  };
  const nudgeSources: readonly NudgeSource[] = [
    ...(ports.fireConversion === undefined && ports.conversions === undefined ? [] : [conversionNudge]),
    ...(ports.deliveries === undefined ? [] : [deliveryNudge]),
    ...(ports.orderPaidNudges ?? []).map((nudge): NudgeSource => () => nudge),
  ];
  const topics = [
    ...consumers.map((c) => c.topic),
    ...(ports.deliveries?.topics ?? []),
    ...(ports.testSend === undefined ? [] : ["template.test_send"]),
    ...(ports.payments === undefined ? [] : [PAYMENT_TOPIC]),
    ...(ports.conversions === undefined ? [] : [MO_TOPIC]),
    ...(nudgeSources.length === 0 ? [] : [ORDER_PAID_TOPIC]),
    ...(ports.otp === undefined ? [] : [OTP_TOPIC]),
  ];
  if (new Set(topics).size !== topics.length) throw new Error("two outbox consumers registered for one topic");

  // One connection per job that can run at once (each BullMQ Worker runs `concurrency` jobs, and a
  // job holds at most one connection at a time), plus the relay, sweeper and heartbeat loops and
  // one spare.
  const jobQueues = topics.length + (ports.fireConversion === undefined && ports.conversions === undefined ? 0 : 1) + (ports.deliverDelivery === undefined && ports.deliveries === undefined ? 0 : 1) + (ports.deliveries === undefined ? 0 : 1);
  const sql = postgres(config.databaseUrl, {
    ...PG_CONNECTION_OPTIONS,
    connection: { ...PG_CONNECTION_OPTIONS.connection, application_name: "ebt-worker" },
    max: jobQueues * config.concurrency + 4 + (ports.payments === undefined ? 0 : 1),
    onnotice: () => undefined,
  });
  try {
    await assertLoginRole(sql, "worker_rw", "DATABASE_URL_WORKER");
  } catch (error) {
    await sql.end({ timeout: 5 });
    throw error;
  }
  // Production without the conversions key sends nothing: say so where the Owner looks (a persisted alert), once per
  // start, and keep running (payments, deliveries and the trivia do not depend on it).
  if (config.nodeEnv === "production" && ports.conversions === undefined && ports.fireConversion === undefined) {
    await raiseAlert(sql, {
      kind: "conversions_disabled",
      severity: "critical",
      dedupeKey: "conversions_disabled",
      message: "SECRETS_CONVERSIONS_PRIVATE_KEY is not set on the worker: no adnet postback and no Meta / TikTok conversion is sent until it is",
      payload: {},
    }).catch((error: unknown) => {
      log.error({ err: error }, "the conversions_disabled alert could not be raised");
    });
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

  // The conversion queue comes first: the order.paid consumer puts jobs on it.
  const fireConversion = ports.fireConversion ?? ports.conversions?.fire(sql, log);
  const sinkDedupesByTxid = ports.sinkDedupesByTxid ?? ports.conversions?.sinkDedupesByTxid;
  const conversionQueue =
    fireConversion === undefined
      ? undefined
      : consume(
          CONVERSION_QUEUE,
          createConversionProcessor({
            sql,
            fire: fireConversion,
            failpoint,
            log,
            leaseMs: config.conversionLeaseMs,
            requestTimeoutMs: config.conversionTimeoutMs,
            ...(sinkDedupesByTxid === undefined ? {} : { sinkDedupesByTxid }),
          }),
        );
  // The delivery runtime (US-025) puts jobs on the delivery queues (a failover, the nudge), which are created below: a late binding. E-mail
  // and WhatsApp deliveries have a queue each (the same processor): WhatsApp sends wait for their number's slot and must never hold the
  // concurrency slots of the e-mail deliveries.
  const deliveryQueues: { email?: Queue | undefined; whatsapp?: Queue | undefined } = {};
  const delivery = ports.deliveries?.create({
    sql,
    log,
    enqueue: async (jobs) => {
      const { email: emailQueue, whatsapp: whatsappQueue } = deliveryQueues;
      if (emailQueue === undefined || whatsappQueue === undefined) throw new Error("the delivery queues are not up");
      const wa = jobs.filter((j) => j.channel === "whatsapp");
      const email = jobs.filter((j) => j.channel !== "whatsapp");
      if (email.length > 0) await enqueueFresh(emailQueue, email);
      if (wa.length > 0) await enqueueFresh(whatsappQueue, wa);
    },
  });
  if (delivery !== undefined) consumers.push(...delivery.outboxConsumers);
  if (ports.testSend !== undefined) consumers.push(createTemplateTestSendConsumer({ sql, sender: ports.testSend(sql) }));
  const { payments } = ports;
  if (payments !== undefined) consumers.push(createPaymentNotificationConsumer({ sql, midtrans: payments.midtrans, log, waDelayMs: payments.waDelayMs }));
  if (ports.otp !== undefined) consumers.push(createOtpSendConsumer({ sql, opener: ports.otp.opener, sender: ports.otp.sender(sql, log), log }));
  if (ports.conversions !== undefined) consumers.push(createMoConsumer());
  if (nudgeSources.length > 0) consumers.push(createOrderPaidConsumer(nudgeSources.map((make) => make({ sql, conversionQueue, deliveryNudge: delivery?.nudge }))));
  const outboxMaxAttempts = new Map(consumers.flatMap((c): [string, number][] => (c.maxAttempts === undefined ? [] : [[c.topic, c.maxAttempts]])));
  const outboxQueues = new Map<string, Queue>();
  for (const consumer of consumers) {
    outboxQueues.set(consumer.topic, consume(consumer.topic, createOutboxProcessor(consumer, { sql, failpoint, log })));
  }
  const deliverDelivery = delivery?.process ?? ports.deliverDelivery;
  const deliveryQueue = deliverDelivery === undefined ? undefined : consume(DELIVERY_QUEUE, deliverDelivery);
  deliveryQueues.email = deliveryQueue;
  const deliveryWaQueue = delivery === undefined ? undefined : consume(DELIVERY_WA_QUEUE, delivery.process);
  deliveryQueues.whatsapp = deliveryWaQueue;

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
        outboxMaxAttempts,
        outboxStaleMs: config.outboxStaleMs,
        ...(conversionQueue === undefined ? {} : { conversionQueue }),
        ...(deliveryQueue === undefined ? {} : { deliveryQueue }),
        ...(deliveryWaQueue === undefined ? {} : { deliveryWaQueue }),
        ...(delivery === undefined ? {} : { extraSweeps: delivery.sweeps }),
        ...(sinkDedupesByTxid === undefined ? {} : { sinkDedupesByTxid }),
      });
      return false;
    }),
    startLoop({ name: "report_rollups", intervalMs: config.rollupIntervalMs, log }, async () => {
      await refreshReportRollups(sql, log);
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
  for (const { name, intervalMs, tick } of delivery?.loops ?? []) loops.push(startLoop({ name, intervalMs, log }, tick));
  if (payments !== undefined) {
    // Nightly, once per WIB day across all workers (the run's claim is a row); checked every interval.
    loops.push(
      startLoop({ name: "reconciliation", intervalMs: config.reconcileIntervalMs, log }, async () => {
        await reconcileIfDue({ sql, midtrans: payments.midtrans, log, waDelayMs: payments.waDelayMs, ...(payments.clock === undefined ? {} : { clock: payments.clock }) });
        return false;
      }),
    );
  }
  log.info(
    {
      topics,
      conversions: conversionQueue !== undefined,
      conversionSinks: ports.conversions !== undefined,
      deliveries: deliveryQueue !== undefined,
      payments: payments !== undefined,
      prefix: config.prefix,
    },
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
      await Promise.all([safeFetch.close(), heartbeatFetch.close(), payments?.close?.(), ports.conversions?.close?.()]);
    },
  };
}

export async function runWorker(env: Env, ports: WorkerPorts = {}): Promise<void> {
  const config = loadWorkerConfig(env);
  const log = createLogger({ level: config.logLevel, role: "worker" });
  // Template test-sends need the messaging private key (to open the SMTP password / WAHA key), the
  // Midtrans re-queries the payment private key (to open the server key).
  const testSend = ports.testSend ?? testSendFromEnv(env, config.dev);
  const payments = ports.payments ?? paymentsFromEnv(env, config);
  // The conversions private key opens the adnet secrets and the CAPI access tokens.
  const conversions = ports.conversions ?? conversionsFromEnv(env, config);
  const otp = ports.otp ?? otpFromEnv(env, config.dev);
  if (otp === undefined) log.warn("SECRETS_MESSAGING_PRIVATE_KEY is not set: OTP login codes are not sent");
  // Code review m7: say it at start, not only through the hourly "no consumer" alert.
  if (payments === undefined) log.warn("SECRETS_PAYMENT_PRIVATE_KEY is not set: Midtrans notifications are not processed and no order can become PAID");
  if (conversions === undefined && ports.fireConversion === undefined) log.warn("SECRETS_CONVERSIONS_PRIVATE_KEY is not set: no adnet postback and no CAPI event is sent");
  // Deliveries (US-025) need the messaging key (the SMTP password and the WAHA keys) and the payment key (the signed download URLs); the
  // player's login link is issued by the database (US-026's issue_magic_link, delivery/magic-links.ts) unless a test passes its own.
  // Without the keys nothing is delivered, and the worker says so.
  const deliveries = ports.deliveries ?? deliveriesFromEnv(env, config, ports.magicLinks ?? createDatabaseMagicLinks);
  if (deliveries === undefined && ports.deliverDelivery === undefined) log.warn("deliveries are off: SECRETS_MESSAGING_PRIVATE_KEY is not set; no ebook is sent by WhatsApp or e-mail");
  const running = await startWorker(
    config,
    {
      ...ports,
      ...(testSend === undefined ? {} : { testSend }),
      ...(payments === undefined ? {} : { payments }),
      ...(conversions === undefined ? {} : { conversions }),
      ...(otp === undefined ? {} : { otp }),
      ...(deliveries === undefined ? {} : { deliveries }),
    },
    log,
  );
  onShutdown(() => running.stop(), log);
}
