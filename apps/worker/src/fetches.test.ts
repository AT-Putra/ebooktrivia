// Security review US-013 #6: only the heartbeat's fetch may reach the Kuma host on a private
// address; the fetch shared with consumers stays strict.
import { SafeFetchError } from "@ebooktrivia/adapters";
import { describe, expect, it } from "vitest";
import { createWorkerFetches } from "./fetches.ts";
import { loadWorkerConfig } from "./worker-config.ts";

const ENV = {
  NODE_ENV: "test",
  DATABASE_URL_WORKER: "postgres://worker:pw@127.0.0.1:5432/app",
  VALKEY_URL: "redis://127.0.0.1:6379",
  UPTIME_KUMA_PUSH_URL: "https://kuma.internal:3001/api/push/x",
  UPTIME_KUMA_ALLOW_PRIVATE_IP: "true",
};
// A private address that never answers: an allowed request times out, a refused one never connects.
const resolver = () => Promise.resolve([{ address: "10.255.255.1", family: 4 as const }]);

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SafeFetchError) return e.code;
    throw e;
  }
  throw new Error("expected the request to fail");
}

describe("createWorkerFetches", () => {
  it("gives the Kuma private-IP allowlist to the heartbeat fetch only", async () => {
    const { safeFetch, heartbeatFetch } = createWorkerFetches(loadWorkerConfig(ENV), { resolver, timeoutMs: 300 });
    try {
      expect(await failure(safeFetch("https://kuma.internal:3001/api/push/x"))).toBe("blocked_address");
      expect(await failure(heartbeatFetch("https://kuma.internal:3001/api/push/x"))).toBe("timeout");
      expect(await failure(heartbeatFetch("https://other.internal:3001/"))).toBe("blocked_address");
    } finally {
      await Promise.all([safeFetch.close(), heartbeatFetch.close()]);
    }
  });

  it("keeps both strict without the Kuma private-IP flag", async () => {
    const { safeFetch, heartbeatFetch } = createWorkerFetches(loadWorkerConfig({ ...ENV, UPTIME_KUMA_ALLOW_PRIVATE_IP: "false" }), { resolver, timeoutMs: 300 });
    try {
      expect(await failure(safeFetch("https://kuma.internal:3001/api/push/x"))).toBe("blocked_address");
      expect(await failure(heartbeatFetch("https://kuma.internal:3001/api/push/x"))).toBe("blocked_address");
    } finally {
      await Promise.all([safeFetch.close(), heartbeatFetch.close()]);
    }
  });
});
