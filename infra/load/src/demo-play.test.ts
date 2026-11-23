import { describe, expect, it } from "vitest";
import { type DemoFile, type PlayPlan } from "./demo-plan.ts";
import { MAX_CONCURRENCY, MAX_SPEED, type PlayFetch, type PlayResponse, playBuyer, runDemoPlay, runLimitProblems } from "./demo-play.ts";

const BASE = "https://play.example.test";
const TIMER_MS = 20_000;
const QUESTIONS = 4;

/**
 * An in-memory play API on a virtual clock (the sleep of the simulator advances it), with the rules the real one has that matter here:
 * a question is served once and its timer runs from then; an answer after deadline + 1.5 s is refused; a question left alone past that is
 * closed as a timeout by the next `current`; an answered question cannot be answered again.
 */
class FakeApi {
  clock = 0;
  readonly waits: number[] = [];
  readonly calls: string[] = [];
  readonly picks: { correct: boolean; elapsedMs: number }[] = [];
  loginStatus = 200;
  /** The next calls to this path answer 429 with Retry-After 7. */
  limited = new Map<string, number>();
  /** The next answers are refused (409) whatever they say. */
  rejectAnswers = 0;
  /** How many response bodies the simulator cancelled (a retried 429 or 5xx, a login). */
  cancelled = 0;
  /** The question each attempt has served so far (positions), to see that no question was served that nobody answered. */
  readonly served: number[] = [];
  private readonly attempts = new Map<string, { setId: string; rows: { id: string; served: number | null; done: boolean; options: string[]; correct: string }[] }>();

  readonly sleep = (ms: number): Promise<void> => {
    this.waits.push(ms);
    this.clock += ms;
    return Promise.resolve();
  };

  private reply(status: number, body: unknown, headers: Record<string, string> = {}, cookies: string[] = []): PlayResponse {
    return {
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null, getSetCookie: () => cookies },
      body: {
        cancel: () => {
          this.cancelled++;
          return Promise.resolve();
        },
      },
      json: () => Promise.resolve(body),
    };
  }

  readonly fetch: PlayFetch = (url, init) => {
    const path = url.slice(BASE.length);
    this.calls.push(path.split("?")[0] ?? path);
    const left = this.limited.get(path) ?? 0;
    if (left > 0) {
      this.limited.set(path, left - 1);
      return Promise.resolve(this.reply(429, { error: "rate_limited" }, { "retry-after": "7" }));
    }
    const body = init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, string>);
    if (path === "/api/v1/play/auth/magic-link") {
      return Promise.resolve(this.loginStatus === 200 ? this.reply(200, { ok: true }, {}, [`__Host-play_session=sess-${body["token"] ?? ""}; Path=/; Secure; HttpOnly`]) : this.reply(this.loginStatus, { error: "forbidden" }));
    }
    if (!(init.headers["cookie"] ?? "").startsWith("__Host-play_session=sess-")) return Promise.resolve(this.reply(401, { error: "unauthorized" }));
    if (init.headers["origin"] !== BASE) return Promise.resolve(this.reply(403, { error: "origin" }));
    if (path === "/api/v1/play/sets/start") {
      const id = `attempt-${body["set_id"] ?? ""}-${init.headers["cookie"] ?? ""}`;
      if (!this.attempts.has(id)) {
        const rows = Array.from({ length: QUESTIONS }, (_, q) => {
          const options = [0, 1, 2, 3].map((o) => `${body["set_id"] ?? ""}-q${String(q)}-o${String(o)}`);
          const correct = options[(q + 1) % 4] ?? "";
          return { id: `${id}-a${String(q)}`, served: null, done: false, options, correct };
        });
        this.attempts.set(id, { setId: body["set_id"] ?? "", rows });
      }
      return Promise.resolve(this.reply(200, { v: 1, attempt_id: id }));
    }
    if (path === "/api/v1/play/attempts/current") {
      const attempt = this.attempts.get(body["attempt_id"] ?? "");
      if (attempt === undefined) return Promise.resolve(this.reply(403, { error: "forbidden" }));
      let timedOut = 0;
      for (const [index, row] of attempt.rows.entries()) {
        if (row.done) continue;
        if (row.served !== null && this.clock > row.served + TIMER_MS + 1500) {
          row.done = true;
          timedOut++;
          continue;
        }
        if (row.served === null) {
          row.served = this.clock;
          this.served.push(index + 1);
        }
        return Promise.resolve(
          this.reply(200, {
            v: 1,
            state: "question",
            answer_id: row.id,
            position: index + 1,
            total: attempt.rows.length,
            prompt: "?",
            options: row.options.map((id) => ({ id, label: id })),
            remaining_ms: Math.max(0, row.served + TIMER_MS - this.clock),
            window_ms: TIMER_MS,
            timed_out: timedOut,
          }),
        );
      }
      return Promise.resolve(this.reply(200, { v: 1, state: "finished", total: attempt.rows.length, timed_out: timedOut }));
    }
    if (path === "/api/v1/play/attempts/answer") {
      const row = [...this.attempts.values()].flatMap((a) => a.rows).find((r) => r.id === body["answer_id"]);
      if (row === undefined || row.served === null) return Promise.resolve(this.reply(403, { error: "forbidden" }));
      if (this.rejectAnswers > 0) {
        this.rejectAnswers--;
        return Promise.resolve(this.reply(409, { error: "too_late" }));
      }
      if (row.done) return Promise.resolve(this.reply(409, { error: "already_answered" }));
      if (this.clock > row.served + TIMER_MS + 1500) return Promise.resolve(this.reply(409, { error: "too_late" }));
      row.done = true;
      const correct = body["option_id"] === row.correct;
      this.picks.push({ correct, elapsedMs: this.clock - row.served });
      return Promise.resolve(this.reply(200, { v: 1, state: "answered", correct, correct_option_id: row.correct }));
    }
    if (path.startsWith("/api/v1/play/leaderboard")) return Promise.resolve(this.reply(200, { v: 1, top: [{ rank: 1, name: "Budi S.", score: 80 }, { rank: 2, name: "Siti W.", score: 70 }] }));
    return Promise.resolve(this.reply(404, {}));
  };

  deps(speed = 1) {
    return { base: BASE, fetch: this.fetch, sleep: this.sleep, speed };
  }
}

const PLAN: PlayPlan = { sets_to_play: 2, skill: 1, think_min_ms: 2000, think_max_ms: 12_000, timeout_rate: 0, abandon_last_set: false, abandon_fraction: 0.5, play_seed: 99 };

/** The answer key as the seed writes it: the correct option of every question (the fake makes option `(q + 1) % 4` correct). */
const KEY = ["s1", "s2", "s3"].flatMap((s) => Array.from({ length: QUESTIONS }, (_, q) => `${s}-q${String(q)}-o${String((q + 1) % 4)}`));

const file = (plans: PlayPlan[], key: string[] = KEY): DemoFile => ({
  kind: "demo",
  run_id: "1a2b3c4d",
  seed: 1,
  planned_at: "2026-11-23T05:00:00.000Z",
  program_id: "program-1",
  program_slug: "demo",
  set_ids: ["s1", "s2", "s3"],
  questions_per_set: [QUESTIONS, QUESTIONS, QUESTIONS],
  correct_option_ids: key,
  buyers: plans.map((plan, i) => ({ index: i + 1, label: `demo-1a2b3c4d-0${String(i + 1)}`, token: `tok${String(i + 1)}`, plan })),
});

const play = (api: FakeApi, plan: PlayPlan, speed = 1, key: string[] = KEY) => {
  const demo = file([plan], key);
  return playBuyer(api.deps(speed), demo, new Set(demo.correct_option_ids), demo.buyers[0] as DemoFile["buyers"][number]);
};

describe("playBuyer", () => {
  const run = async (plan: PlayPlan, speed = 1, api = new FakeApi()) => ({ api, result: await play(api, plan, speed) });

  it("logs in through the app's own route, then plays the planned sets in order with real waits inside the timer", async () => {
    const { api, result } = await run(PLAN);
    expect(result).toMatchObject({ loggedIn: true, sets_started: 2, sets_finished: 2, sets_left_half: 0, answers: 8, correct: 8, timeouts: 0, errors: 0 });
    expect(api.calls.slice(0, 3)).toEqual(["/api/v1/play/auth/magic-link", "/api/v1/play/sets/start", "/api/v1/play/attempts/current"]);
    // Every answer came after a think time inside the buyer's range and well before the deadline.
    for (const pick of api.picks) {
      expect(pick.elapsedMs).toBeGreaterThanOrEqual(PLAN.think_min_ms);
      expect(pick.elapsedMs).toBeLessThanOrEqual(PLAN.think_max_ms);
    }
    // Set 3 was not planned: it was never started.
    expect(api.calls.filter((c) => c === "/api/v1/play/sets/start")).toHaveLength(2);
  });

  it("answers at the planned skill: a skill of 1 is always right, a skill of 0 always wrong", async () => {
    expect((await run({ ...PLAN, skill: 0 })).result).toMatchObject({ answers: 8, correct: 0 });
    const { result } = await run({ ...PLAN, skill: 0.6, sets_to_play: 3 });
    expect(result.answers).toBe(12);
    expect(result.correct).toBeGreaterThan(0);
    expect(result.correct).toBeLessThan(12);
  });

  it("is deterministic: the same plan plays the same way, to the millisecond", async () => {
    const plan = { ...PLAN, skill: 0.6, timeout_rate: 0.2, sets_to_play: 3 };
    const a = await run(plan);
    const b = await run(plan);
    expect(a.api.waits).toEqual(b.api.waits);
    expect(a.api.picks).toEqual(b.api.picks);
    expect(a.result).toEqual(b.result);
    expect((await run({ ...plan, play_seed: 100 })).api.picks).not.toEqual(a.api.picks);
  });

  it("scales think times with --speed, but never the wait of a timeout", async () => {
    const slow = await run(PLAN, 1);
    const fast = await run(PLAN, 10);
    const thinks = (waits: number[]): number[] => waits.filter((w) => w < TIMER_MS);
    expect(Math.max(...thinks(fast.api.waits))).toBeLessThanOrEqual(PLAN.think_max_ms / 10);
    expect(Math.max(...thinks(slow.api.waits))).toBeGreaterThan(PLAN.think_max_ms / 10);
    // A question meant to time out waits its whole timer plus the server's grace (and a margin), at any speed.
    const timeouts = await run({ ...PLAN, timeout_rate: 1, sets_to_play: 1 }, 50);
    expect(timeouts.result).toMatchObject({ answers: 0, timeouts: QUESTIONS, sets_finished: 1, errors: 0 });
    expect(timeouts.api.waits.filter((w) => w >= TIMER_MS + 1500)).toHaveLength(QUESTIONS);
  });

  it("never lets an answer fall outside the timer, even for a buyer whose think time is longer than the timer", async () => {
    const { api, result } = await run({ ...PLAN, think_min_ms: 30_000, think_max_ms: 40_000, sets_to_play: 1 });
    expect(result).toMatchObject({ answers: QUESTIONS, errors: 0, timeouts: 0 });
    for (const pick of api.picks) expect(pick.elapsedMs).toBeLessThanOrEqual(TIMER_MS - 3000);
  });

  it("leaves the last planned set half played when the plan says so, after the planned share of its questions", async () => {
    const { api, result } = await run({ ...PLAN, abandon_last_set: true, abandon_fraction: 0.5 });
    expect(result).toMatchObject({ sets_started: 2, sets_finished: 1, sets_left_half: 1, answers: QUESTIONS + 2, errors: 0 });
    // It stops before asking for the next question: a question that is shown is a question whose timer runs, so the third question of the
    // second set was never served (served: set 1 positions 1 to 4, set 2 positions 1 and 2), and `current` was called 5 + 2 times.
    expect(api.served).toEqual([1, 2, 3, 4, 1, 2]);
    expect(api.calls.filter((c) => c === "/api/v1/play/attempts/current")).toHaveLength(QUESTIONS + 1 + 2);
    // The share never turns the set into a finished one: 0.99 of 4 questions stops after 3.
    expect((await run({ ...PLAN, abandon_last_set: true, abandon_fraction: 0.99 })).result.answers).toBe(QUESTIONS + 3);
  });

  it("a set left half played is resumed where it stopped (starting it again returns the same attempt), and the plan stops at the same point", async () => {
    const api = new FakeApi();
    const plan = { ...PLAN, abandon_last_set: true, sets_to_play: 1 };
    expect((await play(api, plan)).answers).toBe(2);
    // The same buyer again (the fake keys attempts by session): the question served at the first stop is shown again and nothing more is answered.
    const again = await play(api, plan);
    expect(again).toMatchObject({ answers: 0, sets_left_half: 1, errors: 0 });
  });

  it("waits out a 429 (Retry-After) on a call and goes on", async () => {
    const api = new FakeApi();
    api.limited.set("/api/v1/play/sets/start", 2);
    const { result } = await run(PLAN, 1, api);
    expect(result).toMatchObject({ sets_finished: 2, errors: 0 });
    expect(api.waits.filter((w) => w === 7000)).toHaveLength(2);
    // The bodies of the two retried 429s and of the login were cancelled, not left open.
    expect(api.cancelled).toBe(3);
  });

  it("gives up a set after three answers refused in a row, and counts each refusal", async () => {
    const api = new FakeApi();
    api.rejectAnswers = 3;
    const { result } = await run({ ...PLAN, sets_to_play: 1 }, 1, api);
    expect(result).toMatchObject({ answers: 0, errors: 3, sets_started: 1, sets_finished: 0 });
    expect(api.calls.filter((c) => c === "/api/v1/play/attempts/answer")).toHaveLength(3);
    // Two refusals and then an accepted answer do not end the set.
    const lenient = new FakeApi();
    lenient.rejectAnswers = 2;
    expect((await run({ ...PLAN, sets_to_play: 1 }, 1, lenient)).result).toMatchObject({ answers: QUESTIONS, errors: 2, sets_finished: 1 });
  });

  it("counts a refused login as an error and plays nothing", async () => {
    const api = new FakeApi();
    api.loginStatus = 403;
    const { result } = await run(PLAN, 1, api);
    expect(result).toMatchObject({ loggedIn: false, errors: 1, answers: 0, sets_started: 0 });
    expect(result.messages[0]).toMatch(/login/);
    expect(api.calls).toEqual(["/api/v1/play/auth/magic-link"]);
  });

  it("answers a question outside the answer key at random and counts it", async () => {
    const result = await play(new FakeApi(), PLAN, 1, []);
    expect(result).toMatchObject({ unknown_questions: 8, answers: 8, errors: 0 });
  });
});

describe("runLimitProblems: a real origin is never driven harder than speed 20 and 30 buyers at a time", () => {
  it("accepts the limits themselves and anything below, and refuses above them with the flag named", () => {
    expect(runLimitProblems("https://play.example.test", MAX_CONCURRENCY, MAX_SPEED)).toEqual([]);
    expect(runLimitProblems("https://play.example.test", 10, 1)).toEqual([]);
    expect(runLimitProblems("https://play.example.test", 10, MAX_SPEED + 1)).toEqual([expect.stringMatching(/--speed 21 is above 20/)]);
    expect(runLimitProblems("https://play.example.test", MAX_CONCURRENCY + 1, 1)).toEqual([expect.stringMatching(/--concurrency 31 is above 30/)]);
    expect(runLimitProblems("https://play.example.test", 100, 100)).toHaveLength(2);
  });

  it("lets a loopback rehearsal go as fast as it likes", () => {
    for (const base of ["http://127.0.0.1:3410", "http://localhost:3410", "http://localhost"]) expect(runLimitProblems(base, 500, 1000), base).toEqual([]);
    // A look-alike is not loopback.
    expect(runLimitProblems("https://127.0.0.1.evil.test", 500, 1000)).toHaveLength(2);
  });
});

describe("runDemoPlay", () => {
  it("plays every buyer, adds the counts up and reads the leaderboard as the first buyer who logged in", async () => {
    const api = new FakeApi();
    const plans = [PLAN, { ...PLAN, sets_to_play: 1, skill: 0 }, { ...PLAN, sets_to_play: 3, timeout_rate: 1 }];
    const lines: string[] = [];
    // One buyer at a time: the fake's clock is shared, and the buyers' waits must not move each other's timers.
    const { summary, results } = await runDemoPlay({ ...api.deps(), log: (l) => lines.push(l) }, file(plans), 1);
    expect(results).toHaveLength(3);
    expect(summary).toMatchObject({ buyers: 3, logged_in: 3, sets_started: 6, sets_finished: 6, answers: 12, correct: 8, timeouts: 3 * QUESTIONS, errors: 0 });
    expect(summary.leaderboard).toEqual(["#1 Budi S.: 80 points", "#2 Siti W.: 70 points"]);
    expect(api.calls.at(-1)).toBe("/api/v1/play/leaderboard");
    expect(lines).toHaveLength(3);
    // No login token is ever printed.
    expect(lines.join("\n")).not.toMatch(/tok\d/);
  });

  it("starts at most `concurrency` buyers at once and plays all of them", async () => {
    let active = 0;
    let peak = 0;
    const deps = {
      base: BASE,
      speed: 1,
      sleep: () => Promise.resolve(),
      // Every login is refused after a pause, so each buyer ends at once; the pause shows how many are in flight.
      fetch: (async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { status: 403, headers: { get: () => null, getSetCookie: () => [] }, json: () => Promise.resolve({}) };
      }) satisfies PlayFetch,
    };
    const { summary } = await runDemoPlay(deps, file([PLAN, PLAN, PLAN, PLAN, PLAN]), 2);
    expect(peak).toBe(2);
    expect(summary).toMatchObject({ buyers: 5, logged_in: 0, errors: 5 });
  });
});
