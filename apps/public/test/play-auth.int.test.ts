// US-026 (M9a): player login on play.<DOMAIN> against the real PostgreSQL (public_rw login), the real Valkey
// (ACL user `public`), the real stateless Cap provider and the real Better Auth player instance.
//   - the OTP request answers identically (status, body, headers, timing class, log line) for an eligible, a
//     non-eligible and an unknown phone, and only the eligible one gets a code: no row, no outbox, no user
//     for the others;
//   - the rate limits (10/h per IP, a 60 s cooldown and 3/h per phone, Valkey down = 503), Origin checks;
//   - the verify: HMAC store, 5 attempts, expiry, single use, one generic answer, __Host-play_session;
//   - magic links: consume by POST only, single use, refused after expiry, on replay and on the other channel;
//   - sessions: rotation when due, revoked on login and logout, the stock send-otp short-circuited.
import { randomBytes } from "node:crypto";
import type { CapChallenge } from "@ebooktrivia/adapters";
import { issueMagicLink, type MagicLinkChannel } from "@ebooktrivia/core";
import { createSecretOpener, createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { capProviders } from "../src/lib/cap-routes.ts";
import {
  createPlayAuth,
  EXPIRED_SESSION_COOKIE,
  PLAY_SESSION_COOKIE,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_ROTATION_GRACE_SECONDS,
  SESSION_SECONDS,
} from "../src/lib/play/auth.ts";
import { createPlayDb } from "../src/lib/play/db.ts";
import {
  handleLogout,
  handleMagicLink,
  handleMagicLinkResend,
  handleOtpRequest,
  handleOtpVerify,
  handlePlayCap,
  handleSession,
  loadOtpSettings,
  otpPhoneKey,
  PLAY_CAP_SCOPE,
  type PlayDeps,
  playJson,
  readPlayer,
  withPlayer,
} from "../src/lib/play/handlers.ts";
import { PLAY_LIMITS } from "../src/lib/play/limits.ts";
import { verifyStoredOtp } from "../src/lib/play/otp.ts";
import type { Valkey } from "../src/lib/valkey.ts";
import {
  CAPTCHA_KEY,
  capToken,
  captureLog,
  createShop,
  DOMAIN,
  freshIp,
  newCap,
  newValkey,
  one,
  publicSql,
  root,
  type Shop,
  SMALL_CHALLENGES,
  solve,
  uniquePhone,
  valkey,
  withSettings,
} from "./support.ts";

const PLAY_ORIGIN = `https://play.${DOMAIN}`;
const messaging = generateScopeKeyPair();
const sealer = createSecretSealer({ messaging: messaging.publicKey });
const workerOpener = createSecretOpener({ messaging: messaging.privateKey });
const PEPPER = randomBytes(32);
const playDb = createPlayDb(inject("publicDbUrl"));
afterAll(async () => {
  await playDb.close();
});

const auth = createPlayAuth({
  config: { playOrigin: PLAY_ORIGIN, playerAuthSecrets: [{ version: 1, value: randomBytes(32).toString("hex") }], otpPepper: PEPPER },
  sql: publicSql,
  db: playDb.db,
  log: () => undefined,
  maxAttempts: async () => (await loadOtpSettings(publicSql))["otp.max_attempts"],
});

interface TestDeps extends PlayDeps {
  readonly deferred: (() => Promise<void>)[];
  readonly logs: ReturnType<typeof captureLog>;
  /** Runs what the answers deferred (as Next.js does once they have been sent). */
  readonly drain: () => Promise<void>;
}

function playDeps(overrides: Partial<PlayDeps> = {}): TestDeps {
  const deferred: (() => Promise<void>)[] = [];
  const logs = captureLog();
  return {
    sql: publicSql,
    valkey,
    auth,
    capFor: capProviders(valkey, CAPTCHA_KEY, SMALL_CHALLENGES),
    sealer,
    otpPepper: PEPPER,
    playOrigin: PLAY_ORIGIN,
    dataDir: "/srv/data",
    log: logs.log,
    defer: (task) => deferred.push(task),
    deferred,
    logs,
    drain: async () => {
      for (const task of deferred.splice(0)) await task();
    },
    ...overrides,
  };
}

interface Req {
  readonly origin?: string | null;
  readonly ip?: string;
  readonly cookie?: string;
  readonly method?: string;
}
function playRequest(path: string, body: unknown, options: Req = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-for": options.ip ?? freshIp(), "user-agent": "play-int-test/1.0" };
  if (options.origin !== null) headers["origin"] = options.origin ?? PLAY_ORIGIN;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie !== undefined) headers["cookie"] = options.cookie;
  return new Request(`${PLAY_ORIGIN}${path}`, { method: options.method ?? "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

const playCapToken = () => capToken({ landingPageId: PLAY_CAP_SCOPE });
const otpRequest = async (phone: string, options: Req = {}) => playRequest("/api/v1/play/auth/otp", { phone, cap_token: await playCapToken() }, options);
/** A code check with a fresh play-scope Cap token (each is single use), or none / a junk one when `capToken` says so. */
const verifyRequest = async (phone: string, code: string, options: Req & { readonly capToken?: string | null } = {}) =>
  playRequest("/api/v1/play/auth/otp/verify", { phone, code, ...(options.capToken === null ? {} : { cap_token: options.capToken ?? (await playCapToken()) }) }, options);

let shop: Shop;
beforeAll(async () => {
  shop = await createShop();
});

async function player(eligible = true): Promise<{ id: string; phone: string }> {
  const phone = uniquePhone();
  const row = await one(root<{ id: string }[]>`INSERT INTO players (phone, name) VALUES (${phone}, 'Budi Santoso') RETURNING id`);
  await root`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${row.id}, ${shop.programId}, ${eligible ? new Date() : null}, ${eligible})`;
  return { id: row.id, phone };
}

const otpRows = (phone: string) => root<{ id: string; attempts: number }[]>`SELECT id, attempts FROM player_otps WHERE phone = ${phone}`;
const otpOutbox = (phone: string) => root<{ id: string; sealed: Buffer | null; payload: { otp_id: string } }[]>`SELECT id, sealed, payload FROM outbox WHERE topic = 'otp.send' AND payload->>'phone' = ${phone} ORDER BY created_at`;
const authUsers = async (phone: string): Promise<number> => (await root`SELECT 1 FROM player_auth."user" WHERE "phoneNumber" = ${phone}`).length;

/** The newest code sent to `phone`, opened as the worker opens it (the test holds the messaging private key). */
async function sentCode(phone: string): Promise<string> {
  const rows = await otpOutbox(phone);
  const last = rows.at(-1);
  if (last?.sealed == null) throw new Error("no sealed OTP in the outbox");
  return workerOpener.openOtp({ otpId: last.payload.otp_id, phone, sealed: last.sealed });
}

/** `name=value` of the session cookie in a response's Set-Cookie headers. */
function sessionCookie(response: Response): string {
  const header = response.headers.getSetCookie().find((c) => c.startsWith(`${PLAY_SESSION_COOKIE}=`));
  if (header === undefined) throw new Error("no session cookie set");
  return header.split(";")[0] ?? "";
}

async function loginWithOtp(phone: string, deps = playDeps()): Promise<Response> {
  expect((await handleOtpRequest(deps, await otpRequest(phone))).status).toBe(200);
  await deps.drain();
  return handleOtpVerify(deps, await verifyRequest(phone, await sentCode(phone)));
}

/** The player a request's session maps to, through withPlayer (what US-027's routes use), and its cookies. */
async function resolvePlayer(deps: PlayDeps, headers: Headers): Promise<{ playerId: string | null; setCookies: string[] }> {
  const response = await withPlayer(deps, new Request(`${PLAY_ORIGIN}/api/v1/play/probe`, { headers }), (playerId) => Promise.resolve(playJson(200, { playerId })));
  const body = (await response.json()) as { playerId?: string };
  return { playerId: response.status === 200 ? (body.playerId ?? null) : null, setCookies: response.headers.getSetCookie() };
}

/** The session row behind a cookie value (`token.signature`). */
const tokenOf = (cookie: string): string => decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "";

let inspecting: Valkey | undefined;
/** A Valkey user that may DEL (the `public` user may not): only the tests use it, to let a cooldown pass. */
async function inspector(): Promise<Valkey> {
  inspecting ??= await newValkey(undefined, true);
  return inspecting;
}

const headerList = (response: Response): [string, string][] => [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const withoutRequestId = (line: string): string => line.replace(/"requestId":"[0-9a-f-]+",?/, "");

describe("OTP request: no enumeration", () => {
  it("answers an eligible, a non-eligible and an unknown phone identically; only the eligible one gets a code", async () => {
    const eligible = await player(true);
    const notEligible = await player(false);
    const unknown = uniquePhone();
    const answers: { status: number; body: string; headers: [string, string][]; log: string[] }[] = [];
    for (const phone of [eligible.phone, notEligible.phone, unknown]) {
      const deps = playDeps();
      const response = await handleOtpRequest(deps, await otpRequest(phone));
      answers.push({ status: response.status, body: await response.text(), headers: headerList(response), log: deps.logs.lines.map(withoutRequestId) });
      // The answer was made before the phone was looked up at all: nothing exists for it yet, and the one
      // piece of work left is deferred (the eligibility lookup and the issue, after the answer is sent).
      expect(await otpRows(phone)).toHaveLength(0);
      expect(await authUsers(phone)).toBe(0);
      expect(deps.deferred).toHaveLength(1);
      // Whatever happens after the answer (the eligibility lookup) logs nothing about the phone.
      await deps.drain();
      expect(deps.logs.lines.map(withoutRequestId)).toEqual(answers.at(-1)?.log);
    }
    expect(answers[0]).toMatchObject({ status: 200, body: JSON.stringify({ v: 1, status: "sent", resend_after_seconds: 60 }) });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(answers[0]?.headers.map(([name]) => name)).not.toContain("set-cookie");

    // The eligible phone: one HMAC row, one sealed outbox row, its player_auth user created first.
    expect(await otpRows(eligible.phone)).toHaveLength(1);
    expect(await otpOutbox(eligible.phone)).toHaveLength(1);
    expect(await authUsers(eligible.phone)).toBe(1);
    expect(await sentCode(eligible.phone)).toMatch(/^[0-9]{6}$/);
    // The others: nothing stored, nothing sent, no user.
    for (const phone of [notEligible.phone, unknown]) {
      expect(await otpRows(phone)).toHaveLength(0);
      expect(await otpOutbox(phone)).toHaveLength(0);
      expect(await authUsers(phone)).toBe(0);
    }
  });

  it("takes the same time for an eligible and an unknown phone (timing class, with tolerance)", async () => {
    const times = { eligible: [] as number[], unknown: [] as number[] };
    const deps = playDeps();
    for (let round = 0; round < 12; round++) {
      for (const kind of ["eligible", "unknown"] as const) {
        const phone = kind === "eligible" ? (await player(true)).phone : uniquePhone();
        const request = await otpRequest(phone);
        const started = performance.now();
        const response = await handleOtpRequest(deps, request);
        times[kind].push(performance.now() - started);
        expect(response.status).toBe(200);
        await deps.drain();
      }
    }
    const [e, u] = [median(times.eligible), median(times.unknown)];
    // The answer is sent before the phone is looked up, so both take the same path: equal within noise.
    expect(Math.abs(e - u)).toBeLessThanOrEqual(Math.max(15, 0.5 * Math.max(e, u)));
  });

  it("the stock send-otp is short-circuited: it stores nothing and sends nothing (R13)", async () => {
    const { phone } = await player(true);
    expect(await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: phone } })).toEqual({ status: true });
    expect(await root`SELECT 1 FROM player_auth.verification WHERE identifier LIKE ${`%${phone}%`}`).toHaveLength(0);
    expect(await otpRows(phone)).toHaveLength(0);
  });
});

describe("OTP request: rate limits and checks", () => {
  it("allows 10 requests per client IP per hour, then 429 with Retry-After (before the Cap check)", async () => {
    const deps = playDeps();
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await handleOtpRequest(deps, await otpRequest(uniquePhone(), { ip }))).status).toBe(200);
    const refused = await handleOtpRequest(deps, playRequest("/api/v1/play/auth/otp", { phone: uniquePhone(), cap_token: "junk" }, { ip }));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(3500);
    expect(await refused.json()).toMatchObject({ v: 1, error: "rate_limited" });
    // Another IP is not affected.
    expect((await handleOtpRequest(deps, await otpRequest(uniquePhone()))).status).toBe(200);
  });

  it("per phone: a 60 s cooldown, then 3 per hour, for every phone alike (eligible or not)", async () => {
    for (const phone of [(await player(true)).phone, uniquePhone()]) {
      const deps = playDeps();
      expect((await handleOtpRequest(deps, await otpRequest(phone))).status).toBe(200);
      const cooling = await handleOtpRequest(deps, await otpRequest(phone));
      expect(cooling.status).toBe(429);
      expect(Number(cooling.headers.get("retry-after"))).toBeLessThanOrEqual(60);
      // The cooldown passing (its key expiring) leaves the hourly count: 3 sends, the 4th refused.
      for (let sent = 1; sent < 3; sent++) {
        await (await inspector()).del(`rl:otp:cooldown:${otpPhoneKey(phone)}`);
        expect((await handleOtpRequest(deps, await otpRequest(phone))).status).toBe(200);
      }
      await (await inspector()).del(`rl:otp:cooldown:${otpPhoneKey(phone)}`);
      const capped = await handleOtpRequest(deps, await otpRequest(phone));
      expect(capped.status).toBe(429);
      expect(Number(capped.headers.get("retry-after"))).toBeGreaterThan(3500);
      await deps.drain();
    }
  });

  it("a junk or missing Cap token is refused and spends nothing of the phone's budget", async () => {
    const deps = playDeps();
    const { phone } = await player(true);
    for (const capTokenValue of ["junk", "", undefined]) {
      const response = await handleOtpRequest(deps, playRequest("/api/v1/play/auth/otp", { phone, ...(capTokenValue === undefined ? {} : { cap_token: capTokenValue }) }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ v: 1, error: "captcha" });
    }
    // An LP's Cap token does not work on the login page.
    const lpToken = await capToken(shop);
    expect((await handleOtpRequest(deps, playRequest("/api/v1/play/auth/otp", { phone, cap_token: lpToken }))).status).toBe(403);
    expect((await handleOtpRequest(deps, await otpRequest(phone))).status).toBe(200);
  });

  it("refuses a malformed phone (format only) with a field error", async () => {
    const deps = playDeps();
    const response = await handleOtpRequest(deps, playRequest("/api/v1/play/auth/otp", { phone: "12", cap_token: await playCapToken() }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ v: 1, error: "validation", fields: { phone: "not_indonesian" } });
    const notJson = await handleOtpRequest(deps, new Request(`${PLAY_ORIGIN}/x`, { method: "POST", headers: { origin: PLAY_ORIGIN, "content-type": "text/plain" }, body: "phone=1" }));
    expect(notJson.status).toBe(400);
  });

  it("limits a whole IPv6 /48 on top of its /64s (10x the per-client budget) for the code, verify and link routes", async () => {
    await withSettings({ "otp.ip_cap": 1, "otp.max_attempts": 1 }, async () => {
      const deps = playDeps({ verifyFloorMs: 0 });
      const routes = [
        (ip: string) => handleOtpRequest(deps, playRequest("/api/v1/play/auth/otp", { phone: uniquePhone(), cap_token: "junk" }, { ip })),
        async (ip: string) => handleOtpVerify(deps, await verifyRequest(uniquePhone(), "123456", { ip, capToken: null })),
        (ip: string) => handleMagicLink(deps, playRequest("/api/v1/play/auth/magic-link", { channel: "email", token: "x".repeat(43) }, { ip })),
      ];
      for (const call of routes) {
        const site = freshIp().split(":").slice(0, 3).join(":");
        for (let i = 1; i <= PLAY_LIMITS.ip48Factor; i++) expect((await call(`${site}:${i.toString(16)}::1`)).status).not.toBe(429);
        const refused = await call(`${site}:ff::1`);
        expect(refused.status).toBe(429);
      }
      expect(deps.logs.lines.filter((l) => l.includes("rate_limited_ip48"))).toHaveLength(3);
    });
  });

  it("the global send breaker: the same answer, nothing stored or sent, one persisted critical alert", async () => {
    // otp.global_send_cap (bounds 50..100000) is set to what this database has sent in the last 10 minutes,
    // with the bounds lifted for this test only and restored exactly as they were.
    const deps = playDeps();
    const warm = await player(true);
    expect((await handleOtpRequest(deps, await otpRequest(warm.phone))).status).toBe(200);
    await deps.drain();
    const [bounds] = await root<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'app_settings_bounds_check'`;
    await root`ALTER TABLE app_settings DROP CONSTRAINT app_settings_bounds_check`;
    try {
      const [recent] = await root<{ n: number }[]>`SELECT count(*)::int AS n FROM otp_enqueues WHERE enqueued_at > clock_timestamp() - interval '10 minutes'`;
      await root`UPDATE app_settings SET value = ${String(recent?.n ?? 1)}::text::jsonb WHERE key = 'otp.global_send_cap'`;
      await root`DELETE FROM alerts WHERE dedupe_key = 'otp_send_breaker'`;
      const blocked = await player(true);
      const response = await handleOtpRequest(deps, await otpRequest(blocked.phone));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(JSON.stringify({ v: 1, status: "sent", resend_after_seconds: 60 }));
      await deps.drain();
      expect(await otpRows(blocked.phone)).toHaveLength(0);
      expect(await otpOutbox(blocked.phone)).toHaveLength(0);
      expect(await root`SELECT 1 FROM alerts WHERE dedupe_key = 'otp_send_breaker' AND severity = 'critical' AND resolved_at IS NULL`).toHaveLength(1);
      expect(deps.logs.lines.join("")).not.toContain("otp_issue_failed");
    } finally {
      await root`UPDATE app_settings SET value = '500'::jsonb WHERE key = 'otp.global_send_cap'`;
      await root.unsafe(`ALTER TABLE app_settings ADD CONSTRAINT app_settings_bounds_check ${bounds?.def ?? ""}`);
    }
  });

  it("moves the sealed code into the outbox: player_otps keeps only the HMAC", async () => {
    const { phone } = await player(true);
    const deps = playDeps();
    expect((await handleOtpRequest(deps, await otpRequest(phone))).status).toBe(200);
    await deps.drain();
    expect(await root`SELECT 1 FROM player_otps WHERE phone = ${phone} AND sealed_code IS NULL`).toHaveLength(1);
    expect(await sentCode(phone)).toMatch(/^[0-9]{6}$/);
  });

  it("fails closed with 503 when Valkey is down (no code is issued)", async () => {
    const down: Valkey = await newValkey(1);
    const deps = playDeps({ valkey: down });
    const { phone } = await player(true);
    const response = await handleOtpRequest(deps, await otpRequest(phone));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ v: 1, error: "unavailable" });
    expect(deps.deferred).toHaveLength(0);
    expect(deps.logs.lines.join("")).toContain("valkey_unavailable");
  });
});

describe("Origin checks on every mutation", () => {
  it.each([
    ["no Origin", null],
    ["another origin", "https://evil.example.test"],
    ["the API origin", `https://api.${DOMAIN}`],
    ["plain http", `http://play.${DOMAIN}`],
  ])("refuses %s with 403 before anything is read", async (_name, origin) => {
    const deps = playDeps({ valkey: await newValkey(1) });
    const handlers = [
      () => handleOtpRequest(deps, playRequest("/api/v1/play/auth/otp", { phone: uniquePhone() }, { origin })),
      () => handleOtpVerify(deps, playRequest("/api/v1/play/auth/otp/verify", { phone: uniquePhone(), code: "123456" }, { origin })),
      () => handleMagicLink(deps, playRequest("/api/v1/play/auth/magic-link", { channel: "email", token: "x" }, { origin })),
      () => handleLogout(deps, playRequest("/api/v1/play/auth/logout", undefined, { origin })),
      () => handlePlayCap(deps, "challenge", playRequest("/api/v1/play/cap/challenge", undefined, { origin })),
      () => handlePlayCap(deps, "redeem", playRequest("/api/v1/play/cap/redeem", {}, { origin })),
    ];
    for (const call of handlers) {
      const response = await call();
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ v: 1, error: "origin" });
    }
  });
});

describe("OTP verify", () => {
  it("logs in with the code: __Host-play_session (Secure, HttpOnly, SameSite=Lax, Path=/, 30 days, no Domain); single use", async () => {
    const { id, phone } = await player(true);
    const deps = playDeps();
    expect((await handleOtpRequest(deps, await otpRequest(phone))).status).toBe(200);
    await deps.drain();
    const code = await sentCode(phone);
    const response = await handleOtpVerify(deps, await verifyRequest(phone, code));
    expect(response.status).toBe(200);
    // Whose account this is, masked (login CSRF, review L5): mask_phone's "****" + the last 3 digits.
    expect(await response.json()).toEqual({ v: 1, ok: true, phone_masked: `****${phone.slice(-3)}` });
    const [setCookie, ...others] = response.headers.getSetCookie();
    expect(others).toEqual([]);
    expect(setCookie).toMatch(new RegExp(`^${PLAY_SESSION_COOKIE}=[^;]+; Max-Age=${String(SESSION_SECONDS)}; Path=/; HttpOnly; Secure; SameSite=Lax$`));
    expect(setCookie).not.toMatch(/Domain=/i);
    const cookie = sessionCookie(response);
    expect((await resolvePlayer(deps, new Headers({ cookie }))).playerId).toBe(id);
    expect(await readPlayer(deps, new Headers({ cookie }))).toBe(id);
    // The code is gone: a replay is refused.
    expect(await otpRows(phone)).toHaveLength(0);
    const replay = await handleOtpVerify(deps, await verifyRequest(phone, code));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ v: 1, error: "invalid_code" });
  });

  it("allows 5 attempts per code (counted atomically, also in parallel); the right code then fails too", async () => {
    const { phone } = await player(true);
    const deps = playDeps();
    expect((await handleOtpRequest(deps, await otpRequest(phone))).status).toBe(200);
    await deps.drain();
    const code = await sentCode(phone);
    const wrong = code === "000000" ? "111111" : "000000";
    const results = await Promise.all(Array.from({ length: 7 }, () => verifyStoredOtp({ sql: publicSql, pepper: PEPPER, maxAttempts: 5 }, phone, wrong)));
    expect(results.every((r) => !r)).toBe(true);
    expect((await otpRows(phone))[0]?.attempts).toBe(5);
    expect((await handleOtpVerify(deps, await verifyRequest(phone, code))).status).toBe(400);
  });

  it("refuses an expired code, and a correct code of a player who is no longer eligible", async () => {
    const deps = playDeps();
    const expired = await player(true);
    expect((await handleOtpRequest(deps, await otpRequest(expired.phone))).status).toBe(200);
    await deps.drain();
    await root`UPDATE player_otps SET expires_at = clock_timestamp() - interval '1 second' WHERE phone = ${expired.phone}`;
    expect((await handleOtpVerify(deps, await verifyRequest(expired.phone, await sentCode(expired.phone)))).status).toBe(400);

    const refunded = await player(true);
    expect((await handleOtpRequest(deps, await otpRequest(refunded.phone))).status).toBe(200);
    await deps.drain();
    await root`UPDATE player_programs SET eligible = false WHERE player_id = ${refunded.id}`;
    const response = await handleOtpVerify(deps, await verifyRequest(refunded.phone, await sentCode(refunded.phone)));
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("answers a wrong code, an unknown phone and a phone without a code identically", async () => {
    const withCode = await player(true);
    const deps = playDeps();
    expect((await handleOtpRequest(deps, await otpRequest(withCode.phone))).status).toBe(200);
    await deps.drain();
    const code = await sentCode(withCode.phone);
    const answers = [];
    for (const [phone, guess] of [
      [withCode.phone, code === "999999" ? "999998" : "999999"],
      [uniquePhone(), "123456"],
      [(await player(true)).phone, "123456"],
    ] as const) {
      const response = await handleOtpVerify(deps, await verifyRequest(phone, guess));
      answers.push({ status: response.status, body: await response.text(), headers: headerList(response) });
    }
    expect(answers[0]).toMatchObject({ status: 400, body: JSON.stringify({ v: 1, error: "invalid_code" }) });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it("takes the same time for a phone with a code and an unknown phone (timing class); every invalid_code waits for the floor and counts per phone", async () => {
    const times = { withCode: [] as number[], unknown: [] as number[] };
    const deps = playDeps();
    for (let round = 0; round < 8; round++) {
      const known = await player(true);
      expect((await handleOtpRequest(deps, await otpRequest(known.phone))).status).toBe(200);
      await deps.drain();
      const code = await sentCode(known.phone);
      const unknown = uniquePhone();
      for (const [kind, phone, guess] of [
        ["withCode", known.phone, code === "000000" ? "111111" : "000000"],
        ["unknown", unknown, "123456"],
      ] as const) {
        const started = performance.now();
        const response = await handleOtpVerify(deps, await verifyRequest(phone, guess));
        const took = performance.now() - started;
        times[kind].push(took);
        expect(response.status).toBe(400);
        // Structural: the floor holds for both, and both wrote the per-phone verify count.
        expect(took).toBeGreaterThanOrEqual(PLAY_LIMITS.verifyFloorMs - 1);
        expect(await (await inspector()).get(`rl:otp:verify:phone:${otpPhoneKey(phone)}`)).toBe("1");
      }
    }
    const [k, u] = [median(times.withCode), median(times.unknown)];
    expect(Math.abs(k - u)).toBeLessThanOrEqual(Math.max(15, 0.2 * Math.max(k, u)));
  });

  /** A client address in the /64 `net` (2001:db8:x:y), a different host each time (the per-IP limits stay out of the way). */
  const inNet = (net: string, i: number): string => `${net}::${(i + 1).toString(16)}`;
  const freshNet = (): string => freshIp().split(":").slice(0, 4).join(":");

  it("checks at most 10 codes a day per (phone, client network) and 30 per phone, for EVERY phone (known or not), then 429", async () => {
    const deps = playDeps({ verifyFloorMs: 0 });
    for (const phone of [(await player(true)).phone, uniquePhone()]) {
      const nets = [freshNet(), freshNet(), freshNet(), freshNet()];
      for (const net of nets.slice(0, 3)) {
        for (let i = 0; i < PLAY_LIMITS.verifyPhoneNetworkCap; i++) expect((await handleOtpVerify(deps, await verifyRequest(phone, "123456", { ip: inNet(net, i) }))).status).toBe(400);
        const slice = await handleOtpVerify(deps, await verifyRequest(phone, "123456", { ip: inNet(net, 99) }));
        expect(slice.status).toBe(429);
        expect(Number(slice.headers.get("retry-after"))).toBeGreaterThan(86_000);
      }
      // 3 x 10: the phone's daily total is spent, from a fourth network too (a refused slice counted nothing more).
      expect(await (await inspector()).get(`rl:otp:verify:phone:${otpPhoneKey(phone)}`)).toBe(String(PLAY_LIMITS.verifyPhoneCap));
      expect((await handleOtpVerify(deps, await verifyRequest(phone, "123456", { ip: inNet(nets[3] ?? "", 0) }))).status).toBe(429);
    }
  });

  it("an attacker without Cap tokens cannot lock a phone out: no count, and the right code still works (review N1)", async () => {
    const { phone } = await player(true);
    const deps = playDeps({ verifyFloorMs: 0 });
    expect((await handleOtpRequest(deps, await otpRequest(phone))).status).toBe(200);
    await deps.drain();
    for (let i = 0; i < PLAY_LIMITS.verifyPhoneCap + 5; i++) {
      const refused = await handleOtpVerify(deps, await verifyRequest(phone, "123456", { capToken: i % 2 === 0 ? "junk" : null }));
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ v: 1, error: "captcha" });
    }
    // A junk or missing token leaves the per-phone counters untouched.
    expect(await (await inspector()).get(`rl:otp:verify:phone:${otpPhoneKey(phone)}`)).toBeNull();
    expect((await handleOtpVerify(deps, await verifyRequest(phone, await sentCode(phone)))).status).toBe(200);
  });

  it("an attacker with Cap tokens from one network cannot block another network's login", async () => {
    const { phone } = await player(true);
    const deps = playDeps({ verifyFloorMs: 0 });
    expect((await handleOtpRequest(deps, await otpRequest(phone))).status).toBe(200);
    await deps.drain();
    const attacker = freshNet();
    // Guesses straight at the stored code would use up its 5 attempts; these go to the counters, then stop at the slice.
    for (let i = 0; i <= PLAY_LIMITS.verifyPhoneNetworkCap + 2; i++) await handleOtpVerify(deps, await verifyRequest(phone, "123456", { ip: inNet(attacker, i) }));
    expect((await handleOtpVerify(deps, await verifyRequest(phone, "123456", { ip: inNet(attacker, 50) }))).status).toBe(429);
    // The code was attacked 5 times at most: request a fresh one (the cooldown passed) and log in from another network.
    await (await inspector()).del(`rl:otp:cooldown:${otpPhoneKey(phone)}`);
    expect((await handleOtpRequest(deps, await otpRequest(phone))).status).toBe(200);
    await deps.drain();
    expect((await handleOtpVerify(deps, await verifyRequest(phone, await sentCode(phone), { ip: inNet(freshNet(), 0) }))).status).toBe(200);
  });

  it("limits verify attempts per client IP (otp.ip_cap x otp.max_attempts per window)", async () => {
    await withSettings({ "otp.ip_cap": 1, "otp.max_attempts": 2 }, async () => {
      const deps = playDeps();
      const ip = freshIp();
      for (let i = 0; i < 2; i++) expect((await handleOtpVerify(deps, await verifyRequest(uniquePhone(), "123456", { ip }))).status).toBe(400);
      const refused = await handleOtpVerify(deps, await verifyRequest(uniquePhone(), "123456", { ip }));
      expect(refused.status).toBe(429);
    });
  });

  it("a login replaces the session the browser came with (rotate on login)", async () => {
    const { phone } = await player(true);
    const first = sessionCookie(await loginWithOtp(phone));
    const deps = playDeps();
    expect((await handleOtpRequest(deps, await otpRequest(phone))).status).toBe(429); // the cooldown
    await (await inspector()).del(`rl:otp:cooldown:${otpPhoneKey(phone)}`);
    expect((await handleOtpRequest(deps, await otpRequest(phone))).status).toBe(200);
    await deps.drain();
    const second = await handleOtpVerify(deps, await verifyRequest(phone, await sentCode(phone), { cookie: `${first}; other=1` }));
    expect(second.status).toBe(200);
    expect((await resolvePlayer(deps, new Headers({ cookie: first }))).playerId).toBeNull();
    expect((await resolvePlayer(deps, new Headers({ cookie: sessionCookie(second) }))).playerId).not.toBeNull();
  });
});

describe("an auth instance another bundle built (lib/runtime.ts is one per process, built by a page as often as by a route)", () => {
  /** better-auth's APIError as ANOTHER Next.js bundle's copy of the library throws it: the same name and shape, not this module's class. */
  class OtherCopyAPIError extends Error {
    readonly status = "BAD_REQUEST";
    readonly statusCode = 400;
    constructor(message: string) {
      super(message);
      this.name = "APIError";
    }
  }
  const authThrowing = (endpoint: "verifyPhoneNumber" | "playerMagicLinkLogin"): PlayDeps["auth"] => ({
    ...auth,
    api: { ...auth.api, [endpoint]: () => Promise.reject(new OtherCopyAPIError("refused")) },
  });

  it("a wrong code is still invalid_code (400, after the floor), never a 503, when the APIError is another copy's class", async () => {
    const deps = playDeps({ auth: authThrowing("verifyPhoneNumber") });
    const started = performance.now();
    const response = await handleOtpVerify(deps, await verifyRequest(uniquePhone(), "123456"));
    expect(performance.now() - started).toBeGreaterThanOrEqual(PLAY_LIMITS.verifyFloorMs - 1);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ v: 1, error: "invalid_code" });
    expect(deps.logs.lines.some((l) => l.includes('"event":"play.failed"'))).toBe(false);
  });

  it("a refused magic link is still invalid_link (400), never a 503, when the APIError is another copy's class", async () => {
    const deps = playDeps({ auth: authThrowing("playerMagicLinkLogin") });
    const response = await handleMagicLink(deps, playRequest("/api/v1/play/auth/magic-link", { channel: "email", token: "x".repeat(43) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ v: 1, error: "invalid_link" });
    expect(deps.logs.lines.some((l) => l.includes('"event":"play.failed"'))).toBe(false);
  });

  it("any other error is still a 503 (fail closed), for the code and for the link: only the auth library's refusals become the generic answer", async () => {
    const failing = (endpoint: "verifyPhoneNumber" | "playerMagicLinkLogin"): PlayDeps["auth"] => ({
      ...auth,
      api: { ...auth.api, [endpoint]: () => Promise.reject(new Error("boom")) },
    });
    const code = await handleOtpVerify(playDeps({ auth: failing("verifyPhoneNumber") }), await verifyRequest(uniquePhone(), "123456"));
    const link = await handleMagicLink(playDeps({ auth: failing("playerMagicLinkLogin") }), playRequest("/api/v1/play/auth/magic-link", { channel: "email", token: "x".repeat(43) }));
    for (const response of [code, link]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ v: 1, error: "unavailable" });
    }
  });
});

describe("sessions", () => {
  it("rotate once a day: a new token on the next use, the old one valid only for the grace period; one rotation under concurrency", async () => {
    const { id, phone } = await player(true);
    const cookie = sessionCookie(await loginWithOtp(phone));
    const deps = playDeps();
    // Fresh: nothing to rotate.
    expect(await resolvePlayer(deps, new Headers({ cookie }))).toEqual({ playerId: id, setCookies: [] });
    const token = decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "";
    await root`UPDATE player_auth.session SET "createdAt" = now() - interval '25 hours' WHERE token = ${token}`;
    const [a, b] = await Promise.all([resolvePlayer(deps, new Headers({ cookie })), resolvePlayer(deps, new Headers({ cookie }))]);
    expect(a.playerId).toBe(id);
    expect(b.playerId).toBe(id);
    const rotated = [...a.setCookies, ...b.setCookies];
    expect(rotated).toHaveLength(1);
    expect(rotated[0]).toMatch(new RegExp(`^${PLAY_SESSION_COOKIE}=`));
    const old = await one(root<{ left: number }[]>`SELECT extract(epoch FROM "expiresAt" - now())::int AS left FROM player_auth.session WHERE token = ${token}`);
    expect(old.left).toBeLessThanOrEqual(SESSION_ROTATION_GRACE_SECONDS);
    const fresh = (rotated[0] ?? "").split(";")[0] ?? "";
    expect(await resolvePlayer(deps, new Headers({ cookie: fresh }))).toEqual({ playerId: id, setCookies: [] });
    // The session route answers the same, and carries the rotation's cookie when there is one.
    const viaRoute = await handleSession(deps, playRequest("/api/v1/play/auth/session", undefined, { method: "GET", cookie: fresh }));
    expect(await viaRoute.json()).toEqual({ v: 1, authenticated: true, phone_masked: `****${phone.slice(-3)}` });
  });

  it("logout deletes the session and expires the cookie", async () => {
    const { phone } = await player(true);
    const cookie = sessionCookie(await loginWithOtp(phone));
    const deps = playDeps();
    const response = await handleLogout(deps, playRequest("/api/v1/play/auth/logout", undefined, { cookie }));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([EXPIRED_SESSION_COOKIE]);
    expect((await resolvePlayer(deps, new Headers({ cookie }))).playerId).toBeNull();
    const anonymous = await handleSession(deps, playRequest("/api/v1/play/auth/session", undefined, { method: "GET", cookie }));
    expect(await anonymous.json()).toEqual({ v: 1, authenticated: false });
  });

  it("a forged or unsigned cookie is anonymous", async () => {
    const deps = playDeps();
    expect((await resolvePlayer(deps, new Headers({ cookie: `${PLAY_SESSION_COOKIE}=abc.def` }))).playerId).toBeNull();
    expect((await resolvePlayer(deps, new Headers())).playerId).toBeNull();
  });

  it("are capped at 90 days from the login: a rotation carries the login over and never outlives it; past it the session ends", async () => {
    const { id, phone } = await player(true);
    const cookie = sessionCookie(await loginWithOtp(phone));
    const deps = playDeps();
    const token = tokenOf(cookie);
    // 89 days 23 hours after the login, a day-old token rotates: the new one may live one more hour only.
    await root`UPDATE player_auth.session_state SET login_at = now() - interval '89 days 23 hours' WHERE session_id = (SELECT id FROM player_auth.session WHERE token = ${token})`;
    await root`UPDATE player_auth.session SET "createdAt" = now() - interval '25 hours' WHERE token = ${token}`;
    const rotated = await resolvePlayer(deps, new Headers({ cookie }));
    expect(rotated.playerId).toBe(id);
    const fresh = rotated.setCookies[0] ?? "";
    const maxAge = Number(/Max-Age=(\d+)/.exec(fresh)?.[1]);
    expect(maxAge).toBeGreaterThan(3500);
    expect(maxAge).toBeLessThanOrEqual(3600);
    const next = await one(root<{ left: number; login_at: Date }[]>`
      SELECT extract(epoch FROM s."expiresAt" - now())::int AS left, st.login_at
        FROM player_auth.session s JOIN player_auth.session_state st ON st.session_id = s.id WHERE s.token = ${tokenOf(fresh.split(";")[0] ?? "")}`);
    expect(next.left).toBeLessThanOrEqual(3600);
    expect(Date.now() - next.login_at.getTime()).toBeGreaterThan((SESSION_ABSOLUTE_SECONDS - 3600) * 1000 - 60_000);
    // Past the cap: anonymous, the session row is deleted and the cookie expired on the answer.
    await root`UPDATE player_auth.session_state SET login_at = now() - interval '91 days' WHERE session_id = (SELECT id FROM player_auth.session WHERE token = ${tokenOf(fresh.split(";")[0] ?? "")})`;
    const ended = await resolvePlayer(deps, new Headers({ cookie: fresh.split(";")[0] ?? "" }));
    expect(ended.playerId).toBeNull();
    expect(ended.setCookies.some((c) => c.startsWith(`${PLAY_SESSION_COOKIE}=;`) && /Max-Age=0/.test(c))).toBe(true);
    expect(await root`SELECT 1 FROM player_auth.session WHERE token = ${tokenOf(fresh.split(";")[0] ?? "")}`).toHaveLength(0);
  });

  it("a session no login recorded is anonymous (fail closed)", async () => {
    const { phone } = await player(true);
    const cookie = sessionCookie(await loginWithOtp(phone));
    await root`DELETE FROM player_auth.session_state WHERE session_id = (SELECT id FROM player_auth.session WHERE token = ${tokenOf(cookie)})`;
    expect((await resolvePlayer(playDeps(), new Headers({ cookie }))).playerId).toBeNull();
    expect(await readPlayer(playDeps(), new Headers({ cookie }))).toBeNull();
  });

  it("withPlayer refuses every non-GET request without the exact play Origin (403) before the session is read", async () => {
    const { phone } = await player(true);
    const cookie = sessionCookie(await loginWithOtp(phone));
    const deps = playDeps();
    let ran = 0;
    const handler = () => {
      ran++;
      return Promise.resolve(playJson(200, {}));
    };
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const origin of [null, "https://order.ebooktrivia.example.test", `http://play.${DOMAIN}`]) {
        const refused = await withPlayer(deps, playRequest("/api/v1/play/x", {}, { method, origin, cookie }), handler);
        expect(refused.status, `${method} ${String(origin)}`).toBe(403);
        expect(await refused.json()).toEqual({ v: 1, error: "origin" });
      }
      expect((await withPlayer(deps, playRequest("/api/v1/play/x", {}, { method, cookie }), handler)).status, method).toBe(200);
    }
    // A GET needs no Origin (a navigation sends none).
    expect((await withPlayer(deps, playRequest("/api/v1/play/x", undefined, { method: "GET", origin: null, cookie }), handler)).status).toBe(200);
    expect(ran).toBe(5);
  });

  it("withPlayer: 401 for anonymous, 503 for a failing handler, and the rotation's cookie on every answer", async () => {
    const { phone } = await player(true);
    const cookie = sessionCookie(await loginWithOtp(phone));
    const deps = playDeps();
    const anonymous = await withPlayer(deps, playRequest("/api/v1/play/x", undefined, { method: "GET" }), () => Promise.resolve(playJson(200, {})));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ v: 1, error: "unauthenticated" });
    await root`UPDATE player_auth.session SET "createdAt" = now() - interval '25 hours' WHERE token = ${tokenOf(cookie)}`;
    const failed = await withPlayer(deps, playRequest("/api/v1/play/x", undefined, { method: "GET", cookie }), () => Promise.reject(new Error("boom")));
    expect(failed.status).toBe(503);
    const rotated = failed.headers.getSetCookie();
    expect(rotated).toHaveLength(1);
    expect(rotated[0]).toMatch(new RegExp(`^${PLAY_SESSION_COOKIE}=[^;]+;`));
    // The new cookie works; the old one only for the grace period.
    expect((await resolvePlayer(deps, new Headers({ cookie: (rotated[0] ?? "").split(";")[0] ?? "" }))).playerId).not.toBeNull();
  });
});

describe("magic links (confirm by POST; US-025 issues them)", () => {
  async function issued(playerId: string, channel: MagicLinkChannel): Promise<string> {
    const link = issueMagicLink({ channel });
    await root`SELECT issue_magic_link(${playerId}, ${channel}, ${link.tokenHash})`;
    return link.token;
  }
  const consume = (deps: PlayDeps, channel: string, token: string, options: Req = {}) => handleMagicLink(deps, playRequest("/api/v1/play/auth/magic-link", { channel, token }, options));

  it("logs in once: the session cookie; a replay is refused", async () => {
    const { id } = await player(true);
    const token = await issued(id, "whatsapp");
    const deps = playDeps();
    const response = await consume(deps, "whatsapp", token);
    expect(response.status).toBe(200);
    const phone = (await one(root<{ phone: string }[]>`SELECT phone FROM players WHERE id = ${id}`)).phone;
    expect(await response.json()).toEqual({ v: 1, ok: true, phone_masked: `****${phone.slice(-3)}` });
    expect((await resolvePlayer(deps, new Headers({ cookie: sessionCookie(response) }))).playerId).toBe(id);
    const replay = await consume(deps, "whatsapp", token);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ v: 1, error: "invalid_link" });
    expect(replay.headers.getSetCookie()).toEqual([]);
  });

  it("refuses a link on the other channel (and keeps it for its own), an expired link and garbage, identically", async () => {
    const { id } = await player(true);
    const deps = playDeps();
    const emailToken = await issued(id, "email");
    const wrongChannel = await consume(deps, "whatsapp", emailToken);
    const expiredToken = await issued(id, "whatsapp");
    await root`UPDATE magic_links SET expires_at = clock_timestamp() - interval '1 second' WHERE player_id = ${id} AND channel = 'whatsapp'`;
    const expired = await consume(deps, "whatsapp", expiredToken);
    const garbage = await consume(deps, "email", "not-a-token");
    const unknownChannel = await consume(deps, "sms", emailToken);
    for (const response of [wrongChannel, expired, garbage, unknownChannel]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ v: 1, error: "invalid_link" });
    }
    expect((await consume(deps, "email", emailToken)).status).toBe(200);
  });

  it("a database failure before the link is spent leaves it valid (session first, consume last)", async () => {
    const { id } = await player(true);
    const token = await issued(id, "email");
    const deps = playDeps();
    // The login's session state cannot be written: the login fails after the session was created.
    await root`ALTER TABLE player_auth.session_state RENAME TO session_state_off`;
    let failed: Response;
    try {
      failed = await consume(deps, "email", token);
    } finally {
      await root`ALTER TABLE player_auth.session_state_off RENAME TO session_state`;
    }
    expect(failed.status).toBe(503);
    expect(failed.headers.getSetCookie()).toEqual([]);
    expect((await one(root<{ c: boolean }[]>`SELECT consumed_at IS NOT NULL AS c FROM magic_links WHERE player_id = ${id} AND channel = 'email'`)).c).toBe(false);
    expect((await consume(deps, "email", token)).status).toBe(200);
  });

  it("limits attempts per client IP", async () => {
    await withSettings({ "otp.ip_cap": 1, "otp.max_attempts": 1 }, async () => {
      const deps = playDeps();
      const ip = freshIp();
      expect((await consume(deps, "email", "x".repeat(43), { ip })).status).toBe(400);
      expect((await consume(deps, "email", "x".repeat(43), { ip })).status).toBe(429);
    });
  });
});

// US-027 (Owner decision): "send my login link again", the way in when an attacker used up a phone's code checks.
describe("magic link resend: no enumeration, limits", () => {
  const resendRequest = async (phone: string, options: Req = {}) => playRequest("/api/v1/play/auth/magic-link/resend", { phone, cap_token: await playCapToken() }, options);
  const resendJobs = (playerId: string) => root`SELECT 1 FROM outbox WHERE topic = 'magic_link.resend' AND payload->>'player_id' = ${playerId}`;

  it("answers an eligible, a non-eligible and an unknown phone identically; only the eligible one gets a job, after the answer", async () => {
    const startedAt = (await one(root<{ now: Date }[]>`SELECT clock_timestamp() AS now`)).now;
    const eligible = await player(true);
    const notEligible = await player(false);
    const unknown = uniquePhone();
    const answers: { status: number; body: string; headers: [string, string][]; log: string[] }[] = [];
    for (const phone of [eligible.phone, notEligible.phone, unknown]) {
      const deps = playDeps();
      const response = await handleMagicLinkResend(deps, await resendRequest(phone));
      answers.push({ status: response.status, body: await response.text(), headers: headerList(response), log: deps.logs.lines.map(withoutRequestId) });
      // Answered before the phone was looked up: no job yet (the eligible phone's comes with the drain of its own
      // request), the lookup is deferred, and it logs nothing.
      if (phone === eligible.phone) expect(await resendJobs(eligible.id)).toHaveLength(0);
      expect(deps.deferred).toHaveLength(1);
      await deps.drain();
      expect(deps.logs.lines.map(withoutRequestId)).toEqual(answers.at(-1)?.log);
    }
    expect(answers[0]).toMatchObject({ status: 200, body: JSON.stringify({ v: 1, status: "sent" }) });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    // Of the three requests exactly one job exists, and it is the eligible player's (a job names a player id, never a
    // phone, so the other two can only be absent).
    const jobs = await root<{ player_id: string }[]>`
      SELECT payload->>'player_id' AS player_id FROM outbox WHERE topic = 'magic_link.resend' AND created_at >= ${startedAt}`;
    expect(jobs).toEqual([{ player_id: eligible.id }]);
    expect(await resendJobs(notEligible.id)).toHaveLength(0);
  });

  it("takes the same time for an eligible and an unknown phone (timing class, with tolerance)", async () => {
    const times = { eligible: [] as number[], unknown: [] as number[] };
    const deps = playDeps();
    for (let round = 0; round < 10; round++) {
      for (const kind of ["eligible", "unknown"] as const) {
        const phone = kind === "eligible" ? (await player(true)).phone : uniquePhone();
        const request = await resendRequest(phone);
        const started = performance.now();
        expect((await handleMagicLinkResend(deps, request)).status).toBe(200);
        times[kind].push(performance.now() - started);
        await deps.drain();
      }
    }
    const [e, u] = [median(times.eligible), median(times.unknown)];
    expect(Math.abs(e - u)).toBeLessThanOrEqual(Math.max(15, 0.5 * Math.max(e, u)));
  });

  it("per phone: 3 a day for every phone alike (counted only with a valid Cap token); per client IP otp.ip_cap; Valkey down: 503", async () => {
    for (const phone of [(await player(true)).phone, uniquePhone()]) {
      const deps = playDeps();
      // A junk token spends nothing of the phone's budget.
      expect((await handleMagicLinkResend(deps, playRequest("/api/v1/play/auth/magic-link/resend", { phone, cap_token: "junk" }))).status).toBe(403);
      for (let i = 0; i < PLAY_LIMITS.resendPhoneCap; i++) expect((await handleMagicLinkResend(deps, await resendRequest(phone))).status).toBe(200);
      const capped = await handleMagicLinkResend(deps, await resendRequest(phone));
      expect(capped.status).toBe(429);
      expect(Number(capped.headers.get("retry-after"))).toBeGreaterThan(80_000);
      await deps.drain();
    }
    const deps = playDeps();
    const ip = freshIp();
    const cap = (await loadOtpSettings(publicSql))["otp.ip_cap"];
    for (let i = 0; i < cap; i++) expect((await handleMagicLinkResend(deps, await resendRequest(uniquePhone(), { ip }))).status).toBe(200);
    expect((await handleMagicLinkResend(deps, playRequest("/api/v1/play/auth/magic-link/resend", { phone: uniquePhone(), cap_token: "junk" }, { ip }))).status).toBe(429);
    const down = playDeps({ valkey: await newValkey(1) });
    const response = await handleMagicLinkResend(down, await resendRequest(uniquePhone()));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ v: 1, error: "unavailable" });
    expect(down.deferred).toHaveLength(0);
  });

  it("needs the exact Origin, a valid phone and a play-scope Cap token", async () => {
    const deps = playDeps();
    const { phone } = await player(true);
    expect((await handleMagicLinkResend(deps, await resendRequest(phone, { origin: null }))).status).toBe(403);
    expect((await handleMagicLinkResend(deps, await resendRequest(phone, { origin: "https://order.ebooktrivia.example.test" }))).status).toBe(403);
    expect(await (await handleMagicLinkResend(deps, await resendRequest("12"))).json()).toMatchObject({ v: 1, error: "validation" });
    expect((await handleMagicLinkResend(deps, playRequest("/api/v1/play/auth/magic-link/resend", { phone, cap_token: await capToken(shop) }))).status).toBe(403);
    expect(deps.deferred).toHaveLength(0);
  });
});

describe("Cap on the login page", () => {
  it("serves challenges and redeems for the play scope only (same-origin), rate limited per IP", async () => {
    const deps = playDeps();
    const challenge = await handlePlayCap(deps, "challenge", playRequest("/api/v1/play/cap/challenge", undefined));
    expect(challenge.status).toBe(200);
    const redeemed = await handlePlayCap(deps, "redeem", playRequest("/api/v1/play/cap/redeem", solve((await challenge.json()) as CapChallenge)));
    const { token } = (await redeemed.json()) as { success: boolean; token: string };
    expect(await newCap(valkey, PLAY_CAP_SCOPE).verify(token)).toBe(true);
    expect(await newCap(valkey, shop.landingPageId).verify(token)).toBe(false);
    await withSettings({ "captcha.ip_cap": 1 }, async () => {
      const ip = freshIp();
      expect((await handlePlayCap(deps, "challenge", playRequest("/api/v1/play/cap/challenge", undefined, { ip }))).status).toBe(200);
      expect((await handlePlayCap(deps, "challenge", playRequest("/api/v1/play/cap/challenge", undefined, { ip }))).status).toBe(429);
    });
  });
});
