// The worker composition in process (src/worker.ts): relay -> consumer -> finalize, the
// conversion queue, heartbeat, and graceful stop (stop polling, let the job in flight finish,
// close Valkey and PostgreSQL). The production entry registers no ports yet.
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { FireConversion } from "../src/conversion-fire.ts";
import { createLogger } from "../src/log.ts";
import type { OutboxConsumer } from "../src/outbox-consumer.ts";
import { startWorker } from "../src/worker.ts";
import { loadWorkerConfig } from "../src/worker-config.ts";
import { type Catalog, createCatalog, createConversionEvents, createOrders, createOutboxRows, first, sleep, sql, waitFor } from "./support/db.ts";
import { PROBE_TOPIC } from "./support/probe.ts";
import { captureLogger } from "./support/log.ts";
import { workerEnv } from "./support/processes.ts";
import { uniquePrefix } from "./support/valkey.ts";

const log = createLogger({ level: "silent", role: "worker" });
const workerUser = new URL(inject("workerDbUrl")).username;
let catalog: Catalog;
beforeAll(async () => {
  catalog = await createCatalog();
});
afterAll(async () => {
  await sql`DELETE FROM heartbeats WHERE component = 'worker'`;
});

const connections = async () =>
  first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = ${workerUser} AND application_name = 'ebt-worker'`).n;

describe("startWorker", () => {
  it("relays, consumes, fires and beats, and stop() lets the job in flight finish before closing everything", async () => {
    let releaseGate = (): void => undefined;
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    const performed: string[] = [];
    const probe: OutboxConsumer = {
      topic: PROBE_TOPIC,
      leaseMs: 10_000,
      perform: async (row) => {
        performed.push(row.id);
        await gate;
        return undefined;
      },
    };
    const fired: string[] = [];
    const fire: FireConversion = (event) => {
      fired.push(event.id);
      return Promise.resolve({ outcome: { kind: "sent", httpStatus: 204 }, latencyMs: 1, responseSnippet: "", requestUrlRedacted: null });
    };
    const delivered: unknown[] = [];
    const deliverDelivery = (data: unknown): Promise<string> => {
      delivered.push(data);
      return Promise.resolve("sent");
    };
    const config = loadWorkerConfig(workerEnv(uniquePrefix(), { WORKER_HEARTBEAT_INTERVAL_MS: "200" }));
    const [eventId] = await createConversionEvents(await createOrders(catalog, 1));
    const [rowId] = await createOutboxRows(PROBE_TOPIC, 1);
    const [deliveryOrder] = await createOrders(catalog, 1);
    const [delivery] = await sql<{ id: string }[]>`
      INSERT INTO deliveries (order_id, channel, status, not_before) VALUES (${deliveryOrder ?? ""}, 'email', 'pending', now() - interval '1 second')
      RETURNING id`;
    const running = await startWorker(config, { outboxConsumers: [probe], fireConversion: fire, deliverDelivery }, log);

    await waitFor("probe performing", () => Promise.resolve(performed.includes(rowId as string)));
    await waitFor("conversion fired", () => Promise.resolve(fired.includes(eventId as string)));
    await waitFor("delivery port called", () => Promise.resolve(delivered.some((d) => (d as { id: string }).id === delivery?.id)));
    await waitFor("heartbeat", async () => (await sql`SELECT 1 FROM heartbeats WHERE component = 'worker' AND beat_at > now() - interval '5 seconds'`).length === 1);
    expect(await connections()).toBeGreaterThan(0);

    const stopping = running.stop();
    await sleep(300);
    expect(first(await sql<{ processed: boolean }[]>`SELECT processed_at IS NOT NULL AS processed FROM outbox WHERE id = ${rowId ?? ""}`).processed).toBe(false);
    releaseGate();
    await stopping;
    expect(first(await sql<{ processed: boolean }[]>`SELECT processed_at IS NOT NULL AS processed FROM outbox WHERE id = ${rowId ?? ""}`).processed).toBe(true);
    expect(first(await sql<{ status: string }[]>`SELECT status::text FROM conversion_events WHERE id = ${eventId ?? ""}`).status).toBe("sent");
    await waitFor("connections closed", async () => (await connections()) === 0, 5000);
    await sql`UPDATE deliveries SET status = 'cancelled' WHERE id = ${delivery?.id ?? ""}`;
  });

  // Code review US-013 #1: without the US-028 hook an ended program must stay published (the
  // worker cannot move it back), and no sweeper runs whose work has no port.
  it("with the production ports (none yet) relays no topic, fires no conversion and ends no grace period", async () => {
    const config = loadWorkerConfig(workerEnv(uniquePrefix()));
    const [eventId] = await createConversionEvents(await createOrders(catalog, 1));
    const [rowId] = await createOutboxRows(PROBE_TOPIC, 1);
    const ended = await createCatalog({ salesEndAt: new Date(Date.now() - 3 * 86_400_000), graceDays: 1 });
    const captured = captureLogger("debug");
    const running = await startWorker(config, {}, captured.log);
    await sleep(800);
    await running.stop();
    expect(first(await sql<{ status: string }[]>`SELECT status::text FROM programs WHERE id = ${ended.programId}`).status).toBe("published");
    const swept = new Set(captured.lines.filter((l) => l["msg"] === "sweep done").map((l) => l["sweeper"]));
    expect([...swept].sort()).toEqual(["lease_expiry", "login_throttle", "order_expiry", "outbox", "snap_create"]);
    await sql`UPDATE programs SET status = 'draft' WHERE id = ${ended.programId}`;
    expect(first(await sql<{ relayed: boolean }[]>`SELECT relayed_at IS NOT NULL AS relayed FROM outbox WHERE id = ${rowId ?? ""}`).relayed).toBe(false);
    expect(first(await sql<{ status: string }[]>`SELECT status::text FROM conversion_events WHERE id = ${eventId ?? ""}`).status).toBe("pending");
    await sql`UPDATE outbox SET processed_at = now() WHERE id = ${rowId ?? ""}`;
    await sql`UPDATE conversion_events SET status = 'failed', failed_at = now() WHERE id = ${eventId ?? ""}`;
  });

  it("keeps running while Valkey is unreachable, logs it, and still stops cleanly", async () => {
    const { log: captured, lines } = captureLogger("warn");
    const config = loadWorkerConfig(workerEnv(uniquePrefix(), { VALKEY_URL: "redis://127.0.0.1:1", WORKER_HEARTBEAT_INTERVAL_MS: "100" }));
    const probe: OutboxConsumer = { topic: PROBE_TOPIC, leaseMs: 1000, perform: () => Promise.resolve(undefined) };
    const [rowId] = await createOutboxRows(PROBE_TOPIC, 1);
    const running = await startWorker(config, { outboxConsumers: [probe] }, captured);
    await waitFor("connection errors logged", () => Promise.resolve(lines.some((l) => l["msg"] === "valkey health connection error")), 10_000);
    await waitFor("missed push logged", () => Promise.resolve(lines.some((l) => l["msg"] === "heartbeat: Valkey did not answer PING; push skipped")), 10_000);
    // The relay's add timed out: its transaction rolled back instead of holding the row lock.
    await waitFor("relay timeout logged", () => Promise.resolve(lines.some((l) => l["loop"] === "relay" && JSON.stringify(l).includes("did not answer"))), 15_000);
    expect(first(await sql<{ relayed: boolean }[]>`SELECT relayed_at IS NOT NULL AS relayed FROM outbox WHERE id = ${rowId ?? ""}`).relayed).toBe(false);
    const locked = await sql`SELECT id FROM outbox WHERE id = ${rowId ?? ""} FOR UPDATE NOWAIT`;
    expect(locked).toHaveLength(1);
    await running.stop();
    expect(lines.some((l) => l["msg"] === "queue connection error" || l["msg"] === "worker connection error")).toBe(true);
    expect(lines.some((l) => l["msg"] === "Valkey unreachable at shutdown: closing consumers without waiting for jobs in flight")).toBe(true);
    await sql`UPDATE outbox SET processed_at = now() WHERE id = ${rowId ?? ""}`;
  });

  // Security review US-013 #3b: the worker must run as a worker_rw login only.
  it("refuses a database login that is not worker_rw only (an internal login, the superuser)", async () => {
    for (const url of [inject("internalDbUrl"), inject("dbUrl")]) {
      const config = loadWorkerConfig(workerEnv(uniquePrefix(), { DATABASE_URL_WORKER: url }));
      await expect(startWorker(config, {}, log)).rejects.toThrow("DATABASE_URL_WORKER must be a worker_rw login");
    }
  });

  it("refuses two consumers for one topic", async () => {
    const config = loadWorkerConfig(workerEnv(uniquePrefix()));
    const consumer: OutboxConsumer = { topic: PROBE_TOPIC, leaseMs: 1000, perform: () => Promise.resolve(undefined) };
    await expect(startWorker(config, { outboxConsumers: [consumer, consumer] }, log)).rejects.toThrow(/two outbox consumers/);
  });
});
