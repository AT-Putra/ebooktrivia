import { Redis } from "ioredis";
import { redisStorage } from "@better-auth/redis-storage";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createAdminAuth, createPlayerAuth, migrate, post, UNIFORM_BODY } from "./auth.ts";
import type { Resp } from "./auth.ts";
import { freshDb, rows } from "./db.ts";
import { VALKEY, VALKEY_PUBLIC, OTP_PEPPER } from "./env.ts";
import { issueMagicLink, migrateMagicLink, phoneMagicLink } from "./magic-link-plugin.ts";
import { OtpStore } from "./otp-store.ts";

const log = (label: string, v: unknown): void => {
  console.log(`[R13] ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
};
const brief = (r: Resp): Record<string, unknown> => ({
  status: r.status,
  body: r.body,
  contentType: r.headers.get("content-type"),
});
const PHONE = "+6281200000001";
const NON_ELIGIBLE = "+6281299999999";
const cookieName = (c: string | undefined): string | undefined => c?.split("=")[0];
const tableSchemas = async (pool: pg.Pool): Promise<Record<string, string[]>> => {
  const r = await rows(
    pool,
    `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('public','player_auth','admin_auth') ORDER BY 1,2`,
  );
  const out: Record<string, string[]> = {};
  for (const x of r) (out[x.table_schema as string] ??= []).push(x.table_name as string);
  return out;
};

let pool: pg.Pool;
beforeAll(async () => {
  pool = await freshDb("r13_spike");
});
afterAll(async () => {
  await pool.end();
});

describe("1 separate schemas and cookies", () => {
  test("tables land in player_auth / admin_auth; cookies differ; __Host- achievable", async () => {
    const player = createPlayerAuth({ pool, sendOtp: () => Promise.resolve() });
    const admin = createAdminAuth(pool);
    const pSql = await migrate(player.options);
    const aSql = await migrate(admin.options);
    log("player migration SQL", pSql.replace(/\s+/g, " ").slice(0, 700));
    log("admin migration SQL", aSql.replace(/\s+/g, " ").slice(0, 300));
    const t = await tableSchemas(pool);
    log("tables by schema", t);
    expect(t.public).toBeUndefined();
    expect(t.player_auth).toContain("verification");
    expect(t.player_auth).toContain("user");
    expect(t.admin_auth).toContain("user");

    const a = await post(admin.auth, "/sign-up/email", { email: "a@x.test", name: "A", password: "correct-horse-battery" });
    log("admin sign-up", { status: a.status, cookieNames: a.setCookies.map((c) => cookieName(c)) });
    expect(cookieName(a.setCookies[0])).toBe("adm.session_token");

    const ctx = await player.auth.$context;
    await ctx.internalAdapter.createUser({ email: "p@players.invalid", name: "P", phoneNumber: PHONE, phoneNumberVerified: true }, { method: "phone-number" });
    let code = "";
    const p2 = createPlayerAuth({ pool, sendOtp: (_p, c) => { code = c; return Promise.resolve(); } });
    await post(p2.auth, "/phone-number/send-otp", { phoneNumber: PHONE });
    const v = await post(p2.auth, "/phone-number/verify", { phoneNumber: PHONE, code });
    log("player verify", { ...brief(v), setCookie: v.setCookies });
    expect(cookieName(v.setCookies[0])).toBe("play.session_token");

    const h1 = createPlayerAuth({
      pool,
      sendOtp: (_p, c) => { code = c; return Promise.resolve(); },
      advanced: { useSecureCookies: true, cookies: { session_token: { name: "__Host-play_session" } } },
    });
    await post(h1.auth, "/phone-number/send-otp", { phoneNumber: PHONE });
    const v1 = await post(h1.auth, "/phone-number/verify", { phoneNumber: PHONE, code });
    log("__Host- attempt A (useSecureCookies:true + cookies.session_token.name)", v1.setCookies);

    const h2 = createPlayerAuth({
      pool,
      sendOtp: (_p, c) => { code = c; return Promise.resolve(); },
      advanced: {
        useSecureCookies: false,
        cookies: { session_token: { name: "__Host-play_session", attributes: { secure: true, path: "/" } } },
      },
    });
    await post(h2.auth, "/phone-number/send-otp", { phoneNumber: PHONE });
    const v2 = await post(h2.auth, "/phone-number/verify", { phoneNumber: PHONE, code });
    log("__Host- attempt B (useSecureCookies:false + explicit name + attributes.secure)", v2.setCookies);
    const sc = v2.setCookies[0] ?? "";
    expect(sc.startsWith("__Host-play_session=")).toBe(true);
    expect(sc).toContain("Secure");
    expect(sc).toContain("Path=/");
    expect(sc.toLowerCase()).not.toContain("domain=");
    const tokenPair = sc.split(";")[0] ?? "";
    const gs = await h2.auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", { headers: { cookie: tokenPair } }),
    );
    const gsBody = await gs.text();
    log("get-session with __Host- cookie", { status: gs.status, body: gsBody.slice(0, 120) });
    expect(gsBody).toContain(PHONE);
  });
});

describe("2 OTP storage", () => {
  test("stock plugin: code stored in plaintext; hashed only hashes identifier", async () => {
    for (const mode of ["plain", "hashed"] as const) {
      await pool.query(`TRUNCATE player_auth.verification`);
      let sent = "";
      const { auth } = createPlayerAuth({ pool, storeIdentifier: mode, sendOtp: (_p, c) => { sent = c; return Promise.resolve(); } });
      const r = await post(auth, "/phone-number/send-otp", { phoneNumber: PHONE });
      const v = await rows(pool, `SELECT identifier, value FROM player_auth.verification`);
      log(`stock send-otp storeIdentifier=${mode}`, { resp: brief(r), verificationRows: v });
      expect(v).toHaveLength(1);
      expect(v[0]?.value).toBe(`${sent}:0`);
      if (mode === "hashed") expect(v[0]?.identifier).not.toContain("phone-number-otp");
      else expect(v[0]?.identifier).toContain(PHONE);
    }
  });

  test("workaround: gate + custom verifyOTP + HMAC table; no plaintext persisted", async () => {
    await pool.query(`TRUNCATE player_auth.verification`);
    const store = new OtpStore(pool, OTP_PEPPER);
    await store.migrate();
    let delivered = "";
    const { auth } = createPlayerAuth({
      pool,
      otpStore: store,
      sendOtp: () => {
        throw new Error("stock sendOTP must not run in gated mode");
      },
      gate: {
        mode: "shortcircuit",
        enqueueOtp: async (phone) => {
          if (phone !== PHONE) return false;
          delivered = await store.issue(phone);
          return true;
        },
      },
    });
    const r = await post(auth, "/phone-number/send-otp", { phoneNumber: PHONE });
    const ver = await rows(pool, `SELECT * FROM player_auth.verification`);
    const spike = await rows(pool, `SELECT phone, encode(mac,'hex') AS mac_hex, expires_at, attempts FROM spike.spike_otp`);
    log("gated send-otp", brief(r));
    log("verification rows (expect none)", ver);
    log("spike_otp rows (HMAC only)", spike);
    expect(ver).toHaveLength(0);
    expect(JSON.stringify(spike)).not.toContain(delivered);

    const bad = await post(auth, "/phone-number/verify", { phoneNumber: PHONE, code: delivered === "000000" ? "000001" : "000000" });
    log("verify wrong code", brief(bad));
    expect(bad.status).toBe(400);
    const ok = await post(auth, "/phone-number/verify", { phoneNumber: PHONE, code: delivered });
    log("verify right code (user exists)", brief(ok));
    const replay = await post(auth, "/phone-number/verify", { phoneNumber: PHONE, code: delivered });
    log("verify replay", brief(replay));
    expect(replay.status).toBe(400);
    await store.issue(PHONE);
    for (let i = 0; i < 3; i++) await post(auth, "/phone-number/verify", { phoneNumber: PHONE, code: "111111" });
    const attempts = await rows(pool, `SELECT attempts FROM spike.spike_otp WHERE phone=$1`, [PHONE]);
    log("attempts after 3 wrong", attempts);
    expect(attempts[0]?.attempts).toBe(3);
  });
});

describe("3 sign-up disabled", () => {
  test("valid OTP for phone with no user: no user row, no session", async () => {
    await pool.query(`DELETE FROM player_auth.session`);
    await pool.query(`DELETE FROM player_auth."user"`);
    const store = new OtpStore(pool, OTP_PEPPER);
    await store.migrate();
    const { auth } = createPlayerAuth({ pool, otpStore: store, sendOtp: () => Promise.resolve() });
    const code = await store.issue("+6281200000777");
    const r = await post(auth, "/phone-number/verify", { phoneNumber: "+6281200000777", code });
    log("verify valid OTP, unknown phone", brief(r));
    log("set-cookie", r.setCookies);
    const users = await rows(pool, `SELECT id FROM player_auth."user"`);
    const sess = await rows(pool, `SELECT id FROM player_auth.session`);
    log("user rows / session rows", { users: users.length, sessions: sess.length });
    expect(users).toHaveLength(0);
    expect(sess).toHaveLength(0);
    expect(r.status).not.toBe(200);
    expect(r.setCookies).toHaveLength(0);

    for (const path of ["/sign-in/phone-number", "/sign-in/email", "/sign-up/email", "/phone-number/reset-password"]) {
      const x = await post(auth, path, { phoneNumber: "+6281200000777", password: "x", email: "a@b.test", name: "n" });
      log(`POST ${path}`, brief(x));
      expect(x.status).toBeGreaterThanOrEqual(400);
      expect(x.setCookies).toHaveLength(0);
    }
    expect(await rows(pool, `SELECT id FROM player_auth."user"`)).toHaveLength(0);

    const on = createPlayerAuth({ pool, otpStore: store, sendOtp: () => Promise.resolve(), signUpOnVerification: true });
    const c2 = await store.issue("+6281200000888");
    const r2 = await post(on.auth, "/phone-number/verify", { phoneNumber: "+6281200000888", code: c2 });
    const u2 = await rows(pool, `SELECT id FROM player_auth."user"`);
    log("CONTRAST signUpOnVerification=true", { status: r2.status, users: u2.length });
    await pool.query(`DELETE FROM player_auth.session`);
    await pool.query(`DELETE FROM player_auth."user"`);
  });
});

describe("4 eligibility gating and uniform response", () => {
  for (const mode of ["shortcircuit", "passthrough"] as const) {
    test(`gate mode ${mode}`, async () => {
      await pool.query(`TRUNCATE player_auth.verification`);
      await pool.query(`TRUNCATE spike.spike_otp`);
      let sendCalls = 0;
      const enq: string[] = [];
      const store = new OtpStore(pool, OTP_PEPPER);
      const { auth } = createPlayerAuth({
        pool,
        ...(mode === "shortcircuit" ? { otpStore: store } : {}),
        sendOtp: () => {
          sendCalls++;
          return Promise.resolve();
        },
        gate: {
          mode,
          enqueueOtp: async (phone) => {
            enq.push(phone);
            if (phone !== PHONE) return false;
            if (mode === "shortcircuit") await store.issue(phone);
            return true;
          },
        },
      });
      const bad = await post(auth, "/phone-number/send-otp", { phoneNumber: NON_ELIGIBLE });
      const callsAfterBad = sendCalls;
      const verAfterBad = await rows(pool, `SELECT 1 FROM player_auth.verification`);
      const otpAfterBad = await rows(pool, `SELECT 1 FROM spike.spike_otp`);
      const good = await post(auth, "/phone-number/send-otp", { phoneNumber: PHONE });
      log(`[${mode}] non-eligible`, brief(bad));
      log(`[${mode}] eligible`, brief(good));
      log(`[${mode}] sendOTP calls after non-eligible / after eligible`, [callsAfterBad, sendCalls]);
      expect(callsAfterBad).toBe(0);
      expect(verAfterBad).toHaveLength(0);
      expect(otpAfterBad).toHaveLength(0);
      expect(bad.status).toBe(good.status);
      expect(bad.body).toBe(good.body);
      expect(bad.body).toBe(JSON.stringify(UNIFORM_BODY));
      expect(bad.headers.get("content-type")).toBe(good.headers.get("content-type"));
      expect(bad.setCookies).toEqual(good.setCookies);
      expect(enq).toEqual([NON_ELIGIBLE, PHONE]);
      if (mode === "passthrough") expect(sendCalls).toBe(1);
    });
  }
});

describe("5 rate limiting on Valkey secondary storage", () => {
  test("customRules + prefix-confined keys under the public ACL user", async () => {
    const pub = new Redis({ ...VALKEY_PUBLIC, enableReadyCheck: false });
    const worker = new Redis({ ...VALKEY, username: "worker", password: "worker-devonly", enableReadyCheck: false });
    const scanAll = async (): Promise<string[]> => {
      const out: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await worker.scan(cursor, "COUNT", 1000);
        cursor = next;
        out.push(...batch);
      } while (cursor !== "0");
      return out;
    };
    const existing = await scanAll();
    if (existing.length > 0) await worker.del(...existing);
    let sent = 0;
    const { auth } = createPlayerAuth({
      pool,
      sendOtp: () => {
        sent++;
        return Promise.resolve();
      },
      secondaryStorage: redisStorage({ client: pub, keyPrefix: "rl:" }),
      rateLimit: {
        enabled: true,
        storage: "secondary-storage",
        window: 60,
        max: 100,
        customRules: { "/phone-number/send-otp": { window: 60, max: 3 } },
      },
      advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
    });
    const statuses: number[] = [];
    let last: Resp | undefined;
    for (let i = 0; i < 5; i++) {
      last = await post(auth, "/phone-number/send-otp", { phoneNumber: PHONE }, { "x-forwarded-for": "203.0.113.7" });
      statuses.push(last.status);
    }
    log("5 requests from 203.0.113.7 (max 3/60s)", statuses);
    if (last) log("429 response", { ...brief(last), xRetryAfter: last.headers.get("x-retry-after") });
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(sent).toBe(3);
    const other = await post(auth, "/phone-number/send-otp", { phoneNumber: PHONE }, { "x-forwarded-for": "203.0.113.8" });
    expect(other.status).toBe(200);
    await post(auth, "/phone-number/verify", { phoneNumber: PHONE, code: "000000" }, { "x-forwarded-for": "203.0.113.7" });

    const keys = await scanAll();
    const ttls = await Promise.all(keys.map((k) => worker.ttl(k)));
    log("ALL keys in valkey after run (listed as worker)", keys.map((k, i) => `${k} ttl=${String(ttls[i])}`));
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k.startsWith("rl:")).toBe(true);

    let noperm = "";
    try {
      await pub.set("other:x", "1");
    } catch (e) {
      noperm = e instanceof Error ? e.message : String(e);
    }
    log("public user writing key outside rl:/cache:", noperm);
    expect(noperm).toContain("NOPERM");
    const mirrored = keys.filter((k) => k.includes("verification:"));
    log("FINDING: verification rows mirrored into secondaryStorage despite storeInDatabase:true", mirrored);
    expect(mirrored.length).toBeGreaterThan(0);
    const mirroredValue = mirrored[0] ? await worker.get(mirrored[0]) : null;
    const parsed: unknown = JSON.parse(mirroredValue ?? "{}");
    const val = typeof parsed === "object" && parsed !== null && "value" in parsed ? parsed.value : undefined;
    log("mirrored value shape", { keys: Object.keys(parsed as object), valueMatchesCodeColonAttempts: typeof val === "string" && /^[0-9]{6}:[0-9]$/.test(val) });
    expect(typeof val === "string" && /^[0-9]{6}:[0-9]$/.test(val)).toBe(true);
    await pub.quit();
    await worker.quit();
  });

  test("customStorage: rate limit only, nothing else lands in Valkey", async () => {
    const pub = new Redis({ ...VALKEY_PUBLIC, enableReadyCheck: false });
    const worker = new Redis({ ...VALKEY, username: "worker", password: "worker-devonly", enableReadyCheck: false });
    const scanAll = async (): Promise<string[]> => {
      const out: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await worker.scan(cursor, "COUNT", 1000);
        cursor = next;
        out.push(...batch);
      } while (cursor !== "0");
      return out;
    };
    const old = await scanAll();
    if (old.length > 0) await worker.del(...old);
    const script = `local v = redis.call("INCR", KEYS[1]) if v == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end return v`;
    const { auth } = createPlayerAuth({
      pool,
      sendOtp: () => Promise.resolve(),
      rateLimit: {
        enabled: true,
        window: 60,
        max: 100,
        customRules: { "/phone-number/send-otp": { window: 60, max: 3 } },
        customStorage: {
          consume: async (key, rule) => {
            const n = Number(await pub.eval(script, 1, `rl:${key}`, rule.window));
            return n <= rule.max ? { allowed: true, retryAfter: null } : { allowed: false, retryAfter: rule.window };
          },
        },
      },
      advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await post(auth, "/phone-number/send-otp", { phoneNumber: PHONE }, { "x-forwarded-for": "198.51.100.9" })).status);
    }
    log("customStorage statuses", statuses);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const keys = await scanAll();
    log("customStorage valkey keys", keys);
    expect(keys).toEqual(["rl:198.51.100.9|/phone-number/send-otp"]);
    await pub.quit();
    await worker.quit();
  });
});

describe("6 custom phone magic-link plugin", () => {
  test("single-use token, session cookie issued once", async () => {
    await migrateMagicLink(pool);
    const { auth } = createPlayerAuth({ pool, sendOtp: () => Promise.resolve(), plugins: [phoneMagicLink(pool)] });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({
      email: "ml@players.invalid",
      name: "ML",
      phoneNumber: "+6281200000555",
      phoneNumberVerified: true,
    }, { method: "phone-number" });
    const token = await issueMagicLink(pool, user.id);
    const stored = await rows(pool, `SELECT encode(token_hash,'hex') AS token_hash, user_id, consumed_at FROM spike.spike_magic_link`);
    log("stored magic-link row (hash only)", stored);
    expect(JSON.stringify(stored)).not.toContain(token);
    const first = await post(auth, "/phone-magic-link/consume", { token });
    log("consume #1", { ...brief(first), cookieNames: first.setCookies.map((c) => cookieName(c)) });
    expect(first.status).toBe(200);
    expect(cookieName(first.setCookies[0])).toBe("play.session_token");
    const second = await post(auth, "/phone-magic-link/consume", { token });
    log("consume #2", brief(second));
    expect(second.status).toBe(401);
    expect(second.setCookies).toHaveLength(0);
    const unknown = await post(auth, "/phone-magic-link/consume", { token: "x".repeat(43) });
    log("consume unknown token", brief(unknown));
    expect(unknown.body).toBe(second.body);
    const gs = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", { headers: { cookie: first.setCookies[0]?.split(";")[0] ?? "" } }),
    );
    expect(await gs.text()).toContain("+6281200000555");
    const t2 = await issueMagicLink(pool, user.id);
    const results = await Promise.all(Array.from({ length: 8 }, () => post(auth, "/phone-magic-link/consume", { token: t2 })));
    log("8 concurrent consumes", results.map((r) => r.status));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });
});
