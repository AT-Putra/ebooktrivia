// AC 2: the minute sweepers. Each one is idempotent and safe to run concurrently in two worker
// processes (SKIP LOCKED or conditional UPDATEs); they run as worker_rw, so the grants and the
// guard triggers (orders_status_guard, programs_status_guard) are exercised too.
import { NEEDS_MANUAL_REFIRE } from "@ebooktrivia/core";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import { type Queue, Worker } from "bullmq";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { createLogger } from "../src/log.ts";
import { OUTBOX_MAX_ATTEMPTS } from "../src/outbox-consumer.ts";
import { createQueue, JOB_OPTIONS, redisOptions } from "../src/queues.ts";
import {
  endGracePeriods,
  expireLeases,
  expireOrders,
  ORDER_EXPIRY,
  OUTBOX_UNRELAYED_ALERT_MS,
  runSweeps,
  sweepDueConversions,
  sweepDueDeliveries,
  sweepLoginThrottle,
  sweepOutbox,
} from "../src/sweepers.ts";
import { type Catalog, createCatalog, createConversionEvents, createOrders, createOutboxRows, first, letters, sql } from "./support/db.ts";
import { captureLogger } from "./support/log.ts";
import { obliterate, testValkey, uniquePrefix } from "./support/valkey.ts";

const workerSql = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 6, onnotice: () => undefined });
afterAll(async () => {
  await workerSql.end({ timeout: 5 });
});
const log = createLogger({ level: "silent", role: "worker" });

let queues: Queue[] = [];
afterEach(async () => {
  await obliterate(queues);
  queues = [];
});
function queueFor(name: string): Queue {
  const queue = createQueue(name, { valkey: testValkey(), prefix: uniquePrefix() });
  queues.push(queue);
  return queue;
}

let catalog: Catalog;
beforeAll(async () => {
  catalog = await createCatalog();
});

const noHook = (): Promise<void> => Promise.resolve();

/** Processes the next job of `queue` with a processor that throws, so it lands in the failed set. */
async function failNextJob(queue: Queue): Promise<void> {
  const worker = new Worker(queue.name, () => Promise.reject(new Error("previous attempt")), {
    connection: redisOptions(testValkey()),
    prefix: queue.opts.prefix ?? "bull",
    autorun: false,
  });
  const failed = new Promise<void>((resolve) => {
    worker.once("failed", () => {
      resolve();
    });
  });
  void worker.run();
  await failed;
  await worker.close();
}

describe("outbox sweeper", () => {
  it("re-relays relayed-but-unprocessed rows past the stale window (Valkey loss), replacing a finished job, sparing a live one", async () => {
    const topic = "test.sweep_stale";
    const queue = queueFor(topic);
    const [lost, failedJob, live, fresh, leased, crashed] = await createOutboxRows(topic, 6);
    await sql`UPDATE outbox SET relayed_at = now() - interval '10 minutes' WHERE id = ANY(${[lost, failedJob, live, leased, crashed] as string[]}::uuid[])`;
    // crashed: a claim (attempt 1) whose process died; its lease is over, its job may look active.
    await sql`UPDATE outbox SET attempts = 1, available_at = now() - interval '1 second' WHERE id = ${crashed ?? ""}`;
    await sql`UPDATE outbox SET relayed_at = now() WHERE id = ${fresh ?? ""}`;
    await sql`UPDATE outbox SET attempts = 1, available_at = now() + interval '1 minute' WHERE id = ${leased ?? ""}`;
    // failedJob's previous job failed and is kept for diagnostics; live's job is still waiting.
    await queue.add(topic, { id: failedJob }, { ...JOB_OPTIONS, jobId: failedJob as string });
    await failNextJob(queue);
    expect(await queue.getJobState(failedJob as string)).toBe("failed");
    await queue.add(topic, { id: live }, { jobId: live as string, delay: 60_000 });

    const result = await sweepOutbox({ sql: workerSql, log, outboxQueues: new Map([[topic, queue]]), outboxStaleMs: 120_000 });
    expect(result.rerelayed).toBe(4);
    expect(await queue.getJobState(`${crashed as string}-1`)).toBe("waiting");
    expect(await queue.getJobState(lost as string)).toBe("waiting");
    expect(await queue.getJobState(failedJob as string)).toBe("waiting");
    expect(await queue.getJobState(live as string)).toBe("delayed");
    expect(await queue.getJobState(fresh as string)).toBe("unknown");
    expect(await queue.getJobState(leased as string)).toBe("unknown");
    const relayed = await sql<{ id: string; recent: boolean }[]>`
      SELECT id, relayed_at > now() - interval '1 minute' AS recent FROM outbox WHERE id = ANY(${[lost, failedJob, live, leased] as string[]}::uuid[])`;
    expect(Object.fromEntries(relayed.map((r) => [r.id, r.recent]))).toEqual({
      [lost as string]: true,
      [failedJob as string]: true,
      [live as string]: true,
      [leased as string]: false,
    });
  });

  it("alerts once per topic on rows nobody consumes and on rows at the attempt cap", async () => {
    const orphanTopic = `test.orphan_${letters()}`;
    const stuckTopic = `test.stuck_${letters()}`;
    const old = new Date(Date.now() - OUTBOX_UNRELAYED_ALERT_MS - 60_000);
    await createOutboxRows(orphanTopic, 2, { availableAt: old });
    await createOutboxRows(`test.orphan_recent_${letters()}`, 1);
    const [stuck] = await createOutboxRows(stuckTopic, 1);
    await sql`UPDATE outbox SET attempts = ${OUTBOX_MAX_ATTEMPTS}, relayed_at = now() - interval '1 hour', last_error = 'boom' WHERE id = ${stuck ?? ""}`;
    const stuckQueue = queueFor(stuckTopic);
    const deps = { sql: workerSql, log, outboxQueues: new Map([[stuckTopic, stuckQueue]]), outboxStaleMs: 120_000 };

    await Promise.all([sweepOutbox(deps), sweepOutbox(deps)]);
    await sweepOutbox(deps);
    const alerts = await sql<{ kind: string; source: string; severity: string; dedupe_key: string; payload: { topic: string; count: number } }[]>`
      SELECT kind, source, severity, dedupe_key, payload FROM alerts
       WHERE dedupe_key IN (${`outbox_unrelayed:${orphanTopic}`}, ${`outbox_stuck:${stuckTopic}`}) ORDER BY kind`;
    expect(alerts).toEqual([
      { kind: "outbox_stuck", source: "worker", severity: "critical", dedupe_key: `outbox_stuck:${stuckTopic}`, payload: { topic: stuckTopic, count: 1 } },
      { kind: "outbox_unrelayed", source: "worker", severity: "warning", dedupe_key: `outbox_unrelayed:${orphanTopic}`, payload: { topic: orphanTopic, count: 2 } },
    ]);
    expect(await stuckQueue.getJobState(stuck as string)).toBe("unknown");
  });
});

describe("due sweepers (conversions, deliveries)", () => {
  it("enqueues due pending conversion events with one deterministic job per (event, attempt)", async () => {
    const queue = queueFor("conversion.fire");
    const orders = await createOrders(catalog, 4);
    const [due0] = await createConversionEvents([orders[0] as string]);
    const [due2] = await createConversionEvents([orders[1] as string], { attempts: 2 });
    await createConversionEvents([orders[2] as string], { nextAttemptAt: new Date(Date.now() + 60_000) });
    await createConversionEvents([orders[3] as string], { status: "sent", attempts: 1 });

    const deps = { sql: workerSql, log, conversionQueue: queue };
    await Promise.all([sweepDueConversions(deps), sweepDueConversions(deps)]);
    // Other files' events may be due too (one shared database): look at this test's events only.
    const jobs = (await queue.getJobs(["waiting"])).filter((j) => [due0, due2].includes((j.data as { id: string }).id));
    expect(jobs.map((j) => j.id).sort()).toEqual([`${due0 as string}-0`, `${due2 as string}-2`].sort());
    const ours = new Set(orders);
    const enqueued = await sql<{ order_id: string }[]>`
      SELECT order_id FROM conversion_events WHERE id = ANY(${(await queue.getJobs(["waiting"])).map((j) => (j.data as { id: string }).id)}::uuid[])`;
    expect(enqueued.filter((r) => ours.has(r.order_id))).toHaveLength(2);
    expect(await sweepDueConversions({ sql: workerSql, log })).toBe(0);
  });

  it("enqueues due pending deliveries (not_before passed) once per attempt", async () => {
    const queue = queueFor("delivery.send");
    const [a, b, c] = await createOrders(catalog, 3);
    const rows = await sql<{ id: string }[]>`
      INSERT INTO deliveries (order_id, channel, status, not_before, attempts) VALUES
        (${a ?? ""}, 'email', 'pending', now() - interval '1 second', 1),
        (${b ?? ""}, 'email', 'pending', now() + interval '1 hour', 0),
        (${c ?? ""}, 'email', 'sent', now() - interval '1 second', 1)
      RETURNING id`;
    expect(await sweepDueDeliveries({ sql: workerSql, log, deliveryQueue: queue })).toBe(1);
    expect((await queue.getJobs(["waiting"])).map((j) => j.id)).toEqual([`${rows[0]?.id ?? ""}-1`]);
    expect(await sweepDueDeliveries({ sql: workerSql, log })).toBe(0);
  });
});

describe("order expiry sweeper", () => {
  it("moves pending orders past expires_at to expired, once, and nothing else", async () => {
    const past = new Date(Date.now() - 60_000);
    const expiring = await createOrders(catalog, 3, { status: "pending", expiresAt: past });
    const [notYet] = await createOrders(catalog, 1, { status: "pending" });
    const [paid] = await createOrders(catalog, 1, { status: "paid", expiresAt: past });
    const counts = await Promise.all([expireOrders(workerSql), expireOrders(workerSql)]);
    expect(counts[0] + counts[1]).toBeGreaterThanOrEqual(3);
    const rows = await sql<{ id: string; status: string }[]>`
      SELECT id, status::text FROM orders WHERE id = ANY(${[...expiring, notYet, paid] as string[]}::uuid[])`;
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    for (const id of expiring) expect(status[id]).toBe("expired");
    expect(status[notYet as string]).toBe("pending");
    expect(status[paid as string]).toBe("paid");
    // The rule is core's order machine (code review US-013 #9), not a status hardcoded here.
    expect([...ORDER_EXPIRY]).toEqual([["pending", "expired"]]);
  });
});

describe("grace-end sweeper", () => {
  it("moves a published program past sales_end_at + grace_days to awaiting_confirmation, after the US-028 hook, once", async () => {
    const ended = await createCatalog({ salesEndAt: new Date(Date.now() - 3 * 86_400_000), graceDays: 2 });
    const inGrace = await createCatalog({ salesEndAt: new Date(Date.now() - 86_400_000), graceDays: 2 });
    const draft = await createCatalog({ salesEndAt: new Date(Date.now() - 10 * 86_400_000), graceDays: 1, status: "draft" });
    const calls: { programId: string; statusInTx: string }[] = [];
    const hook = async (tx: postgres.TransactionSql, program: { programId: string; graceEndedAt: Date }) => {
      const [row] = await tx<{ status: string }[]>`SELECT status::text FROM public.programs WHERE id = ${program.programId}`;
      calls.push({ programId: program.programId, statusInTx: row?.status ?? "" });
      expect(program.graceEndedAt.getTime()).toBeLessThan(Date.now());
    };
    await Promise.all([endGracePeriods(workerSql, hook, log), endGracePeriods(workerSql, hook, log)]);
    await endGracePeriods(workerSql, hook, log);
    expect(calls.filter((c) => c.programId === ended.programId)).toEqual([{ programId: ended.programId, statusInTx: "published" }]);
    const rows = await sql<{ id: string; status: string }[]>`
      SELECT id, status::text FROM programs WHERE id IN (${ended.programId}, ${inGrace.programId}, ${draft.programId})`;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [ended.programId]: "awaiting_confirmation",
      [inGrace.programId]: "published",
      [draft.programId]: "draft",
    });
  });

  // Code review US-013 #4: one failing program must not hold back the programs after it.
  it("keeps a program whose hook fails published (one transaction), alerts once, and still ends the next ones", async () => {
    const failing = await createCatalog({ salesEndAt: new Date(Date.now() - 4 * 86_400_000), graceDays: 1 });
    const next = await createCatalog({ salesEndAt: new Date(Date.now() - 3 * 86_400_000), graceDays: 1 });
    const hook = (_tx: postgres.TransactionSql, program: { programId: string }) =>
      program.programId === failing.programId ? Promise.reject(new Error("snapshot failed")) : noHook();
    const captured = captureLogger();
    expect(await endGracePeriods(workerSql, hook, captured.log)).toBeGreaterThanOrEqual(1);
    await endGracePeriods(workerSql, hook, captured.log);
    const status = async (programId: string) => first(await sql<{ status: string }[]>`SELECT status::text FROM programs WHERE id = ${programId}`).status;
    expect(await status(failing.programId)).toBe("published");
    expect(await status(next.programId)).toBe("awaiting_confirmation");
    expect(captured.lines.filter((l) => l["programId"] === failing.programId && l["level"] === 50)).toHaveLength(2);
    const alerts = await sql<{ kind: string; severity: string }[]>`
      SELECT kind, severity FROM alerts WHERE dedupe_key = ${`grace_end_failed:${failing.programId}`}`;
    expect(alerts).toEqual([{ kind: "grace_end_failed", severity: "critical" }]);
    await endGracePeriods(workerSql, noHook, captured.log);
    expect(await status(failing.programId)).toBe("awaiting_confirmation");
  });
});

describe("lease expiry sweeper", () => {
  it("applies core expireConversionLease and expireDeliveryLease to sending rows whose lease ran out", async () => {
    const orders = await createOrders(catalog, 4);
    const [expiredConv] = await createConversionEvents([orders[0] as string], {
      status: "sending",
      attempts: 1,
      leaseUntil: new Date(Date.now() - 1000),
    });
    const [activeConv] = await createConversionEvents([orders[1] as string], {
      status: "sending",
      attempts: 1,
      leaseUntil: new Date(Date.now() + 60_000),
    });
    const deliveries = await sql<{ id: string }[]>`
      INSERT INTO deliveries (order_id, channel, status, lease_until, attempts) VALUES
        (${orders[2] ?? ""}, 'email', 'sending', now() - interval '1 second', 1),
        (${orders[3] ?? ""}, 'email', 'sending', now() + interval '1 minute', 1)
      RETURNING id`;
    const results = await Promise.all([expireLeases(workerSql), expireLeases(workerSql)]);
    expect(results.reduce((n, r) => n + r.conversions, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.deliveries, 0)).toBe(1);

    const conv = await sql<{ id: string; status: string; last_error: string | null }[]>`
      SELECT id, status::text, last_error FROM conversion_events WHERE id IN (${expiredConv ?? ""}, ${activeConv ?? ""})`;
    const byId = Object.fromEntries(conv.map((r) => [r.id, r]));
    expect(byId[expiredConv as string]?.status).toBe("failed");
    expect(byId[expiredConv as string]?.last_error?.startsWith(NEEDS_MANUAL_REFIRE)).toBe(true);
    expect(byId[activeConv as string]?.status).toBe("sending");
    const del = await sql<{ id: string; status: string }[]>`
      SELECT id, status::text FROM deliveries WHERE id = ANY(${deliveries.map((d) => d.id)}::uuid[])`;
    expect(Object.fromEntries(del.map((r) => [r.id, r.status]))).toEqual({ [deliveries[0]?.id ?? ""]: "unknown", [deliveries[1]?.id ?? ""]: "sending" });

    // A sink that dedupes by txid gets an automatic retry instead.
    const [dedupes] = await createConversionEvents(await createOrders(catalog, 1), {
      status: "sending",
      attempts: 1,
      leaseUntil: new Date(Date.now() - 1000),
    });
    await expireLeases(workerSql, () => true);
    expect(first(await sql<{ status: string }[]>`SELECT status::text FROM conversion_events WHERE id = ${dedupes ?? ""}`).status).toBe("pending");
  });
});

describe("admin login throttle sweeper (US-016)", () => {
  it("deletes spent rows only: an active window, an active lock, consecutive failures and a hard lock stay", async () => {
    const key = () => `${letters()}${letters()}`.replace(/[g-z]/g, "e").padEnd(64, "0");
    const keys = { spent: key(), lockSpent: key(), window: key(), locked: key(), consecutive: key(), hard: key() };
    await sql`
      INSERT INTO admin_auth.login_throttle (key, failures, window_started_at, locked_until, consecutive, hard_locked_at) VALUES
        (${keys.spent}, 3, now() - interval '16 minutes', NULL, 0, NULL),
        (${keys.lockSpent}, 5, now() - interval '40 minutes', now() - interval '1 minute', 0, NULL),
        (${keys.window}, 2, now() - interval '5 minutes', NULL, 0, NULL),
        (${keys.locked}, 5, now() - interval '20 minutes', now() + interval '5 minutes', 0, NULL),
        (${keys.consecutive}, 1, now() - interval '30 minutes', NULL, 7, NULL),
        (${keys.hard}, 5, now() - interval '3 days', now() - interval '2 days', 20, now() - interval '2 days')`;
    expect(await sweepLoginThrottle(workerSql)).toBeGreaterThanOrEqual(2);
    const left = await sql<{ key: string }[]>`SELECT key FROM admin_auth.login_throttle WHERE key = ANY(${Object.values(keys)})`;
    expect(left.map((r) => r.key).sort()).toEqual([keys.window, keys.locked, keys.consecutive, keys.hard].sort());
  });

  it("refuses a window shorter than 15 minutes, so live windows are never swept (ET070)", async () => {
    for (const window of [0, 60, 899, 86_401]) {
      const error = await sweepLoginThrottle(workerSql, window).then(
        () => null,
        (e: unknown) => e,
      );
      expect((error as postgres.PostgresError).code, String(window)).toBe("ET070");
    }
  });

  it("is the worker's only access to admin_auth", async () => {
    const denied = await workerSql`SELECT 1 FROM admin_auth.login_throttle LIMIT 1`.then(
      () => null,
      (e: unknown) => e,
    );
    expect((denied as postgres.PostgresError).code).toBe("42501");
  });
});

describe("runSweeps", () => {
  it("runs every sweeper and keeps going when one fails", async () => {
    const [orderId] = await createOrders(catalog, 1, { status: "pending", expiresAt: new Date(Date.now() - 1000) });
    const captured = captureLogger("debug");
    const broken = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice: () => undefined });
    await broken.end();
    await runSweeps({ sql: broken, log: captured.log, outboxQueues: new Map(), outboxStaleMs: 120_000 });
    expect(captured.lines.filter((l) => l["level"] === 50).map((l) => l["sweeper"])).toEqual(["lease_expiry", "outbox", "order_expiry", "login_throttle"]);
    await runSweeps({ sql: workerSql, log: captured.log, outboxQueues: new Map(), outboxStaleMs: 120_000 });
    expect(first(await sql<{ status: string }[]>`SELECT status::text FROM orders WHERE id = ${orderId ?? ""}`).status).toBe("expired");
  });

  // Code review US-013 #1: a sweeper whose work needs a port does not run without it.
  it("runs grace_end, due_conversions and due_deliveries only when their port is registered", async () => {
    const ended = await createCatalog({ salesEndAt: new Date(Date.now() - 3 * 86_400_000), graceDays: 1 });
    const captured = captureLogger("debug");
    await runSweeps({ sql: workerSql, log: captured.log, outboxQueues: new Map(), outboxStaleMs: 120_000 });
    expect(captured.lines.filter((l) => l["msg"] === "sweep done").map((l) => l["sweeper"])).toEqual(["lease_expiry", "outbox", "order_expiry", "login_throttle"]);
    expect(first(await sql<{ status: string }[]>`SELECT status::text FROM programs WHERE id = ${ended.programId}`).status).toBe("published");

    const withPorts = captureLogger("debug");
    await runSweeps({
      sql: workerSql,
      log: withPorts.log,
      outboxQueues: new Map(),
      outboxStaleMs: 120_000,
      graceEnd: noHook,
      conversionQueue: queueFor("conversion.fire"),
      deliveryQueue: queueFor("delivery.send"),
    });
    expect(withPorts.lines.filter((l) => l["msg"] === "sweep done").map((l) => l["sweeper"])).toEqual([
      "lease_expiry",
      "outbox",
      "due_conversions",
      "due_deliveries",
      "order_expiry",
      "grace_end",
      "login_throttle",
    ]);
    expect(first(await sql<{ status: string }[]>`SELECT status::text FROM programs WHERE id = ${ended.programId}`).status).toBe("awaiting_confirmation");
  });
});
