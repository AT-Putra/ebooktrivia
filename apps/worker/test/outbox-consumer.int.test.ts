// AC 1 (consumers): a job carries only the outbox id; the consumer re-reads the row, claims it
// with a lease (attempts = fencing token), performs the effect, then finalizes conditioned on the
// claim. A stale finisher whose lease was lost changes nothing.
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { afterAll, describe, expect, inject, it } from "vitest";
import { inertFailpoint } from "../src/failpoint.ts";
import { createLogger } from "../src/log.ts";
import { createOutboxProcessor, OUTBOX_MAX_ATTEMPTS, type OutboxConsumer } from "../src/outbox-consumer.ts";
import { createOutboxRows, first, sql, suffix } from "./support/db.ts";
import { captureLogger } from "./support/log.ts";

const workerSql = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 4, onnotice: () => undefined });
afterAll(async () => {
  await workerSql.end({ timeout: 5 });
});
const log = createLogger({ level: "silent", role: "worker" });

interface OutboxState {
  attempts: number;
  processed: boolean;
  sealed: Uint8Array | null;
  last_error: string | null;
  leased_ms: number;
}
const state = async (id: string): Promise<OutboxState> =>
  first(
    await sql<OutboxState[]>`
      SELECT attempts, processed_at IS NOT NULL AS processed, sealed, last_error,
             round(extract(epoch FROM available_at - now()) * 1000)::int AS leased_ms
        FROM outbox WHERE id = ${id}`,
  );

function consumer(topic: string, perform: OutboxConsumer["perform"], leaseMs = 10_000): OutboxConsumer {
  return { topic, leaseMs, perform };
}

describe("outbox consumer", () => {
  it("claims, performs once, commits its writes with processed_at and wipes the sealed material", async () => {
    const topic = "test.consume_ok";
    const [id] = await createOutboxRows(topic, 1);
    await sql`UPDATE outbox SET sealed = '\\x0102'::bytea WHERE id = ${id ?? ""}`;
    const seen: unknown[] = [];
    const marker = `outbox-ok-${suffix()}`;
    const process = createOutboxProcessor(
      consumer(topic, (row, signal) => {
        seen.push({ id: row.id, payload: row.payload, sealed: Buffer.from(row.sealed ?? []).toString("hex"), attempts: row.attempts, aborted: signal.aborted });
        return Promise.resolve(async (tx) => {
          await tx`INSERT INTO public.alerts (source, kind, message, dedupe_key) VALUES ('worker', 'probe', 'probe', ${marker})`;
        });
      }),
      { sql: workerSql, failpoint: inertFailpoint, log },
    );
    expect(await process({ id })).toBe("processed");
    expect(seen).toEqual([{ id, payload: { n: 1 }, sealed: "0102", attempts: 1, aborted: false }]);
    expect(await state(id as string)).toMatchObject({ attempts: 1, processed: true, sealed: null, last_error: null });
    expect(first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM alerts WHERE dedupe_key = ${marker}`).n).toBe(1);

    // A duplicate job (re-relay, BullMQ re-delivery) finds the row processed: no second effect.
    expect(await process({ id })).toBe("skipped");
    expect(seen).toHaveLength(1);
  });

  it("does not claim a row whose lease is still active, or a row of another topic", async () => {
    const topic = "test.consume_leased";
    const [id] = await createOutboxRows(topic, 1);
    let release = (): void => undefined;
    const performing = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const process = createOutboxProcessor(
      consumer(topic, async () => {
        calls++;
        await performing;
        return undefined;
      }),
      { sql: workerSql, failpoint: inertFailpoint, log },
    );
    const firstRun = process({ id });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await process({ id })).toBe("skipped");
    const other = createOutboxProcessor(consumer("test.other_topic", () => Promise.resolve(undefined)), { sql: workerSql, failpoint: inertFailpoint, log });
    expect(await other({ id })).toBe("skipped");
    release();
    expect(await firstRun).toBe("processed");
    expect(calls).toBe(1);
  });

  it("a stale finisher whose lease was lost (row re-claimed) commits nothing", async () => {
    const topic = "test.consume_stale";
    const [id] = await createOutboxRows(topic, 1);
    const marker = `outbox-stale-${suffix()}`;
    const process = createOutboxProcessor(
      consumer(topic, async () => {
        // Meanwhile the lease expired and another worker re-claimed the row (attempts moved on).
        await sql`UPDATE outbox SET attempts = attempts + 1 WHERE id = ${id ?? ""}`;
        return async (tx) => {
          await tx`INSERT INTO public.alerts (source, kind, message, dedupe_key) VALUES ('worker', 'probe', 'probe', ${marker})`;
        };
      }),
      { sql: workerSql, failpoint: inertFailpoint, log },
    );
    expect(await process({ id })).toBe("lease_lost");
    expect(await state(id as string)).toMatchObject({ attempts: 2, processed: false });
    expect(first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM alerts WHERE dedupe_key = ${marker}`).n).toBe(0);
  });

  it("records a failure, backs the row off and rethrows; it stops claiming after the attempt cap", async () => {
    const topic = "test.consume_fail";
    const [id] = await createOutboxRows(topic, 1);
    const process = createOutboxProcessor(
      consumer(topic, () => Promise.reject(new Error("upstream said no"))),
      { sql: workerSql, failpoint: inertFailpoint, log },
    );
    await expect(process({ id })).rejects.toThrow("upstream said no");
    const failed = await state(id as string);
    expect(failed).toMatchObject({ attempts: 1, processed: false, last_error: "upstream said no" });
    expect(failed.leased_ms).toBeGreaterThan(20_000);

    await sql`UPDATE outbox SET available_at = now() - interval '1 second', attempts = ${OUTBOX_MAX_ATTEMPTS} WHERE id = ${id ?? ""}`;
    expect(await process({ id })).toBe("skipped");
    expect((await state(id as string)).attempts).toBe(OUTBOX_MAX_ATTEMPTS);
  });

  // Security review US-013 #5b: last_error must not carry PII from an error message.
  it("masks phone numbers and emails in last_error", async () => {
    const topic = "test.consume_pii";
    const [id] = await createOutboxRows(topic, 1);
    const process = createOutboxProcessor(
      consumer(topic, () => Promise.reject(new Error("WAHA refused +6281234567890 (buyer@example.com)"))),
      { sql: workerSql, failpoint: inertFailpoint, log },
    );
    await expect(process({ id })).rejects.toThrow("WAHA refused");
    expect((await state(id as string)).last_error).toBe("WAHA refused [number] ([email])");
  });

  // Code review US-013 #11: a failing backoff UPDATE must not replace the consumer's error.
  it("rethrows the consumer's error and logs the backoff failure when the database is gone too", async () => {
    const topic = "test.consume_backoff";
    const [id] = await createOutboxRows(topic, 1);
    const own = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice: () => undefined });
    const captured = captureLogger();
    const process = createOutboxProcessor(
      consumer(topic, async () => {
        await own.end();
        throw new Error("upstream said no");
      }),
      { sql: own, failpoint: inertFailpoint, log: captured.log },
    );
    await expect(process({ id })).rejects.toThrow("upstream said no");
    expect(captured.lines.some((l) => l["msg"] === "outbox backoff could not be recorded" && l["level"] === 50)).toBe(true);
  });

  it("refuses job data that is not { id: <uuid> }", async () => {
    const process = createOutboxProcessor(consumer("test.consume_bad", () => Promise.resolve(undefined)), { sql: workerSql, failpoint: inertFailpoint, log });
    await expect(process({ id: "x" })).rejects.toThrow(TypeError);
    await expect(process({ id: "00000000-0000-4000-8000-000000000000", extra: 1 })).rejects.toThrow(TypeError);
    expect(await process({ id: "00000000-0000-4000-8000-000000000000" })).toBe("skipped");
  });
});
