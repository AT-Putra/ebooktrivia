import { describe, expect, it } from "vitest";
import { startLoop } from "./loop.ts";
import { createLogger } from "./log.ts";

const log = createLogger({ level: "silent", role: "worker" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("startLoop", () => {
  it("runs the tick at once, then every interval, never overlapping", async () => {
    let running = 0;
    let maxRunning = 0;
    let ticks = 0;
    const loop = startLoop({ name: "t", intervalMs: 20, log }, async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      ticks++;
      await sleep(30);
      running--;
      return false;
    });
    await sleep(170);
    await loop.stop();
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(ticks).toBeLessThanOrEqual(5);
    expect(maxRunning).toBe(1);
  });

  it("runs again immediately while the tick reports more work", async () => {
    let ticks = 0;
    const loop = startLoop({ name: "t", intervalMs: 10_000, log }, () => {
      ticks++;
      return Promise.resolve(ticks < 5);
    });
    await sleep(100);
    await loop.stop();
    expect(ticks).toBe(5);
  });

  it("logs a failing tick and keeps going", async () => {
    let ticks = 0;
    const loop = startLoop({ name: "t", intervalMs: 10, log }, () => {
      ticks++;
      return Promise.reject(new Error("boom"));
    });
    await sleep(80);
    await loop.stop();
    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  it("stop() waits for the tick in flight and prevents further ticks", async () => {
    let finished = false;
    let ticks = 0;
    const loop = startLoop({ name: "t", intervalMs: 1, log }, async () => {
      ticks++;
      await sleep(60);
      finished = true;
      return true;
    });
    await sleep(10);
    await loop.stop();
    expect(finished).toBe(true);
    const after = ticks;
    await sleep(50);
    expect(ticks).toBe(after);
    await loop.stop();
  });
});
