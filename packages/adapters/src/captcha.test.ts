import { createHash, randomBytes } from "node:crypto";
import { type Challenge, solveChallenge } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AltchaProviderConfig,
  CAP_TOKEN_TTL_MS,
  type CapChallenge,
  type CapProviderConfig,
  createAltchaProvider,
  createCapProvider,
  createCaptchaVerifier,
  createMemoryReplayStore,
} from "./captcha.ts";

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------
// In-process solvers

// The client side of @cap.js/server 4.0.5: each sub-challenge i has salt prng(token + i, s) and target
// prng(token + i + "d", d); its solution is a nonce n with sha256(salt + n) starting with the target.
// prng is copied from the server (it is not exported).
function prng(seed: string, length: number): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  let state = hash >>> 0;
  let result = "";
  while (result.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result += (state >>> 0).toString(16).padStart(8, "0");
  }
  return result.substring(0, length);
}

function solveCap({ challenge, token }: CapChallenge): number[] {
  return Array.from({ length: challenge.c }, (_, index) => {
    const salt = prng(`${token}${String(index + 1)}`, challenge.s);
    const target = prng(`${token}${String(index + 1)}d`, challenge.d);
    let nonce = 0;
    while (!createHash("sha256").update(`${salt}${String(nonce)}`).digest("hex").startsWith(target)) nonce++;
    return nonce;
  });
}

async function solveAltcha(challenge: Challenge): Promise<string> {
  const solution = await solveChallenge({ challenge, deriveKey });
  if (solution === null) throw new Error("ALTCHA challenge not solved");
  return Buffer.from(JSON.stringify({ challenge, solution })).toString("base64");
}

const reencode = (payload: string, edit: (decoded: { challenge: Challenge; solution: Record<string, unknown> }) => void): string => {
  const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { challenge: Challenge; solution: Record<string, unknown> };
  edit(decoded);
  return Buffer.from(JSON.stringify(decoded)).toString("base64");
};

// Low cost keeps the tests fast: 3 sub-challenges of 1 hex digit for Cap, 1 PBKDF2 iteration and a
// counter of at most 20 for ALTCHA.
const cheapCap = (overrides: Partial<CapProviderConfig> = {}) =>
  createCapProvider({ replay: createMemoryReplayStore(), challengeCount: 3, challengeDifficulty: 1, ...overrides });
const cheapAltcha = (overrides: Partial<AltchaProviderConfig> = {}) =>
  createAltchaProvider({ key: randomBytes(32), replay: createMemoryReplayStore(), cost: 1, maxCounter: 20, ...overrides });

// Async storage hooks with a delay between read and delete, as a network store (Valkey) behaves.
function slowStorage() {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  const challenges = new Map<string, { challenge: { c: number; s: number; d: number }; expires: number }>();
  const tokens = new Map<string, number>();
  return {
    challenges: {
      store: async (key: string, data: { challenge: { c: number; s: number; d: number }; expires: number }) => {
        await tick();
        challenges.set(key, data);
      },
      read: async (key: string) => {
        await tick();
        return challenges.get(key) ?? null;
      },
      delete: async (key: string) => {
        await tick();
        challenges.delete(key);
      },
      deleteExpired: () => Promise.resolve(),
    },
    tokens: {
      store: async (key: string, expires: number) => {
        await tick();
        tokens.set(key, expires);
      },
      get: async (key: string) => {
        await tick();
        return tokens.get(key) ?? null;
      },
      delete: async (key: string) => {
        await tick();
        tokens.delete(key);
      },
      deleteExpired: () => Promise.resolve(),
    },
  };
}

// ---------------------------------------------------------------------------------------------

describe("memory replay store", () => {
  it("marks a key once until its ttl passes", async () => {
    let clock = 1_000_000;
    const store = createMemoryReplayStore({ now: () => clock });
    expect(await store.markUsed("a", 1000)).toBe(true);
    expect(await store.markUsed("a", 1000)).toBe(false);
    expect(await store.markUsed("b", 1000)).toBe(true);
    clock += 999;
    expect(await store.markUsed("a", 1000)).toBe(false);
    clock += 1;
    expect(await store.markUsed("a", 1000)).toBe(true);
  });

  it("is bounded: evicts expired keys when full and refuses new keys while every key is live", async () => {
    let clock = 0;
    const store = createMemoryReplayStore({ maxEntries: 2, now: () => clock });
    expect(await store.markUsed("a", 100)).toBe(true);
    expect(await store.markUsed("b", 500)).toBe(true);
    expect(await store.markUsed("c", 100)).toBe(false);
    clock = 100;
    expect(await store.markUsed("c", 100)).toBe(true);
    expect(await store.markUsed("b", 500)).toBe(false);
    expect(await store.markUsed("d", 100)).toBe(false);
  });

  it("rejects invalid keys, ttls and sizes", async () => {
    const store = createMemoryReplayStore();
    await expect(store.markUsed("", 1000)).rejects.toThrow(RangeError);
    await expect(store.markUsed("a", 0)).rejects.toThrow(RangeError);
    await expect(store.markUsed("a", 1.5)).rejects.toThrow(RangeError);
    expect(() => createMemoryReplayStore({ maxEntries: 0 })).toThrow(RangeError);
  });
});

describe("Cap provider", () => {
  it("redeems a real solution for a token that verifies exactly once", async () => {
    const cap = cheapCap();
    const challenge = await cap.challenge();
    expect(challenge.challenge).toEqual({ c: 3, s: 32, d: 1 });
    const redeemed = await cap.redeem({ token: challenge.token, solutions: solveCap(challenge) });
    if (!redeemed.success) throw new Error("redeem failed");
    expect(await cap.verify(redeemed.token)).toBe(true);
    expect(await cap.verify(redeemed.token)).toBe(false);
  });

  it("uses Cap's defaults when not configured", async () => {
    const cap = createCapProvider({ replay: createMemoryReplayStore() });
    const { challenge, expires } = await cap.challenge();
    expect(challenge).toEqual({ c: 50, s: 32, d: 4 });
    expect(expires - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(() => createCapProvider({ replay: createMemoryReplayStore(), challengeDifficulty: 0 })).toThrow(RangeError);
  });

  it("redeems a challenge once and refuses wrong, malformed or unknown solutions", async () => {
    const cap = cheapCap();
    const challenge = await cap.challenge();
    const solutions = solveCap(challenge);
    expect((await cap.redeem({ token: challenge.token, solutions })).success).toBe(true);
    expect(await cap.redeem({ token: challenge.token, solutions })).toEqual({ success: false });

    const other = await cap.challenge();
    const wrong = solveCap(other).map((n) => n + 1_000_000);
    expect(await cap.redeem({ token: other.token, solutions: wrong })).toEqual({ success: false });
    // Cap deletes a challenge on the first attempt, right or wrong.
    expect(await cap.redeem({ token: other.token, solutions: solveCap(other) })).toEqual({ success: false });

    const fresh = await cap.challenge();
    const good = solveCap(fresh);
    for (const body of [
      null,
      "x",
      {},
      { token: fresh.token },
      { token: fresh.token, solutions: good.slice(1) },
      { token: fresh.token, solutions: [...good, 1] },
      { token: fresh.token, solutions: good.map(String) },
      { token: fresh.token.toUpperCase(), solutions: good },
      { token: 42, solutions: good },
      { token: "0".repeat(50), solutions: good },
    ]) {
      expect(await cap.redeem(body)).toEqual({ success: false });
    }
    expect((await cap.redeem({ token: fresh.token, solutions: good })).success).toBe(true);
  });

  it("is single-use under concurrency, even with async storage hooks", async () => {
    const cap = cheapCap({ storage: slowStorage() });
    const challenge = await cap.challenge();
    const solutions = solveCap(challenge);
    const redeems = await Promise.all([cap.redeem({ token: challenge.token, solutions }), cap.redeem({ token: challenge.token, solutions })]);
    expect(redeems.filter((r) => r.success)).toHaveLength(1);
    const redeemed = redeems.find((r) => r.success);
    if (redeemed?.success !== true) throw new Error("redeem failed");
    const verifies = await Promise.all([cap.verify(redeemed.token), cap.verify(redeemed.token), cap.verify(redeemed.token)]);
    expect(verifies.filter(Boolean)).toHaveLength(1);
    expect(await cap.verify(redeemed.token)).toBe(false);
  });

  it("C1: junk redeems never take replay slots, so they cannot lock out a solved challenge", async () => {
    const cap = cheapCap({ replay: createMemoryReplayStore({ maxEntries: 50 }) });
    const challenge = await cap.challenge();
    const solutions = solveCap(challenge);
    // Well-formed but unknown challenge tokens, and a real token with wrong solutions on another challenge.
    for (let i = 0; i < 200; i++) {
      expect(await cap.redeem({ token: randomBytes(25).toString("hex"), solutions })).toEqual({ success: false });
    }
    for (let i = 0; i < 60; i++) {
      const burned = await cap.challenge();
      expect(await cap.redeem({ token: burned.token, solutions: solutions.map((n) => n + 1_000_000) })).toEqual({ success: false });
    }
    const redeemed = await cap.redeem({ token: challenge.token, solutions });
    if (!redeemed.success) throw new Error("a solved challenge was locked out by junk redeems");
    expect(await cap.verify(redeemed.token)).toBe(true);
  });

  it("refuses an expired challenge and an expired token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-04-01T03:00:00Z"));
    const cap = cheapCap({ challengeTtlMs: 60_000 });

    const late = await cap.challenge();
    vi.setSystemTime(Date.now() + 60_001);
    expect(await cap.redeem({ token: late.token, solutions: solveCap(late) })).toEqual({ success: false });

    const challenge = await cap.challenge();
    const redeemed = await cap.redeem({ token: challenge.token, solutions: solveCap(challenge) });
    if (!redeemed.success) throw new Error("redeem failed");
    expect(redeemed.expires - Date.now()).toBe(CAP_TOKEN_TTL_MS);
    vi.setSystemTime(redeemed.expires + 1);
    expect(await cap.verify(redeemed.token)).toBe(false);
  });

  it("refuses malformed and unknown tokens and fails closed when storage throws", async () => {
    const cap = cheapCap();
    for (const token of ["", "abc", "x:y", "0".repeat(50), `${"0".repeat(16)}:${"0".repeat(30)}`, `${"A".repeat(16)}:${"0".repeat(30)}`]) {
      expect(await cap.verify(token)).toBe(false);
    }
    expect(await cap.verify(42 as unknown as string)).toBe(false);

    const broken = slowStorage();
    broken.tokens.get = () => Promise.reject(new Error("valkey down"));
    broken.challenges.read = () => Promise.reject(new Error("valkey down"));
    const down = cheapCap({ storage: broken });
    const challenge = await down.challenge();
    expect(await down.redeem({ token: challenge.token, solutions: solveCap(challenge) })).toEqual({ success: false });
    expect(await down.verify(`${"0".repeat(16)}:${"0".repeat(30)}`)).toBe(false);
  });

  it("does not leave Cap's process exit handlers installed", () => {
    const events = ["beforeExit", "SIGINT", "SIGTERM", "SIGQUIT"] as const;
    const before = events.map((event) => process.listenerCount(event));
    cheapCap();
    expect(events.map((event) => process.listenerCount(event))).toEqual(before);
  });
});

describe("ALTCHA provider", () => {
  it("verifies a real solution once and refuses its replay", async () => {
    const altcha = cheapAltcha();
    const challenge = await altcha.challenge();
    expect(challenge.parameters).toMatchObject({ algorithm: "PBKDF2/SHA-256", cost: 1 });
    expect(typeof challenge.parameters.keySignature).toBe("string");
    const payload = await solveAltcha(challenge);
    expect(await altcha.verify(payload)).toBe(true);
    expect(await altcha.verify(payload)).toBe(false);
  });

  it("refuses a tampered challenge, a forged solution and another key", async () => {
    const key = randomBytes(32);
    const altcha = cheapAltcha({ key });
    const payload = await solveAltcha(await altcha.challenge());
    const tampered = [
      reencode(payload, (p) => {
        p.challenge.parameters.cost = 2;
      }),
      reencode(payload, (p) => {
        p.challenge.parameters.expiresAt = (p.challenge.parameters.expiresAt ?? 0) + 3600;
      }),
      reencode(payload, (p) => {
        p.challenge.signature = "0".repeat(64);
      }),
      reencode(payload, (p) => {
        p.solution.derivedKey = "0".repeat(64);
      }),
      reencode(payload, (p) => {
        p.solution.derivedKey = 7;
      }),
    ];
    for (const forged of tampered) expect(await altcha.verify(forged)).toBe(false);
    expect(await cheapAltcha().verify(payload)).toBe(false);
    // None of the refusals consumed the genuine payload.
    expect(await createAltchaProvider({ key, replay: createMemoryReplayStore(), cost: 1, maxCounter: 20 }).verify(payload)).toBe(true);
  });

  it("refuses an expired challenge by the injected clock and by the wall clock", async () => {
    let clock = Date.now();
    // A store that accepts any ttl, so only the expiry check can refuse.
    const altcha = cheapAltcha({ ttlMs: 60_000, now: () => clock, replay: { markUsed: () => Promise.resolve(true) } });
    const payload = await solveAltcha(await altcha.challenge());
    clock += 60_000;
    expect(await altcha.verify(payload)).toBe(false);

    // Issued in the past: the injected clock says valid, altcha-lib's own wall-clock check says expired.
    const past = Date.now() - 2 * 3_600_000;
    const stale = cheapAltcha({ ttlMs: 60_000, now: () => past });
    expect(await stale.verify(await solveAltcha(await stale.challenge()))).toBe(false);
  });

  it("refuses malformed payloads", async () => {
    const altcha = cheapAltcha();
    const payload = await solveAltcha(await altcha.challenge());
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
    for (const bad of [
      "",
      "not base64!",
      Buffer.from("not json").toString("base64"),
      encode(null),
      encode({ challenge: {} }),
      encode({ challenge: { parameters: {}, signature: "x" }, solution: {} }),
      reencode(payload, (p) => {
        delete p.challenge.parameters.expiresAt;
      }),
      reencode(payload, (p) => {
        p.challenge.parameters.expiresAt = 1.5;
      }),
      "A".repeat(8200),
    ]) {
      expect(await altcha.verify(bad)).toBe(false);
    }
    expect(await altcha.verify(42 as unknown as string)).toBe(false);
    expect(await altcha.verify(payload)).toBe(true);
  });

  it("uses a 5000-iteration cost by default and validates its config", async () => {
    const challenge = await createAltchaProvider({ key: randomBytes(32), replay: createMemoryReplayStore() }).challenge();
    expect(challenge.parameters.cost).toBe(5_000);
    expect((challenge.parameters.expiresAt ?? 0) * 1000 - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    const replay = createMemoryReplayStore();
    expect(() => createAltchaProvider({ key: randomBytes(31), replay })).toThrow(RangeError);
    expect(() => createAltchaProvider({ key: "k".repeat(32) as unknown as Uint8Array, replay })).toThrow(RangeError);
    expect(() => createAltchaProvider({ key: randomBytes(32), replay, cost: 0 })).toThrow(RangeError);
    expect(() => createAltchaProvider({ key: randomBytes(32), replay, maxCounter: 1 })).toThrow(RangeError);
    expect(() => createAltchaProvider({ key: randomBytes(32), replay, ttlMs: 999 })).toThrow(RangeError);
  });
});

describe("captcha verifier", () => {
  it("routes each provider's submission to it, once", async () => {
    const cap = cheapCap();
    const altcha = cheapAltcha();
    const verifier = createCaptchaVerifier({ cap, altcha });

    const challenge = await cap.challenge();
    const redeemed = await cap.redeem({ token: challenge.token, solutions: solveCap(challenge) });
    if (!redeemed.success) throw new Error("redeem failed");
    const payload = await solveAltcha(await altcha.challenge());

    expect(await verifier.verify({ provider: "altcha", token: redeemed.token })).toBe(false);
    expect(await verifier.verify({ provider: "cap", token: payload })).toBe(false);
    expect(await verifier.verify({ provider: "cap", token: redeemed.token })).toBe(true);
    expect(await verifier.verify({ provider: "altcha", token: payload })).toBe(true);
    expect(await verifier.verify({ provider: "cap", token: redeemed.token })).toBe(false);
    expect(await verifier.verify({ provider: "altcha", token: payload })).toBe(false);
  });

  it("fails closed on an unconfigured or unknown provider, malformed input and provider errors", async () => {
    const always = { verify: () => Promise.resolve(true) };
    const verifier = createCaptchaVerifier({ cap: always });
    expect(await verifier.verify({ provider: "cap", token: "t" })).toBe(true);
    expect(await verifier.verify({ provider: "altcha", token: "t" })).toBe(false);
    for (const bad of [
      null,
      "cap",
      [],
      {},
      { provider: "recaptcha", token: "t" },
      { provider: "CAP", token: "t" },
      { provider: "cap" },
      { provider: "cap", token: "" },
      { provider: "cap", token: 7 },
      { provider: "cap", token: "t".repeat(8193) },
    ]) {
      expect(await verifier.verify(bad)).toBe(false);
    }
    expect(await createCaptchaVerifier({}).verify({ provider: "cap", token: "t" })).toBe(false);
    const throwing = createCaptchaVerifier({ altcha: { verify: () => Promise.reject(new Error("boom")) } });
    expect(await throwing.verify({ provider: "altcha", token: "t" })).toBe(false);
  });
});
