import { describe, expect, it } from "vitest";
import { ConfigError } from "./env.ts";
import { DEV_FLAG_ENV, loadWorkerConfig } from "./worker-config.ts";

const BASE = {
  NODE_ENV: "development",
  DATABASE_URL_WORKER: "postgres://worker:pw@127.0.0.1:5432/app",
  VALKEY_URL: "redis://127.0.0.1:6379",
  VALKEY_USERNAME: "worker",
  VALKEY_PASSWORD: "pw",
};

const without = (env: Record<string, string>, ...names: string[]): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));

function configError(env: Record<string, string>): string {
  try {
    loadWorkerConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.message;
    throw e;
  }
  throw new Error("expected a ConfigError");
}

describe("loadWorkerConfig", () => {
  it("parses a minimal environment with the documented defaults", () => {
    const config = loadWorkerConfig(BASE);
    expect(config).toMatchObject({
      nodeEnv: "development",
      databaseUrl: BASE.DATABASE_URL_WORKER,
      valkey: { host: "127.0.0.1", port: 6379, db: 0, username: "worker", password: "pw", tls: false },
      prefix: "ebt",
      logLevel: "info",
      dev: { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: false },
      relayIntervalMs: 500,
      sweepIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      outboxStaleMs: 120_000,
      conversionLeaseMs: 60_000,
      conversionTimeoutMs: 5000,
      concurrency: 4,
      lockDurationMs: 30_000,
      stalledIntervalMs: 30_000,
    });
    expect(config.uptimeKuma).toBeUndefined();
    expect(config.failpoint).toBeUndefined();
  });

  it("reads TLS, the db index and every override", () => {
    const config = loadWorkerConfig({
      ...BASE,
      VALKEY_URL: "rediss://valkey.internal:6380/2",
      BULLMQ_PREFIX: "ebt-test_1",
      LOG_LEVEL: "warn",
      UPTIME_KUMA_PUSH_URL: "https://kuma.example.com/api/push/abc123?status=up",
      UPTIME_KUMA_ALLOW_PRIVATE_IP: "true",
      WORKER_RELAY_INTERVAL_MS: "100",
      WORKER_SWEEP_INTERVAL_MS: "250",
      WORKER_HEARTBEAT_INTERVAL_MS: "300",
      WORKER_OUTBOX_STALE_MS: "1000",
      WORKER_CONVERSION_LEASE_MS: "3000",
      WORKER_CONVERSION_TIMEOUT_MS: "1000",
      WORKER_CONCURRENCY: "8",
      WORKER_LOCK_DURATION_MS: "2000",
      WORKER_STALLED_INTERVAL_MS: "1000",
      WORKER_DEV_ALLOW_HTTP: "1",
      WORKER_DEV_ALLOW_LOOPBACK: "true",
      WORKER_DEV_ALLOW_PLAINTEXT_SMTP: "0",
      WORKER_FAILPOINT: "after_enqueue_before_mark",
    });
    expect(config).toMatchObject({
      valkey: { host: "valkey.internal", port: 6380, db: 2, tls: true },
      prefix: "ebt-test_1",
      logLevel: "warn",
      uptimeKuma: { allowPrivateIp: true },
      relayIntervalMs: 100,
      sweepIntervalMs: 250,
      heartbeatIntervalMs: 300,
      outboxStaleMs: 1000,
      conversionLeaseMs: 3000,
      conversionTimeoutMs: 1000,
      concurrency: 8,
      lockDurationMs: 2000,
      stalledIntervalMs: 1000,
      dev: { allowHttp: true, allowLoopback: true, allowPlaintextSmtp: false },
      failpoint: "after_enqueue_before_mark",
    });
    expect(config.uptimeKuma?.pushUrl.href).toBe("https://kuma.example.com/api/push/abc123?status=up");
  });

  it("fails fast on missing or malformed required values", () => {
    expect(configError({ ...BASE, DATABASE_URL_WORKER: "" })).toMatch(/DATABASE_URL_WORKER is required/);
    expect(configError({ ...BASE, DATABASE_URL_WORKER: "mysql://x/y" })).toMatch(/DATABASE_URL_WORKER must be a postgres:/);
    expect(configError({ ...BASE, DATABASE_URL_WORKER: "not a url" })).toMatch(/DATABASE_URL_WORKER must be a postgres:/);
    expect(configError(without(BASE, "VALKEY_URL"))).toMatch(/VALKEY_URL is required/);
    expect(configError({ ...BASE, VALKEY_URL: "http://127.0.0.1:6379" })).toMatch(/VALKEY_URL must be redis:/);
    expect(configError({ ...BASE, VALKEY_URL: "redis://u:p@127.0.0.1:6379" })).toMatch(/credentials/);
    expect(configError({ ...BASE, VALKEY_URL: "redis://127.0.0.1:6379/x" })).toMatch(/database index/);
    expect(configError({ ...BASE, VALKEY_URL: "redis://127.0.0.1:6379/1?x=1" })).toMatch(/query/);
    expect(configError({ ...BASE, VALKEY_URL: "redis://" })).toMatch(/VALKEY_URL must be redis:/);
    expect(configError({ ...BASE, VALKEY_URL: "redis://[::1" })).toMatch(/VALKEY_URL must be redis:/);
    expect(configError(without(BASE, "VALKEY_PASSWORD"))).toMatch(/VALKEY_USERNAME and VALKEY_PASSWORD go together/);
    expect(configError({ ...BASE, NODE_ENV: "staging" })).toMatch(/NODE_ENV must be one of/);
    expect(configError({ ...BASE, LOG_LEVEL: "verbose" })).toMatch(/LOG_LEVEL must be one of/);
    expect(configError({ ...BASE, BULLMQ_PREFIX: "ebt:x" })).toMatch(/BULLMQ_PREFIX/);
    expect(configError({ ...BASE, WORKER_RELAY_INTERVAL_MS: "10" })).toMatch(/WORKER_RELAY_INTERVAL_MS must be an integer in 50\.\.10000/);
    expect(configError({ ...BASE, WORKER_CONCURRENCY: "2.5" })).toMatch(/WORKER_CONCURRENCY must be an integer/);
    expect(configError({ ...BASE, WORKER_DEV_ALLOW_HTTP: "yes" })).toMatch(/WORKER_DEV_ALLOW_HTTP must be true, false, 1 or 0/);
    expect(configError({ ...BASE, WORKER_FAILPOINT: "nope" })).toMatch(/WORKER_FAILPOINT must be one of/);
    expect(configError({ ...BASE, WORKER_CONVERSION_LEASE_MS: "3000", WORKER_CONVERSION_TIMEOUT_MS: "1001" })).toMatch(
      /WORKER_CONVERSION_TIMEOUT_MS must be at least 2000 ms shorter than WORKER_CONVERSION_LEASE_MS/,
    );
    expect(configError({ ...BASE, UPTIME_KUMA_PUSH_URL: "kuma" })).toMatch(/UPTIME_KUMA_PUSH_URL must be an http\(s\) URL/);
    expect(configError({ ...BASE, UPTIME_KUMA_PUSH_URL: "http://kuma.example.com/api/push/x" })).toMatch(/https/);
  });

  it("never echoes a secret value in its errors", () => {
    expect(configError({ ...BASE, DATABASE_URL_WORKER: "mysql://worker:hunter2@db/app" })).not.toContain("hunter2");
    expect(configError({ ...BASE, VALKEY_URL: "redis://u:hunter2@127.0.0.1:6379" })).not.toContain("hunter2");
  });

  // Carry-over A9: the safe-fetch / SMTP dev flags (allowHttp, devAllowLoopback, devAllowPlaintext)
  // and the chaos-test failpoint must never be active in production.
  describe("A9: production refuses every dev-only flag", () => {
    // Security review US-013 #2: NODE_ENV defaulted to development, so an unset NODE_ENV let the
    // dev flags through in production.
    it("requires NODE_ENV, so the dev-flag guard cannot fail open", () => {
      expect(configError({ ...without(BASE, "NODE_ENV"), WORKER_DEV_ALLOW_LOOPBACK: "1" })).toMatch(/NODE_ENV is required/);
      expect(configError({ ...BASE, NODE_ENV: "" })).toMatch(/NODE_ENV is required/);
    });

    const PRODUCTION = { ...BASE, NODE_ENV: "production" };

    it("starts in production without them, and requires Valkey credentials there", () => {
      expect(loadWorkerConfig(PRODUCTION).nodeEnv).toBe("production");
      expect(configError(without(PRODUCTION, "VALKEY_USERNAME", "VALKEY_PASSWORD"))).toMatch(
        /VALKEY_USERNAME and VALKEY_PASSWORD are required in production/,
      );
    });

    it.each([...DEV_FLAG_ENV])("refuses %s in production, whatever its value", (name) => {
      for (const value of ["true", "1", "false", "0", "after_enqueue_before_mark"]) {
        expect(configError({ ...PRODUCTION, [name]: value })).toMatch(new RegExp(`${name} is a dev-only flag`));
      }
    });

    it("lists the dev flags the adapters know", () => {
      expect([...DEV_FLAG_ENV].sort()).toEqual([
        "WORKER_DEV_ALLOW_HTTP",
        "WORKER_DEV_ALLOW_LOOPBACK",
        "WORKER_DEV_ALLOW_PLAINTEXT_SMTP",
        "WORKER_FAILPOINT",
      ]);
    });

    it("lets an http push URL through only with the dev http flag, outside production", () => {
      const url = "http://127.0.0.1:3001/api/push/x";
      expect(configError({ ...BASE, UPTIME_KUMA_PUSH_URL: url })).toMatch(/https/);
      expect(loadWorkerConfig({ ...BASE, UPTIME_KUMA_PUSH_URL: url, WORKER_DEV_ALLOW_HTTP: "true" }).uptimeKuma?.pushUrl.protocol).toBe(
        "http:",
      );
    });
  });
});
