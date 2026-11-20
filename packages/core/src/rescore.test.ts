// The Owner override's re-score (US-018), tested with seeded attempt rows: three players on a
// two-set program, stored the way the answer path stores them, then re-scored under changed
// rules (correct option, points, a shortened and a restored timer).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ANSWER_LATENCY_GRACE_MS,
  type PlayerStats,
  type RescoreAnswer,
  type RescoreAttempt,
  type RescoreInput,
  type RescoreQuestion,
  type RescoreResult,
  rescorePlayers,
  scoreAnswer,
} from "./rescore.ts";

const T0 = Date.parse("2027-05-01T03:00:00.000Z");
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

const QUESTIONS: readonly RescoreQuestion[] = [
  { id: "q1", setId: "s1", points: 10, timerSeconds: 20, correctOptionId: "o1a" },
  { id: "q2", setId: "s1", points: 10, timerSeconds: 20, correctOptionId: "o2a" },
  { id: "q3", setId: "s2", points: 10, timerSeconds: 20, correctOptionId: "o3a" },
];

const answer = (id: string, attemptId: string, questionId: string, optionId: string | null, served: number | null, answered: number | null, stored: RescoreAnswer["stored"]): RescoreAnswer => ({
  id,
  attemptId,
  questionId,
  optionId,
  servedAt: served === null ? null : at(served),
  // The deadline the player was shown: served + the 20 s timer every seeded question had.
  deadlineAt: served === null ? null : at(served + 20),
  answeredAt: answered === null ? null : at(answered),
  stored,
});

/**
 * A: s1 q1 right in 5 s, q2 right in 12 s; s2 q3 wrong in 3 s (finished both sets).
 * B: s1 q1 wrong in 8 s, q2 timed out (20 s); never started s2.
 * C: s1 q1 right in 11 s, q2 served and still open.
 */
const ANSWERS: readonly RescoreAnswer[] = [
  answer("a-a1-q1", "aA1", "q1", "o1a", 0, 5, { correct: true, points: 10, elapsedMs: 5000 }),
  answer("a-a1-q2", "aA1", "q2", "o2a", 10, 22, { correct: true, points: 10, elapsedMs: 12000 }),
  answer("a-a2-q3", "aA2", "q3", "o3b", 60, 63, { correct: false, points: 0, elapsedMs: 3000 }),
  answer("b-b1-q1", "aB1", "q1", "o1b", 0, 8, { correct: false, points: 0, elapsedMs: 8000 }),
  answer("b-b1-q2", "aB1", "q2", null, 10, 30, { correct: false, points: 0, elapsedMs: 20000 }),
  answer("c-c1-q1", "aC1", "q1", "o1a", 0, 11, { correct: true, points: 10, elapsedMs: 11000 }),
  answer("c-c1-q2", "aC1", "q2", null, 20, null, { correct: null, points: 0, elapsedMs: null }),
];

const ATTEMPTS: readonly RescoreAttempt[] = [
  { id: "aA1", playerId: "pA", setId: "s1", stored: { score: 20, totalMs: 17000, finishedAt: at(22) } },
  { id: "aA2", playerId: "pA", setId: "s2", stored: { score: 0, totalMs: 3000, finishedAt: at(63) } },
  { id: "aB1", playerId: "pB", setId: "s1", stored: { score: 0, totalMs: 28000, finishedAt: at(30) } },
  { id: "aC1", playerId: "pC", setId: "s1", stored: { score: 10, totalMs: 11000, finishedAt: null } },
];

const STATS: readonly PlayerStats[] = [
  { playerId: "pA", score: 20, totalMs: 20000, setsCompleted: 2, finishedAt: at(63) },
  { playerId: "pB", score: 0, totalMs: 28000, setsCompleted: 1, finishedAt: null },
  { playerId: "pC", score: 10, totalMs: 11000, setsCompleted: 0, finishedAt: null },
];

const seeded = (questions: readonly RescoreQuestion[] = QUESTIONS): RescoreInput => ({ setIds: ["s1", "s2"], questions, attempts: ATTEMPTS, answers: ANSWERS, stats: STATS });
const withRule = (id: string, change: Partial<RescoreQuestion>): RescoreQuestion[] => QUESTIONS.map((q) => (q.id === id ? { ...q, ...change } : q));

/** The input with `result` written back, as the database holds it after the override. */
function applied(input: RescoreInput, result: RescoreResult, questions: readonly RescoreQuestion[]): RescoreInput {
  const answers = new Map(result.answers.map((a) => [a.id, a]));
  const attempts = new Map(result.attempts.map((a) => [a.id, a]));
  const stats = new Map(result.stats.map((s) => [s.playerId, s]));
  return {
    setIds: input.setIds,
    questions,
    answers: input.answers.map((a) => {
      const n = answers.get(a.id);
      return n === undefined ? a : { ...a, stored: { correct: n.correct, points: n.points, elapsedMs: n.elapsedMs } };
    }),
    attempts: input.attempts.map((a) => {
      const n = attempts.get(a.id);
      return n === undefined ? a : { ...a, stored: { score: n.score, totalMs: n.totalMs, finishedAt: n.finishedAt } };
    }),
    stats: [...new Set([...input.stats.map((s) => s.playerId), ...stats.keys()])].map((p) => stats.get(p) ?? input.stats.find((s) => s.playerId === p) ?? { playerId: p, score: 0, totalMs: 0, setsCompleted: 0, finishedAt: null }),
  };
}

describe("rescorePlayers with seeded attempt rows", () => {
  it("re-scoring under unchanged rules changes nothing (stored rows follow the same rules)", () => {
    const result = rescorePlayers(seeded());
    expect(result).toMatchObject({ players: 3, answersScored: 7, answers: [], attempts: [], stats: [] });
    expect(result.after).toEqual(result.before);
    expect(result.before).toEqual({ score: 30, totalMs: 59000, setsCompleted: 3, finished: 1 });
  });

  it("recomputes from the raw pick and timestamps, never from a stored score", () => {
    const tampered: RescoreInput = {
      ...seeded(),
      answers: ANSWERS.map((a) => (a.id === "b-b1-q1" ? { ...a, stored: { correct: true, points: 10, elapsedMs: 1 } } : a)),
      attempts: ATTEMPTS.map((a) => (a.id === "aB1" ? { ...a, stored: { ...a.stored, score: 10 } } : a)),
      stats: STATS.map((s) => (s.playerId === "pB" ? { ...s, score: 1000 } : s)),
    };
    const result = rescorePlayers(tampered);
    expect(result.answers).toEqual([{ id: "b-b1-q1", correct: false, points: 0, elapsedMs: 8000 }]);
    expect(result.attempts).toEqual([{ id: "aB1", score: 0, totalMs: 28000, finishedAt: at(30) }]);
    expect(result.stats).toEqual([{ playerId: "pB", score: 0, totalMs: 28000, setsCompleted: 1, finishedAt: null }]);
  });

  it("changing which option is correct re-scores every affected answer, attempt and player", () => {
    const result = rescorePlayers(seeded(withRule("q1", { correctOptionId: "o1b" })));
    expect(result.answers).toEqual([
      { id: "a-a1-q1", correct: false, points: 0, elapsedMs: 5000 },
      { id: "b-b1-q1", correct: true, points: 10, elapsedMs: 8000 },
      { id: "c-c1-q1", correct: false, points: 0, elapsedMs: 11000 },
    ]);
    expect(result.attempts).toEqual([
      { id: "aA1", score: 10, totalMs: 17000, finishedAt: at(22) },
      { id: "aB1", score: 10, totalMs: 28000, finishedAt: at(30) },
      { id: "aC1", score: 0, totalMs: 11000, finishedAt: null },
    ]);
    expect(result.stats).toEqual([
      { playerId: "pA", score: 10, totalMs: 20000, setsCompleted: 2, finishedAt: at(63) },
      { playerId: "pB", score: 10, totalMs: 28000, setsCompleted: 1, finishedAt: null },
      { playerId: "pC", score: 0, totalMs: 11000, setsCompleted: 0, finishedAt: null },
    ]);
    expect(result.before).toEqual({ score: 30, totalMs: 59000, setsCompleted: 3, finished: 1 });
    expect(result.after).toEqual({ score: 20, totalMs: 59000, setsCompleted: 3, finished: 1 });
  });

  it("changing points changes only the players who answered that question correctly", () => {
    const result = rescorePlayers(seeded(withRule("q2", { points: 25 })));
    expect(result.answers).toEqual([{ id: "a-a1-q2", correct: true, points: 25, elapsedMs: 12000 }]);
    expect(result.attempts).toEqual([{ id: "aA1", score: 35, totalMs: 17000, finishedAt: at(22) }]);
    expect(result.stats).toEqual([{ playerId: "pA", score: 35, totalMs: 20000, setsCompleted: 2, finishedAt: at(63) }]);
    expect(result.after.score - result.before.score).toBe(15);
  });

  it("a shortened timer: an answer after the new deadline (+1500 ms grace) becomes a timeout, elapsed is capped at the new timer", () => {
    // q2 20 s -> 10 s: A answered at 12 s (> 10 s + 1.5 s): timeout, 0 points, 10 000 ms.
    // B's timeout counted 20 s: now min(20 s, 10 s). C's q2 is still open: untouched.
    const result = rescorePlayers(seeded(withRule("q2", { timerSeconds: 10 })));
    expect(result.answers).toEqual([
      { id: "a-a1-q2", correct: false, points: 0, elapsedMs: 10000 },
      { id: "b-b1-q2", correct: false, points: 0, elapsedMs: 10000 },
    ]);
    expect(result.attempts).toEqual([
      { id: "aA1", score: 10, totalMs: 15000, finishedAt: at(22) },
      { id: "aB1", score: 0, totalMs: 18000, finishedAt: at(30) },
    ]);
    expect(result.stats.map((s) => [s.playerId, s.score, s.totalMs])).toEqual([
      ["pA", 10, 18000],
      ["pB", 0, 18000],
    ]);
  });

  it("a shortened timer keeps an answer that arrived inside the latency grace, with elapsed = the new timer", () => {
    // q1 20 s -> 10 s: C answered right at 11 s, inside 10 s + 1.5 s: still correct, elapsed 10 000 ms.
    const result = rescorePlayers(seeded(withRule("q1", { timerSeconds: 10 })));
    expect(result.answers).toEqual([{ id: "c-c1-q1", correct: true, points: 10, elapsedMs: 10000 }]);
    expect(result.stats).toEqual([{ playerId: "pC", score: 10, totalMs: 10000, setsCompleted: 0, finishedAt: null }]);
  });

  it("a lengthened timer never rewards a pick made after the deadline the player was shown", () => {
    // D picked the right answer 25 s after being served, past the 20 s deadline shown (+1.5 s): a timeout.
    const late = answer("d-d1-q1", "aD1", "q1", "o1a", 0, 25, { correct: false, points: 0, elapsedMs: 20000 });
    const input: RescoreInput = {
      ...seeded(),
      attempts: [...ATTEMPTS, { id: "aD1", playerId: "pD", setId: "s1", stored: { score: 0, totalMs: 20000, finishedAt: null } }],
      answers: [...ANSWERS, late],
      stats: [...STATS, { playerId: "pD", score: 0, totalMs: 20000, setsCompleted: 0, finishedAt: null }],
    };
    // q1 20 s -> 30 s: D stays a timeout capped at the 20 s deadline shown; nothing changes at all.
    const result = rescorePlayers({ ...input, questions: withRule("q1", { timerSeconds: 30 }) });
    expect(result).toMatchObject({ answers: [], attempts: [], stats: [] });
    // Without a recorded deadline the 30 s timer would accept it: deadline_at is what caps it.
    expect(scoreAnswer({ points: 10, timerSeconds: 30, correctOptionId: "o1a" }, { ...late, deadlineAt: null })).toEqual({ correct: true, points: 10, elapsedMs: 25000 });
  });

  it("a lengthened timer adds no time to a timeout: elapsed is capped at the deadline the player was shown (security review N1)", () => {
    // B's q2 timed out at its 20 s deadline. q2 20 s -> 600 s: still 20 000 ms, B's total unchanged.
    const result = rescorePlayers(seeded(withRule("q2", { timerSeconds: 600 })));
    expect(result).toMatchObject({ answers: [], attempts: [], stats: [] });
    expect(result.after.totalMs).toBe(result.before.totalMs);
    // A never-served row has no deadline: it counts the current timer (the documented asymmetry).
    expect(scoreAnswer({ points: 10, timerSeconds: 600, correctOptionId: "x" }, { optionId: null, servedAt: null, deadlineAt: null, answeredAt: at(1) })).toEqual({ correct: false, points: 0, elapsedMs: 600_000 });
  });

  it("restoring the timer restores the original scores (the pick is never rewritten)", () => {
    const shortened = withRule("q2", { timerSeconds: 10 });
    const first = rescorePlayers(seeded(shortened));
    const afterFirst = applied(seeded(), first, shortened);
    const restored = rescorePlayers({ ...afterFirst, questions: QUESTIONS });
    const back = applied(afterFirst, restored, QUESTIONS);
    expect(back.answers.map((a) => a.stored)).toEqual(ANSWERS.map((a) => a.stored));
    expect(back.attempts.map((a) => a.stored)).toEqual(ATTEMPTS.map((a) => a.stored));
    expect(restored.after).toEqual(first.before);
  });

  it("is idempotent: re-scoring its own written result changes nothing", () => {
    const rules = withRule("q1", { correctOptionId: "o1b", points: 7, timerSeconds: 6 });
    const first = rescorePlayers(seeded(rules));
    const second = rescorePlayers(applied(seeded(), first, rules));
    expect(second).toMatchObject({ answers: [], attempts: [], stats: [] });
    expect(second.before).toEqual(first.after);
  });

  it("is deterministic: input order does not matter, output is sorted by id", () => {
    const rules = withRule("q1", { correctOptionId: "o1b" });
    const reversed: RescoreInput = {
      setIds: ["s2", "s1"],
      questions: [...rules].reverse(),
      attempts: [...ATTEMPTS].reverse(),
      answers: [...ANSWERS].reverse(),
      stats: [...STATS].reverse(),
    };
    expect(rescorePlayers(reversed)).toEqual(rescorePlayers(seeded(rules)));
  });

  it("finished_at: the last set finish once EVERY set of the program is finished, NULL otherwise", () => {
    const withThirdSet: RescoreInput = { ...seeded(), setIds: ["s1", "s2", "s3"], questions: [...QUESTIONS, { id: "q4", setId: "s3", points: 10, timerSeconds: 20, correctOptionId: "o4a" }] };
    const result = rescorePlayers(withThirdSet);
    expect(result.stats).toEqual([{ playerId: "pA", score: 20, totalMs: 20000, setsCompleted: 2, finishedAt: null }]);
    expect(result.after.finished).toBe(0);
  });

  it("writes a stats row for a player who has none yet", () => {
    const result = rescorePlayers({ ...seeded(), stats: STATS.filter((s) => s.playerId !== "pC") });
    expect(result.stats).toEqual([{ playerId: "pC", score: 10, totalMs: 11000, setsCompleted: 0, finishedAt: null }]);
    expect(result.before.score).toBe(20);
  });

  it("an attempt with no answer rows yet scores 0 and is not finished", () => {
    const input: RescoreInput = { ...seeded(), attempts: [...ATTEMPTS, { id: "aB2", playerId: "pB", setId: "s2", stored: { score: 0, totalMs: 0, finishedAt: null } }] };
    expect(rescorePlayers(input)).toMatchObject({ answers: [], attempts: [], stats: [] });
  });

  it.each<[string, (input: RescoreInput) => RescoreInput]>([
    ["a duplicate set id", (i) => ({ ...i, setIds: ["s1", "s1"] })],
    ["a duplicate question", (i) => ({ ...i, questions: [...i.questions, QUESTIONS[0] as RescoreQuestion] })],
    ["a question outside the program's sets", (i) => ({ ...i, questions: [...i.questions, { id: "qx", setId: "sx", points: 1, timerSeconds: 1, correctOptionId: null }] })],
    ["negative points", (i) => ({ ...i, questions: withRule("q1", { points: -1 }) })],
    ["a zero timer", (i) => ({ ...i, questions: withRule("q1", { timerSeconds: 0 }) })],
    ["an attempt outside the program's sets", (i) => ({ ...i, attempts: [...i.attempts, { id: "ax", playerId: "pA", setId: "sx", stored: { score: 0, totalMs: 0, finishedAt: null } }] })],
    ["two attempts of one player on one set", (i) => ({ ...i, attempts: [...i.attempts, { id: "aA9", playerId: "pA", setId: "s1", stored: { score: 0, totalMs: 0, finishedAt: null } }] })],
    ["a duplicate attempt", (i) => ({ ...i, attempts: [...i.attempts, ATTEMPTS[0] as RescoreAttempt] })],
    ["stats of a player without an attempt", (i) => ({ ...i, stats: [...i.stats, { playerId: "pZ", score: 0, totalMs: 0, setsCompleted: 0, finishedAt: null }] })],
    ["a duplicate stats row", (i) => ({ ...i, stats: [...i.stats, STATS[0] as PlayerStats] })],
    ["an answer of an unknown attempt", (i) => ({ ...i, answers: [...i.answers, answer("x", "a??", "q1", null, 0, 1, { correct: false, points: 0, elapsedMs: 1000 })] })],
    ["an answer for a question of another set", (i) => ({ ...i, answers: [...i.answers, answer("x", "aA1", "q3", null, 0, 1, { correct: false, points: 0, elapsedMs: 1000 })] })],
    ["a duplicate answer row", (i) => ({ ...i, answers: [...i.answers, ANSWERS[0] as RescoreAnswer] })],
    ["two answer rows for one question of an attempt", (i) => ({ ...i, answers: [...i.answers, answer("a-a1-q1-bis", "aA1", "q1", null, 0, 1, { correct: false, points: 0, elapsedMs: 1000 })] })],
    ["an invalid timestamp", (i) => ({ ...i, answers: [answer("x", "aA1", "q1", null, 0, Number.NaN, { correct: false, points: 0, elapsedMs: 0 })] })],
  ])("refuses %s", (_what, broken) => {
    expect(() => rescorePlayers(broken(seeded()))).toThrow(RangeError);
  });
});

describe("scoreAnswer", () => {
  const rule = { points: 10, timerSeconds: 20, correctOptionId: "right" };

  it("pending, never served, timeout, late, inside the grace, right and wrong", () => {
    expect(scoreAnswer(rule, { optionId: null, servedAt: at(0), deadlineAt: null, answeredAt: null })).toEqual({ correct: null, points: 0, elapsedMs: null });
    expect(scoreAnswer(rule, { optionId: null, servedAt: null, deadlineAt: null, answeredAt: at(99) })).toEqual({ correct: false, points: 0, elapsedMs: 20000 });
    expect(scoreAnswer(rule, { optionId: null, servedAt: at(0), deadlineAt: at(20), answeredAt: at(20) })).toEqual({ correct: false, points: 0, elapsedMs: 20000 });
    expect(scoreAnswer(rule, { optionId: "right", servedAt: at(0), deadlineAt: null, answeredAt: new Date(T0 + 20000 + ANSWER_LATENCY_GRACE_MS + 1) })).toEqual({ correct: false, points: 0, elapsedMs: 20000 });
    expect(scoreAnswer(rule, { optionId: "right", servedAt: at(0), deadlineAt: null, answeredAt: new Date(T0 + 20000 + ANSWER_LATENCY_GRACE_MS) })).toEqual({ correct: true, points: 10, elapsedMs: 20000 });
    expect(scoreAnswer(rule, { optionId: "right", servedAt: at(0), deadlineAt: at(20), answeredAt: at(4) })).toEqual({ correct: true, points: 10, elapsedMs: 4000 });
    expect(scoreAnswer(rule, { optionId: "wrong", servedAt: at(0), deadlineAt: at(20), answeredAt: at(4) })).toEqual({ correct: false, points: 0, elapsedMs: 4000 });
  });

  it("counts a clock-skewed answer (answered before served) as 0 ms, and a question without a correct option as wrong", () => {
    expect(scoreAnswer(rule, { optionId: "right", servedAt: at(5), deadlineAt: null, answeredAt: at(4) })).toEqual({ correct: true, points: 10, elapsedMs: 0 });
    expect(scoreAnswer({ ...rule, correctOptionId: null }, { optionId: "right", servedAt: at(0), deadlineAt: null, answeredAt: at(1) })).toEqual({ correct: false, points: 0, elapsedMs: 1000 });
  });

  it("never scores above the question's points or above its timer (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 600 }),
        fc.option(fc.constantFrom("right", "wrong")),
        fc.option(fc.integer({ min: -5_000, max: 700_000 })),
        fc.option(fc.integer({ min: 0, max: 700_000 })),
        (points, timerSeconds, optionId, offset, deadline) => {
          const scored = scoreAnswer({ points, timerSeconds, correctOptionId: "right" }, { optionId, servedAt: at(0), deadlineAt: deadline === null ? null : new Date(T0 + deadline), answeredAt: offset === null ? null : new Date(T0 + offset) });
          expect(scored.points === 0 || scored.points === points).toBe(true);
          expect((scored.elapsedMs ?? 0) <= timerSeconds * 1000).toBe(true);
          expect(scored.points > 0).toBe(scored.correct === true && points > 0);
        },
      ),
    );
  });
});
