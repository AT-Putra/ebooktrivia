// The status poll with an injected clock: the schedule, the backoff, the stop conditions. No timers.
import { describe, expect, it } from "vitest";
import type { PageState } from "./contract.ts";
import { FAILURE_MAX_MS, failureDelayMs, POLL_FAST_COUNT, POLL_FAST_MS, POLL_MAX_MS, type PollDeps, type PollResult, pollDelayMs, pollOrder } from "./poll.ts";

/** A fake clock: sleeping advances it, and records every wait. */
function harness(results: readonly PollResult[], options: { totalMs?: number } = {}) {
  let clock = 1_000_000;
  const waits: number[] = [];
  const statuses: PageState[] = [];
  const checked: number[] = [];
  const controller = new AbortController();
  let calls = 0;
  const deps: PollDeps = {
    fetchStatus: () => {
      const result = results[Math.min(calls, results.length - 1)];
      calls++;
      return Promise.resolve(result ?? { kind: "retry" });
    },
    sleep: (ms) => {
      waits.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
    signal: controller.signal,
    onStatus: (s) => statuses.push(s),
    onChecked: (at) => checked.push(at),
    ...(options.totalMs === undefined ? {} : { totalMs: options.totalMs }),
  };
  return { deps, waits, statuses, checked, controller, calls: () => calls };
}

const pending: PollResult = { kind: "status", status: "pending" };
const paid: PollResult = { kind: "status", status: "paid" };

describe("the schedule", () => {
  it("is fast first, then slows down, then never goes past the cap", () => {
    const delays = Array.from({ length: 24 }, (_, attempt) => pollDelayMs(attempt));
    expect(delays.slice(0, POLL_FAST_COUNT)).toEqual(Array(POLL_FAST_COUNT).fill(POLL_FAST_MS));
    expect(delays[POLL_FAST_COUNT]).toBe(4500);
    for (let i = 1; i < delays.length; i++) expect(delays[i] ?? 0).toBeGreaterThanOrEqual(delays[i - 1] ?? 0);
    expect(Math.max(...delays)).toBe(POLL_MAX_MS);
    expect(delays.at(-1)).toBe(POLL_MAX_MS);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(3000);
  });

  it("backs off exponentially after failures, honours Retry-After, and is capped", () => {
    expect(failureDelayMs(1, undefined)).toBe(6000);
    expect(failureDelayMs(2, undefined)).toBe(12_000);
    expect(failureDelayMs(3, undefined)).toBe(24_000);
    expect(failureDelayMs(10, undefined)).toBe(FAILURE_MAX_MS);
    expect(failureDelayMs(1, 45_000)).toBe(45_000);
    expect(failureDelayMs(1, 10 * 60_000)).toBe(FAILURE_MAX_MS);
  });
});

describe("pollOrder", () => {
  it("makes no request at all for an order that is already paid or refunded", async () => {
    for (const state of ["paid", "refunded"] as const) {
      const h = harness([pending]);
      expect(await pollOrder(state, h.deps)).toBe("terminal");
      expect(h.calls()).toBe(0);
      expect(h.waits).toEqual([]);
    }
  });

  it("keeps polling an order that can still be paid late (expired, failed, review) at the slowest interval, within the time limit", async () => {
    for (const state of ["expired", "failed", "review"] as const) {
      const h = harness([{ kind: "status", status: state }], { totalMs: 10 * 60_000 });
      expect(await pollOrder(state, h.deps), state).toBe("timeout");
      expect(h.waits.length).toBeGreaterThanOrEqual(2);
      expect(new Set(h.waits)).toEqual(new Set([POLL_MAX_MS]));
      expect(h.statuses).toEqual([]);
    }
  });

  it("stops when a late settlement turns an expired order into a paid one, and reports it", async () => {
    const h = harness([{ kind: "status", status: "expired" }, { kind: "status", status: "expired" }, paid]);
    expect(await pollOrder("expired", h.deps)).toBe("terminal");
    expect(h.waits).toEqual([POLL_MAX_MS, POLL_MAX_MS, POLL_MAX_MS]);
    expect(h.statuses).toEqual(["paid"]);
    expect(h.calls()).toBe(3);
  });

  it("never asks a late-payable order faster than every 30 s, not even after failures", async () => {
    const h = harness([{ kind: "retry" }, { kind: "retry" }, { kind: "retry", retryAfterMs: 45_000 }, paid]);
    expect(await pollOrder("failed", h.deps)).toBe("terminal");
    expect(h.waits).toEqual([POLL_MAX_MS, POLL_MAX_MS, POLL_MAX_MS, 45_000]);
  });

  it("polls on the schedule until the order is paid, reporting each change once", async () => {
    const h = harness([pending, pending, pending, paid]);
    expect(await pollOrder("pending", h.deps)).toBe("terminal");
    expect(h.waits).toEqual([3000, 3000, 3000, 3000]);
    expect(h.statuses).toEqual(["paid"]);
    expect(h.checked).toHaveLength(4);
    expect(h.calls()).toBe(4);
  });

  it("stops at the first terminal state it sees (never polls a paid or refunded order again)", async () => {
    for (const status of ["paid", "refunded"] as const) {
      const h = harness([{ kind: "status", status }, pending]);
      expect(await pollOrder("pending", h.deps)).toBe("terminal");
      expect(h.calls()).toBe(1);
    }
  });

  it("never loops tight: every request is preceded by a wait of at least the base interval", async () => {
    const h = harness([pending], { totalMs: 10 * 60_000 });
    expect(await pollOrder("pending", h.deps)).toBe("timeout");
    expect(h.waits.length).toBe(h.calls());
    expect(Math.min(...h.waits)).toBeGreaterThanOrEqual(POLL_FAST_MS);
    expect(h.calls()).toBeLessThan(40);
  });

  it("keeps going through failures with growing waits, and resets after a good answer", async () => {
    const h = harness([{ kind: "retry" }, { kind: "retry" }, { kind: "retry", retryAfterMs: 40_000 }, pending, paid]);
    expect(await pollOrder("pending", h.deps)).toBe("terminal");
    expect(h.waits).toEqual([3000, 6000, 12_000, 40_000, 3000]);
    expect(h.statuses).toEqual(["paid"]);
  });

  it("stops when the order is unknown (404)", async () => {
    const h = harness([pending, { kind: "gone" }]);
    expect(await pollOrder("pending", h.deps)).toBe("gone");
    expect(h.calls()).toBe(2);
  });

  it("stops at the time limit, so the page can offer a manual check", async () => {
    const h = harness([pending], { totalMs: 60_000 });
    expect(await pollOrder("pending", h.deps)).toBe("timeout");
    expect(h.waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
  });

  it("stops at once when aborted, before and after a request", async () => {
    const before = harness([pending]);
    before.controller.abort();
    expect(await pollOrder("pending", before.deps)).toBe("aborted");
    expect(before.calls()).toBe(0);

    const during = harness([pending]);
    const original = during.deps.fetchStatus;
    const deps: PollDeps = {
      ...during.deps,
      fetchStatus: async () => {
        during.controller.abort();
        return original();
      },
    };
    expect(await pollOrder("pending", deps)).toBe("aborted");
    expect(during.statuses).toEqual([]);
  });
});
