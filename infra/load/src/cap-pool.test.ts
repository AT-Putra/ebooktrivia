// The solver against the REAL stateless Cap provider of the app (packages/adapters captcha.ts): a solution the
// provider redeems proves the prng copy and the hash check; a pool token it verifies once proves the whole route.
import { randomBytes } from "node:crypto";
import { createCapProvider, createMemoryReplayStore } from "@ebooktrivia/adapters";
import { describe, expect, it } from "vitest";
import { type FetchLike, generatePool, inProcessSolver, threadSolver } from "./cap-pool.ts";
import { solveChallenge } from "./cap-solver.ts";

const KEY = randomBytes(32);
const LP = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const provider = (config: { challengeCount?: number; challengeSize?: number; challengeDifficulty?: number } = {}) =>
  createCapProvider({ key: KEY, scope: LP, replay: createMemoryReplayStore(), challengeCount: 3, challengeSize: 16, challengeDifficulty: 2, ...config });

/** The app's Cap routes in front of a provider, as a fetch the pool can call. */
function routes(cap: ReturnType<typeof provider>, overrides: { status?: number; refuseRedeem?: boolean } = {}): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push(`${init.method} ${url} origin=${init.headers["origin"] ?? ""}`);
      if (overrides.status !== undefined) return Promise.resolve({ status: overrides.status, json: () => Promise.resolve({}) });
      if (url.endsWith("/challenge")) return Promise.resolve({ status: 200, json: () => cap.challenge() });
      const body = JSON.parse(init.body ?? "{}") as unknown;
      return Promise.resolve({ status: 200, json: () => (overrides.refuseRedeem === true ? Promise.resolve({ success: false }) : cap.redeem(body)) });
    },
  };
}

describe("the Cap solver", () => {
  it.each([1, 2, 3, 4])("is accepted by the real provider at difficulty %i (odd and even hex digits)", async (d) => {
    const cap = provider({ challengeCount: 3, challengeDifficulty: d });
    const { token, challenge } = await cap.challenge();
    const redeemed = await cap.redeem({ token, solutions: solveChallenge(token, challenge) });
    expect(redeemed.success).toBe(true);
  });

  it("is refused by the provider when one nonce is wrong (the check is not vacuous)", async () => {
    const cap = provider({ challengeDifficulty: 3 });
    const { token, challenge } = await cap.challenge();
    const solutions = solveChallenge(token, challenge);
    solutions[1] = (solutions[1] ?? 0) + 1;
    expect((await cap.redeem({ token, solutions })).success).toBe(false);
  });
});

describe("the Cap token pool", () => {
  it("makes the requested number of distinct tokens, each valid once for the landing page", async () => {
    const cap = provider();
    const { fetch, calls } = routes(cap);
    const tokens = await generatePool({ api: "https://api.example.test/", lpKey: "lp_abcdef12", origin: "https://lp.example.test", count: 12, maxRps: 1000, fetch, solve: inProcessSolver, concurrency: 3 });
    expect(tokens).toHaveLength(12);
    expect(new Set(tokens.map((t) => t.token)).size).toBe(12);
    expect(calls).toHaveLength(24);
    expect(calls[0]).toBe("POST https://api.example.test/api/v1/cap/lp_abcdef12/challenge origin=https://lp.example.test");
    for (const { token, expires } of tokens) {
      expect(expires).toBeGreaterThan(Date.now() + 10 * 60_000);
      expect(await cap.verify(token)).toBe(true);
      expect(await cap.verify(token)).toBe(false);
    }
  });

  it("runs the solver in worker threads too", async () => {
    const cap = provider();
    const solver = threadSolver(2);
    try {
      const tokens = await generatePool({ api: "https://api.example.test", lpKey: "lp_abcdef12", origin: "https://lp.example.test", count: 4, maxRps: 1000, fetch: routes(cap).fetch, solve: solver.solve, concurrency: 2 });
      expect(tokens).toHaveLength(4);
      expect(await cap.verify(tokens[0]?.token ?? "")).toBe(true);
    } finally {
      await solver.close();
    }
  });

  it("fails loudly on a rate limit (429) and on a refused redeem, instead of writing a short pool", async () => {
    const base = { api: "https://api.example.test", lpKey: "lp_abcdef12", origin: "https://lp.example.test", count: 2, maxRps: 1000, solve: inProcessSolver, concurrency: 1 };
    await expect(generatePool({ ...base, fetch: routes(provider(), { status: 429 }).fetch })).rejects.toThrow(/429/);
    await expect(generatePool({ ...base, fetch: routes(provider(), { refuseRedeem: true }).fetch })).rejects.toThrow(/redeem was refused/);
  });

  it("spaces the requests by 1 / maxRps", async () => {
    const started = Date.now();
    await generatePool({ api: "https://api.example.test", lpKey: "lp_abcdef12", origin: "https://lp.example.test", count: 3, maxRps: 20, fetch: routes(provider()).fetch, solve: inProcessSolver, concurrency: 3 });
    // 6 requests at 20 per second: the last one starts at least 5 * 50 ms after the first.
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
  });
});
