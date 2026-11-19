// The concurrency cap of argon2.ts, with the native binding replaced by controllable promises: no
// interleaving of a finishing hash, a queued one and a newly started one may exceed the cap.
import { beforeEach, describe, expect, it, vi } from "vitest";

const pending: (() => void)[] = [];
let inflight = 0;
let peak = 0;

vi.mock("@node-rs/argon2", () => ({
  hash: vi.fn(
    () =>
      new Promise<string>((resolve) => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        pending.push(() => {
          inflight -= 1;
          resolve("$argon2id$mock");
        });
      }),
  ),
  verify: vi.fn(() => Promise.resolve(true)),
}));

const { hashSecret } = await import("./argon2.ts");
const LIMIT = 4;
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

beforeEach(() => {
  pending.length = 0;
  inflight = 0;
  peak = 0;
});

describe("argon2 concurrency cap", () => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])("never runs more than the cap when a new hash starts %i ticks after one finishes", async (delay) => {
    const all = Array.from({ length: LIMIT + 1 }, (_, i) => hashSecret(`s${String(i)}`));
    await ticks(10);
    expect(inflight).toBe(LIMIT);
    pending.shift()?.();
    await ticks(delay);
    all.push(hashSecret("late"));
    for (let guard = 0; guard < 100 && (pending.length > 0 || inflight > 0); guard++) {
      await ticks(10);
      pending.shift()?.();
    }
    await Promise.all(all);
    expect(peak).toBeLessThanOrEqual(LIMIT);
    expect(inflight).toBe(0);
  });
});
