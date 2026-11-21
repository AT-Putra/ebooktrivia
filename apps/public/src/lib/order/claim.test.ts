// The order page's claim flow, including React's development double mount (mount, unmount, mount in one
// tick): an order that is already paid at load must claim exactly once, not never and not twice.
import { describe, expect, it } from "vitest";
import { CLAIM_RETRY_MS, type ClaimDeps, type ClaimLatch, claimAndFire, type WonClaim } from "./claim.ts";
import type { OrderClaimBody } from "./contract.ts";

const WON: WonClaim = { v: 1, fire: true, event_id: "0b9f5f0e-2c1d-4e6a-9d3f-1a2b3c4d5e6f", transaction_id: "7c0d8c1e-6f43-4a0e-8f3b-2e8a4d9a1b77", value_idr: 49_000, pixels: { meta: "1234567890123" } };
const LOST: OrderClaimBody = { v: 1, fire: false };

/** The real timer-based sleep of the page: aborts cut it short. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** The effect's side effects, recorded: what the server saw and what was fired. */
function recorder(answers: readonly (OrderClaimBody | null)[] = [WON]) {
  const requests: number[] = [];
  const fired: WonClaim[] = [];
  const waits: number[] = [];
  const deps = (signal: AbortSignal, overrides: Partial<ClaimDeps> = {}): ClaimDeps => ({
    signal,
    sleep: overrides.sleep ?? sleep,
    request: () => {
      requests.push(requests.length);
      return Promise.resolve(answers[Math.min(requests.length - 1, answers.length - 1)] ?? null);
    },
    fire: (claim) => {
      fired.push(claim);
      return Promise.resolve();
    },
    ...overrides,
  });
  const recordingSleep = (ms: number): Promise<void> => {
    waits.push(ms);
    return Promise.resolve();
  };
  return { requests, fired, waits, deps, recordingSleep };
}

describe("claimAndFire under React's development double mount", () => {
  it("claims exactly once when the effect runs, is aborted and runs again in the same tick (an order already paid at load)", async () => {
    const latch: ClaimLatch = { current: false };
    const r = recorder();
    const first = new AbortController();
    const second = new AbortController();
    // mount ... (cleanup) unmount ... mount, all before the next tick; the latch is the component's ref and survives.
    const run1 = claimAndFire(latch, r.deps(first.signal));
    first.abort();
    const run2 = claimAndFire(latch, r.deps(second.signal));
    await Promise.all([run1, run2]);
    expect(r.requests).toHaveLength(1);
    expect(r.fired).toEqual([WON]);
    expect(latch.current).toBe(true);
  });

  it("claims exactly once when the effect runs twice WITHOUT an abort in between (a status change and a late mount)", async () => {
    const latch: ClaimLatch = { current: false };
    const r = recorder();
    const controller = new AbortController();
    await Promise.all([claimAndFire(latch, r.deps(controller.signal)), claimAndFire(latch, r.deps(controller.signal))]);
    expect(r.requests).toHaveLength(1);
    expect(r.fired).toHaveLength(1);
  });

  it("sends nothing for a run that was aborted before its first tick, and leaves the latch free for the next run", async () => {
    const latch: ClaimLatch = { current: false };
    const r = recorder();
    const controller = new AbortController();
    const run = claimAndFire(latch, r.deps(controller.signal));
    controller.abort();
    await run;
    expect(r.requests).toEqual([]);
    expect(latch.current).toBe(false);
    await claimAndFire(latch, r.deps(new AbortController().signal));
    expect(r.requests).toHaveLength(1);
    expect(r.fired).toHaveLength(1);
  });

  it("does not claim again once it has claimed (a reload of the effect after a manual check, say)", async () => {
    const latch: ClaimLatch = { current: false };
    const r = recorder([WON, LOST]);
    await claimAndFire(latch, r.deps(new AbortController().signal));
    await claimAndFire(latch, r.deps(new AbortController().signal));
    expect(r.requests).toHaveLength(1);
    expect(r.fired).toHaveLength(1);
  });
});

describe("claimAndFire", () => {
  it("fires nothing for an answer of fire:false (a reload, another tab, a claim that is over)", async () => {
    const r = recorder([LOST]);
    await claimAndFire({ current: false }, r.deps(new AbortController().signal));
    expect(r.requests).toHaveLength(1);
    expect(r.fired).toEqual([]);
  });

  it("retries a failed request twice with growing waits, then gives up: three requests in all", async () => {
    const r = recorder([null]);
    await claimAndFire({ current: false }, r.deps(new AbortController().signal, { sleep: r.recordingSleep }));
    expect(r.requests).toHaveLength(CLAIM_RETRY_MS.length + 1);
    expect(r.waits).toEqual([0, ...CLAIM_RETRY_MS]);
    expect(r.fired).toEqual([]);
  });

  it("stops retrying after a good answer, and fires a won claim once", async () => {
    const r = recorder([null, WON]);
    await claimAndFire({ current: false }, r.deps(new AbortController().signal, { sleep: r.recordingSleep }));
    expect(r.requests).toHaveLength(2);
    expect(r.fired).toEqual([WON]);
  });

  it("stops when the page is left while a request is out or between retries", async () => {
    const outstanding = recorder([WON]);
    const controller = new AbortController();
    const run = claimAndFire({ current: false }, { ...outstanding.deps(controller.signal), request: () => { controller.abort(); return Promise.resolve(WON); } });
    await run;
    expect(outstanding.fired).toEqual([]);

    const between = recorder([null]);
    const second = new AbortController();
    await claimAndFire({ current: false }, between.deps(second.signal, { sleep: (ms, signal) => { if (ms > 0) second.abort(); return sleep(0, signal); } }));
    expect(between.requests).toHaveLength(1);
    expect(between.fired).toEqual([]);
  });
});
