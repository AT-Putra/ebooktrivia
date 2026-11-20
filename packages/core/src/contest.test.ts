// The grace-end finalize, ranking and winners (US-028), masking, and the facts finalize relies on.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareFinal,
  type ContestAnswer,
  type ContestInput,
  type ContestQuestion,
  finalizeContest,
  finalizedAt,
  graceEndAt,
  maskName,
  maskPhone,
} from "./contest.ts";
import { compareRanking } from "./ranking.ts";
import { DAY_MS, unlockedCount } from "./unlock.ts";

const G = new Date(Date.parse("2027-07-31T17:00:00.000Z")); // 00:00 WIB after D_end 2027-07-31
const at = (seconds: number): Date => new Date(G.getTime() - 10 * DAY_MS + seconds * 1000);
const paid = new Date(G.getTime() - 40 * DAY_MS);

/** Two sets of two 20 s / 10 point questions; option "<q>-r" is right, "<q>-w" wrong. */
const QUESTIONS: readonly ContestQuestion[] = [
  { id: "q1", setId: "s1", points: 10, timerSeconds: 20, correctOptionId: "q1-r" },
  { id: "q2", setId: "s1", points: 10, timerSeconds: 20, correctOptionId: "q2-r" },
  { id: "q3", setId: "s2", points: 10, timerSeconds: 20, correctOptionId: "q3-r" },
  { id: "q4", setId: "s2", points: 10, timerSeconds: 30, correctOptionId: "q4-r" },
];

const row = (id: string, attemptId: string, questionId: string, pick: "r" | "w" | null, served: number | null, answered: number | null, extra: Partial<ContestAnswer> = {}): ContestAnswer => ({
  id,
  attemptId,
  questionId,
  optionId: pick === null ? null : `${questionId}-${pick}`,
  servedAt: served === null ? null : at(served),
  deadlineAt: served === null ? null : at(served + (QUESTIONS.find((q) => q.id === questionId)?.timerSeconds ?? 0)),
  extensionMs: 0,
  answeredAt: answered === null ? null : at(answered),
  ...extra,
});

function base(over: Partial<ContestInput> = {}): ContestInput {
  return {
    graceEnd: G,
    setIds: ["s1", "s2"],
    questions: QUESTIONS,
    players: [
      { id: "pA", eligible: true, firstPaidAt: paid },
      { id: "pB", eligible: true, firstPaidAt: paid },
      { id: "pC", eligible: true, firstPaidAt: paid },
      { id: "pD", eligible: false, firstPaidAt: paid },
    ],
    attempts: [
      { id: "aA1", playerId: "pA", setId: "s1" },
      { id: "aA2", playerId: "pA", setId: "s2" },
      { id: "aB1", playerId: "pB", setId: "s1" },
      { id: "aD1", playerId: "pD", setId: "s1" },
    ],
    answers: [
      // A: everything answered, 20 points in 5 + 6 + 7 + 8 s, finishing at 1008 s.
      row("r-a1", "aA1", "q1", "r", 0, 5),
      row("r-a2", "aA1", "q2", "r", 100, 106),
      row("r-a3", "aA2", "q3", "w", 1000, 1007),
      row("r-a4", "aA2", "q4", "w", 1000, 1008),
      // B: q1 right in 4 s, q2 served at 200 s and left open; never started s2.
      row("r-b1", "aB1", "q1", "r", 0, 4),
      row("r-b2", "aB1", "q2", null, 200, null),
      // D (refunded): q1 right in 1 s, q2 never served.
      row("r-d1", "aD1", "q1", "r", 0, 1),
      row("r-d2", "aD1", "q2", null, null, null),
    ],
    tiers: [
      { id: "t2", rankFrom: 2, rankTo: 3 },
      { id: "t1", rankFrom: 1, rankTo: 1 },
    ],
    ...over,
  };
}

describe("graceEndAt", () => {
  it("is sales end plus grace days", () => {
    expect(graceEndAt(new Date("2027-06-30T17:00:00.000Z"), 31)).toEqual(G);
    expect(() => graceEndAt(new Date(Number.NaN), 1)).toThrow(RangeError);
    expect(() => graceEndAt(G, -1)).toThrow(RangeError);
    expect(() => graceEndAt(G, 1.5)).toThrow(RangeError);
  });

  it("every set is unlocked at G for every player who paid by then (so finalize may charge every unplayed question)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.parse("2027-01-01T00:00:00Z"), max: Date.parse("2028-01-01T00:00:00Z") }),
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 0, max: 120 }),
        fc.integer({ min: 1, max: 200 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (salesEndMs, graceDays, setCount, salesDays, where) => {
          const salesEnd = new Date(salesEndMs);
          const graceEnd = graceEndAt(salesEnd, graceDays);
          // Paid anywhere from the sales start to G itself (late settlement included).
          const start = salesEndMs - salesDays * DAY_MS;
          const firstPaidAt = new Date(Math.floor(start + where * (graceEnd.getTime() - start)));
          expect(unlockedCount({ salesEnd, graceDays, setCount, firstPaidAt, now: graceEnd, attempted: 0 })).toBe(setCount);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("finalizedAt", () => {
  it("keeps an answer, closes a served row at its deadline (or served + timer) and an unserved one at G", () => {
    expect(finalizedAt({ extensionMs: 0, optionId: null, servedAt: at(0), deadlineAt: at(20), answeredAt: at(3) }, 20, G)).toEqual(at(3));
    expect(finalizedAt({ extensionMs: 0, optionId: null, servedAt: at(0), deadlineAt: at(25), answeredAt: null }, 20, G)).toEqual(at(25));
    expect(finalizedAt({ extensionMs: 0, optionId: null, servedAt: at(0), deadlineAt: null, answeredAt: null }, 20, G)).toEqual(at(20));
    expect(finalizedAt({ extensionMs: 0, optionId: null, servedAt: null, deadlineAt: null, answeredAt: null }, 20, G)).toEqual(G);
  });
});

describe("finalizeContest", () => {
  it("finalizes open and unserved rows as timeouts with the full timer and 0 points", () => {
    const result = finalizeContest(base());
    const answer = (id: string) => result.answers.find((a) => a.id === id);
    expect(answer("r-b2")).toEqual({ id: "r-b2", answeredAt: at(220), correct: false, points: 0, elapsedMs: 20_000 });
    expect(answer("r-d2")).toEqual({ id: "r-d2", answeredAt: G, correct: false, points: 0, elapsedMs: 20_000 });
    expect(answer("r-a1")).toEqual({ id: "r-a1", answeredAt: at(5), correct: true, points: 10, elapsedMs: 5000 });
    expect(result.answers.map((a) => a.id)).toEqual(["r-a1", "r-a2", "r-a3", "r-a4", "r-b1", "r-b2", "r-d1", "r-d2"]);
  });

  it("adds the timers of every set never started as one aggregate, and leaves finished_at NULL", () => {
    const { stats, attempts } = finalizeContest(base());
    expect(stats).toEqual([
      { playerId: "pA", score: 20, totalMs: 26_000, setsCompleted: 2, finishedAt: at(1008), unplayedMs: 0 },
      // 4 s + 20 s (q2 timed out) + 20 s + 30 s (s2 never started).
      { playerId: "pB", score: 10, totalMs: 74_000, setsCompleted: 1, finishedAt: null, unplayedMs: 50_000 },
      // Never started anything: every timer.
      { playerId: "pC", score: 0, totalMs: 90_000, setsCompleted: 0, finishedAt: null, unplayedMs: 90_000 },
      // D's set 1 has a question never served: not finished (security review N6).
      { playerId: "pD", score: 10, totalMs: 71_000, setsCompleted: 0, finishedAt: null, unplayedMs: 50_000 },
    ]);
    expect(attempts.find((a) => a.id === "aB1")).toEqual({ id: "aB1", score: 10, totalMs: 24_000, finishedAt: at(220) });
  });

  it("ranks eligible players only, NULLS LAST, and awards the tiers by rank", () => {
    const { entries, winners } = finalizeContest(base());
    expect(entries.map((e) => [e.rank, e.playerId])).toEqual([
      [1, "pA"],
      [2, "pB"],
      [3, "pC"],
    ]);
    expect(winners).toEqual([
      { tierId: "t1", playerId: "pA", rank: 1 },
      { tierId: "t2", playerId: "pB", rank: 2 },
      { tierId: "t2", playerId: "pC", rank: 3 },
    ]);
  });

  it("a finished player ranks ahead of an unfinished one with the same score and time (NULLS LAST)", () => {
    const input = base({
      setIds: ["s1"],
      questions: QUESTIONS.slice(0, 2),
      attempts: [
        { id: "aA1", playerId: "pA", setId: "s1" },
        { id: "aB1", playerId: "pB", setId: "s1" },
      ],
      answers: [
        // A finishes late; B leaves q2 open, so it is finalized as a 20 s timeout ...
        row("r-a1", "aA1", "q1", "r", 0, 5),
        row("r-a2", "aA1", "q2", null, 5000, 5020),
        row("r-b1", "aB1", "q1", "r", 0, 5),
        row("r-b2", "aB1", "q2", null, 10, null),
      ],
      players: [
        { id: "pA", eligible: true, firstPaidAt: paid },
        { id: "pB", eligible: true, firstPaidAt: paid },
      ],
    });
    // ... and both finish, B earlier: B ranks first.
    expect(finalizeContest(input).entries.map((e) => e.playerId)).toEqual(["pB", "pA"]);
    // Without B's q2 row B's set is unfinished: same score and time (the missing row costs its timer), finished_at NULL last.
    const missing = { ...input, answers: input.answers.filter((a) => a.id !== "r-b2") };
    const result = finalizeContest(missing);
    expect(result.stats.find((s) => s.playerId === "pB")).toMatchObject({ totalMs: 25_000, finishedAt: null, unplayedMs: 20_000 });
    expect(result.entries.map((e) => e.playerId)).toEqual(["pA", "pB"]);
  });

  it("breaks an exact tie by the earlier first payment, then by player id (unique ranks)", () => {
    const tie = (firstPaidA: Date | null, firstPaidB: Date | null) =>
      finalizeContest(
        base({
          players: [
            { id: "pB", eligible: true, firstPaidAt: firstPaidB },
            { id: "pA", eligible: true, firstPaidAt: firstPaidA },
          ],
          attempts: [],
          answers: [],
          tiers: [{ id: "t1", rankFrom: 1, rankTo: 1 }],
        }),
      );
    const later = new Date(paid.getTime() + 1);
    expect(tie(later, paid).entries.map((e) => [e.rank, e.playerId])).toEqual([
      [1, "pB"],
      [2, "pA"],
    ]);
    expect(tie(paid, paid).entries.map((e) => e.playerId)).toEqual(["pA", "pB"]);
    expect(tie(paid, paid).winners).toEqual([{ tierId: "t1", playerId: "pA", rank: 1 }]);
    // A missing first payment (not possible for an eligible player in the database) sorts last.
    expect(tie(null, paid).entries.map((e) => e.playerId)).toEqual(["pB", "pA"]);
    expect(tie(paid, null).entries.map((e) => e.playerId)).toEqual(["pA", "pB"]);
  });

  it("scores with the current rules, never the stored ones, and counts an answer given in an outage extension", () => {
    const extended = row("r-b2", "aB1", "q2", "r", 200, 200 + 3600, { deadlineAt: at(200 + 20 + 3600), extensionMs: 3_600_000 });
    const result = finalizeContest(base({ answers: [row("r-b1", "aB1", "q1", "w", 0, 4), extended] }));
    expect(result.answers).toEqual([
      { id: "r-b1", answeredAt: at(4), correct: false, points: 0, elapsedMs: 4000 },
      // Inside the extended deadline: it counts, with the full 20 s charged.
      { id: "r-b2", answeredAt: at(3800), correct: true, points: 10, elapsedMs: 20_000 },
    ]);
    // An open extended question is closed at its extended deadline, still charged 20 s.
    const open = finalizeContest(base({ answers: [{ ...extended, optionId: null, answeredAt: null }] }));
    expect(open.answers).toEqual([{ id: "r-b2", answeredAt: at(3820), correct: false, points: 0, elapsedMs: 20_000 }]);
  });

  it("counts a question served at or after G as never served (finalized at G, the full timer, 0 points)", () => {
    const afterG = { id: "r-b2", attemptId: "aB1", questionId: "q2", optionId: "q2-r", servedAt: G, deadlineAt: new Date(G.getTime() + 20_000), answeredAt: null, extensionMs: 0 };
    expect(finalizedAt(afterG, 20, G)).toEqual(G);
    const result = finalizeContest(base({ answers: [row("r-b1", "aB1", "q1", "r", 0, 4), afterG, { ...afterG, id: "r-b3", questionId: "q1", attemptId: "aA1", answeredAt: new Date(G.getTime() + 5000) }] }));
    expect(result.answers).toEqual([
      { id: "r-b1", answeredAt: at(4), correct: true, points: 10, elapsedMs: 4000 },
      { id: "r-b2", answeredAt: G, correct: false, points: 0, elapsedMs: 20_000 },
      // An answer to it (only a trusted writer could store one) is still scored as never served.
      { id: "r-b3", answeredAt: new Date(G.getTime() + 5000), correct: false, points: 0, elapsedMs: 20_000 },
    ]);
  });

  it("does not count a set started but never served as finished: it ties with a set never started (security review N6)", () => {
    const one = QUESTIONS.slice(0, 2);
    const result = finalizeContest(
      base({
        setIds: ["s1"],
        questions: one,
        players: [
          { id: "pA", eligible: true, firstPaidAt: paid },
          { id: "pB", eligible: true, firstPaidAt: paid },
        ],
        attempts: [{ id: "aA1", playerId: "pA", setId: "s1" }],
        answers: [row("r-a1", "aA1", "q1", null, null, null), row("r-a2", "aA1", "q2", null, null, null)],
        tiers: [],
      }),
    );
    expect(result.attempts).toEqual([{ id: "aA1", score: 0, totalMs: 40_000, finishedAt: null }]);
    // Same score, same time, both unfinished: only the stable tie-breakers order them.
    expect(result.stats.map((s) => [s.playerId, s.score, s.totalMs, s.finishedAt])).toEqual([
      ["pA", 0, 40_000, null],
      ["pB", 0, 40_000, null],
    ]);
    // One served question is not enough either.
    const half = finalizeContest(base({ setIds: ["s1"], questions: one, attempts: [{ id: "aA1", playerId: "pA", setId: "s1" }], answers: [row("r-a1", "aA1", "q1", "r", 0, 3), row("r-a2", "aA1", "q2", null, null, null)], tiers: [] }));
    expect(half.attempts[0]?.finishedAt).toBeNull();
  });

  it("counts no set as finished in a program without sets", () => {
    const result = finalizeContest(base({ setIds: [], questions: [], attempts: [], answers: [], tiers: [] }));
    expect(result.stats.every((s) => s.finishedAt === null && s.totalMs === 0)).toBe(true);
    expect(result.winners).toEqual([]);
  });

  it.each<[string, Partial<ContestInput>]>([
    ["an invalid grace end", { graceEnd: new Date(Number.NaN) }],
    ["a duplicate set", { setIds: ["s1", "s1"] }],
    ["a duplicate question", { questions: [...QUESTIONS, QUESTIONS[0] as ContestQuestion] }],
    ["a question outside the program", { questions: [...QUESTIONS, { id: "qx", setId: "sx", points: 1, timerSeconds: 5, correctOptionId: null }] }],
    ["a duplicate player", { players: [...base().players, { id: "pA", eligible: true, firstPaidAt: paid }] }],
    ["an attempt on another program's set", { attempts: [...base().attempts, { id: "ax", playerId: "pC", setId: "sx" }] }],
    ["an attempt of an unknown player", { attempts: [...base().attempts, { id: "ax", playerId: "px", setId: "s2" }] }],
    ["a second attempt on one set", { attempts: [...base().attempts, { id: "ax", playerId: "pA", setId: "s1" }] }],
    ["an answer of an unknown attempt", { answers: [row("rx", "ax", "q1", null, null, null)] }],
    ["an answer for another set's question", { answers: [row("rx", "aA1", "q3", null, null, null)] }],
    ["one question answered twice", { answers: [row("rx", "aA1", "q1", null, null, null), row("ry", "aA1", "q1", null, null, null)] }],
    ["a duplicate answer id", { answers: [row("rx", "aA1", "q1", null, null, null), row("rx", "aA1", "q2", null, null, null)] }],
    ["a prize tier starting below 1", { tiers: [{ id: "t", rankFrom: 0, rankTo: 1 }] }],
    ["a prize tier ending before it starts", { tiers: [{ id: "t", rankFrom: 3, rankTo: 2 }] }],
    ["overlapping prize tiers", { tiers: [{ id: "t", rankFrom: 1, rankTo: 3 }, { id: "u", rankFrom: 3, rankTo: 4 }] }],
  ])("refuses %s", (_what, over) => {
    expect(() => finalizeContest(base(over))).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Properties on random play histories.

const TIMERS = [5, 20, 30] as const;
const questionsArb = fc.array(fc.array(fc.constantFrom(...TIMERS), { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 3 });

/** One question's play: never served (row but no serve), served and open, or answered (pick, after ms). */
const playArb = fc.oneof(
  fc.constant({ kind: "unserved" as const }),
  fc.record({ kind: fc.constant("open" as const), served: fc.integer({ min: 0, max: 1000 }) }),
  fc.record({ kind: fc.constant("answered" as const), served: fc.integer({ min: 0, max: 1000 }), after: fc.integer({ min: 0, max: 40_000 }), right: fc.boolean() }),
);

type Play = typeof playArb extends fc.Arbitrary<infer T> ? T : never;

function program(timers: readonly (readonly number[])[]) {
  const setIds = timers.map((_, s) => `s${String(s)}`);
  const questions: ContestQuestion[] = timers.flatMap((set, s) =>
    set.map((timerSeconds, i) => ({ id: `q${String(s)}-${String(i)}`, setId: `s${String(s)}`, points: 10, timerSeconds, correctOptionId: `q${String(s)}-${String(i)}-r` })),
  );
  return { setIds, questions };
}

function answerOf(id: string, attemptId: string, q: ContestQuestion, play: Play): ContestAnswer {
  const base0 = G.getTime() - DAY_MS;
  if (play.kind === "unserved") return { id, attemptId, questionId: q.id, extensionMs: 0, optionId: null, servedAt: null, deadlineAt: null, answeredAt: null };
  const servedAt = new Date(base0 + play.served * 1000);
  const deadlineAt = new Date(servedAt.getTime() + q.timerSeconds * 1000);
  if (play.kind === "open") return { id, attemptId, questionId: q.id, extensionMs: 0, optionId: null, servedAt, deadlineAt, answeredAt: null };
  return { id, attemptId, questionId: q.id, extensionMs: 0, optionId: `${q.id}-${play.right ? "r" : "w"}`, servedAt, deadlineAt, answeredAt: new Date(servedAt.getTime() + play.after) };
}

describe("properties", () => {
  it("skipping a set never beats playing it, whatever the play", () => {
    fc.assert(
      fc.property(questionsArb, fc.array(fc.option(fc.array(playArb, { minLength: 3, maxLength: 3 }), { nil: undefined }), { minLength: 3, maxLength: 3 }), fc.nat(), (timers, plays, pick) => {
        const { setIds, questions } = program(timers);
        // The history: set s is played with plays[s] (undefined = never started).
        const history = (played: readonly (readonly Play[] | undefined)[]) => {
          const attempts = setIds.flatMap((setId, s) => (played[s] === undefined ? [] : [{ id: `a${String(s)}`, playerId: "p", setId }]));
          const answers = setIds.flatMap((setId, s) => {
            const p = played[s];
            if (p === undefined) return [];
            return questions.filter((q) => q.setId === setId).map((q, i) => answerOf(`r${String(s)}-${String(i)}`, `a${String(s)}`, q, p[i] ?? { kind: "unserved" }));
          });
          const result = finalizeContest({ graceEnd: G, setIds, questions, players: [{ id: "p", eligible: true, firstPaidAt: paid }], attempts, answers, tiers: [] });
          const entry = result.entries[0];
          if (entry === undefined) throw new Error("no entry");
          return entry;
        };
        const skippedSet = pick % setIds.length;
        const skipped = plays.map((p, s) => (s === skippedSet ? undefined : p));
        const played = plays.map((p, s) => (s === skippedSet ? (p ?? []) : p));
        expect(compareRanking(history(played), history(skipped))).toBeLessThanOrEqual(0);
      }),
      { numRuns: 500 },
    );
  });

  it("ranks are unique 1..n in compareFinal order, input order does not matter, and winners are exactly the ranks inside the tiers", () => {
    fc.assert(
      fc.property(
        questionsArb,
        fc.array(fc.record({ eligible: fc.boolean(), paidDay: fc.integer({ min: 0, max: 3 }), sets: fc.array(fc.option(fc.array(playArb, { minLength: 3, maxLength: 3 }), { nil: undefined }), { minLength: 3, maxLength: 3 }) }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 4 }),
        (timers, people, tierSize) => {
          const { setIds, questions } = program(timers);
          const players = people.map((p, i) => ({ id: `p${String(i)}`, eligible: p.eligible, firstPaidAt: new Date(paid.getTime() + p.paidDay * DAY_MS) }));
          const attempts = people.flatMap((p, i) => setIds.flatMap((setId, s) => (p.sets[s] === undefined ? [] : [{ id: `a${String(i)}-${String(s)}`, playerId: `p${String(i)}`, setId }])));
          const answers = people.flatMap((p, i) =>
            setIds.flatMap((setId, s) => {
              const play = p.sets[s];
              if (play === undefined) return [];
              return questions.filter((q) => q.setId === setId).map((q, k) => answerOf(`r${String(i)}-${String(s)}-${String(k)}`, `a${String(i)}-${String(s)}`, q, play[k] ?? { kind: "unserved" }));
            }),
          );
          const tiers = [
            { id: "gold", rankFrom: 1, rankTo: tierSize },
            { id: "silver", rankFrom: tierSize + 2, rankTo: tierSize + 3 },
          ];
          const input: ContestInput = { graceEnd: G, setIds, questions, players, attempts, answers, tiers };
          const result = finalizeContest(input);
          const eligible = players.filter((p) => p.eligible);
          expect(result.entries.map((e) => e.rank)).toEqual(eligible.map((_, i) => i + 1));
          for (const [i, e] of result.entries.entries()) {
            const next = result.entries[i + 1];
            if (next === undefined) continue;
            const key = (x: typeof e) => ({ ...x, firstPaidAt: players.find((p) => p.id === x.playerId)?.firstPaidAt ?? null });
            expect(compareFinal(key(e), key(next))).toBeLessThan(0);
          }
          expect(result.winners.map((w) => w.rank)).toEqual(result.entries.map((e) => e.rank).filter((r) => r <= tierSize || (r >= tierSize + 2 && r <= tierSize + 3)));
          const reversed = finalizeContest({ ...input, players: [...players].reverse(), attempts: [...attempts].reverse(), answers: [...answers].reverse(), tiers: [...tiers].reverse() });
          expect(reversed).toEqual(result);
          // Every elapsed is within its question's timer, and no row stays open.
          for (const a of result.answers) {
            const q = questions.find((x) => x.id === answers.find((y) => y.id === a.id)?.questionId);
            expect(a.elapsedMs).toBeLessThanOrEqual((q?.timerSeconds ?? 0) * 1000);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("masking", () => {
  it("keeps each word's first character, with a fixed mask", () => {
    expect(maskName("Budi Santoso")).toBe("B*** S***");
    expect(maskName("  siti\t nur  ")).toBe("s*** n***");
    expect(maskName("Ñandú 😀x")).toBe("Ñ*** 😀***");
    expect(maskName("A")).toBe("A***");
    expect(maskName("")).toBe("***");
    expect(maskName(" \n ")).toBe("***");
  });

  it("shows only the last 3 digits of a phone", () => {
    expect(maskPhone("+6281234567890")).toBe("****890");
    expect(maskPhone("+62 812-3456-7012")).toBe("****012");
    expect(maskPhone("12")).toBe("****12");
    expect(maskPhone(null)).toBeNull();
  });

  it("never contains more of a name than its initials", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 12, unit: "grapheme-ascii" }), { maxLength: 5 }), (words) => {
        const masked = maskName(words.join(" "));
        for (const token of masked.split(" ")) expect(Array.from(token.replace(/\*+$/, "")).length).toBeLessThanOrEqual(1);
      }),
    );
  });
});
