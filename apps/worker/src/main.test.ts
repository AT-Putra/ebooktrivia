import { describe, expect, it } from "vitest";
import { ConfigError } from "./env.ts";
import { main, parseRole } from "./main.ts";

describe("parseRole", () => {
  it("defaults to the worker and accepts --role=worker|internal", () => {
    expect(parseRole([])).toBe("worker");
    expect(parseRole(["--role=worker"])).toBe("worker");
    expect(parseRole(["--role=internal"])).toBe("internal");
  });

  it("refuses an unknown role or argument", () => {
    expect(() => parseRole(["--role=admin"])).toThrow(/--role must be worker or internal/);
    expect(() => parseRole(["--role"])).toThrow(/unknown argument/);
    expect(() => parseRole(["--verbose"])).toThrow(/unknown argument/);
    expect(() => parseRole(["--role=worker", "--role=internal"])).toThrow(/once/);
  });
});

describe("main", () => {
  // main() dynamically imports each role's whole module graph (bullmq, ioredis, postgres, hono).
  // The first, cold import takes about 1 s alone but passed the 5 s default while 69 suites ran in
  // parallel (failed the ralph gate on 2026-11-19), so this test gets its own budget. A real hang
  // still fails it.
  it("loads the chosen role and fails fast on its configuration", { timeout: 30_000 }, async () => {
    await expect(main(["--role=internal"], {})).rejects.toThrow(ConfigError);
    await expect(main(["--role=internal"], { NODE_ENV: "test" })).rejects.toThrow(/GLITCHTIP_HOOK_TOKEN_SHA256 is required/);
    await expect(main([], { NODE_ENV: "test" })).rejects.toThrow(/DATABASE_URL_WORKER is required/);
    await expect(main([], {})).rejects.toThrow(/NODE_ENV is required/);
  });
});
