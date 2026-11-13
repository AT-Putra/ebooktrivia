import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./log.ts";
import { onShutdown } from "./shutdown.ts";

const log = createLogger({ level: "silent", role: "worker" });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeProcess() {
  const proc = Object.assign(new EventEmitter(), { exit: vi.fn<(code: number) => void>() });
  return proc;
}

describe("onShutdown", () => {
  it.each(["SIGTERM", "SIGINT"] as const)("stops gracefully on %s and exits 0", async (signal) => {
    const proc = fakeProcess();
    const stop = vi.fn(() => Promise.resolve());
    onShutdown(stop, log, { proc, timeoutMs: 1000 });
    proc.emit(signal);
    await tick();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it("exits 1 when stopping fails", async () => {
    const proc = fakeProcess();
    onShutdown(() => Promise.reject(new Error("close failed")), log, { proc, timeoutMs: 1000 });
    proc.emit("SIGTERM");
    await tick();
    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it("forces exit 1 on a second signal or when stopping takes too long", async () => {
    const proc = fakeProcess();
    const stop = vi.fn(() => new Promise<void>(() => undefined));
    onShutdown(stop, log, { proc, timeoutMs: 30 });
    proc.emit("SIGTERM");
    proc.emit("SIGINT");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(1);
    const slow = fakeProcess();
    onShutdown(() => new Promise<void>(() => undefined), log, { proc: slow, timeoutMs: 20 });
    slow.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(slow.exit).toHaveBeenCalledWith(1);
  });
});
