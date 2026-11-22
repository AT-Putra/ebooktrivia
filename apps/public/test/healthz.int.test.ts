// GET /healthz (US-015) through the route handler, on the real process-wide runtime: the public_rw pool, the `public`
// Valkey user (PING is in its allowlist) and the worker's heartbeat row. The answer is a fixed body: nothing about the
// dependencies leaks, and every answer is no-store.
import { randomBytes } from "node:crypto";
import { generateScopeKeyPair } from "@ebooktrivia/crypto";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { GET } from "../src/app/healthz/route.ts";
import { getRuntime } from "../src/lib/runtime.ts";
import { DOMAIN, root } from "./support.ts";

const stderr = vi.spyOn(process.stderr, "write");

const setBeat = async (interval: string | null): Promise<void> => {
  await root`DELETE FROM public.heartbeats WHERE component = 'worker'`;
  if (interval !== null) await root`INSERT INTO public.heartbeats (component, beat_at) VALUES ('worker', now() - ${interval}::interval)`;
};

const answer = async (): Promise<{ status: number; body: unknown; cache: string | null }> => {
  const response = await GET();
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
};

beforeAll(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DOMAIN", DOMAIN);
  vi.stubEnv("DATABASE_URL_PUBLIC", inject("publicDbUrl"));
  vi.stubEnv("VALKEY_URL", inject("valkeyUrl"));
  vi.stubEnv("VALKEY_USERNAME", inject("valkeyUsername"));
  vi.stubEnv("VALKEY_PASSWORD", inject("valkeyPassword"));
  vi.stubEnv("SECRETS_PAYMENT_PRIVATE_KEY", inject("paymentPrivateKey"));
  vi.stubEnv("CAPTCHA_HMAC_KEY", randomBytes(32).toString("hex"));
  vi.stubEnv("PLAYER_AUTH_SECRETS", `1:${randomBytes(32).toString("hex")}`);
  vi.stubEnv("PLAYER_OTP_PEPPER", randomBytes(32).toString("hex"));
  vi.stubEnv("SECRETS_MESSAGING_PUBLIC_KEY", generateScopeKeyPair().publicKey.toString("base64url"));
  stderr.mockImplementation(() => true);
});

afterAll(async () => {
  await (await getRuntime()).close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /healthz", () => {
  it('answers 200 {"status":"ok"} with a fresh worker heartbeat, a reachable database and Valkey', async () => {
    await setBeat("10 seconds");
    expect(await answer()).toEqual({ status: 200, body: { status: "ok" }, cache: "no-store" });
  });

  it('answers 503 {"status":"degraded"} when the worker heartbeat is stale, and when there is none', async () => {
    await setBeat("5 minutes");
    expect(await answer()).toEqual({ status: 503, body: { status: "degraded" }, cache: "no-store" });
    await setBeat(null);
    expect(await answer()).toEqual({ status: 503, body: { status: "degraded" }, cache: "no-store" });
  });

  it("answers 200 again once the worker beats", async () => {
    await setBeat("1 second");
    expect((await answer()).status).toBe(200);
  });

  it("answers 503 when Valkey is gone, naming nothing", async () => {
    await setBeat("1 second");
    (await getRuntime()).order.valkey.disconnect();
    const lines: string[] = [];
    stderr.mockImplementation((chunk) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
    const response = await answer();
    expect(response).toEqual({ status: 503, body: { status: "degraded" }, cache: "no-store" });
    // The server's own log names the failed probe, never a host, a version or an error text.
    expect(lines.join("")).toContain('"event":"healthz.degraded"');
    expect(lines.join("")).toContain('"kind":"valkey"');
  });
});
