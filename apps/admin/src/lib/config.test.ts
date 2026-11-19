import { describe, expect, it } from "vitest";
import { adminOrigin, AdminConfigError, loadAdminConfig, parseAuthSecrets, parseOrigin } from "./config.ts";

/** 64 hex characters, as provisioning generates (test values only). */
const SECRET = "a1".repeat(32);
const SECRET_2 = "b2".repeat(32);
const DB = "postgres://ebt_admin:pw@127.0.0.1:5432/ebooktrivia"; // test value only
const ORIGIN = "https://admin.example.test"; // reserved TLD (RFC 2606), test value only

describe("parseOrigin", () => {
  it("accepts an exact https origin, with or without a port", () => {
    expect(parseOrigin(ORIGIN, false)).toBe(ORIGIN);
    expect(parseOrigin("https://admin.example.test:8443", false)).toBe("https://admin.example.test:8443");
  });

  it("accepts http only on a loopback host and only with the explicit flag", () => {
    for (const loopback of ["http://127.0.0.1:3200", "http://localhost:3200", "http://[::1]:3200"]) {
      expect(parseOrigin(loopback, false), loopback).toBeNull();
      expect(parseOrigin(loopback, true), loopback).toBe(loopback);
    }
    expect(parseOrigin("http://admin.example.test", true)).toBeNull();
    expect(parseOrigin("http://10.0.0.5:3200", true)).toBeNull();
    expect(parseOrigin("http://127.0.0.2:3200", true)).toBeNull();
  });

  it.each([
    "https://admin.example.test/",
    "https://admin.example.test/login",
    "https://admin.example.test?x=1",
    "https://admin.example.test#x",
    "https://user:pw@admin.example.test",
    "HTTPS://admin.example.test",
    "https://ADMIN.example.test",
    "https://admin.example.test:443",
    "ftp://admin.example.test",
    "admin.example.test",
    "null",
    "",
  ])("rejects a non-canonical or non-origin value: %s", (raw) => {
    expect(parseOrigin(raw, true)).toBeNull();
  });

  it("returns null when unset", () => {
    expect(parseOrigin(undefined, true)).toBeNull();
  });
});

describe("adminOrigin", () => {
  it("is null when ADMIN_ORIGIN is unset or invalid", () => {
    expect(adminOrigin({ NODE_ENV: "production" })).toBeNull();
    expect(adminOrigin({ NODE_ENV: "production", ADMIN_ORIGIN: "http://127.0.0.1:3200" })).toBeNull();
    expect(adminOrigin({ NODE_ENV: "development", ADMIN_ORIGIN: "http://127.0.0.1:3200" })).toBeNull();
    expect(adminOrigin({ NODE_ENV: "production", ADMIN_ORIGIN: "http://127.0.0.1:3200", ADMIN_ALLOW_INSECURE_LOOPBACK: "1" })).toBe("http://127.0.0.1:3200");
  });

  it("requires NODE_ENV and a well-formed flag", () => {
    expect(() => adminOrigin({ ADMIN_ORIGIN: ORIGIN })).toThrow(AdminConfigError);
    expect(() => adminOrigin({ NODE_ENV: "staging", ADMIN_ORIGIN: ORIGIN })).toThrow(AdminConfigError);
    expect(() => adminOrigin({ NODE_ENV: "test", ADMIN_ORIGIN: ORIGIN, ADMIN_ALLOW_INSECURE_LOOPBACK: "yes" })).toThrow(AdminConfigError);
  });
});

describe("parseAuthSecrets", () => {
  it("parses versioned secrets newest first", () => {
    expect(parseAuthSecrets(`2:${SECRET_2}, 1:${SECRET}`)).toEqual([
      { version: 2, value: SECRET_2 },
      { version: 1, value: SECRET },
    ]);
    expect(parseAuthSecrets(`1:${SECRET.toUpperCase()}`)).toEqual([{ version: 1, value: SECRET.toUpperCase() }]);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["no version", SECRET],
    ["63 hex characters", `1:${SECRET.slice(1)}`],
    ["65 hex characters", `1:${SECRET}a`],
    ["not hex", `1:${"x".repeat(64)}`],
    ["32 characters (the old minimum)", `1:${"x".repeat(32)}`],
    ["a repeated version", `1:${SECRET},1:${SECRET_2}`],
    ["the same secret under two versions", `2:${SECRET},1:${SECRET}`],
    ["the same secret in another case", `2:${SECRET.toUpperCase()},1:${SECRET}`],
    ["a bad version", `x:${SECRET}`],
    ["a negative version", `-1:${SECRET}`],
    ["a trailing comma", `1:${SECRET},`],
  ])("refuses %s", (_label, raw) => {
    expect(() => parseAuthSecrets(raw)).toThrow(AdminConfigError);
  });
});

describe("loadAdminConfig", () => {
  const env = { NODE_ENV: "production", ADMIN_ORIGIN: ORIGIN, ADMIN_AUTH_SECRETS: `1:${SECRET}`, DATABASE_URL_ADMIN: DB };

  it("parses a complete production environment", () => {
    expect(loadAdminConfig(env)).toEqual({ production: true, origin: ORIGIN, authSecrets: [{ version: 1, value: SECRET }], databaseUrl: DB });
  });

  it.each([
    [{ ADMIN_ORIGIN: undefined }, "ADMIN_ORIGIN"],
    [{ ADMIN_ORIGIN: "http://admin.example.test" }, "ADMIN_ORIGIN"],
    [{ ADMIN_ORIGIN: "http://127.0.0.1:3200" }, "ADMIN_ORIGIN"],
    [{ ADMIN_AUTH_SECRETS: undefined }, "ADMIN_AUTH_SECRETS"],
    [{ ADMIN_AUTH_SECRETS: `1:${"x".repeat(64)}` }, "ADMIN_AUTH_SECRETS"],
    [{ DATABASE_URL_ADMIN: undefined }, "DATABASE_URL_ADMIN"],
    [{ DATABASE_URL_ADMIN: "mysql://x" }, "DATABASE_URL_ADMIN"],
    [{ DATABASE_URL_ADMIN: "not a url" }, "DATABASE_URL_ADMIN"],
    [{ NODE_ENV: undefined }, "NODE_ENV"],
  ])("fails on %o, naming the variable only", (override, name) => {
    let error: unknown;
    try {
      loadAdminConfig({ ...env, ...override });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AdminConfigError);
    expect((error as Error).message).toContain(name);
    expect((error as Error).message).not.toContain("pw@");
    expect((error as Error).message).not.toContain("xxxxxxxx");
    expect((error as Error).message).not.toContain(SECRET);
  });
});
