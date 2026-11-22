// GET /healthz of the console (US-015): the route handler on a real PostgreSQL (the admin_rw login, the worker's
// heartbeat row) and a real Valkey (the ACL user `admin` of the dev stack; PING is in its allowlist). The answer is
// a fixed body whatever fails, and a Valkey that is missing or unreachable is a degraded answer, not an error.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/healthz/route.ts";
import { adminHealth } from "../src/lib/health.ts";
import { type AuthRuntime } from "../src/lib/auth/runtime.ts";
import { newRuntime, root } from "./support.ts";

const KEY = Symbol.for("ebooktrivia.admin.health.valkey");
type Holder = { [KEY]?: { disconnect: () => void } | undefined };

// DEV ONLY defaults: the local dev stack (infra/dev/valkey/users.acl); CI starts the same ACL.
const VALKEY_URL = process.env["TEST_VALKEY_URL"] ?? "redis://127.0.0.1:56379";
const VALKEY_USERNAME = process.env["TEST_VALKEY_ADMIN_USERNAME"] ?? "admin";
const VALKEY_PASSWORD = process.env["TEST_VALKEY_ADMIN_PASSWORD"] ?? "admin-devonly";

let rt: AuthRuntime;
const stderr = vi.spyOn(process.stderr, "write");
vi.mock("../src/lib/next/runtime.ts", () => ({ getRuntime: () => Promise.resolve(rt) }));

/** The next probe builds its Valkey client again, from the environment as it is then. */
const forgetClient = (): void => {
  const holder = globalThis as Holder;
  holder[KEY]?.disconnect();
  holder[KEY] = undefined;
};

const setBeat = async (interval: string | null): Promise<void> => {
  await root`DELETE FROM public.heartbeats WHERE component = 'worker'`;
  if (interval !== null) await root`INSERT INTO public.heartbeats (component, beat_at) VALUES ('worker', now() - ${interval}::interval)`;
};

const answer = async (): Promise<{ status: number; body: unknown; cache: string | null }> => {
  const response = await GET();
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
};

beforeAll(() => {
  rt = newRuntime();
  stderr.mockImplementation(() => true);
});
afterEach(() => {
  forgetClient();
  vi.unstubAllEnvs();
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("GET /healthz (admin)", () => {
  it('answers 200 {"status":"ok"} with a fresh worker heartbeat, a reachable database and Valkey', async () => {
    vi.stubEnv("VALKEY_URL", VALKEY_URL);
    vi.stubEnv("VALKEY_USERNAME", VALKEY_USERNAME);
    vi.stubEnv("VALKEY_PASSWORD", VALKEY_PASSWORD);
    await setBeat("10 seconds");
    expect(await answer()).toEqual({ status: 200, body: { status: "ok" }, cache: "no-store" });
    expect(await adminHealth(rt.sql, { VALKEY_URL, VALKEY_USERNAME, VALKEY_PASSWORD })).toEqual({ ok: true, failed: [] });
  });

  it('answers 503 {"status":"degraded"} when the worker heartbeat is stale, and when there is none', async () => {
    vi.stubEnv("VALKEY_URL", VALKEY_URL);
    vi.stubEnv("VALKEY_USERNAME", VALKEY_USERNAME);
    vi.stubEnv("VALKEY_PASSWORD", VALKEY_PASSWORD);
    await setBeat("5 minutes");
    expect(await answer()).toEqual({ status: 503, body: { status: "degraded" }, cache: "no-store" });
    await setBeat(null);
    expect(await answer()).toEqual({ status: 503, body: { status: "degraded" }, cache: "no-store" });
  });

  it("answers 503 when Valkey is not configured, refuses a wrong password, or cannot be reached (a closed port), each quickly", async () => {
    await setBeat("1 second");
    const started = Date.now();
    vi.stubEnv("VALKEY_URL", "");
    expect(await answer()).toEqual({ status: 503, body: { status: "degraded" }, cache: "no-store" });
    forgetClient();
    vi.stubEnv("VALKEY_URL", VALKEY_URL);
    vi.stubEnv("VALKEY_USERNAME", VALKEY_USERNAME);
    vi.stubEnv("VALKEY_PASSWORD", "not-the-password");
    expect(await answer()).toEqual({ status: 503, body: { status: "degraded" }, cache: "no-store" });
    forgetClient();
    vi.stubEnv("VALKEY_URL", "redis://127.0.0.1:1");
    expect(await answer()).toEqual({ status: 503, body: { status: "degraded" }, cache: "no-store" });
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("names the failed probe in the server's log only", async () => {
    await setBeat(null);
    vi.stubEnv("VALKEY_URL", VALKEY_URL);
    vi.stubEnv("VALKEY_USERNAME", VALKEY_USERNAME);
    vi.stubEnv("VALKEY_PASSWORD", VALKEY_PASSWORD);
    const lines: string[] = [];
    stderr.mockImplementation((chunk) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
    expect(await answer()).toEqual({ status: 503, body: { status: "degraded" }, cache: "no-store" });
    expect(lines.join("")).toContain('"event":"admin.healthz_degraded"');
    expect(lines.join("")).toContain('"kind":"heartbeat"');
  });
});
