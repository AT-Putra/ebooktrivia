// US-027 (M9b): the question flow through the play functions (sql/play.sql), called as public_rw, the public
// app's role. The database is the clock: every time below is moved by shifting the stored timestamps back (as
// the superuser), never by passing one in.
//   - start: unlocked + eligible + before the grace end; ONE attempt per player and set, also when started in
//     parallel; every answer row inserted at once, unserved, shuffled;
//   - current: a call that serves answers "served" and nothing of the question; the next call (a new
//     transaction that writes nothing) shows it; a refresh shows the same question with LESS time left; a question
//     past its deadline + 1500 ms closes as a timeout (0 points, the full timer, nothing revealed);
//   - answer: one write; exactly one of two concurrent answers is recorded; accepted until the deadline + 1500 ms
//     with elapsed = min(answered - served, timer); the attempt and the stats are updated in the same write; the
//     correct option and the explanation come only from play_reveal, for a committed pick (AC-Q9);
//   - THE ROLLBACK PROBE (security review HIGH-1): no read of a question, a correctness or a score inside a
//     transaction that has written (ET147), also in one simple-query string that ends in an error;
//   - IDOR: another player's set, attempt or answer row is refused (ET140 / ET141), whatever the id;
//   - after the grace end nothing starts or is served (closed), while a question served before it still counts;
//   - the leaderboard: the final order (compareFinal, D4) with the snapshot's total time (D8), masked, eligible
//     players only; the player's own rank; an oracle: the live order of random play equals the snapshot's;
//   - the unlock floor: a set once shown open stays open after an extend-only reschedule.
import { randomInt } from "node:crypto";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";
import { asRole, first, sql, sqlState } from "./db.ts";
import { createPlayer, createProgram, createTriviaSet, type Question } from "./fixtures.ts";

type Json = Record<string, unknown>;
const DEVICE = Buffer.alloc(32, 1);

const start = (playerId: string, setId: string) =>
  asRole("public_rw", async (tx) => first(await tx<{ id: string }[]>`SELECT public.play_start_set(${playerId}, ${setId}) AS id`).id);
/** ONE play_current call, in a transaction of its own. */
const currentOnce = (playerId: string, attemptId: string) =>
  asRole("public_rw", async (tx) => first(await tx<{ r: Json }[]>`SELECT public.play_current(${playerId}, ${attemptId}, '203.0.113.7', ${DEVICE}) AS r`).r);
/** What the app does (lib/play/trivia.ts handleCurrent): call again after "served", adding up the timeouts. */
async function current(playerId: string, attemptId: string): Promise<Json> {
  let closed = 0;
  for (let call = 0; call < 3; call++) {
    const r = await currentOnce(playerId, attemptId);
    closed += Number(r["timed_out"] ?? 0);
    if (r["state"] !== "served") return { ...r, timed_out: closed };
  }
  throw new Error("served three times");
}
const answerOnly = (playerId: string, answerId: string, optionId: string) =>
  asRole("public_rw", async (tx) => first(await tx<{ r: Json }[]>`SELECT public.play_answer(${playerId}, ${answerId}, ${optionId}, '203.0.113.7', ${DEVICE}) AS r`).r);
const settle = (playerId: string, answerId: string) => asRole("public_rw", async (tx) => first(await tx<{ r: Json }[]>`SELECT public.play_settle(${playerId}, ${answerId}) AS r`).r);
const reveal = (playerId: string, answerId: string) => asRole("public_rw", async (tx) => first(await tx<{ r: Json }[]>`SELECT public.play_reveal(${playerId}, ${answerId}) AS r`).r);
/** What the app does (handleAnswer): the pick, its settle and the reveal, each in a transaction of its own. */
async function answer(playerId: string, answerId: string, optionId: string): Promise<Json> {
  expect(await answerOnly(playerId, answerId, optionId)).toEqual({ state: "answered", answer_id: answerId });
  expect(await settle(playerId, answerId)).toEqual({ state: "settled", answer_id: answerId });
  return reveal(playerId, answerId);
}
/** Moves a served row's clock back by `ms` (as if the player had been looking at it that long). */
const age = (answerId: string, ms: number) =>
  sql`UPDATE attempt_questions SET served_at = served_at - make_interval(secs => ${ms / 1000}), deadline_at = deadline_at - make_interval(secs => ${ms / 1000}) WHERE id = ${answerId}`;
const row = async (answerId: string) =>
  first(
    await sql<{ served: Date | null; deadline: Date | null; answered: Date | null; option: string | null; points: number; correct: boolean | null; elapsed: number | null }[]>`
      SELECT served_at AS served, deadline_at AS deadline, answered_at AS answered, option_id AS option, points, correct, elapsed_ms AS elapsed
        FROM attempt_questions WHERE id = ${answerId}`,
  );
const stats = async (playerId: string, programId: string) =>
  (await sql<{ score: number; total_ms: number; sets_completed: number; finished_at: Date | null }[]>`
    SELECT score, total_ms::int AS total_ms, sets_completed, finished_at FROM player_program_stats WHERE player_id = ${playerId} AND program_id = ${programId}`)[0];
const optionsOf = (q: Json) => (q["options"] as { id: string; label: string }[]).map((o) => o.id);
const questionIdOf = async (answerId: string) => first(await sql<{ q: string }[]>`SELECT question_id AS q FROM attempt_questions WHERE id = ${answerId}`).q;

describe("the question flow (play_start_set, play_current, play_answer, play_reveal as public_rw)", () => {
  let programId: string;
  let setId: string;
  let lockedSetId: string;
  let q1: Question;
  let q2: Question;
  /** Two sets of two 20 s questions: the D8 total of a player who answered nothing. */
  const PROGRAM_MS = 80_000;
  beforeAll(async () => {
    ({ programId } = await createProgram());
    ({ setId, q1, q2 } = await createTriviaSet(programId, 1));
    ({ setId: lockedSetId } = await createTriviaSet(programId, 2));
  });
  const questionOf = (id: string): Question => (id === q1.id ? q1 : q2);

  it("starts ONE attempt per player and set, also when started in parallel, with every row unserved and shuffled", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const ids = await Promise.all(Array.from({ length: 6 }, () => start(playerId, setId)));
    expect(new Set(ids).size).toBe(1);
    expect(await start(playerId, setId)).toBe(ids[0]);
    const attempts = await sql`SELECT id FROM set_attempts WHERE player_id = ${playerId}`;
    expect(attempts).toHaveLength(1);
    const rows = await sql<{ question_id: string; position: number; permutation: string[]; served_at: Date | null }[]>`
      SELECT question_id, position, permutation, served_at FROM attempt_questions WHERE attempt_id = ${ids[0] ?? ""} ORDER BY position`;
    expect(rows.map((r) => r.position)).toEqual([1, 2]);
    expect(rows.map((r) => r.question_id).sort()).toEqual([q1.id, q2.id].sort());
    for (const r of rows) {
      expect(r.served_at).toBeNull();
      expect([...r.permutation].sort()).toEqual([...questionOf(r.question_id).options].sort());
    }
  });

  it("refuses a locked set (ET142), a non-eligible player (ET141) and an unknown set (ET140)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    expect(await sqlState(start(playerId, lockedSetId))).toBe("ET142");
    const { playerId: unpaid } = await createPlayer({ programId, eligible: false });
    expect(await sqlState(start(unpaid, setId))).toBe("ET141");
    expect(await sqlState(start(playerId, "00000000-0000-4000-8000-000000000000"))).toBe("ET140");
    // Another program's set: the player is not eligible there (IDOR on the set id).
    const other = await createProgram();
    const { setId: otherSet } = await createTriviaSet(other.programId);
    expect(await sqlState(start(playerId, otherSet))).toBe("ET141");
  });

  it("serves in one call ('served', nothing of the question) and shows in the next; a refresh never resets the timer; opaque options only", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await start(playerId, setId);
    expect(await currentOnce(playerId, attemptId)).toEqual({ state: "served", timed_out: 0 });
    const shown = await currentOnce(playerId, attemptId);
    expect(shown).toMatchObject({ state: "question", position: 1, total: 2, timed_out: 0, window_ms: 20_000 });
    const answerId = String(shown["answer_id"]);
    const served = await row(answerId);
    expect((served.deadline?.getTime() ?? 0) - (served.served?.getTime() ?? 0)).toBe(20_000);
    await age(answerId, 7_000);
    const again = await currentOnce(playerId, attemptId);
    expect(again["answer_id"]).toBe(answerId);
    expect(Number(again["remaining_ms"])).toBeLessThanOrEqual(13_000);
    expect(Number(again["remaining_ms"])).toBeGreaterThan(11_000);
    expect((await row(answerId)).served).toEqual(new Date((served.served?.getTime() ?? 0) - 7_000));
    // The options, in this attempt's stored order, and NOTHING about correctness.
    const stored = first(await sql<{ permutation: string[] }[]>`SELECT permutation FROM attempt_questions WHERE id = ${answerId}`);
    expect(optionsOf(again)).toEqual(stored.permutation);
    expect(Object.keys(again).sort()).toEqual(["answer_id", "options", "position", "prompt", "remaining_ms", "state", "timed_out", "total", "window_ms"]);
    for (const option of again["options"] as Json[]) expect(Object.keys(option).sort()).toEqual(["id", "label"]);
    expect(JSON.stringify(again)).not.toMatch(/correct|explanation|points|is_correct/i);
  });

  it("answers once: of two concurrent answers exactly one is recorded (the other ET144); the answer says nothing, the reveal of the committed pick does", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await start(playerId, setId);
    const answerId = String((await current(playerId, attemptId))["answer_id"]);
    const question = questionOf(await questionIdOf(answerId));
    const settle = (p: Promise<Json>) =>
      p.then(
        (value) => ({ value, code: null }),
        (error: unknown) => ({ value: null, code: error instanceof postgres.PostgresError ? error.code : "not a PostgresError" }),
      );
    const results = await Promise.all([settle(answerOnly(playerId, answerId, question.options[1])), settle(answerOnly(playerId, answerId, question.options[0]))]);
    const accepted = results.filter((r) => r.value !== null);
    expect(accepted.map((r) => r.value)).toEqual([{ state: "answered", answer_id: answerId }]);
    expect(results.filter((r) => r.value === null).map((r) => r.code)).toEqual(["ET144"]);
    const recorded = await row(answerId);
    const revealed = await reveal(playerId, answerId);
    expect(revealed).toMatchObject({ state: "revealed", answer_id: answerId, correct_option_id: question.options[0], correct: recorded.option === question.options[0] });
    expect(revealed["points"]).toBe(recorded.option === question.options[0] ? 10 : 0);
    // A third answer later: still refused, nothing changes.
    expect(await sqlState(answerOnly(playerId, answerId, question.options[2]))).toBe("ET144");
    expect((await row(answerId)).option).toBe(recorded.option);
  });

  it("the pick writes only the pick; its settle scores it (elapsed = answered - served) with the attempt and the stats (D8), once", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await start(playerId, setId);
    const answerId = String((await current(playerId, attemptId))["answer_id"]);
    await age(answerId, 4_000);
    const question = questionOf(await questionIdOf(answerId));
    await answerOnly(playerId, answerId, question.options[0]);
    // Nothing that depends on correctness is written with the pick (security review HIGH-1 residual).
    expect(await row(answerId)).toMatchObject({ option: question.options[0], correct: null, points: 0, elapsed: null });
    expect(first(await sql<{ score: number }[]>`SELECT score FROM set_attempts WHERE id = ${attemptId}`).score).toBe(0);
    expect(await stats(playerId, programId)).toBeUndefined();
    expect(await settle(playerId, answerId)).toEqual({ state: "settled", answer_id: answerId });
    const scored = await row(answerId);
    expect(await settle(playerId, answerId)).toEqual({ state: "settled", answer_id: answerId });
    expect(await row(answerId)).toEqual(scored);
    const result = await reveal(playerId, answerId);
    expect(result["option_id"]).toBe(question.options[0]);
    expect(result).toMatchObject({ correct: true, points: 10, correct_option_id: question.options[0], explanation: null });
    const elapsed = Number(result["elapsed_ms"]);
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
    expect(elapsed).toBeLessThan(6_000);
    const recorded = await row(answerId);
    expect(elapsed).toBe((recorded.answered?.getTime() ?? 0) - (recorded.served?.getTime() ?? 0));
    expect(result["attempt"]).toEqual({ score: 10, total_ms: elapsed, finished: false });
    expect(first(await sql<{ score: number; total_ms: number }[]>`SELECT score, total_ms::int AS total_ms FROM set_attempts WHERE id = ${attemptId}`)).toEqual({ score: 10, total_ms: elapsed });
    // The three questions not answered yet (one of this set, both of the locked set) count their whole timers.
    expect(await stats(playerId, programId)).toEqual({ score: 10, total_ms: PROGRAM_MS - 20_000 + elapsed, sets_completed: 0, finished_at: null });
  });

  it("accepts a pick inside the latency grace (deadline + 1500 ms) charged at most the timer; refuses one after it (ET109)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await start(playerId, setId);
    const inGrace = String((await current(playerId, attemptId))["answer_id"]);
    await age(inGrace, 20_800);
    const graceQuestion = questionOf(await questionIdOf(inGrace));
    expect(await answer(playerId, inGrace, graceQuestion.options[0])).toMatchObject({ correct: true, points: 10, elapsed_ms: 20_000 });
    const late = String((await current(playerId, attemptId))["answer_id"]);
    await age(late, 21_600);
    const lateQuestion = questionOf(await questionIdOf(late));
    expect(await sqlState(answerOnly(playerId, late, lateQuestion.options[0]))).toBe("ET109");
    expect((await row(late)).answered).toBeNull();
  });

  it("closes a question past its deadline + 1500 ms as a timeout (0 points, the full timer, nothing revealed), then finishes the set", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await start(playerId, setId);
    const firstId = String((await current(playerId, attemptId))["answer_id"]);
    await age(firstId, 25_000);
    // The call that closes the timeout and serves the next question shows nothing of it.
    expect(await currentOnce(playerId, attemptId)).toEqual({ state: "served", timed_out: 1 });
    const next = await currentOnce(playerId, attemptId);
    expect(next).toMatchObject({ state: "question", position: 2, timed_out: 0 });
    expect(JSON.stringify(next)).not.toMatch(/correct|explanation/i);
    const closed = await row(firstId);
    expect(closed).toMatchObject({ option: null, points: 0, correct: false, elapsed: 20_000 });
    expect(closed.answered).toEqual(closed.deadline);
    expect(await sqlState(reveal(playerId, firstId))).toBe("ET148");
    // The last question times out too: the set is finished, its finish = the last answer.
    await age(String(next["answer_id"]), 25_000);
    expect(await current(playerId, attemptId)).toEqual({ state: "finished", total: 2, score: 0, total_ms: 40_000, timed_out: 1 });
    const attempt = first(await sql<{ finished_at: Date | null }[]>`SELECT finished_at FROM set_attempts WHERE id = ${attemptId}`);
    expect(attempt.finished_at).toEqual((await row(String(next["answer_id"]))).answered);
    expect(await stats(playerId, programId)).toMatchObject({ score: 0, total_ms: PROGRAM_MS, sets_completed: 1, finished_at: null });
    expect(await current(playerId, attemptId)).toMatchObject({ state: "finished" });
  });

  it("recovers a pick that was never settled (a crash between the calls): play_current and play_reveal score it first", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await start(playerId, setId);
    const firstId = String((await current(playerId, attemptId))["answer_id"]);
    await answerOnly(playerId, firstId, questionOf(await questionIdOf(firstId)).options[0]);
    // No settle: the next current scores it, then serves the next question.
    expect(await current(playerId, attemptId)).toMatchObject({ state: "question", position: 2 });
    expect(await row(firstId)).toMatchObject({ correct: true, points: 10 });
    const secondId = String((await currentOnce(playerId, attemptId))["answer_id"]);
    await answerOnly(playerId, secondId, questionOf(await questionIdOf(secondId)).options[1]);
    expect(await reveal(playerId, secondId)).toMatchObject({ state: "revealed", correct: false, points: 0 });
    expect(await stats(playerId, programId)).toMatchObject({ score: 10, sets_completed: 1 });
    // Another player's row: refused (ET140).
    const { playerId: other } = await createPlayer({ programId, eligible: true });
    expect(await sqlState(settle(other, secondId))).toBe("ET140");
  });

  it("refuses another player's attempt and answer rows, and an option of another question (IDOR: ET140 / ET051)", async () => {
    const { playerId: owner } = await createPlayer({ programId, eligible: true });
    const { playerId: intruder } = await createPlayer({ programId, eligible: true });
    const attemptId = await start(owner, setId);
    const answerId = String((await current(owner, attemptId))["answer_id"]);
    expect(await sqlState(currentOnce(intruder, attemptId))).toBe("ET140");
    expect(await sqlState(answerOnly(intruder, answerId, q1.options[0]))).toBe("ET140");
    expect(await sqlState(reveal(intruder, answerId))).toBe("ET140");
    expect(await sqlState(answerOnly(owner, answerId, "00000000-0000-4000-8000-000000000000"))).toBe("ET051");
    expect((await row(answerId)).answered).toBeNull();
    expect(await sqlState(reveal(owner, answerId))).toBe("ET148");
  });

  it("refuses an answer to a question not served yet (ET145), and a refunded player (ET141)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await start(playerId, setId);
    const unserved = first(await sql<{ id: string }[]>`SELECT id FROM attempt_questions WHERE attempt_id = ${attemptId} ORDER BY position LIMIT 1`).id;
    expect(await sqlState(answerOnly(playerId, unserved, q1.options[0]))).toBe("ET145");
    await sql`UPDATE player_programs SET eligible = false, first_paid_at = NULL WHERE player_id = ${playerId}`;
    expect(await sqlState(currentOnce(playerId, attemptId))).toBe("ET141");
  });

  it("only public_rw may call the play entry points; nobody reaches the internal helpers (42501)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    for (const role of ["admin_rw", "worker_rw", "internal_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`SELECT public.play_start_set(${playerId}, ${setId})`)), role).toBe("42501");
    }
    for (const statement of [
      `SELECT public.play_settle_answer(gen_random_uuid())`,
      `SELECT * FROM public.play_ranking('${programId}')`,
      `SELECT public.play_program_ms('${programId}')`,
      `SELECT public.play_unlocked_count(now(), 1, 1, now(), now(), 0, 0)`,
    ]) {
      expect(await sqlState(asRole("public_rw", (tx) => tx.unsafe(statement))), statement).toBe("42501");
    }
  });
});

describe("the rollback probe (security review HIGH-1): nothing secret from a transaction that has written", () => {
  let programId: string;
  let setId: string;
  let q1: Question;
  let q2: Question;
  beforeAll(async () => {
    ({ programId } = await createProgram());
    ({ setId, q1, q2 } = await createTriviaSet(programId, 1));
  });
  const optionFor = async (answerId: string) => ((await questionIdOf(answerId)) === q1.id ? q1 : q2).options[0];

  it("BEGIN; current; current; ROLLBACK: the serve says 'served', the second call is refused (ET147), and the serve is undone", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await start(playerId, setId);
    const seen: Json[] = [];
    const probe = asRole("public_rw", async (tx) => {
      seen.push(first(await tx<{ r: Json }[]>`SELECT public.play_current(${playerId}, ${attemptId}, NULL, NULL) AS r`).r);
      seen.push(first(await tx<{ r: Json }[]>`SELECT public.play_current(${playerId}, ${attemptId}, NULL, NULL) AS r`).r);
    });
    expect(await sqlState(probe)).toBe("ET147");
    expect(seen).toEqual([{ state: "served", timed_out: 0 }]);
    expect(await sql`SELECT 1 FROM attempt_questions WHERE attempt_id = ${attemptId} AND served_at IS NOT NULL`).toHaveLength(0);
  });

  it("an answer and its settle or reveal in one transaction: ET147, the pick undone; every score read too", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await start(playerId, setId);
    const answerId = String((await current(playerId, attemptId))["answer_id"]);
    const option = await optionFor(answerId);
    for (const read of [
      `SELECT public.play_settle('${playerId}', '${answerId}')`,
      `SELECT public.play_reveal('${playerId}', '${answerId}')`,
      `SELECT * FROM public.play_attempts('${playerId}', '${programId}')`,
      `SELECT * FROM public.play_standing('${playerId}', '${programId}')`,
      `SELECT * FROM public.play_leaderboard('${programId}', 10)`,
      `SELECT public.play_current('${playerId}', '${attemptId}', NULL, NULL)`,
    ]) {
      const probe = asRole("public_rw", async (tx) => {
        await tx`SELECT public.play_answer(${playerId}, ${answerId}, ${option}, NULL, NULL)`;
        await tx.unsafe(read);
      });
      expect(await sqlState(probe), read).toBe("ET147");
    }
    expect((await row(answerId)).answered).toBeNull();
    // And public_rw reads no score directly (42501): of an attempt only its start and finish.
    for (const statement of [`SELECT score FROM public.set_attempts WHERE id = '${attemptId}'`, `SELECT score FROM public.player_program_stats`]) {
      expect(await sqlState(asRole("public_rw", (tx) => tx.unsafe(statement))), statement).toBe("42501");
    }
  });

  it("the same in ONE simple-query string ending in an error: refused at the read (ET147), nothing kept", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await start(playerId, setId);
    const conn = await sql.reserve();
    try {
      const current2 = `SET ROLE public_rw; SELECT public.play_current('${playerId}', '${attemptId}', NULL, NULL); SELECT public.play_current('${playerId}', '${attemptId}', NULL, NULL); SELECT 1 / 0`;
      expect(await sqlState(conn.unsafe(current2))).toBe("ET147");
      await conn.unsafe("RESET ROLE");
      expect(await sql`SELECT 1 FROM attempt_questions WHERE attempt_id = ${attemptId} AND served_at IS NOT NULL`).toHaveLength(0);
      const answerId = String((await current(playerId, attemptId))["answer_id"]);
      const pickAndReveal = `SET ROLE public_rw; SELECT public.play_answer('${playerId}', '${answerId}', '${await optionFor(answerId)}', NULL, NULL); SELECT public.play_reveal('${playerId}', '${answerId}'); SELECT 1 / 0`;
      expect(await sqlState(conn.unsafe(pickAndReveal))).toBe("ET147");
      await conn.unsafe("RESET ROLE");
      expect((await row(answerId)).answered).toBeNull();
    } finally {
      await conn.unsafe("RESET ROLE").catch(() => undefined);
      conn.release();
    }
  });

  it("the app's flow still works: each write and each read in a transaction of its own", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await start(playerId, setId);
    for (let n = 1; n <= 2; n++) {
      const shown = await current(playerId, attemptId);
      expect(shown).toMatchObject({ state: "question", position: n });
      const answerId = String(shown["answer_id"]);
      expect(await answer(playerId, answerId, await optionFor(answerId))).toMatchObject({ state: "revealed", correct: true, points: 10 });
    }
    expect(await current(playerId, attemptId)).toMatchObject({ state: "finished", score: 20 });
    const attempts = await asRole("public_rw", (tx) => tx<Json[]>`SELECT * FROM public.play_attempts(${playerId}, ${programId})`);
    expect(attempts).toEqual([{ set_id: setId, attempt_id: attemptId, score: 20, finished: true }]);
  });
});

describe("after the grace end", () => {
  it("starts nothing (ET110) and serves nothing (closed), while a question served before it still counts until its deadline + 1500 ms", async () => {
    const { programId } = await createProgram();
    const { setId, q1, q2 } = await createTriviaSet(programId, 1);
    const { setId: secondSet } = await createTriviaSet(programId, 2);
    const { playerId } = await createPlayer({ programId, eligible: true });
    // Paid long ago: both sets are unlocked by the schedule.
    await sql`UPDATE player_programs SET first_paid_at = now() - interval '40 days' WHERE player_id = ${playerId}`;
    const attemptId = await start(playerId, setId);
    const served = String((await current(playerId, attemptId))["answer_id"]);
    await age(served, 5_000);
    // The grace period ends now: sales ended 2 days ago with 2 days of grace, minus a little.
    await sql`UPDATE programs SET sales_start_at = now() - interval '50 days', sales_end_at = now() - interval '2 days' - interval '2 seconds', grace_days = 2 WHERE id = ${programId}`;
    expect(await sqlState(start(playerId, secondSet))).toBe("ET110");
    const question = (await questionIdOf(served)) === q1.id ? q1 : q2;
    expect(await answer(playerId, served, question.options[0])).toMatchObject({ correct: true, points: 10 });
    expect(await current(playerId, attemptId)).toEqual({ state: "closed", timed_out: 0 });
  });
});

describe("the live leaderboard (play_leaderboard, play_standing)", () => {
  it("ranks EVERY eligible player by the final order (score, time, finish, first payment, player id), masked", async () => {
    const { programId } = await createProgram();
    await createTriviaSet(programId, 1);
    const at = (s: string) => new Date(s);
    const players: { id: string; name: string }[] = [];
    const add = async (name: string, paid: Date | null, eligible: boolean, score: number, totalMs: number, finished: Date | null) => {
      const { playerId } = await createPlayer({ programId, eligible: true });
      await sql`UPDATE players SET name = ${name} WHERE id = ${playerId}`;
      await sql`UPDATE player_programs SET first_paid_at = ${paid}, eligible = ${eligible} WHERE player_id = ${playerId}`;
      await sql`INSERT INTO player_program_stats (player_id, program_id, score, total_ms, sets_completed, finished_at) VALUES (${playerId}, ${programId}, ${score}, ${totalMs}, 0, ${finished})`;
      players.push({ id: playerId, name });
      return playerId;
    };
    const top = await add("Ayu Lestari", at("2027-01-02T00:00:00Z"), true, 30, 9_000, null);
    const tieLaterPaid = await add("Budi", at("2027-01-03T00:00:00Z"), true, 20, 5_000, at("2027-02-01T00:00:00Z"));
    const tieEarlierPaid = await add("Citra Dewi", at("2027-01-01T00:00:00Z"), true, 20, 5_000, at("2027-02-01T00:00:00Z"));
    const unfinished = await add("Dian", at("2027-01-01T00:00:00Z"), true, 20, 5_000, null);
    const slower = await add("Eka", at("2027-01-01T00:00:00Z"), true, 20, 6_000, at("2027-01-15T00:00:00Z"));
    await add("Refunded Rich", null, false, 99, 1, at("2027-01-05T00:00:00Z"));
    // total_ms is a bigint (a string from the driver).
    const board = (await asRole("public_rw", (tx) => tx<Json[]>`SELECT * FROM public.play_leaderboard(${programId}, 10)`)).map((r) => ({ ...r, total_ms: Number(r["total_ms"]) }));
    expect(board).toEqual([
      { rank: 1, masked_name: "A*** L***", score: 30, total_ms: 9_000, sets_completed: 0, finished: false },
      { rank: 2, masked_name: "C*** D***", score: 20, total_ms: 5_000, sets_completed: 0, finished: true },
      { rank: 3, masked_name: "B***", score: 20, total_ms: 5_000, sets_completed: 0, finished: true },
      { rank: 4, masked_name: "D***", score: 20, total_ms: 5_000, sets_completed: 0, finished: false },
      { rank: 5, masked_name: "E***", score: 20, total_ms: 6_000, sets_completed: 0, finished: true },
    ]);
    expect(JSON.stringify(board)).not.toMatch(new RegExp(players.map((p) => p.id).join("|")));
    expect(await asRole("public_rw", (tx) => tx`SELECT rank FROM public.play_leaderboard(${programId}, 2)`)).toHaveLength(2);
    const standing = async (playerId: string) => {
      const r = first(await asRole("public_rw", (tx) => tx<Json[]>`SELECT * FROM public.play_standing(${playerId}, ${programId})`));
      return { ...r, total_ms: Number(r["total_ms"]) };
    };
    expect(await standing(top)).toMatchObject({ rank: 1, ranked: 5, masked_name: "A*** L***" });
    expect(await standing(tieEarlierPaid)).toMatchObject({ rank: 2 });
    expect(await standing(tieLaterPaid)).toMatchObject({ rank: 3 });
    expect(await standing(unfinished)).toMatchObject({ rank: 4 });
    expect(await standing(slower)).toMatchObject({ rank: 5, score: 20, total_ms: 6_000 });
    // D8: a player who has answered nothing ranks too, with score 0 and every timer (1 set of two 20 s questions).
    const { playerId: fresh } = await createPlayer({ programId, eligible: true });
    expect(await standing(fresh)).toMatchObject({ rank: 6, score: 0, total_ms: 40_000, ranked: 6 });
    const last = (await asRole("public_rw", (tx) => tx<Json[]>`SELECT * FROM public.play_leaderboard(${programId}, 10)`)).at(-1);
    expect(last).toMatchObject({ rank: 6, score: 0, finished: false });
    expect(Number(last?.["total_ms"])).toBe(40_000);
    // The program's timers are computed once per ranking, not once per player without stats (code review minor).
    await createPlayer({ programId, eligible: true });
    const programMsCalls = await sql.begin(async (tx) => {
      await tx`SET LOCAL track_functions = 'all'`;
      expect(await tx`SELECT * FROM public.play_ranking(${programId})`).toHaveLength(7);
      return Number(first(await tx<{ n: string }[]>`SELECT pg_stat_get_xact_function_calls('public.play_program_ms'::regproc) AS n`).n);
    });
    expect(programMsCalls).toBe(1);
    const { playerId: stranger } = await createPlayer({ programId: (await createProgram()).programId, eligible: true });
    expect(await sqlState(standing(stranger))).toBe("ET141");
  });

  // Owner decision D8: what the board shows live is what the results snapshot freezes.
  it("oracle: after random play to past G, the live order and every player's rank equal the results snapshot's", async () => {
    for (let round = 0; round < 3; round++) {
      const { programId } = await createProgram();
      const sets: Question[][] = [];
      const setIds: string[] = [];
      for (let n = 1; n <= 3; n++) {
        const s = await createTriviaSet(programId, n);
        setIds.push(s.setId);
        sets.push([s.q1, s.q2]);
      }
      const optionIds = new Map(sets.flat().map((q) => [q.id, q.options]));
      const players: string[] = [];
      for (let p = 0; p < 10; p++) {
        const { playerId } = await createPlayer({ programId, eligible: true });
        // Paid long ago, a few seconds apart (some on the same instant: the player id decides then).
        await sql`UPDATE player_programs SET first_paid_at = now() - interval '40 days' + make_interval(secs => ${randomInt(0, 3)}) WHERE player_id = ${playerId}`;
        players.push(playerId);
        const style = randomInt(0, 5); // 0: never plays; 1: only times out; else a mix
        if (style === 0) continue;
        for (const setId of setIds) {
          if (style > 1 && randomInt(0, 4) === 0) continue; // a set never started
          const attemptId = await start(playerId, setId);
          const stopAt = style > 1 && randomInt(0, 3) === 0 ? randomInt(0, 2) : 2; // a set left unfinished
          let lastTimedOut = false;
          for (let n = 0; n < stopAt; n++) {
            const shown = await current(playerId, attemptId);
            if (shown["state"] !== "question") break;
            const answerId = String(shown["answer_id"]);
            const action = style === 1 ? 2 : randomInt(0, 3); // 0 right, 1 wrong, 2 time out
            const options = optionIds.get(await questionIdOf(answerId)) ?? ["", "", ""];
            lastTimedOut = action === 2 && n === 1;
            if (action === 2) {
              await age(answerId, 25_000);
            } else {
              await age(answerId, [2_000, 4_000][randomInt(0, 2)] ?? 2_000);
              const optionId = action === 0 ? options[0] : options[1];
              if (randomInt(0, 4) === 0) {
                // A crash after the pick committed, before its settle: the next current or reveal scores it.
                await answerOnly(playerId, answerId, optionId);
                await (randomInt(0, 2) === 0 ? reveal(playerId, answerId) : current(playerId, attemptId));
              } else {
                await answer(playerId, answerId, optionId);
              }
            }
          }
          // A player coming back closes the set's last question that timed out (the set's end); a question that timed
          // out in a set left unfinished stays open, as the finalize finds it (it closes it at its deadline).
          if (lastTimedOut) expect(await current(playerId, attemptId)).toMatchObject({ state: "finished" });
        }
      }
      // Everything above happened two days ago, before G; G is one day ago (the snapshot settles 60 s after it).
      const shift = "interval '2 days'";
      await sql.unsafe(`
        UPDATE attempt_questions aq SET served_at = served_at - ${shift}, deadline_at = deadline_at - ${shift}, answered_at = answered_at - ${shift}
          FROM set_attempts a JOIN trivia_sets s ON s.id = a.set_id WHERE a.id = aq.attempt_id AND s.program_id = '${programId}'`);
      await sql.unsafe(`UPDATE set_attempts a SET finished_at = finished_at - ${shift} FROM trivia_sets s WHERE s.id = a.set_id AND s.program_id = '${programId}'`);
      await sql.unsafe(`UPDATE player_program_stats SET finished_at = finished_at - ${shift} WHERE program_id = '${programId}'`);
      await sql`UPDATE programs SET sales_start_at = now() - interval '60 days', sales_end_at = now() - interval '3 days', grace_days = 2 WHERE id = ${programId}`;

      const live = await sql<{ player_id: string; rank: number; score: number; total_ms: string }[]>`SELECT player_id, rank, score, total_ms FROM public.play_ranking(${programId}) ORDER BY rank`;
      for (const r of live) {
        const own = first(await asRole("public_rw", (tx) => tx<{ rank: number }[]>`SELECT rank FROM public.play_standing(${r.player_id}, ${programId})`));
        expect(own.rank, `round ${String(round)} player ${r.player_id}`).toBe(r.rank);
      }
      await asRole("worker_rw", (tx) => tx`SELECT public.create_leaderboard_snapshot(${programId}::uuid)`);
      const [snapshot] = await sql<{ entries: { rank: number; player_id: string; score: number; total_ms: number }[] }[]>`SELECT entries FROM leaderboard_snapshots WHERE program_id = ${programId}`;
      const frozen = (snapshot?.entries ?? []).map((e) => ({ player_id: e.player_id, rank: e.rank, score: e.score, total_ms: e.total_ms }));
      expect(live.map((r) => ({ player_id: r.player_id, rank: r.rank, score: r.score, total_ms: Number(r.total_ms) })), `round ${String(round)}`).toEqual(frozen);
      expect(frozen).toHaveLength(players.length);
    }
  });
});

describe("the unlock floor (play_note_unlocked)", () => {
  it("keeps a set the player saw open unlocked after an extend-only reschedule", async () => {
    const { programId } = await createProgram();
    const sets = [];
    for (let n = 1; n <= 10; n++) sets.push((await createTriviaSet(programId, n)).setId);
    const { playerId } = await createPlayer({ programId, eligible: true });
    // Sales end in 1 day without grace, paid 1 day ago: A = 3 days for 10 sets, day 1 -> 1 + floor(1 * 9 / 2) = 5.
    await sql`UPDATE programs SET sales_start_at = now() - interval '10 days', sales_end_at = now() + interval '1 day', grace_days = 0 WHERE id = ${programId}`;
    await sql`UPDATE player_programs SET first_paid_at = now() - interval '1 day' WHERE player_id = ${playerId}`;
    const note = () => asRole("public_rw", async (tx) => first(await tx<{ n: number }[]>`SELECT public.play_note_unlocked(${playerId}, ${programId}) AS n`).n);
    const seen = await note();
    expect(seen).toBe(5);
    // Grace 0 -> 60 days (extend-only): the formula alone now unlocks 2 (one a day), the floor keeps the 5 shown.
    await sql`UPDATE programs SET grace_days = 60 WHERE id = ${programId}`;
    const formula = first(await sql<{ n: number }[]>`
      SELECT public.play_unlocked_count(p.sales_end_at, p.grace_days, 10, pp.first_paid_at, clock_timestamp(), 0, 0) AS n
        FROM programs p JOIN player_programs pp ON pp.program_id = p.id WHERE p.id = ${programId} AND pp.player_id = ${playerId}`).n;
    expect(formula).toBe(2);
    expect(await note()).toBe(seen);
    await start(playerId, sets[seen - 1] ?? "");
    expect(await sqlState(start(playerId, sets[seen] ?? ""))).toBe("ET142");
    // A player who is not eligible gets 0 and nothing is written.
    const { playerId: unpaid } = await createPlayer({ programId, eligible: false });
    expect(await asRole("public_rw", async (tx) => first(await tx<{ n: number }[]>`SELECT public.play_note_unlocked(${unpaid}, ${programId}) AS n`).n)).toBe(0);
  });
});
