// US-019 follow-up "Cap routes" (US-020): POST /api/v1/cap/{lp_key}/challenge and /redeem with the
// checkout's Origin / CORS rule, Valkey rate limits (per IP /64 and /48), and the STATELESS Cap
// provider: signed challenges and tokens per landing page, nothing stored but one single-use mark per
// verified token, shared by both apps/public instances.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type CapAction, capPreflight, capProviders, type CapRouteDeps, handleCap } from "../src/lib/cap-routes.ts";
import { hitRateLimits, type Valkey, valkeyCapTokenMarks } from "../src/lib/valkey.ts";
import { CAPTCHA_KEY, capDeps, createShop, freshIp, newCap, newValkey, type RequestOptions, type Shop, SMALL_CHALLENGES, solve, valkey, withSettings } from "./support.ts";

const call = (deps: CapRouteDeps, shop: Shop, action: CapAction, body: unknown, options: RequestOptions = {}): Promise<Response> =>
  handleCap(deps, action, apiRequestFor(shop, action, body, options), shop.lpKey);

function apiRequestFor(shop: Shop, action: CapAction, body: unknown, options: RequestOptions): Request {
  return new Request(`https://api.example.test/api/v1/cap/${shop.lpKey}/${action}`, {
    method: "POST",
    headers: {
      "x-forwarded-for": options.ip ?? freshIp(),
      ...(options.origin === null ? {} : { origin: options.origin ?? shop.origin }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** An IPv6 address in a /48 of its own, in a /64 of its own inside it. */
const freshNetwork = (): { readonly in64: (host: string) => string; readonly in48: (subnet: string) => string } => {
  const base = freshIp().split(":").slice(0, 3).join(":");
  return { in64: (host) => `${base}:1::${host}`, in48: (subnet) => `${base}:${subnet}::1` };
};

describe("Cap routes", () => {
  it("serve the registered origin with CORS for it only, and refuse other origins without CORS headers", async () => {
    const shop = await createShop();
    const other = await createShop();
    const deps = capDeps();
    const challenge = await call(deps, shop, "challenge", undefined);
    expect(challenge.status).toBe(200);
    expect(challenge.headers.get("access-control-allow-origin")).toBe(shop.origin);
    expect(challenge.headers.get("access-control-allow-credentials")).toBeNull();
    const body = (await challenge.json()) as { challenge: { c: number; s: number; d: number }; token: string; expires: number };
    expect(body.token).toMatch(/^[0-9a-f]{172}$/);
    const redeemed = await call(deps, shop, "redeem", solve(body));
    expect(await redeemed.json()).toMatchObject({ success: true, token: expect.stringMatching(/^[0-9a-f]{146}$/) as unknown });
    expect(redeemed.headers.get("access-control-allow-origin")).toBe(shop.origin);

    for (const action of ["challenge", "redeem"] as const) {
      for (const origin of [null, other.origin, "https://evil.example.test"]) {
        const refused = await call(deps, shop, action, action === "redeem" ? {} : undefined, { origin });
        expect(refused.status, `${action} ${String(origin)}`).toBe(403);
        expect(await refused.json()).toEqual({ v: 1, error: "origin" });
        expect(refused.headers.get("access-control-allow-origin")).toBeNull();
      }
      const preflight = (origin: string) =>
        capPreflight(deps, new Request(`https://api.example.test/api/v1/cap/${shop.lpKey}/${action}`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } }), shop.lpKey);
      const allowed = await preflight(shop.origin);
      expect(allowed.status).toBe(204);
      expect(allowed.headers.get("access-control-allow-headers")).toBe("content-type, accept");
      expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();
      expect((await preflight(other.origin)).headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("redeem a challenge of one instance on the other, always to the same token, which verifies exactly once across instances", async () => {
    const shop = await createShop();
    // Two apps/public instances: their own Valkey connections and Cap providers, one key, one Valkey.
    const [valkeyA, valkeyB] = [await newValkey(), await newValkey()];
    const depsA = capDeps({ valkey: valkeyA, capFor: capProviders(valkeyA, CAPTCHA_KEY, SMALL_CHALLENGES) });
    const depsB = capDeps({ valkey: valkeyB, capFor: capProviders(valkeyB, CAPTCHA_KEY, SMALL_CHALLENGES) });
    const challenge = (await (await call(depsA, shop, "challenge", undefined)).json()) as Parameters<typeof solve>[0];
    const solution = solve(challenge);
    const answers = await Promise.all([call(depsB, shop, "redeem", solution), call(depsA, shop, "redeem", solution), call(depsB, shop, "redeem", solution)]);
    const bodies = (await Promise.all(answers.map((r) => r.json()))) as { success: boolean; token?: string }[];
    expect(bodies.every((r) => r.success)).toBe(true);
    expect(new Set(bodies.map((r) => r.token)).size).toBe(1);
    const token = bodies[0]?.token ?? "";
    const [a, b] = [newCap(valkeyA, shop.landingPageId), newCap(valkeyB, shop.landingPageId)];
    const verified = await Promise.all([a.verify(token), b.verify(token), a.verify(token), b.verify(token)]);
    expect(verified.filter(Boolean)).toHaveLength(1);
    expect(await b.verify(token)).toBe(false);
    // Another deployment's key verifies nothing.
    expect(await newCap(valkeyA, shop.landingPageId, randomBytes(32)).verify(token)).toBe(false);
  });

  it("refuse a tampered challenge (any byte, a lower difficulty) and a tampered token at the routes and at checkout", async () => {
    const shop = await createShop();
    const deps = capDeps();
    const challenge = (await (await call(deps, shop, "challenge", undefined)).json()) as Parameters<typeof solve>[0];
    const bytes = Buffer.from(challenge.token, "hex");
    bytes.writeUInt8(1, 53);
    const easier = bytes.toString("hex");
    expect(await (await call(deps, shop, "redeem", solve({ ...challenge, challenge: { ...challenge.challenge, d: 1 }, token: easier }))).json()).toEqual({ success: false });
    for (const index of [0, 1, 20, 40, 60, 85]) {
      const forged = Buffer.from(challenge.token, "hex");
      forged[index] = (forged[index] ?? 0) ^ 0x80;
      const token = forged.toString("hex");
      expect(await (await call(deps, shop, "redeem", solve({ ...challenge, token }))).json(), `byte ${String(index)}`).toEqual({ success: false });
    }
    const redeemed = (await (await call(deps, shop, "redeem", solve(challenge))).json()) as { success: true; token: string };
    const cap = newCap(valkey, shop.landingPageId);
    const tampered = Buffer.from(redeemed.token, "hex");
    tampered[40] = (tampered[40] ?? 0) ^ 0x01;
    expect(await cap.verify(tampered.toString("hex"))).toBe(false);
    expect(await cap.verify(redeemed.token)).toBe(true);
  });

  it("solve for one landing page only: another page's challenge route never redeems or verifies it (P2-3)", async () => {
    const [shopA, shopB] = [await createShop(), await createShop()];
    const deps = capDeps();
    const challenge = (await (await call(deps, shopA, "challenge", undefined)).json()) as Parameters<typeof solve>[0];
    expect(await (await call(deps, shopB, "redeem", solve(challenge))).json()).toEqual({ success: false });
    const redeemed = (await (await call(deps, shopA, "redeem", solve(challenge))).json()) as { success: boolean; token: string };
    expect(redeemed.success).toBe(true);
    expect(await newCap(valkey, shopB.landingPageId).verify(redeemed.token)).toBe(false);
    expect(await newCap(valkey, shopA.landingPageId).verify(redeemed.token)).toBe(true);
  });

  it("refuse a wrong solution and a body that is not JSON, as a failed redeem", async () => {
    const shop = await createShop();
    const deps = capDeps();
    const challenge = (await (await call(deps, shop, "challenge", undefined)).json()) as Parameters<typeof solve>[0];
    const wrong = { token: challenge.token, solutions: solve(challenge).solutions.map((n) => n + 1) };
    expect(await (await call(deps, shop, "redeem", wrong)).json()).toEqual({ success: false });
    const notJson = await handleCap(deps, "redeem", new Request(`https://api.example.test/api/v1/cap/${shop.lpKey}/redeem`, { method: "POST", headers: { origin: shop.origin, "content-type": "application/json" }, body: "{" }), shop.lpKey);
    expect(await notJson.json()).toEqual({ success: false });
  });

  it("limit challenge + redeem requests per client IP (one budget for both routes)", async () => {
    await withSettings({ "captcha.ip_cap": 3 }, async () => {
      const shop = await createShop();
      const deps = capDeps();
      const ip = freshIp();
      const challenge = (await (await call(deps, shop, "challenge", undefined, { ip })).json()) as Parameters<typeof solve>[0];
      expect((await call(deps, shop, "redeem", solve(challenge), { ip })).status).toBe(200);
      expect((await call(deps, shop, "challenge", undefined, { ip })).status).toBe(200);
      const limited = await call(deps, shop, "redeem", {}, { ip });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ v: 1, error: "rate_limited" });
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await call(deps, shop, "challenge", undefined, { ip: freshIp() })).status).toBe(200);
    });
  });

  it("limit an IPv6 /48 on top of its /64s (P2-4)", async () => {
    await withSettings({ "captcha.ip_cap": 300, "captcha.ip48_cap": 3 }, async () => {
      const shop = await createShop();
      const deps = capDeps();
      const network = freshNetwork();
      // Three /64 networks of one /48, one request each: the /64 limit is far away, the /48 one is hit.
      for (const subnet of ["a", "b", "c"]) expect((await call(deps, shop, "challenge", undefined, { ip: network.in48(subnet) })).status, subnet).toBe(200);
      const limited = await call(deps, shop, "challenge", undefined, { ip: network.in48("d") });
      expect(limited.status).toBe(429);
      expect(deps.logs.lines.some((l) => l.includes('"reason":"rate_limited_ip48"'))).toBe(true);
      // Another /48, and IPv4 (no /48 bucket), are unaffected.
      expect((await call(deps, shop, "challenge", undefined, { ip: freshNetwork().in64("1") })).status).toBe(200);
      expect((await call(deps, shop, "challenge", undefined, { ip: "198.51.100.77" })).status).toBe(200);
    });
  });

  it("count the /48 before the /64: a /48 over its cap creates no counter for a fresh /64 of it (P2-4)", async () => {
    await withSettings({ "captcha.ip48_cap": 2 }, async () => {
      const shop = await createShop();
      const deps = capDeps();
      const inspector = await newValkey(undefined, true);
      const network = freshNetwork();
      for (const subnet of ["a", "b"]) expect((await call(deps, shop, "challenge", undefined, { ip: network.in48(subnet) })).status).toBe(200);
      const fresh = network.in48("c");
      expect((await call(deps, shop, "challenge", undefined, { ip: fresh })).status).toBe(429);
      expect(await inspector.exists(`rl:captcha:ip:${fresh.split(":").slice(0, 4).join(":")}::/64`)).toBe(0);
      expect(await inspector.exists(`rl:captcha:ip:${network.in48("a").split(":").slice(0, 4).join(":")}::/64`)).toBe(1);
    });
  });

  it("count limits in order and stop at the first one over: later counters never rise (B1)", async () => {
    const inspector = await newValkey(undefined, true);
    const tag = freshIp();
    const limits = [
      { key: `order:a:${tag}`, limit: 1, windowMs: 60_000 },
      { key: `order:b:${tag}`, limit: 5, windowMs: 60_000 },
    ];
    expect(await hitRateLimits(valkey, limits)).toEqual({ allowed: true });
    for (let i = 0; i < 3; i++) expect(await hitRateLimits(valkey, limits)).toMatchObject({ allowed: false, index: 0 });
    expect(await inspector.get(`rl:order:a:${tag}`)).toBe("4");
    expect(await inspector.get(`rl:order:b:${tag}`)).toBe("1");
    expect(await inspector.pttl(`rl:order:b:${tag}`)).toBeGreaterThan(0);
  });

  it("need nothing beyond the `public` ACL allowlist, which refuses the rest, INFO included (dev ACL = production line)", async () => {
    // What the app sends: PING, EVAL with INCR / PTTL / PEXPIRE, SET NX PX. No ready check, no reads, no deletes.
    expect(await valkey.ping()).toBe("PONG");
    expect(await hitRateLimits(valkey, [{ key: `acl:${freshIp()}`, limit: 1, windowMs: 60_000 }])).toEqual({ allowed: true });
    expect(await valkeyCapTokenMarks(valkey).markUsed(randomBytes(16).toString("base64url"), 60_000)).toBe(true);
    const refused = (p: Promise<unknown>) => p.then(() => "allowed", (error: unknown) => (error instanceof Error ? error.message : String(error)));
    for (const [what, run] of [
      ["INFO", () => valkey.info("server")],
      ["GET", () => valkey.get("rl:acl")],
      ["GETDEL", () => valkey.getdel("cache:public:acl")],
      ["DEL", () => valkey.del("cache:public:acl")],
      ["EXISTS", () => valkey.exists("rl:acl")],
      ["SCAN", () => valkey.scan("0")],
      ["KEYS", () => valkey.keys("*")],
      ["EVALSHA", () => valkey.evalsha("0".repeat(40), 0)],
      ["SCRIPT LOAD", () => valkey.call("SCRIPT", "LOAD", "return 1")],
      ["FUNCTION LIST", () => valkey.call("FUNCTION", "LIST")],
      ["CLIENT LIST", () => valkey.call("CLIENT", "LIST")],
      ["SET outside the prefixes", () => valkey.set("ebt:acl", "1")],
      ["SET another app's cache", () => valkey.set("cache:admin:acl", "1")],
      ["EVAL touching another prefix", () => valkey.eval("return redis.call('INCR', KEYS[1])", 1, "ebt:acl")],
      ["EVAL running a command outside the list", () => valkey.eval("return redis.call('GET', KEYS[1])", 1, "rl:acl")],
      ["FLUSHALL", () => valkey.flushall()],
    ] as const) {
      // A command refused inside a script reports "ACL failure in script" instead of NOPERM.
      expect(await refused(run()), what).toMatch(/NOPERM|ACL failure in script/);
    }
  });

  it("fail CLOSED with 503 while Valkey is unreachable", async () => {
    const shop = await createShop();
    const down = await newValkey(1);
    const deps = capDeps({ valkey: down, capFor: capProviders(down, CAPTCHA_KEY, SMALL_CHALLENGES) });
    for (const action of ["challenge", "redeem"] as const) {
      const response = await call(deps, shop, action, action === "redeem" ? {} : undefined);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ v: 1, error: "unavailable" });
    }
    expect(deps.logs.lines.every((l) => l.includes('"reason":"valkey_unavailable"'))).toBe(true);
    // Challenge and redeem need no store at all: with only the token marks' Valkey down, both still work.
    const half = capDeps({ capFor: capProviders(down, CAPTCHA_KEY, SMALL_CHALLENGES) });
    const challenge = (await (await call(half, shop, "challenge", undefined)).json()) as Parameters<typeof solve>[0];
    expect(await (await call(half, shop, "redeem", solve(challenge))).json()).toMatchObject({ success: true });
    // Every key the public app writes expires (Valkey runs noeviction). `public` itself may not SCAN.
    const inspector = await newValkey(undefined, true);
    let cursor = "0";
    let seen = 0;
    do {
      const [next, keys] = await inspector.scan(cursor, "COUNT", 1000);
      cursor = next;
      for (const key of keys) {
        if (!key.startsWith("rl:") && !key.startsWith("cache:public:")) continue;
        seen++;
        expect(await inspector.pttl(key), key).toBeGreaterThan(0);
      }
    } while (cursor !== "0");
    expect(seen).toBeGreaterThan(0);
  });
  it("store NOTHING for 10000 challenge and redeem requests: the only new Valkey keys are the rl: counters", async () => {
    const shop = await createShop();
    const inspector = await newValkey(undefined, true);
    const keys = async (store: Valkey): Promise<Set<string>> => {
      const seen = new Set<string>();
      let cursor = "0";
      do {
        const [next, batch] = await store.scan(cursor, "COUNT", 1000);
        cursor = next;
        for (const key of batch) seen.add(key);
      } while (cursor !== "0");
      return seen;
    };
    await withSettings({ "captcha.ip_cap": 1000 }, async () => {
      const deps = capDeps();
      // Ten clients, each in a /48 of its own, 500 challenges and 500 redeems each (their own limits allow 1000).
      const clients = Array.from({ length: 10 }, () => `2001:db8:${randomBytes(2).readUInt16BE().toString(16)}:1::${randomBytes(2).readUInt16BE().toString(16)}`);
      const before = await keys(inspector);
      let ok = 0;
      for (const ip of clients) {
        for (let batch = 0; batch < 10; batch++) {
          const challenges = await Promise.all(Array.from({ length: 50 }, () => call(deps, shop, "challenge", undefined, { ip }).then((r) => r.json() as Promise<Parameters<typeof solve>[0]>)));
          const answers = await Promise.all(challenges.map((c) => call(deps, shop, "redeem", solve(c), { ip }).then((r) => r.json() as Promise<{ success: boolean }>)));
          ok += answers.filter((a) => a.success).length;
        }
      }
      expect(ok).toBe(5000);
      const added = [...(await keys(inspector))].filter((key) => !before.has(key));
      expect(added.filter((key) => !key.startsWith("rl:"))).toEqual([]);
      // One /64 and one /48 counter per client, nothing else.
      expect(added.sort()).toEqual(clients.flatMap((ip) => [`rl:captcha:ip:${ip.split(":").slice(0, 4).join(":")}::/64`, `rl:captcha:ip48:${ip.split(":").slice(0, 3).join(":")}::/48`]).sort());
    });
  }, 300_000);
});
