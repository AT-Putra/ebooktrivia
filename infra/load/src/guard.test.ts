import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { assertLoadTarget, checkEnvironment, checkMarkers, checkResolved, checkWhatsAppOff, databaseHost, LoadGuardError, RUN_ID } from "./guard.ts";

const URL_LOCAL = "postgres://postgres:pw@127.0.0.1:55432/ebooktrivia";

describe("load guard: environment and host", () => {
  it("accepts an explicit dev target on loopback", () => {
    expect(checkEnvironment(URL_LOCAL, { LOAD_TARGET_ENV: "dev" })).toEqual([]);
    expect(checkEnvironment("postgres://u:p@localhost/db", { LOAD_TARGET_ENV: "staging" })).toEqual([]);
    expect(checkEnvironment("postgres://u:p@[::1]:5432/db", { LOAD_TARGET_ENV: "staging" })).toEqual([]);
  });

  it("refuses a missing, misspelt or production LOAD_TARGET_ENV", () => {
    for (const value of [undefined, "", "production", "prod", "Staging", "staging "]) {
      expect(checkEnvironment(URL_LOCAL, { LOAD_TARGET_ENV: value }), String(value)).toHaveLength(1);
    }
  });

  it("refuses a remote host unless it is listed, and only the exact host", () => {
    const remote = "postgres://u:p@db.example.net:5432/ebooktrivia";
    expect(checkEnvironment(remote, { LOAD_TARGET_ENV: "staging" })).toHaveLength(1);
    expect(checkEnvironment(remote, { LOAD_TARGET_ENV: "staging", LOAD_ALLOWED_DB_HOSTS: "db.example.net" })).toEqual([]);
    expect(checkEnvironment(remote, { LOAD_TARGET_ENV: "staging", LOAD_ALLOWED_DB_HOSTS: "other.example.net, DB.EXAMPLE.NET" })).toEqual([]);
    expect(checkEnvironment(remote, { LOAD_TARGET_ENV: "staging", LOAD_ALLOWED_DB_HOSTS: "example.net" })).toHaveLength(1);
    expect(checkEnvironment("postgres://u:p@10.89.51.2/db", { LOAD_TARGET_ENV: "staging", LOAD_ALLOWED_DB_HOSTS: "10.89.51.2" })).toEqual([]);
  });

  it("refuses a URL without a host (a socket path) and reports every problem at once", () => {
    expect(databaseHost("postgres:///db?host=/var/run/postgresql")).toBe("");
    // no host at all, and a `host` parameter: two reasons, both reported
    expect(checkEnvironment("postgres:///db?host=/var/run/postgresql", { LOAD_TARGET_ENV: "staging" })).toHaveLength(2);
    expect(checkEnvironment("not a url", {})).toHaveLength(2);
  });

  // Review item 1: postgres.js lets `?host=` (and `hostaddr`) override the URL's own host, so a loopback host in the URL proved nothing.
  it("refuses a host or hostaddr query parameter, whatever the host in the URL and however it is spelt", () => {
    const env = { LOAD_TARGET_ENV: "staging" } as const;
    for (const url of [
      "postgres://u:p@127.0.0.1/db?host=prod.example.net",
      "postgres://u:p@127.0.0.1/db?HOST=prod.example.net",
      "postgres://u:p@127.0.0.1/db?hostaddr=203.0.113.9",
      "postgres://u:p@127.0.0.1/db?sslmode=require&host=/var/run/postgresql",
      "postgres://u:p@localhost:5432/db?host=127.0.0.1",
    ]) {
      expect(
        checkEnvironment(url, env).some((p) => /query parameter/.test(p)),
        url,
      ).toBe(true);
    }
    // other parameters are fine
    expect(checkEnvironment("postgres://u:p@127.0.0.1/db?sslmode=require&application_name=load", env)).toEqual([]);
  });

  it("refuses a list of hosts and a socket path", () => {
    const env = { LOAD_TARGET_ENV: "staging", LOAD_ALLOWED_DB_HOSTS: "db.example.net" } as const;
    expect(checkEnvironment("postgres://u:p@127.0.0.1,db.example.net/db", env).length).toBeGreaterThanOrEqual(1);
    expect(checkEnvironment("postgres://u:p@127.0.0.1,db.example.net/db", env).some((p) => /more than one host/.test(p))).toBe(true);
    expect(checkEnvironment("postgres://u:p@db.example.net,127.0.0.1:5433/db", env).some((p) => /more than one host/.test(p))).toBe(true);
    expect(checkEnvironment("postgres://u@%2Fvar%2Frun%2Fpostgresql/db", env).length).toBeGreaterThanOrEqual(1);
    expect(checkEnvironment("postgres:///db", env)).toHaveLength(1);
  });
});

describe("load guard: what postgres.js resolved", () => {
  const env = { LOAD_TARGET_ENV: "staging" } as const;

  it("accepts one loopback host, or a listed one, and no socket path", () => {
    expect(checkResolved({ host: ["127.0.0.1"], path: false }, env)).toEqual([]);
    expect(checkResolved({ host: ["10.89.51.2"], path: undefined }, { ...env, LOAD_ALLOWED_DB_HOSTS: "10.89.51.2" })).toEqual([]);
    expect(checkResolved(undefined, env)).toEqual([]);
  });

  it("refuses a resolved host that is neither, several hosts, a socket path and a non-string", () => {
    expect(checkResolved({ host: ["prod.example.net"], path: false }, env)).toHaveLength(1);
    expect(checkResolved({ host: ["127.0.0.1", "prod.example.net"], path: false }, env).length).toBeGreaterThanOrEqual(2);
    expect(checkResolved({ host: ["127.0.0.1"], path: "/var/run/postgresql" }, env)).toHaveLength(1);
    expect(checkResolved({ host: [42], path: false }, env)).toHaveLength(1);
    expect(checkResolved({ host: ["/var/run/postgresql"], path: false }, env)).toHaveLength(1);
  });

  it("is what makes the real postgres.js client safe: a ?host= override resolves to the overriding host, which is refused", () => {
    // postgres() connects lazily: building the client reads the URL only. The URL check refuses this URL too; this proves the second line.
    const sql = postgres("postgres://u:p@127.0.0.1/db?host=prod.example.net", { max: 1 });
    try {
      expect(checkResolved((sql as unknown as { options: unknown }).options, env).length).toBeGreaterThanOrEqual(1);
    } finally {
      void sql.end({ timeout: 0 });
    }
    const fine = postgres("postgres://u:p@127.0.0.1:55432/db", { max: 1 });
    try {
      expect(checkResolved((fine as unknown as { options: unknown }).options, env)).toEqual([]);
    } finally {
      void fine.end({ timeout: 0 });
    }
  });
});

describe("load guard: WhatsApp must be off for a run that creates orders", () => {
  it("accepts no active session and a delay of an hour or more", () => {
    expect(checkWhatsAppOff(0, 3600)).toEqual([]);
    expect(checkWhatsAppOff(0, 86_400)).toEqual([]);
  });

  it("refuses an active session, a short, missing or malformed delay, each for its own reason", () => {
    expect(checkWhatsAppOff(1, 86_400)).toHaveLength(1);
    expect(checkWhatsAppOff(0, 3599)).toHaveLength(1);
    expect(checkWhatsAppOff(0, 180)).toHaveLength(1);
    expect(checkWhatsAppOff(0, undefined)).toHaveLength(1);
    expect(checkWhatsAppOff(0, "86400")).toHaveLength(1);
    expect(checkWhatsAppOff(2, 0)).toHaveLength(2);
  });
});

describe("load guard: run ids", () => {
  it("accepts exactly 8 lower-case hex digits (what seed.ts makes) and nothing else", () => {
    expect(RUN_ID.test("0a1b2c3d")).toBe(true);
    for (const bad of ["", "0A1B2C3D", "0a1b2c3", "0a1b2c3d4", "0a1b2c3g", "../../etc", "0a1b2c3d\n", "% OR 1=1"]) expect(RUN_ID.test(bad), bad).toBe(false);
  });
});

describe("load guard: the database's own markers", () => {
  const ok = new Map<string, unknown>([
    ["midtrans.environment", "sandbox"],
    ["deployment.environment", "staging"],
  ]);

  it("accepts a sandbox database carrying the matching marker", () => {
    expect(checkMarkers(ok, "staging")).toEqual([]);
  });

  it("refuses a production Midtrans environment, even with the marker", () => {
    expect(checkMarkers(new Map([...ok, ["midtrans.environment", "production"]]), "staging")).toHaveLength(1);
  });

  it("refuses a database without the marker (the case of a production database before its Midtrans switch)", () => {
    expect(checkMarkers(new Map([["midtrans.environment", "sandbox"]]), "staging")).toHaveLength(1);
    expect(checkMarkers(new Map(), "staging")).toHaveLength(2);
  });

  it("refuses a marker that names another environment than the one asked for", () => {
    expect(checkMarkers(ok, "dev")).toHaveLength(1);
    expect(checkMarkers(new Map([...ok, ["deployment.environment", "production"]]), "staging")).toHaveLength(1);
  });
});

describe("assertLoadTarget", () => {
  const fakeSql = (rows: { key: string; value: unknown }[]) => (() => Promise.resolve(rows)) as unknown as Parameters<typeof assertLoadTarget>[0];

  it("reads nothing when the environment check already fails (no query for a wrong host)", async () => {
    let queried = false;
    const sql = (() => {
      queried = true;
      return Promise.resolve([]);
    }) as unknown as Parameters<typeof assertLoadTarget>[0];
    await expect(assertLoadTarget(sql, "postgres://u:p@prod.example.net/db", { LOAD_TARGET_ENV: "staging" })).rejects.toBeInstanceOf(LoadGuardError);
    expect(queried).toBe(false);
  });

  it("returns the environment for a marked database and throws for an unmarked one", async () => {
    const good = fakeSql([
      { key: "midtrans.environment", value: "sandbox" },
      { key: "deployment.environment", value: "dev" },
    ]);
    await expect(assertLoadTarget(good, URL_LOCAL, { LOAD_TARGET_ENV: "dev" })).resolves.toBe("dev");
    const bad = fakeSql([{ key: "midtrans.environment", value: "production" }]);
    await expect(assertLoadTarget(bad, URL_LOCAL, { LOAD_TARGET_ENV: "dev" })).rejects.toThrow(/midtrans\.environment/);
  });
});
