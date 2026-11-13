// Conversion-fire consumer (AC 1, AC 3 groundwork): claim with a lease per core
// conversion-machine, fire through the injected port, record the outcome conditioned on the
// claim; every fire is logged in conversion_attempts.
import { CONVERSION_RETRY_DELAYS_MS, NEEDS_MANUAL_REFIRE } from "@ebooktrivia/core";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type ConversionToFire, createConversionProcessor, type FireConversion } from "../src/conversion-fire.ts";
import { inertFailpoint } from "../src/failpoint.ts";
import { createLogger } from "../src/log.ts";
import { type Catalog, createCatalog, createConversionEvents, createOrders, first, sql } from "./support/db.ts";

const workerSql = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 4, onnotice: () => undefined });
afterAll(async () => {
  await workerSql.end({ timeout: 5 });
});
const log = createLogger({ level: "silent", role: "worker" });

let catalog: Catalog;
beforeAll(async () => {
  catalog = await createCatalog();
});

async function newEvent(opts: Parameters<typeof createConversionEvents>[1] = {}): Promise<string> {
  const [orderId] = await createOrders(catalog, 1);
  return first(await createConversionEvents([orderId as string], opts));
}

interface EventState {
  status: string;
  attempts: number;
  lease_until: Date | null;
  next_attempt_at: Date;
  last_http_status: number | null;
  last_error: string | null;
  sent: boolean;
  failed: boolean;
}
const eventState = async (id: string): Promise<EventState> =>
  first(
    await sql<EventState[]>`
      SELECT status, attempts, lease_until, next_attempt_at, last_http_status, last_error, sent_at IS NOT NULL AS sent,
             failed_at IS NOT NULL AS failed
        FROM conversion_events WHERE id = ${id}`,
  );
const attemptLog = (id: string) =>
  sql<{ attempt: number; http_status: number | null; error: string | null; request_url_redacted: string | null; response_excerpt: string | null }[]>`
    SELECT attempt, http_status, error, request_url_redacted, response_excerpt FROM conversion_attempts
     WHERE conversion_event_id = ${id} ORDER BY created_at, attempt`;

const sent: FireConversion = () =>
  Promise.resolve({ outcome: { kind: "sent", httpStatus: 200 }, latencyMs: 12, responseSnippet: "ok", requestUrlRedacted: "https://sink.example/[redacted]" });

function processor(fire: FireConversion) {
  return createConversionProcessor({ sql: workerSql, fire, failpoint: inertFailpoint, log, leaseMs: 10_000, requestTimeoutMs: 1000 });
}

describe("conversion-fire consumer", () => {
  it("claims a due event, fires it once and records sent, with one attempt row", async () => {
    const id = await newEvent();
    const fired: ConversionToFire[] = [];
    const process = processor((event, signal) => {
      fired.push(event);
      expect(signal.aborted).toBe(false);
      return sent(event, signal);
    });
    expect(await process({ id })).toBe("sent");
    expect(fired).toEqual([
      expect.objectContaining({ id, sink: "meta", kind: "mt", adnetId: null, valueIdr: 49_000, attempt: 1 }),
    ]);
    expect(await eventState(id)).toMatchObject({ status: "sent", attempts: 1, lease_until: null, last_http_status: 200, last_error: null, sent: true });
    expect(await attemptLog(id)).toEqual([
      { attempt: 1, http_status: 200, error: null, request_url_redacted: "https://sink.example/[redacted]", response_excerpt: "ok" },
    ]);
    // The same job again, or the sweeper's job for the same attempt: not pending any more.
    expect(await process({ id })).toBe("skipped");
    expect(fired).toHaveLength(1);
  });

  it("schedules a retry per CONVERSION_RETRY_DELAYS_MS after a failed attempt", async () => {
    const id = await newEvent();
    const process = processor(() =>
      Promise.resolve({ outcome: { kind: "failed", httpStatus: 500, error: "HTTP 500" }, latencyMs: 5, responseSnippet: "boom", requestUrlRedacted: null }),
    );
    const before = Date.now();
    expect(await process({ id })).toBe("pending");
    const state = await eventState(id);
    expect(state).toMatchObject({ status: "pending", attempts: 1, lease_until: null, last_http_status: 500, last_error: "HTTP 500" });
    const delay = state.next_attempt_at.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual((CONVERSION_RETRY_DELAYS_MS[0] ?? 0) - 2000);
    expect(delay).toBeLessThanOrEqual((CONVERSION_RETRY_DELAYS_MS[0] ?? 0) + 5000);
    expect(await process({ id })).toBe("skipped"); // not due yet
  });

  it("never re-fires an uncertain send: maybe_sent and a throwing port both end failed for a manual re-fire", async () => {
    for (const fire of [
      () => Promise.resolve({ outcome: { kind: "maybe_sent", error: "timeout" } as const, latencyMs: 1000, responseSnippet: "", requestUrlRedacted: null }),
      () => Promise.reject(new Error("socket hang up")),
    ] satisfies FireConversion[]) {
      const id = await newEvent();
      expect(await processor(fire)({ id })).toBe("failed");
      const state = await eventState(id);
      expect(state).toMatchObject({ status: "failed", attempts: 1, failed: true });
      expect(state.last_error?.startsWith(NEEDS_MANUAL_REFIRE)).toBe(true);
      expect((await attemptLog(id)).map((a) => a.attempt)).toEqual([1]);
    }
  });

  it("does not claim an event that is not due, not pending, or unknown", async () => {
    const fire = (): Promise<never> => Promise.reject(new Error("must not fire"));
    expect(await processor(fire)({ id: await newEvent({ nextAttemptAt: new Date(Date.now() + 60_000) }) })).toBe("skipped");
    expect(await processor(fire)({ id: await newEvent({ status: "sent", attempts: 1 }) })).toBe("skipped");
    expect(await processor(fire)({ id: "00000000-0000-4000-8000-000000000000" })).toBe("skipped");
  });

  it("a stale finisher (its attempt was superseded) logs the attempt but cannot overwrite the row", async () => {
    const id = await newEvent();
    const process = processor(async (event, signal) => {
      // While this request was out, the lease expired, the sweeper re-queued the row and attempt 2 started.
      await sql`UPDATE conversion_events SET attempts = 2, status = 'sending', lease_until = now() + interval '1 minute' WHERE id = ${id}`;
      return sent(event, signal);
    });
    expect(await process({ id })).toBe("stale");
    expect(await eventState(id)).toMatchObject({ status: "sending", attempts: 2, sent: false });
    expect((await attemptLog(id)).map((a) => [a.attempt, a.http_status])).toEqual([[1, 200]]);
  });

  it("accepts a late 2xx for the latest attempt after the lease sweeper failed the row (no double pay)", async () => {
    const id = await newEvent();
    const process = processor(async (event, signal) => {
      await sql`UPDATE conversion_events SET status = 'failed', lease_until = NULL, failed_at = now(), last_error = 'lease expired' WHERE id = ${id}`;
      return sent(event, signal);
    });
    expect(await process({ id })).toBe("sent");
    expect(await eventState(id)).toMatchObject({ status: "sent", attempts: 1, last_error: null, sent: true });
  });

  // Security review US-013 #4: a process stalled between claim and fire (GC pause, suspended VM)
  // may have lost its lease; it must not fire then.
  // Security re-check US-013: the budget starts BEFORE the claim transaction, so a stall during
  // its commit round trip or before its continuation runs counts too.
  it("does not fire once the lease budget has passed since the claim, and leaves the row to the sweeper", async () => {
    const id = await newEvent();
    let fires = 0;
    const order: string[] = [];
    const readings = [0, 10_000 - 1000 - 1000 + 1];
    const recorded = new Proxy(workerSql, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (prop !== "begin" || typeof value !== "function") return value;
        return (...args: unknown[]) => {
          order.push("begin");
          return (value as (...a: unknown[]) => unknown)(...args);
        };
      },
    });
    const process = createConversionProcessor({
      sql: recorded,
      fire: (event, signal) => {
        fires++;
        return sent(event, signal);
      },
      failpoint: inertFailpoint,
      log,
      leaseMs: 10_000,
      requestTimeoutMs: 1000,
      clock: () => {
        order.push("clock");
        return readings.shift() ?? Number.POSITIVE_INFINITY;
      },
    });
    expect(await process({ id })).toBe("stale");
    expect(order.slice(0, 2)).toEqual(["clock", "begin"]);
    expect(fires).toBe(0);
    expect(await eventState(id)).toMatchObject({ status: "sending", attempts: 1 });
    expect(await attemptLog(id)).toEqual([]);
  });

  // Code review US-013 #7: the event row vanished while the request was out.
  it("returns stale when the event was deleted during the fire, without a foreign-key error", async () => {
    const id = await newEvent();
    const process = processor(async (event, signal) => {
      await sql`DELETE FROM conversion_events WHERE id = ${id}`;
      return sent(event, signal);
    });
    expect(await process({ id })).toBe("stale");
  });

  // Code review US-013 #10: a value that cannot be sent is not retried every minute forever.
  it("fails an event whose value_idr is out of the safe integer range, without firing", async () => {
    const id = await newEvent();
    await sql`UPDATE conversion_events SET value_idr = 9007199254740993 WHERE id = ${id}`;
    let fires = 0;
    const process = processor((event, signal) => {
      fires++;
      return sent(event, signal);
    });
    expect(await process({ id })).toBe("failed");
    expect(fires).toBe(0);
    const state = await eventState(id);
    expect(state).toMatchObject({ status: "failed", attempts: 0, failed: true, lease_until: null });
    expect(state.last_error).toMatch(/value_idr/);
    expect(await process({ id })).toBe("skipped");
  });

  it("two jobs racing for the same due event produce one claim and one fire", async () => {
    const id = await newEvent();
    let fires = 0;
    const process = processor(async (event, signal) => {
      fires++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return sent(event, signal);
    });
    const results = await Promise.all([process({ id }), process({ id }), process({ id })]);
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
    expect(results.filter((r) => r === "skipped")).toHaveLength(2);
    expect(fires).toBe(1);
    expect(await attemptLog(id)).toHaveLength(1);
  });
});
