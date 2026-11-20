// The database's Owner override (packages/db sql/override.sql) derives every score it writes in SQL.
// @ebooktrivia/core is its oracle:
//   - public.score_answer (the one SQL copy of the per-answer rule) equals core scoreAnswer on random
//     millisecond inputs (property test);
//   - across varied scenarios (shortened, lengthened to 600 s and restored timer, changed correct
//     option, points, all at once, tampered rows) on seeded players (fast, slow, late, exactly at and
//     1 ms past the latency grace, sub-second, timed out, pending, never served, no deadline shown,
//     clock-skewed, exact ties, a tie broken by the finish), the rows the database writes equal what
//     core rescorePlayers computes, row for row, and the leaderboard ranks (competition ranking,
//     NULLS LAST) agree.
import { ANSWER_LATENCY_GRACE_MS, assignRanks, type PlayerStats, type RescoreInput, type RescoreQuestion, rescorePlayers, scoreAnswer } from "@ebooktrivia/core";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestAdmin, newRuntime, root, suffix } from "./support.ts";

type Id = { id: string };
const one = async <T>(rows: Promise<readonly T[]>): Promise<T> => {
  const [row] = await rows;
  if (row === undefined) throw new Error("no row");
  return row;
};

let rt: ReturnType<typeof newRuntime>;
let ownerId = "";
let programId = "";
const sets: Record<"A" | "B", string> = { A: "", B: "" };
/** question key -> id, and its options by position (1-3). */
const q: Record<string, { id: string; options: string[] }> = {};

/** Loads the program's whole state as core reads it. */
async function load(): Promise<RescoreInput> {
  const setIds = (await root<Id[]>`SELECT id FROM trivia_sets WHERE program_id = ${programId}`).map((r) => r.id);
  const questions = await root<RescoreQuestion[]>`
    SELECT q.id, q.set_id AS "setId", q.points, q.timer_seconds AS "timerSeconds",
           (SELECT o.id FROM question_options o WHERE o.question_id = q.id AND o.is_correct) AS "correctOptionId"
      FROM questions q JOIN trivia_sets s ON s.id = q.set_id WHERE s.program_id = ${programId}`;
  const attempts = await root<{ id: string; playerId: string; setId: string; score: number; totalMs: number; finishedAt: Date | null }[]>`
    SELECT a.id, a.player_id AS "playerId", a.set_id AS "setId", a.score, a.total_ms::float8 AS "totalMs", a.finished_at AS "finishedAt"
      FROM set_attempts a JOIN trivia_sets s ON s.id = a.set_id WHERE s.program_id = ${programId}`;
  const answers = await root<{ id: string; attemptId: string; questionId: string; optionId: string | null; servedAt: Date | null; deadlineAt: Date | null; answeredAt: Date | null; extensionMs: number; correct: boolean | null; points: number; elapsedMs: number | null }[]>`
    SELECT aq.id, aq.attempt_id AS "attemptId", aq.question_id AS "questionId", aq.option_id AS "optionId", aq.served_at AS "servedAt",
           aq.deadline_at AS "deadlineAt", aq.answered_at AS "answeredAt", aq.deadline_extension_ms AS "extensionMs", aq.correct, aq.points, aq.elapsed_ms AS "elapsedMs"
      FROM attempt_questions aq JOIN set_attempts a ON a.id = aq.attempt_id JOIN trivia_sets s ON s.id = a.set_id WHERE s.program_id = ${programId}`;
  const stats = await root<PlayerStats[]>`
    SELECT player_id AS "playerId", score, total_ms::float8 AS "totalMs", sets_completed AS "setsCompleted", finished_at AS "finishedAt"
      FROM player_program_stats WHERE program_id = ${programId}`;
  return {
    setIds,
    questions,
    attempts: attempts.map((a) => ({ id: a.id, playerId: a.playerId, setId: a.setId, stored: { score: a.score, totalMs: a.totalMs, finishedAt: a.finishedAt } })),
    answers: answers.map((a) => ({ ...a, stored: { correct: a.correct, points: a.points, elapsedMs: a.elapsedMs } })),
    stats,
  };
}

/** The rows as comparable plain values, sorted. */
function snapshot(input: RescoreInput) {
  const time = (d: Date | null) => d?.getTime() ?? null;
  return {
    answers: input.answers.map((a) => [a.id, a.stored.correct, a.stored.points, a.stored.elapsedMs]).sort(),
    attempts: input.attempts.map((a) => [a.id, a.stored.score, a.stored.totalMs, time(a.stored.finishedAt)]).sort(),
    stats: input.stats.map((s) => [s.playerId, s.score, s.totalMs, s.setsCompleted, time(s.finishedAt)]).sort(),
  };
}

/** `input` with core's result written back (what the database must hold afterwards). */
function expected(input: RescoreInput, change: { questionId: string; points: number; timerSeconds: number; correct: number }) {
  const questions = input.questions.map((x) => (x.id === change.questionId ? { ...x, points: change.points, timerSeconds: change.timerSeconds, correctOptionId: q[keyOf(x.id)]?.options[change.correct - 1] ?? null } : x));
  const result = rescorePlayers({ ...input, questions });
  const answers = new Map(result.answers.map((a) => [a.id, a]));
  const attempts = new Map(result.attempts.map((a) => [a.id, a]));
  const stats = new Map(result.stats.map((s) => [s.playerId, s]));
  const after: RescoreInput = {
    ...input,
    questions,
    answers: input.answers.map((a) => {
      const n = answers.get(a.id);
      return n === undefined ? a : { ...a, stored: { correct: n.correct, points: n.points, elapsedMs: n.elapsedMs } };
    }),
    attempts: input.attempts.map((a) => {
      const n = attempts.get(a.id);
      return n === undefined ? a : { ...a, stored: { score: n.score, totalMs: n.totalMs, finishedAt: n.finishedAt } };
    }),
    stats: input.stats.map((s) => stats.get(s.playerId) ?? s),
  };
  return { after, result };
}

const keyOf = (questionId: string): string => Object.entries(q).find(([, v]) => v.id === questionId)?.[0] ?? "";

const T0 = Math.floor(Date.now() / 1000) * 1000 - 3_600_000; // an hour ago, whole seconds
/** T0 + `seconds`, in whole milliseconds (seconds may carry up to 3 decimals). */
const at = (seconds: number | null): Date | null => (seconds === null ? null : new Date(T0 + Math.round(seconds * 1000)));

/**
 * answer facts: [question key, picked position or null, served s, answered s, deadline s]. The
 * deadline defaults to served + 20 s (the timer shown); null = no deadline recorded.
 */
type Facts = readonly [string, number | null, number | null, number | null, (number | null | undefined)?, number?];

async function seedPlayer(name: string, attempts: Readonly<Partial<Record<"A" | "B", readonly Facts[]>>>): Promise<string> {
  const player = await one(root<Id[]>`INSERT INTO players (phone, name) VALUES (${`+62813${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`}, ${name}) RETURNING id`);
  await root`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${player.id}, ${programId}, now(), true)`;
  for (const [set, facts] of Object.entries(attempts) as ["A" | "B", readonly Facts[]][]) {
    const attempt = await one(root<Id[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${player.id}, ${sets[set]}) RETURNING id`);
    for (const [i, [key, pick, served, answered, deadline, extension]] of facts.entries()) {
      const question = q[key];
      if (question === undefined) throw new Error(key);
      const shown = deadline === undefined ? (served === null ? null : served + 20) : deadline;
      const row = await one(root<Id[]>`
        INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at, option_id)
        VALUES (${attempt.id}, ${question.id}, ${i + 1}, ${question.options}::uuid[], ${at(served)}, ${at(shown)}, ${at(answered)},
                ${pick === null ? null : (question.options[pick - 1] ?? null)})
        RETURNING id`);
      // An Owner's outage extension (US-028) of `extension` seconds, written as only its tool may (ET106 otherwise).
      if (extension !== undefined) {
        await root.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE contest_results");
          await tx`UPDATE public.attempt_questions SET deadline_at = deadline_at + ${extension} * interval '1 second', deadline_extension_ms = ${extension * 1000} WHERE id = ${row.id}`;
        });
      }
    }
  }
  return player.id;
}

/** Writes core's score of the current rules as the stored values (how the answer path stores them). */
async function storeCoreScores(): Promise<void> {
  const input = await load();
  const players = new Set(input.attempts.map((a) => a.playerId));
  const result = rescorePlayers({ ...input, stats: input.stats.filter((s) => players.has(s.playerId)) });
  for (const a of result.answers) await root`UPDATE attempt_questions SET correct = ${a.correct}, points = ${a.points}, elapsed_ms = ${a.elapsedMs} WHERE id = ${a.id}`;
  for (const a of result.attempts) await root`UPDATE set_attempts SET score = ${a.score}, total_ms = ${a.totalMs}, finished_at = ${a.finishedAt} WHERE id = ${a.id}`;
  for (const s of result.stats) {
    await root`
      INSERT INTO player_program_stats (player_id, program_id, score, total_ms, sets_completed, finished_at)
      VALUES (${s.playerId}, ${programId}, ${s.score}, ${s.totalMs}, ${s.setsCompleted}, ${s.finishedAt})
      ON CONFLICT (player_id, program_id) DO UPDATE SET score = EXCLUDED.score, total_ms = EXCLUDED.total_ms, sets_completed = EXCLUDED.sets_completed, finished_at = EXCLUDED.finished_at`;
  }
}

beforeAll(async () => {
  rt = newRuntime();
  ownerId = (await createTestAdmin(rt, "owner")).userId;
  const product = await one(root<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
  programId = (
    await one(root<Id[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product.id}, ${`oracle-${suffix()}`}, 'Oracle', 'published', now() - interval '2 days', now() + interval '30 days', 30) RETURNING id`)
  ).id;
  for (const [set, position, keys] of [["A", 1, ["a1", "a2", "a3"]], ["B", 2, ["b1"]]] as const) {
    sets[set] = (await one(root<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${programId}, ${position}, ${set}) RETURNING id`)).id;
    for (const [i, key] of keys.entries()) {
      const question = await one(root<Id[]>`INSERT INTO questions (set_id, position, prompt, points, timer_seconds) VALUES (${sets[set]}, ${i + 1}, ${key}, 10, 20) RETURNING id`);
      const options = await root<Id[]>`
        INSERT INTO question_options (question_id, position, label, is_correct)
        VALUES (${question.id}, 1, 'A', true), (${question.id}, 2, 'B', false), (${question.id}, 3, 'C', false) RETURNING id`;
      q[key] = { id: question.id, options: options.map((o) => o.id) };
    }
  }
  // Raw facts per player: [question, pick, served s, answered s].
  await seedPlayer("fast, finished both sets", { A: [["a1", 1, 0, 3], ["a2", 1, 30, 34], ["a3", 1, 60, 62]], B: [["b1", 1, 100, 105]] });
  await seedPlayer("same totals, finished later", { A: [["a1", 1, 200, 203], ["a2", 1, 230, 234], ["a3", 1, 260, 262]], B: [["b1", 1, 300, 305]] });
  await seedPlayer("slow 12 s, wrong, timed out", { A: [["a1", 1, 0, 12], ["a2", 2, 30, 38], ["a3", null, 60, 80]] });
  await seedPlayer("inside the grace (21 s), pending", { A: [["a1", 1, 0, 21], ["a2", null, 30, null]] });
  await seedPlayer("late pick (25 s)", { A: [["a1", 1, 0, 25], ["a2", 3, 30, 33], ["a3", 1, 60, 64]] });
  await seedPlayer("never served, then right", { A: [["a1", null, null, 90], ["a2", 1, 30, 31], ["a3", 1, 60, 61]] });
  await seedPlayer("tie one", { A: [["a1", 1, 0, 5], ["a2", 2, 30, 35]] });
  await seedPlayer("tie two", { A: [["a1", 1, 400, 405], ["a2", 2, 430, 435]] });
  await seedPlayer("clock skew", { A: [["a1", 1, 10, 9], ["a2", 1, 30, 40], ["a3", 2, 60, 79]] });
  await seedPlayer("exactly at the grace (21.5 s)", { A: [["a1", 1, 0, 21.5], ["a2", 1, 30, 51.5], ["a3", 1, 60, 61.5]] });
  await seedPlayer("1 ms past the grace (21.501 s)", { A: [["a1", 1, 0, 21.501], ["a2", 1, 30, 51.501], ["a3", 1, 60, 81.501]] });
  await seedPlayer("sub-second (3.456 s), no deadline shown", { A: [["a1", 1, 0, 3.456], ["a2", 2, 30, 34.567, null], ["a3", null, 60, 85, null]] });
  // An outage extension (US-028): a1 answered 5 minutes in, inside its 10-minute extension; a3 open, extended 2 minutes.
  await seedPlayer("extended after an outage", { A: [["a1", 1, 0, 300, undefined, 600], ["a2", 2, 30, 34], ["a3", null, 60, null, undefined, 120]] });
  await storeCoreScores();
});

/** The database's ranks and core's ranks, per player. */
async function ranks(): Promise<{ db: Record<string, number>; core: Record<string, number> }> {
  const rows = await root<{ playerId: string; rank: number; score: number; totalMs: number; finishedAt: Date | null }[]>`
    SELECT player_id AS "playerId", score, total_ms::float8 AS "totalMs", finished_at AS "finishedAt",
           rank() OVER (ORDER BY score DESC, total_ms ASC, finished_at ASC NULLS LAST)::int AS rank
      FROM player_program_stats WHERE program_id = ${programId}`;
  return {
    db: Object.fromEntries(rows.map((r) => [r.playerId, r.rank])),
    core: Object.fromEntries(assignRanks(rows.map((r) => ({ id: r.playerId, score: r.score, totalMs: r.totalMs, finishedAt: r.finishedAt }))).map((r) => [r.id, r.rank])),
  };
}

const SCENARIOS: readonly (readonly [string, { questionId: () => string; points: number; timerSeconds: number; correct: number }])[] = [
  ["shortened timer (a1 20 s -> 10 s)", { questionId: () => q["a1"]?.id ?? "", points: 10, timerSeconds: 10, correct: 1 }],
  ["lengthened timer (a1 -> 30 s)", { questionId: () => q["a1"]?.id ?? "", points: 10, timerSeconds: 30, correct: 1 }],
  ["lengthened to 600 s (a3: timeouts keep the shown 20 s)", { questionId: () => q["a3"]?.id ?? "", points: 10, timerSeconds: 600, correct: 1 }],
  ["restored timer (a1 -> 20 s)", { questionId: () => q["a1"]?.id ?? "", points: 10, timerSeconds: 20, correct: 1 }],
  ["changed correct option (a2 -> 2)", { questionId: () => q["a2"]?.id ?? "", points: 10, timerSeconds: 20, correct: 2 }],
  ["points change (a3 -> 25)", { questionId: () => q["a3"]?.id ?? "", points: 25, timerSeconds: 20, correct: 1 }],
  ["all at once (a1: 7 points, 12 s, option 3)", { questionId: () => q["a1"]?.id ?? "", points: 7, timerSeconds: 12, correct: 3 }],
  ["back to the start (a1, a2, a3 restored)", { questionId: () => q["a1"]?.id ?? "", points: 10, timerSeconds: 20, correct: 1 }],
];

describe("override_question_scoring equals core rescorePlayers (the oracle)", () => {
  it("the seed is consistent: re-scoring it under its own rules changes nothing", async () => {
    const input = await load();
    expect(rescorePlayers(input)).toMatchObject({ answers: [], attempts: [], stats: [] });
    expect(input.stats).toHaveLength(13);
  });

  it.each(SCENARIOS)("%s: every answer, attempt and stats row, the summary and the ranks", async (_name, scenario) => {
    const before = await load();
    const change = { questionId: scenario.questionId(), points: scenario.points, timerSeconds: scenario.timerSeconds, correct: scenario.correct };
    const { after, result } = expected(before, change);
    const option = q[keyOf(change.questionId)]?.options[change.correct - 1] ?? "";
    const setId = before.questions.find((x) => x.id === change.questionId)?.setId ?? "";
    const [row] = await rt.sql<{ summary: Record<string, number> }[]>`
      SELECT public.override_question_scoring(${programId}, ${setId}, ${change.questionId}, ${change.points}, ${change.timerSeconds}, ${option},
                                              'Oracle scenario re-score.', ${ownerId}, NULL, NULL) AS summary`;
    const db = await load();
    expect(snapshot(db)).toEqual(snapshot(after));
    expect(row?.summary).toMatchObject({ answers_changed: result.answers.length, score_before: result.before.score, score_after: result.after.score, total_ms_before: result.before.totalMs, total_ms_after: result.after.totalMs });
    const r = await ranks();
    expect(r.db).toEqual(r.core);
    // Re-scoring the database's own result under the same rules changes nothing (idempotent).
    expect(rescorePlayers(db)).toMatchObject({ answers: [], attempts: [], stats: [] });
  });

  it("re-derives a tampered answer on ANOTHER question and a tampered attempt finish, like core", async () => {
    // public_rw can write attempt_questions.points; a finish can be stored wrong too.
    const victim = await one(root<{ answer: string; attempt: string }[]>`
      SELECT aq.id AS answer, a.id AS attempt FROM attempt_questions aq JOIN set_attempts a ON a.id = aq.attempt_id
       WHERE aq.question_id = ${q["a2"]?.id ?? ""} AND aq.answered_at IS NOT NULL AND aq.points > 0 ORDER BY aq.id LIMIT 1`);
    const finished = await one(root<Id[]>`SELECT a.id FROM set_attempts a WHERE a.set_id = ${sets.A} AND a.finished_at IS NOT NULL ORDER BY a.id LIMIT 1`);
    await root`UPDATE attempt_questions SET points = 999, correct = true, elapsed_ms = 1 WHERE id = ${victim.answer}`;
    await root`UPDATE set_attempts SET finished_at = date_trunc('milliseconds', now()) WHERE id = ${finished.id}`;
    const before = await load();
    // Override a1 (unchanged rule): the tampered a2 row and the tampered finish are re-derived.
    const change = { questionId: q["a1"]?.id ?? "", points: 10, timerSeconds: 20, correct: 1 };
    const { after, result } = expected(before, change);
    expect(result.answers.map((a) => a.id)).toContain(victim.answer);
    expect(result.attempts.map((a) => a.id)).toContain(finished.id);
    await rt.sql`
      SELECT public.override_question_scoring(${programId}, ${sets.A}, ${change.questionId}, 10, 20, ${q["a1"]?.options[0] ?? ""}, 'Oracle re-derives tampered rows.', ${ownerId}, NULL, NULL)`;
    const db = await load();
    expect(snapshot(db)).toEqual(snapshot(after));
    expect(rescorePlayers(db)).toMatchObject({ answers: [], attempts: [], stats: [] });
  });

  it("restores the original rules at the end, and two exact ties share a rank", async () => {
    for (const key of ["a2", "a3"]) {
      const question = q[key];
      if (question === undefined) throw new Error(key);
      const setId = (await one(root<{ setId: string }[]>`SELECT set_id AS "setId" FROM questions WHERE id = ${question.id}`)).setId;
      await rt.sql`SELECT public.override_question_scoring(${programId}, ${setId}, ${question.id}, 10, 20, ${question.options[0] ?? ""}, 'Oracle restores the rules.', ${ownerId}, NULL, NULL)`;
    }
    const db = await load();
    expect(rescorePlayers(db)).toMatchObject({ answers: [], attempts: [], stats: [] });
    const r = await ranks();
    const ties = Object.values(r.db).filter((rank, _i, all) => all.filter((x) => x === rank).length > 1);
    expect(ties.length).toBeGreaterThanOrEqual(2);
    expect(r.db).toEqual(r.core);
  });
});

describe("public.score_answer equals core scoreAnswer (property, whole milliseconds)", () => {
  it("on random rules and answer facts, with and without an outage extension (US-028)", async () => {
    const OPTION = { right: "00000000-0000-4000-8000-000000000001", wrong: "00000000-0000-4000-8000-000000000002" } as const;
    const base = T0;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 5, max: 600 }),
        fc.boolean(), // a correct option recorded
        fc.option(fc.constantFrom<"right" | "wrong">("right", "wrong")),
        fc.option(fc.integer({ min: 0, max: 600_000 }), { freq: 6 }), // served offset
        fc.option(fc.integer({ min: 0, max: 700_000 }), { freq: 3 }), // shown deadline - served
        fc.oneof({ weight: 2, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 7_200_000 }) }), // the extension inside the deadline
        // answered - served: anywhere, or anchored at the grace edge cap + extension + 1500 ms + {-1, 0, +1}.
        fc.oneof(
          fc.option(fc.integer({ min: -5_000, max: 8_000_000 }), { freq: 6 }).map((ms) => ({ kind: "free" as const, ms })),
          fc.constantFrom(-1, 0, 1).map((delta) => ({ kind: "edge" as const, delta })),
        ),
        async (points, timerSeconds, hasCorrect, pick, served, shown, extension, answered) => {
          const servedAt = served === null ? null : new Date(base + served);
          // An extension only exists on a shown deadline (CHECK), which then holds it.
          const extensionMs = servedAt === null || shown === null ? 0 : extension;
          const deadlineAt = servedAt === null || shown === null ? null : new Date(servedAt.getTime() + shown + extensionMs);
          const cap = shown === null ? timerSeconds * 1000 : Math.min(timerSeconds * 1000, shown);
          const answerOffset = answered.kind === "edge" ? cap + extensionMs + ANSWER_LATENCY_GRACE_MS + answered.delta : answered.ms;
          const answeredAt = answerOffset === null ? null : new Date((servedAt ?? new Date(base)).getTime() + answerOffset);
          const correctOptionId = hasCorrect ? OPTION.right : null;
          const optionId = pick === null ? null : OPTION[pick];
          const core = scoreAnswer({ points, timerSeconds, correctOptionId }, { optionId, servedAt, deadlineAt, answeredAt, extensionMs });
          const [sql] = await root<{ correct: boolean | null; points: number; elapsedMs: number | null }[]>`
            SELECT correct, points, elapsed_ms AS "elapsedMs"
              FROM public.score_answer(${points}, ${timerSeconds}, ${correctOptionId}::uuid, ${optionId}::uuid, ${servedAt}, ${deadlineAt}, ${answeredAt}, ${extensionMs})`;
          expect(sql).toEqual(core);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("at the grace edge: 21.5 s is on time, 21.501 s is late; a shorter shown deadline caps elapsed", async () => {
    const servedAt = new Date(T0);
    const right = "00000000-0000-4000-8000-000000000001";
    for (const [answeredMs, deadlineMs, timer, expected] of [
      [21_500, 20_000, 20, { correct: true, points: 10, elapsedMs: 20_000 }],
      [21_501, 20_000, 20, { correct: false, points: 0, elapsedMs: 20_000 }],
      [3_456, null, 20, { correct: true, points: 10, elapsedMs: 3_456 }],
      [25_000, 20_000, 600, { correct: false, points: 0, elapsedMs: 20_000 }],
      [25_000, null, 600, { correct: true, points: 10, elapsedMs: 25_000 }],
    ] as const) {
      const facts = { optionId: right, servedAt, deadlineAt: deadlineMs === null ? null : new Date(T0 + deadlineMs), answeredAt: new Date(T0 + answeredMs), extensionMs: 0 };
      expect(scoreAnswer({ points: 10, timerSeconds: timer, correctOptionId: right }, facts)).toEqual(expected);
      const [sql] = await root<{ correct: boolean | null; points: number; elapsedMs: number | null }[]>`
        SELECT correct, points, elapsed_ms AS "elapsedMs" FROM public.score_answer(10, ${timer}, ${right}::uuid, ${right}::uuid, ${facts.servedAt}, ${facts.deadlineAt}, ${facts.answeredAt}, 0)`;
      expect(sql).toEqual(expected);
    }
  });
});
