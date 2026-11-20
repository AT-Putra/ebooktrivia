import { createHash, randomBytes } from "node:crypto";
import { type Challenge, solveChallenge } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AltchaProviderConfig,
  CAP_CHALLENGE_TOKEN_LENGTH,
  CAP_MARK_MARGIN_MS,
  CAP_TOKEN_GRACE_MS,
  CAP_TOKEN_LENGTH,
  type CapChallenge,
  type CapProviderConfig,
  CaptchaStoreUnavailable,
  createAltchaProvider,
  createCapProvider,
  createCaptchaVerifier,
  createMemoryReplayStore,
  type ReplayStore,
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
const KEY = randomBytes(32);
const LP_A = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const LP_B = "0b1c2d3e-4f50-4a61-8b72-c3d4e5f60718";
const cheapCap = (overrides: Partial<CapProviderConfig> = {}) =>
  createCapProvider({ key: KEY, scope: LP_A, replay: createMemoryReplayStore(), challengeCount: 3, challengeDifficulty: 1, ...overrides });
const cheapAltcha = (overrides: Partial<AltchaProviderConfig> = {}) =>
  createAltchaProvider({ key: randomBytes(32), replay: createMemoryReplayStore(), cost: 1, maxCounter: 20, ...overrides });

/** A ReplayStore that counts its calls. */
function countingStore(inner: ReplayStore = createMemoryReplayStore()): ReplayStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    markUsed(key, ttlMs) {
      calls.push(key);
      return inner.markUsed(key, ttlMs);
    },
  };
}

/** `hex` with one bit of byte `index` flipped. */
const flipped = (hex: string, index: number): string => {
  const bytes = Buffer.from(hex, "hex");
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  return bytes.toString("hex");
};

async function redeemed(cap: ReturnType<typeof cheapCap>): Promise<{ challenge: CapChallenge; token: string; expires: number }> {
  const challenge = await cap.challenge();
  const result = await cap.redeem({ token: challenge.token, solutions: solveCap(challenge) });
  if (!result.success) throw new Error("redeem failed");
  return { challenge, token: result.token, expires: result.expires };
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

describe("Cap provider (stateless, US-020)", () => {
  it("redeems a real solution for a token that verifies exactly once", async () => {
    const cap = cheapCap();
    const { challenge, token, expires } = await redeemed(cap);
    expect(challenge.token).toMatch(new RegExp(`^[0-9a-f]{${String(CAP_CHALLENGE_TOKEN_LENGTH)}}$`));
    expect(CAP_CHALLENGE_TOKEN_LENGTH).toBe(172);
    expect(token).toMatch(new RegExp(`^[0-9a-f]{${String(CAP_TOKEN_LENGTH)}}$`));
    expect(CAP_TOKEN_LENGTH).toBe(146);
    expect(expires).toBe(challenge.expires + CAP_TOKEN_GRACE_MS);
    expect(await cap.verify(token)).toBe(true);
    expect(await cap.verify(token)).toBe(false);
  });

  it("uses Cap's defaults when not configured, and signs them into the token", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const challenge = await createCapProvider({ key: KEY, scope: LP_A, replay: createMemoryReplayStore() }).challenge();
    expect(challenge.challenge).toEqual({ c: 50, s: 32, d: 4 });
    expect(challenge.expires).toBe(1_800_000_000_000 + 10 * 60_000);
    const payload = Buffer.from(challenge.token, "hex");
    expect(payload.readUInt8(0)).toBe(1);
    expect(payload.subarray(1, 17).toString("hex")).toBe(LP_A.replaceAll("-", ""));
    expect(Number(payload.readBigUInt64BE(17))).toBe(1_800_000_000_000);
    expect(Number(payload.readBigUInt64BE(25))).toBe(challenge.expires);
    expect([payload.readUInt16BE(49), payload.readUInt16BE(51), payload.readUInt8(53)]).toEqual([50, 32, 4]);
  });

  it("stores nothing for a challenge or a redeem; only verify marks, once per token", async () => {
    const store = countingStore();
    const cap = cheapCap({ replay: store });
    for (let i = 0; i < 20; i++) await redeemed(cap);
    await cap.redeem({ token: (await cap.challenge()).token, solutions: [0, 0, 0] });
    expect(store.calls).toEqual([]);
    const { token } = await redeemed(cap);
    await cap.verify(token);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("redeems the same challenge to the same token every time (no redeem state), which still works only once", async () => {
    const cap = cheapCap();
    const challenge = await cap.challenge();
    const solution = { token: challenge.token, solutions: solveCap(challenge) };
    const answers = await Promise.all([cap.redeem(solution), cap.redeem(solution), cheapCap().redeem(solution)]);
    const tokens = answers.map((a) => (a.success ? a.token : ""));
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).not.toBe("");
    const verified = await Promise.all([cap.verify(tokens[0] ?? ""), cap.verify(tokens[0] ?? ""), cap.verify(tokens[0] ?? "")]);
    expect(verified.filter(Boolean)).toHaveLength(1);
  });

  it("lets one token work exactly once across two provider instances sharing the replay store", async () => {
    const shared = createMemoryReplayStore();
    const [one, two] = [cheapCap({ replay: shared }), cheapCap({ replay: shared })];
    const { token } = await redeemed(one);
    const verified = await Promise.all([one.verify(token), two.verify(token), two.verify(token), one.verify(token)]);
    expect(verified.filter(Boolean)).toHaveLength(1);
  });

  it("binds challenges and tokens to their landing page: another scope refuses both", async () => {
    const shared = createMemoryReplayStore();
    const [a, b] = [cheapCap({ replay: shared }), cheapCap({ scope: LP_B, replay: shared })];
    const challenge = await a.challenge();
    expect(await b.redeem({ token: challenge.token, solutions: solveCap(challenge) })).toEqual({ success: false });
    const { token } = await redeemed(a);
    expect(await b.verify(token)).toBe(false);
    expect(await a.verify(token)).toBe(true);
  });

  it("refuses a challenge with ANY byte changed, a lowered difficulty, another key and an expired one", async () => {
    const cap = cheapCap();
    const challenge = await cap.challenge();
    const solutions = solveCap(challenge);
    for (let i = 0; i < CAP_CHALLENGE_TOKEN_LENGTH / 2; i++) {
      const forged = flipped(challenge.token, i);
      expect(await cap.redeem({ token: forged, solutions: solveCap({ ...challenge, token: forged }) }), `byte ${String(i)}`).toEqual({ success: false });
    }
    // d lowered to 0 with the original MAC: the MAC no longer verifies.
    const bytes = Buffer.from(challenge.token, "hex");
    bytes.writeUInt8(0, 53);
    expect(await cap.redeem({ token: bytes.toString("hex"), solutions })).toEqual({ success: false });
    expect(await cheapCap({ key: randomBytes(32) }).redeem({ token: challenge.token, solutions })).toEqual({ success: false });
    expect(await cap.redeem({ token: challenge.token, solutions: solutions.slice(1) })).toEqual({ success: false });
    expect((await cap.redeem({ token: challenge.token, solutions })).success).toBe(true);

    vi.useFakeTimers({ now: Date.now() });
    const late = await cap.challenge();
    const lateSolutions = solveCap(late);
    vi.setSystemTime(late.expires);
    expect(await cap.redeem({ token: late.token, solutions: lateSolutions })).toEqual({ success: false });
  });

  it("refuses a token with ANY byte changed, another key, a challenge token and an expired one, without spending the real one", async () => {
    vi.useFakeTimers({ now: Date.now() });
    const store = countingStore();
    const cap = cheapCap({ replay: store });
    const { challenge, token, expires } = await redeemed(cap);
    for (let i = 0; i < CAP_TOKEN_LENGTH / 2; i++) expect(await cap.verify(flipped(token, i)), `byte ${String(i)}`).toBe(false);
    expect(await cheapCap({ key: randomBytes(32), replay: store }).verify(token)).toBe(false);
    expect(await cap.verify(challenge.token)).toBe(false);
    for (const bad of ["", "abc", token.toUpperCase(), `${token}00`, 42 as unknown as string]) expect(await cap.verify(bad)).toBe(false);
    expect(store.calls).toEqual([]);
    vi.setSystemTime(expires);
    expect(await cap.verify(token)).toBe(false);
    vi.setSystemTime(expires - 1);
    expect(await cap.verify(token)).toBe(true);
  });

  it("marks a token for its remaining life plus a minute, so a peer whose clock is ahead cannot reuse it (P2-2)", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const ttls: number[] = [];
    const cap = cheapCap({
      replay: {
        markUsed: (_key, ttl) => {
          ttls.push(ttl);
          return Promise.resolve(true);
        },
      },
    });
    const { token, expires } = await redeemed(cap);
    vi.setSystemTime(expires - 123_456);
    expect(await cap.verify(token)).toBe(true);
    expect(CAP_MARK_MARGIN_MS).toBe(60_000);
    expect(ttls).toEqual([123_456 + 60_000]);
  });

  it("refuses malformed input without touching the store, and throws CaptchaStoreUnavailable when the store fails", async () => {
    const failing = countingStore({ markUsed: () => Promise.reject(new Error("valkey down")) });
    const cap = cheapCap({ replay: failing });
    for (const solution of [null, "x", {}, { token: 1 }, { token: "abc", solutions: [] }]) expect(await cap.redeem(solution)).toEqual({ success: false });
    expect(await cap.verify("abc")).toBe(false);
    expect(failing.calls).toEqual([]);
    const { token } = await redeemed(cap);
    const cause = await cap.verify(token).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(CaptchaStoreUnavailable);
    expect((cause as Error).cause).toEqual(new Error("valkey down"));
  });

  it("refuses a challenge signed under a weaker or longer-lived configuration by a provider sharing the key (P2-1)", async () => {
    // The review's case: c=1, d=1 signed with the shared key, refused by Cap's defaults (c=50, d=4).
    const weakSigner = createCapProvider({ key: KEY, scope: LP_A, replay: createMemoryReplayStore(), challengeCount: 1, challengeDifficulty: 1 });
    const weak = await weakSigner.challenge();
    const defaults = createCapProvider({ key: KEY, scope: LP_A, replay: createMemoryReplayStore() });
    expect(await defaults.redeem({ token: weak.token, solutions: solveCap(weak) })).toEqual({ success: false });
    expect((await weakSigner.redeem({ token: weak.token, solutions: solveCap(weak) })).success).toBe(true);
    // Each parameter on its own, with real solutions (cheap configs): only the strength check refuses them.
    const base = { challengeCount: 4, challengeSize: 16, challengeDifficulty: 2, challengeTtlMs: 600_000 };
    const strict = createCapProvider({ key: KEY, scope: LP_A, replay: createMemoryReplayStore(), ...base });
    for (const weaker of [{ challengeCount: 3 }, { challengeSize: 15 }, { challengeDifficulty: 1 }, { challengeTtlMs: 600_001 }]) {
      const signer = createCapProvider({ key: KEY, scope: LP_A, replay: createMemoryReplayStore(), ...base, ...weaker });
      const challenge = await signer.challenge();
      expect(await strict.redeem({ token: challenge.token, solutions: solveCap(challenge) }), JSON.stringify(weaker)).toEqual({ success: false });
    }
    // A stronger and shorter-lived challenge is fine.
    const lenient = cheapCap();
    const harder = createCapProvider({ key: KEY, scope: LP_A, replay: createMemoryReplayStore(), challengeCount: 4, challengeDifficulty: 2, challengeTtlMs: 60_000 });
    const challenge = await harder.challenge();
    expect((await lenient.redeem({ token: challenge.token, solutions: solveCap(challenge) })).success).toBe(true);
  });

  it("validates its configuration", () => {
    expect(() => cheapCap({ key: randomBytes(31) })).toThrow(/at least 32 bytes/);
    for (const scope of ["lp_x", LP_A.toUpperCase(), ""]) expect(() => cheapCap({ scope }), scope).toThrow(/UUID/);
    expect(() => cheapCap({ challengeCount: 0x10000 })).toThrow(/challengeCount/);
    expect(() => cheapCap({ challengeDifficulty: 256 })).toThrow(/challengeDifficulty/);
    expect(() => cheapCap({ challengeTtlMs: 0 })).toThrow(/challengeTtlMs/);
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
    const storeDown = createCaptchaVerifier({ altcha: { verify: () => Promise.reject(new CaptchaStoreUnavailable(new Error("valkey down"))) } });
    await expect(storeDown.verify({ provider: "altcha", token: "t" })).rejects.toBeInstanceOf(CaptchaStoreUnavailable);
  });
});
