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
  alertNoPaymentMethods,
  endGracePeriods,
  expireLeases,
  expireOrders,
  failStaleSnapCreates,
  ORDER_EXPIRY,
  OUTBOX_UNRELAYED_ALERT_MS,
  pruneStrangerContacts,
  runSweeps,
  sweepDueConversions,
  sweepDueDeliveries,
  sweepLoginThrottle,
  sweepOutbox,
} from "../src/sweepers.ts";
import { type Catalog, createCatalog, createConversionEvents, createOrders, createOutboxRows, first, letters, sql, suffix } from "./support/db.ts";
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

/** SQLSTATE of the error `p` rejects with (throws if it resolves). */
async function sqlStateOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  throw new Error("expected the statement to fail");
}

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

describe("stale Snap create sweeper (US-020 crash window)", () => {
  /** A pending order without a URL whose attempt `n` started `ageMs` ago (n = 0: no attempt row). */
  async function orderWithAttempt(n: number, ageMs: number, url: string | null = null): Promise<string> {
    const [id] = await createOrders(catalog, 1, { status: "pending" });
    const orderId = id as string;
    await sql`UPDATE orders SET snap_attempt_count = ${n}, snap_redirect_url = ${url}, created_at = ${new Date(Date.now() - ageMs)} WHERE id = ${orderId}`;
    for (let i = 1; i <= n; i++) {
      // midtrans_order_id is {public_id}-{n} of the order (midtrans_attempts_id_guard, ET049).
      await sql`
        INSERT INTO midtrans_attempts (order_id, n, midtrans_order_id, created_at)
        SELECT id, ${i}, public_id || '-' || ${String(i)}, ${new Date(Date.now() - (i === n ? ageMs : ageMs + 60_000))} FROM orders WHERE id = ${orderId}`;
    }
    return orderId;
  }
  const statusOf = async (id: string): Promise<string> => first(await sql<{ status: string }[]>`SELECT status::text FROM orders WHERE id = ${id}`).status;

  it("marks a pending order still without a URL 60 s after its latest attempt as snap_create_failed, once", async () => {
    const stale = await orderWithAttempt(2, 61_000);
    const noAttempt = await orderWithAttempt(0, 61_000);
    const fresh = await orderWithAttempt(2, 20_000);
    const withUrl = await orderWithAttempt(1, 120_000, "https://app.sandbox.midtrans.com/snap/v4/redirection/z");
    const counts = await Promise.all([failStaleSnapCreates(workerSql), failStaleSnapCreates(workerSql)]);
    expect(counts[0] + counts[1]).toBeGreaterThanOrEqual(2);
    expect(await statusOf(stale)).toBe("snap_create_failed");
    expect(await statusOf(noAttempt)).toBe("snap_create_failed");
    // The latest attempt counts, not the order's age: a retry started 20 s ago is still in flight.
    expect(await statusOf(fresh)).toBe("pending");
    expect(await statusOf(withUrl)).toBe("pending");
    expect(await failStaleSnapCreates(workerSql)).toBe(0);
    // Every attempt row is kept for reconciliation (US-021).
    expect(first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM midtrans_attempts WHERE order_id = ${stale}`).n).toBe(2);
  });
});

describe("grace-end sweeper (US-028: public.create_leaderboard_snapshot)", () => {
  const DAY = 86_400_000;
  const status = async (programId: string) => first(await sql<{ status: string }[]>`SELECT status::text FROM programs WHERE id = ${programId}`).status;
  const snapshots = async (programId: string) => (await sql`SELECT 1 FROM leaderboard_snapshots WHERE program_id = ${programId}`).length;
  /** An eligible player of the program (a roster entry, so the finalize writes a stats row for it). */
  async function eligiblePlayer(programId: string): Promise<string> {
    const player = first(await sql<{ id: string }[]>`INSERT INTO players (phone, name) VALUES (${`+62815${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`}, 'Pemain') RETURNING id`);
    await sql`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${player.id}, ${programId}, now() - interval '20 days', true)`;
    return player.id;
  }

  it("snapshots each published program GRACE_END_SETTLE_MS past its grace end exactly once, also with two workers at once", async () => {
    const ended = await createCatalog({ salesEndAt: new Date(Date.now() - 3 * DAY), graceDays: 2 });
    await eligiblePlayer(ended.programId);
    const settling = await createCatalog({ salesEndAt: new Date(Date.now() - 2 * DAY - 20_000), graceDays: 2 });
    const inGrace = await createCatalog({ salesEndAt: new Date(Date.now() - DAY), graceDays: 2 });
    const draft = await createCatalog({ salesEndAt: new Date(Date.now() - 10 * DAY), graceDays: 1, status: "draft" });
    const captured = captureLogger("info");
    await Promise.all([endGracePeriods(workerSql, captured.log), endGracePeriods(workerSql, captured.log)]);
    await endGracePeriods(workerSql, captured.log);
    expect(await snapshots(ended.programId)).toBe(1);
    expect(captured.lines.filter((l) => l["programId"] === ended.programId && l["msg"] === "grace period ended: results snapshot written")).toHaveLength(1);
    expect(first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'contest.snapshot' AND entity_id = ${ended.programId}`).n).toBe(1);
    expect(first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM player_program_stats WHERE program_id = ${ended.programId}`).n).toBe(1);
    expect({ ended: await status(ended.programId), settling: await status(settling.programId), inGrace: await status(inGrace.programId), draft: await status(draft.programId) }).toEqual({
      ended: "awaiting_confirmation",
      settling: "published",
      inGrace: "published",
      draft: "draft",
    });
    expect(await snapshots(settling.programId)).toBe(0);
    // worker_rw writes no snapshot or program status itself.
    expect(await sqlStateOf(workerSql`INSERT INTO public.leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${inGrace.programId}, now(), '[]')`)).toBe("42501");
    expect(await sqlStateOf(workerSql`UPDATE public.programs SET status = 'awaiting_confirmation' WHERE id = ${inGrace.programId}`)).toBe("42501");
  });

  it("skips a program whose contest lock stays busy (no alert), and snapshots it on the next sweep", async () => {
    const busy = await createCatalog({ salesEndAt: new Date(Date.now() - 4 * DAY), graceDays: 1 });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = (): void => undefined;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = sql.begin(async (tx) => {
      await tx`SELECT public.lock_program_contest(${busy.programId})`;
      held();
      await gate;
    });
    await holding;
    const captured = captureLogger("info");
    try {
      await endGracePeriods(workerSql, captured.log);
    } finally {
      release();
      await holder;
    }
    expect(captured.lines.filter((l) => l["programId"] === busy.programId).map((l) => [l["msg"], l["code"]])).toEqual([["grace-end skipped; the next sweep looks again", "55P03"]]);
    expect(await sql`SELECT 1 FROM alerts WHERE dedupe_key = ${`grace_end_failed:${busy.programId}`}`).toHaveLength(0);
    expect(await status(busy.programId)).toBe("published");
    await endGracePeriods(workerSql, captured.log);
    expect(await status(busy.programId)).toBe("awaiting_confirmation");
  });

  // Code review US-013 #4: one failing program must not hold back the programs after it.
  it("keeps a program whose snapshot fails published (one transaction), alerts once, and still ends the next ones", async () => {
    const failing = await createCatalog({ salesEndAt: new Date(Date.now() - 6 * DAY), graceDays: 1 });
    await eligiblePlayer(failing.programId);
    const next = await createCatalog({ salesEndAt: new Date(Date.now() - 5 * DAY), graceDays: 1 });
    // A failure inside the function for this program only: its stats row cannot be written.
    const constraint = `test_fail_${failing.programId.replaceAll("-", "")}`;
    await sql.unsafe(`ALTER TABLE player_program_stats ADD CONSTRAINT ${constraint} CHECK (program_id <> '${failing.programId}') NOT VALID`);
    const captured = captureLogger();
    try {
      expect(await endGracePeriods(workerSql, captured.log)).toBeGreaterThanOrEqual(1);
      await endGracePeriods(workerSql, captured.log);
    } finally {
      await sql.unsafe(`ALTER TABLE player_program_stats DROP CONSTRAINT ${constraint}`);
    }
    expect(await status(failing.programId)).toBe("published");
    expect(await snapshots(failing.programId)).toBe(0);
    expect(await status(next.programId)).toBe("awaiting_confirmation");
    expect(captured.lines.filter((l) => l["programId"] === failing.programId && l["level"] === 50)).toHaveLength(2);
    const alerts = await sql<{ kind: string; severity: string }[]>`
      SELECT kind, severity FROM alerts WHERE dedupe_key = ${`grace_end_failed:${failing.programId}`}`;
    expect(alerts).toEqual([{ kind: "grace_end_failed", severity: "critical" }]);
    await endGracePeriods(workerSql, captured.log);
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
    // The database is shared with the other test files (which may leave a lease that ran out): the counts are at least this test's own rows, and the rows
    // below say exactly which were expired.
    expect(results.reduce((n, r) => n + r.conversions, 0)).toBeGreaterThanOrEqual(1);
    expect(results.reduce((n, r) => n + r.deliveries, 0)).toBeGreaterThanOrEqual(1);

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
    // 16 random hex characters (mapping letters g-z to "e" made two of these six keys collide ~10% of runs).
    const key = () => `${suffix()}${suffix()}`.padEnd(64, "0");
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
    expect(captured.lines.filter((l) => l["level"] === 50).map((l) => l["sweeper"])).toEqual(["lease_expiry", "outbox", "snap_create", "order_expiry", "grace_end", "login_throttle", "otp_expiry", "payment_methods", "wa_contacts_retention"]);
    await runSweeps({ sql: workerSql, log: captured.log, outboxQueues: new Map(), outboxStaleMs: 120_000 });
    expect(first(await sql<{ status: string }[]>`SELECT status::text FROM orders WHERE id = ${orderId ?? ""}`).status).toBe("expired");
  });

  // Code review US-013 #1: a sweeper whose work needs a port does not run without it. The grace end
  // needs none (US-028: its work is the SQL function), so it always runs.
  it("runs due_conversions and due_deliveries only when their port is registered; grace_end always", async () => {
    const ended = await createCatalog({ salesEndAt: new Date(Date.now() - 3 * 86_400_000), graceDays: 1 });
    const captured = captureLogger("debug");
    await runSweeps({ sql: workerSql, log: captured.log, outboxQueues: new Map(), outboxStaleMs: 120_000 });
    expect(captured.lines.filter((l) => l["msg"] === "sweep done").map((l) => l["sweeper"])).toEqual(["lease_expiry", "outbox", "snap_create", "order_expiry", "grace_end", "login_throttle", "otp_expiry", "payment_methods", "wa_contacts_retention"]);
    expect(first(await sql<{ status: string }[]>`SELECT status::text FROM programs WHERE id = ${ended.programId}`).status).toBe("awaiting_confirmation");

    const withPorts = captureLogger("debug");
    await runSweeps({
      sql: workerSql,
      log: withPorts.log,
      outboxQueues: new Map(),
      outboxStaleMs: 120_000,
      conversionQueue: queueFor("conversion.fire"),
      deliveryQueue: queueFor("delivery.send"),
    });
    expect(withPorts.lines.filter((l) => l["msg"] === "sweep done").map((l) => l["sweeper"])).toEqual([
      "lease_expiry",
      "outbox",
      "due_conversions",
      "due_deliveries",
      "snap_create",
      "order_expiry",
      "grace_end",
      "login_throttle",
      "otp_expiry",
      "payment_methods",
      "wa_contacts_retention",
    ]);
  });
});

describe("payment_methods (Owner D11): the checkout takes no orders while no method is enabled, and the Owner is told", () => {
  const KEY = "midtrans.enabled_methods";
  const alertRows = () => sql<{ severity: string; source: string; message: string }[]>`SELECT severity, source, message FROM alerts WHERE dedupe_key = 'checkout_no_payment_methods' AND resolved_at IS NULL`;

  it("raises ONE critical alert while the list is empty (or holds no code the system knows), none while a method is enabled, and not again within the hour", async () => {
    const [saved] = await sql<{ value: unknown }[]>`SELECT value FROM app_settings WHERE key = ${KEY}`;
    try {
      await sql`DELETE FROM alerts WHERE dedupe_key = 'checkout_no_payment_methods'`;
      expect(await alertNoPaymentMethods(workerSql)).toBe(false);
      expect(await alertRows()).toEqual([]);

      await sql`UPDATE app_settings SET value = '[]'::jsonb WHERE key = ${KEY}`;
      expect(await alertNoPaymentMethods(workerSql)).toBe(true);
      expect(await alertRows()).toEqual([{ severity: "critical", source: "worker", message: expect.stringContaining("no payment method is enabled") as unknown }]);
      // Deduped while unresolved.
      expect(await alertNoPaymentMethods(workerSql)).toBe(false);
      expect(await alertRows()).toHaveLength(1);

      // A list of codes nobody knows is "none" too (the checkout drops them).
      await sql`UPDATE alerts SET resolved_at = now() WHERE dedupe_key = 'checkout_no_payment_methods'`;
      await sql`UPDATE app_settings SET value = '["not_a_method"]'::jsonb WHERE key = ${KEY}`;
      expect(await alertNoPaymentMethods(workerSql)).toBe(true);

      await sql`UPDATE alerts SET resolved_at = now() WHERE dedupe_key = 'checkout_no_payment_methods'`;
      await sql`UPDATE app_settings SET value = '["other_qris"]'::jsonb WHERE key = ${KEY}`;
      expect(await alertNoPaymentMethods(workerSql)).toBe(false);
    } finally {
      await sql`UPDATE alerts SET resolved_at = now() WHERE dedupe_key = 'checkout_no_payment_methods' AND resolved_at IS NULL`;
      if (saved !== undefined) await sql`UPDATE app_settings SET value = ${sql.json(saved.value as postgres.JSONValue)} WHERE key = ${KEY}`;
    }
  });
});

// US-030: strangers' WhatsApp contacts (no order, no player) leave the database once unconfirmed for 7 days; a buyer's or a
// player's row stays, and so does a young stranger's.
describe("pruneStrangerContacts", () => {
  it("deletes stale stranger rows only, through prune_stranger_wa_contacts (worker_rw cannot delete wa_contacts itself)", async () => {
    const [orderId] = await createOrders(catalog, 1, { status: "paid" });
    const { buyer_phone: buyer } = first(await sql<{ buyer_phone: string }[]>`SELECT buyer_phone FROM orders WHERE id = ${orderId ?? ""}`);
    const digits = () => String(Math.floor(10_000_000 + Math.random() * 89_999_999));
    const stranger = `+62815${digits()}`;
    const young = `+62815${digits()}`;
    const player = `+62815${digits()}`;
    await sql`INSERT INTO players (phone, name) VALUES (${player}, 'Pemain')`;
    for (const [phone, age] of [[stranger, "8 days"], [young, "2 days"], [buyer, "30 days"], [player, "30 days"]] as const) {
      await sql`INSERT INTO wa_contacts (phone, number_exists, chat_id, checked_at) VALUES (${phone}, true, ${`${phone.slice(1)}@c.us`}, now() - ${age}::interval)
                ON CONFLICT (phone) DO UPDATE SET checked_at = EXCLUDED.checked_at`;
    }
    await expect(workerSql`DELETE FROM public.wa_contacts WHERE phone = ${stranger}`).rejects.toMatchObject({ code: "42501" });
    expect(await pruneStrangerContacts(workerSql)).toBeGreaterThanOrEqual(1);
    const left = (await sql<{ phone: string }[]>`SELECT phone FROM wa_contacts WHERE phone IN (${stranger}, ${young}, ${buyer}, ${player})`).map((r) => r.phone);
    expect(left.sort()).toEqual([young, buyer, player].sort());
  });
});
