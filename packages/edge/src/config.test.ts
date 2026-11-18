import { describe, expect, it } from "vitest";
import { loadEdgeConfig } from "./config.ts";
import { drainOnSignals, type SignalProcess } from "./signals.ts";

describe("loadEdgeConfig", () => {
  it("has defaults outside production", () => {
    expect(loadEdgeConfig({ NODE_ENV: "development" })).toEqual({
      production: false,
      host: "0.0.0.0",
      port: 3000,
      trustedProxy: null,
      drainMs: 5000,
      drainFile: undefined,
      closeTimeoutMs: 15_000,
    });
  });

  it("reads every setting", () => {
    expect(
      loadEdgeConfig({
        NODE_ENV: "production",
        TRUSTED_PROXY_IP: "10.89.50.2",
        EDGE_HOST: "::",
        EDGE_PORT: "3100",
        EDGE_DRAIN_MS: "6000",
        EDGE_DRAIN_FILE: "/run/edge/drain",
        EDGE_CLOSE_TIMEOUT_MS: "10000",
      }),
    ).toEqual({ production: true, host: "::", port: 3100, trustedProxy: "10.89.50.2", drainMs: 6000, drainFile: "/run/edge/drain", closeTimeoutMs: 10_000 });
  });

  it("requires NODE_ENV, and TRUSTED_PROXY_IP and EDGE_HOST in production", () => {
    expect(() => loadEdgeConfig({})).toThrow("NODE_ENV is required");
    expect(() => loadEdgeConfig({ NODE_ENV: "production", EDGE_HOST: "10.89.50.11" })).toThrow("TRUSTED_PROXY_IP is required with NODE_ENV=production");
    // Fail closed: production never listens on every interface by default (security review S2).
    expect(() => loadEdgeConfig({ NODE_ENV: "production", TRUSTED_PROXY_IP: "10.89.50.2" })).toThrow("EDGE_HOST is required with NODE_ENV=production");
  });

  it("refuses bad values without echoing them", () => {
    const bad: Record<string, string>[] = [
      { TRUSTED_PROXY_IP: "caddy" },
      { TRUSTED_PROXY_IP: "10.89.50.0/24" },
      { EDGE_HOST: "localhost" },
      { EDGE_PORT: "70000" },
      { EDGE_PORT: "-1" },
      { EDGE_DRAIN_MS: "5s" },
      { EDGE_DRAIN_FILE: "relative/drain" },
    ];
    for (const env of bad) {
      const value = Object.values(env)[0] ?? "";
      expect(() => loadEdgeConfig({ NODE_ENV: "test", ...env })).toThrow(Object.keys(env)[0]);
      try {
        loadEdgeConfig({ NODE_ENV: "test", ...env });
      } catch (error) {
        expect((error as Error).message).not.toContain(value);
      }
    }
  });
});

describe("drainOnSignals", () => {
  function fakeProcess() {
    const listeners = new Map<string, () => void>();
    const exits: number[] = [];
    const proc: SignalProcess = {
      on: (event, listener) => listeners.set(event, listener),
      exit: (code) => exits.push(code),
    };
    return { proc, exits, signal: (name: string) => listeners.get(name)?.() };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("drains once on SIGTERM and exits 0", async () => {
    const { proc, exits, signal } = fakeProcess();
    let drains = 0;
    drainOnSignals(
      () => {
        drains++;
        return Promise.resolve();
      },
      () => undefined,
      proc,
    );
    signal("SIGTERM");
    await tick();
    expect([drains, exits]).toEqual([1, [0]]);
  });

  it("exits 1 on a second signal or a failed drain", async () => {
    const first = fakeProcess();
    drainOnSignals(() => new Promise(() => undefined), () => undefined, first.proc);
    first.signal("SIGINT");
    first.signal("SIGTERM");
    expect(first.exits).toEqual([1]);

    const failing = fakeProcess();
    const logged: string[] = [];
    drainOnSignals(() => Promise.reject(new Error("close failed")), (m) => logged.push(m), failing.proc);
    failing.signal("SIGTERM");
    await tick();
    expect(failing.exits).toEqual([1]);
    expect(logged).toContain("drain failed: close failed");
  });
});
