import { describe, expect, it } from "vitest";
import { ConfigError } from "./env.ts";
import { INTERNAL_ENV, loadInternalConfig, RUNTIME_ENV } from "./internal-config.ts";

const TOKEN_SHA256 = "a".repeat(64);
const BASE = {
  NODE_ENV: "production",
  DATABASE_URL_INTERNAL: "postgres://internal:pw@127.0.0.1:5432/app",
  GLITCHTIP_HOOK_TOKEN_SHA256: TOKEN_SHA256,
};

function configError(env: Record<string, string>): string {
  try {
    loadInternalConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.message;
    throw e;
  }
  throw new Error("expected a ConfigError");
}

describe("loadInternalConfig", () => {
  it("parses a minimal environment with the documented defaults", () => {
    const config = loadInternalConfig(BASE);
    expect(config).toEqual({
      nodeEnv: "production",
      databaseUrl: BASE.DATABASE_URL_INTERNAL,
      hookTokenSha256: Buffer.from(TOKEN_SHA256, "hex"),
      host: "127.0.0.1",
      port: 9000,
      domainsReloadMs: 60_000,
      hookRatePerMinute: 60,
      logLevel: "info",
    });
  });

  it("reads the bind address and the overrides", () => {
    const config = loadInternalConfig({
      ...BASE,
      GLITCHTIP_HOOK_TOKEN_SHA256: "AB".repeat(32),
      INTERNAL_HOST: "0.0.0.0",
      INTERNAL_PORT: "0",
      INTERNAL_DOMAINS_RELOAD_MS: "500",
      INTERNAL_HOOK_RATE_PER_MINUTE: "5",
      LOG_LEVEL: "silent",
    });
    expect(config).toMatchObject({ host: "0.0.0.0", port: 0, domainsReloadMs: 500, hookRatePerMinute: 5, logLevel: "silent" });
    expect(config.hookTokenSha256.toString("hex")).toBe("ab".repeat(32));
    expect(loadInternalConfig({ ...BASE, INTERNAL_HOST: "::1" }).host).toBe("::1");
  });

  it("requires NODE_ENV (security review US-013 #2)", () => {
    expect(configError({ DATABASE_URL_INTERNAL: BASE.DATABASE_URL_INTERNAL, GLITCHTIP_HOOK_TOKEN_SHA256: TOKEN_SHA256 })).toMatch(/NODE_ENV is required/);
    expect(configError({ ...BASE, NODE_ENV: "staging" })).toMatch(/NODE_ENV must be one of/);
  });

  it("fails fast on missing or malformed values", () => {
    expect(configError({ ...BASE, DATABASE_URL_INTERNAL: "" })).toMatch(/DATABASE_URL_INTERNAL is required/);
    expect(configError({ ...BASE, GLITCHTIP_HOOK_TOKEN_SHA256: "abc" })).toMatch(/64 hex characters/);
    expect(configError({ ...BASE, GLITCHTIP_HOOK_TOKEN_SHA256: "g".repeat(64) })).toMatch(/64 hex characters/);
    expect(configError({ ...BASE, INTERNAL_HOST: "localhost" })).toMatch(/INTERNAL_HOST must be an IP address/);
    expect(configError({ ...BASE, INTERNAL_PORT: "70000" })).toMatch(/INTERNAL_PORT must be an integer in 0\.\.65535/);
  });

  // "Holds no keys, and no worker env vars accepted": a misplaced worker.env line must stop the
  // internal process instead of silently putting a key into it.
  it.each([
    "DATABASE_URL",
    "DATABASE_URL_WORKER",
    "DATABASE_URL_PUBLIC",
    "SECRETS_PAYMENT_PRIVATE_KEY",
    "SECRETS_CONVERSIONS_PUBLIC_KEY",
    "VALKEY_URL",
    "VALKEY_PASSWORD",
    "WORKER_DEV_ALLOW_HTTP",
    "UPTIME_KUMA_PUSH_URL",
    "GLITCHTIP_HOOK_TOKEN",
    "MIDTRANS_SERVER_KEY",
    "SOME_SIGNING_PRIVATE_KEY",
  ])("refuses to start when %s is present, without reading its value", (name) => {
    const reads: string[] = [];
    const env = new Proxy(
      { ...BASE, [name]: "hunter2" },
      {
        get(target, key: string) {
          reads.push(key);
          return target[key as keyof typeof target];
        },
      },
    );
    let message = "";
    try {
      loadInternalConfig(env);
    } catch (e) {
      message = e instanceof ConfigError ? e.message : "not a ConfigError";
    }
    expect(message).toMatch(new RegExp(`^${name}: not accepted by the internal process`));
    expect(message).not.toContain("hunter2");
    expect(reads).not.toContain(name);
  });

  // Security review US-013 #3a: an allowlist, not a denylist, so a key under any name is refused.
  it.each(["SENTRY_DSN", "AWS_SECRET_ACCESS_KEY", "npm_config__authToken", "SOME_API_KEY", "PGPASSWORD", "RECORD_GRAPH_FILE", "FOO"])(
    "refuses %s, a name outside its allowlist",
    (name) => {
      expect(configError({ ...BASE, [name]: "hunter2" })).toBe(`${name}: not accepted by the internal process (it holds no keys or other roles' settings)`);
    },
  );

  it("accepts the fixed runtime names next to its own", () => {
    const runtime = Object.fromEntries(RUNTIME_ENV.map((name) => [name, "x"]));
    expect(loadInternalConfig({ ...BASE, ...runtime }).nodeEnv).toBe("production");
  });

  // The names rootless podman 5.8 gives the internal quadlet's container (infra/quadlet/
  // internal.container, observed in infra/verify/local/stack-sim.sh) next to internal.env.
  it("accepts the environment of its podman container", () => {
    const podman = { HOME: "/home/node", HOSTNAME: "internal", NODE_VERSION: "26.13.0", PATH: "/usr/local/bin:/usr/bin", PWD: "/app", container: "podman" };
    expect(loadInternalConfig({ ...BASE, ...podman }).nodeEnv).toBe("production");
  });

  it("reads no environment variable outside its own list", () => {
    const reads = new Set<string>();
    const env = new Proxy(
      { ...BASE, PATH: "/usr/bin", HOME: "/home/app", TZ: "UTC" },
      {
        get(target, key: string) {
          reads.add(key);
          return target[key as keyof typeof target];
        },
      },
    );
    loadInternalConfig(env);
    expect([...reads].filter((k) => !(INTERNAL_ENV as readonly string[]).includes(k))).toEqual([]);
  });
});
