// Security review items 5 and 6: play rows only for eligible players on published programs; winners
// and the contest's program statuses are written only by contest_results' functions (US-028,
// contest.int.test.ts covers those functions). US-028 security review P1-2: the database sets every
// play timestamp, a pick counts only until its deadline + 1500 ms, nothing starts or is served
// after the grace end, and public_rw writes no score. US-027: the public app writes play rows only through the
// play functions (sql/play.sql), which run as their owner trivia_play: the guards are exercised as trivia_play,
// the one untrusted writer left, and public_rw writes no play row at all and reads no question or answer.
import { beforeAll, describe, expect, it } from "vitest";
import { asRole, first, sql, sqlState } from "./db.ts";
import { createAttempt, createPlayer, createProgram, createTriviaSet, type Question } from "./fixtures.ts";

type Id = { id: string };

describe("play rows (trivia_play, the play functions' owner; public_rw writes none)", () => {
  let programId: string;
  let setId: string;
  let q1: Question;
  let q2: Question;
  let otherSetQuestion: Question;
  beforeAll(async () => {
    ({ programId } = await createProgram());
    ({ setId, q1, q2 } = await createTriviaSet(programId, 1));
    ({ q1: otherSetQuestion } = await createTriviaSet(programId, 2));
  });

  const startAttempt = (playerId: string, set: string) =>
    asRole("trivia_play", async (tx) =>
      first(await tx<Id[]>`INSERT INTO public.set_attempts (player_id, set_id) VALUES (${playerId}, ${set}) RETURNING id`)
        .id,
    );
  /**
   * A question row, served at once: inserted unserved (as play_start_set does), then served by a second statement
   * (as play_current does; the caller's served_at is replaced by the clock).
   */
  const serve = (attemptId: string, question: Question, position = 1) =>
    asRole("trivia_play", async (tx) => {
      const id = first(
        await tx<Id[]>`
          INSERT INTO public.attempt_questions (attempt_id, question_id, position, permutation)
          VALUES (${attemptId}, ${question.id}, ${position}, ${question.options}::uuid[]) RETURNING id`,
      ).id;
      await tx`UPDATE public.attempt_questions SET served_at = '2000-01-01' WHERE id = ${id}`;
      return id;
    });
  const row = async (id: string) =>
    first(
      await sql<{ served: Date | null; deadline: Date | null; answered: Date | null; option: string | null; points: number; correct: boolean | null }[]>`
        SELECT served_at AS served, deadline_at AS deadline, answered_at AS answered, option_id AS option, points, correct FROM attempt_questions WHERE id = ${id}`,
    );
  const near = (at: Date | null, ms = Date.now()) => Math.abs((at?.getTime() ?? 0) - ms) < 5_000;

  it("lets an eligible player play: the database sets served_at, deadline_at and answered_at, and no score", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await startAttempt(playerId, setId);
    const id = await serve(attemptId, q1);
    const served = await row(id);
    expect(near(served.served)).toBe(true);
    expect((served.deadline?.getTime() ?? 0) - (served.served?.getTime() ?? 0)).toBe(20_000);
    await asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET answered_at = '2000-01-01', option_id = ${q1.options[0]} WHERE id = ${id}`);
    const answered = await row(id);
    expect(near(answered.answered)).toBe(true);
    expect(answered).toMatchObject({ option: q1.options[0], points: 0, correct: null });
    // An unserved row, served later by an UPDATE: the clock again, whatever the caller sends.
    const later = first(
      await asRole("trivia_play", (tx) => tx<Id[]>`
        INSERT INTO public.attempt_questions (attempt_id, question_id, position, permutation) VALUES (${attemptId}, ${q2.id}, 2, ${q2.options}::uuid[]) RETURNING id`),
    ).id;
    expect((await row(later)).served).toBeNull();
    await asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET served_at = '2999-01-01' WHERE id = ${later}`);
    expect(near((await row(later)).served)).toBe(true);
  });

  it("refuses to change a serve or an answer, a pick without an answer, and an answer before the serve (ET108)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await startAttempt(playerId, setId);
    const id = await serve(attemptId, q1);
    const unserved = first(
      await asRole("trivia_play", (tx) => tx<Id[]>`
        INSERT INTO public.attempt_questions (attempt_id, question_id, position, permutation) VALUES (${attemptId}, ${q2.id}, 2, ${q2.options}::uuid[]) RETURNING id`),
    ).id;
    expect(await sqlState(asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET served_at = served_at - interval '10 seconds' WHERE id = ${id}`))).toBe("ET108");
    expect(await sqlState(asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET option_id = ${q1.options[0]} WHERE id = ${id}`))).toBe("ET108");
    expect(await sqlState(asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET answered_at = now(), option_id = ${q2.options[0]} WHERE id = ${unserved}`))).toBe("ET108");
    await asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET answered_at = now(), option_id = ${q1.options[1]} WHERE id = ${id}`);
    for (const statement of [
      `UPDATE public.attempt_questions SET option_id = '${q1.options[0]}' WHERE id = '${id}'`,
      `UPDATE public.attempt_questions SET answered_at = answered_at + interval '1 second' WHERE id = '${id}'`,
      `UPDATE public.attempt_questions SET answered_at = NULL, option_id = NULL WHERE id = '${id}'`,
    ]) {
      expect(await sqlState(asRole("trivia_play", (tx) => tx.unsafe(statement))), statement).toBe("ET108");
    }
  });

  it("refuses a pick after the deadline + 1500 ms (ET109); a timeout then closes at the deadline", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await startAttempt(playerId, setId);
    const id = await serve(attemptId, q1);
    // 21.6 s ago, as if the player came back after the timer and the latency grace.
    await sql`UPDATE attempt_questions SET served_at = served_at - interval '21600 milliseconds', deadline_at = deadline_at - interval '21600 milliseconds' WHERE id = ${id}`;
    expect(await sqlState(asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET answered_at = now(), option_id = ${q1.options[0]} WHERE id = ${id}`))).toBe("ET109");
    await asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET answered_at = now() WHERE id = ${id}`);
    const closed = await row(id);
    expect(closed.answered).toEqual(closed.deadline);
    expect(closed.option).toBeNull();
  });

  it("refuses to start a set or serve a question at or after the grace end (ET110), and plays nothing on an ended program", async () => {
    const ended = await createProgram();
    const { setId: endedSet, q1: endedQ, q2: endedQ2 } = await createTriviaSet(ended.programId, 1);
    const { playerId } = await createPlayer({ programId: ended.programId, eligible: true });
    const attemptId = await createAttempt(playerId, endedSet);
    const unserved = first(
      await sql<Id[]>`INSERT INTO attempt_questions (attempt_id, question_id, position, permutation) VALUES (${attemptId}, ${endedQ.id}, 1, ${endedQ.options}::uuid[]) RETURNING id`,
    ).id;
    const { setId: otherSet } = await createTriviaSet(ended.programId, 2);
    await sql`UPDATE programs SET sales_end_at = now() - interval '3 days', grace_days = 2, sales_start_at = now() - interval '40 days' WHERE id = ${ended.programId}`;
    expect(await sqlState(startAttempt(playerId, otherSet))).toBe("ET110");
    expect(await sqlState(asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET served_at = now() WHERE id = ${unserved}`))).toBe("ET110");
    expect(await sqlState(serve(attemptId, endedQ2, 2))).toBe("ET110");
  });

  it("public_rw writes no play row at all, and no score (42501, US-027)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await startAttempt(playerId, setId);
    const id = await serve(attemptId, q1);
    for (const statement of [
      `UPDATE public.attempt_questions SET points = 10 WHERE id = '${id}'`,
      `UPDATE public.attempt_questions SET correct = true WHERE id = '${id}'`,
      `UPDATE public.attempt_questions SET elapsed_ms = 1 WHERE id = '${id}'`,
      `UPDATE public.attempt_questions SET deadline_at = now() + interval '1 hour' WHERE id = '${id}'`,
      `UPDATE public.set_attempts SET score = 10 WHERE id = '${attemptId}'`,
      `UPDATE public.set_attempts SET total_ms = 1, finished_at = now() WHERE id = '${attemptId}'`,
      `INSERT INTO public.player_program_stats (player_id, program_id, score) VALUES ('${playerId}', '${programId}', 10)`,
      `UPDATE public.player_program_stats SET score = 10 WHERE player_id = '${playerId}'`,
      `INSERT INTO public.attempt_questions (attempt_id, question_id, position, permutation, answered_at, option_id, points) VALUES ('${attemptId}', '${q2.id}', 2, '{}', now(), '${q2.options[0]}', 10)`,
      `INSERT INTO public.set_attempts (player_id, set_id, score) VALUES ('${playerId}', '${setId}', 10)`,
      `INSERT INTO public.set_attempts (player_id, set_id) VALUES ('${playerId}', '${setId}')`,
      `INSERT INTO public.attempt_questions (attempt_id, question_id, position, permutation) VALUES ('${attemptId}', '${q2.id}', 2, '{}')`,
      `UPDATE public.attempt_questions SET served_at = now() WHERE attempt_id = '${attemptId}'`,
      `UPDATE public.attempt_questions SET answered_at = now(), option_id = '${q1.options[0]}' WHERE id = '${id}'`,
      `SELECT public.lock_program_contest_shared('${programId}')`,
    ]) {
      expect(await sqlState(asRole("public_rw", (tx) => tx.unsafe(statement))), statement).toBe("42501");
    }
  });

  it("waits for an exclusive contest lock (a snapshot, a re-score, an extension) before it writes", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await startAttempt(playerId, setId);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = (): void => undefined;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = sql.begin(async (tx) => {
      await tx`SELECT public.lock_program_contest(${programId})`;
      held();
      await gate;
    });
    await holding;
    const blocked = await sqlState(
      asRole("trivia_play", async (tx) => {
        await tx.unsafe("SET LOCAL lock_timeout = '300ms'");
        await tx`INSERT INTO public.attempt_questions (attempt_id, question_id, position, permutation) VALUES (${attemptId}, ${q1.id}, 1, ${q1.options}::uuid[])`;
      }),
    );
    release();
    await holder;
    expect(blocked).toBe("55P03");
  });

  it("rejects an attempt by a never-paid player (ET050)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: false });
    expect(await sqlState(startAttempt(playerId, setId))).toBe("ET050");
  });

  it("rejects an attempt on a draft program (ET050)", async () => {
    const draft = await createProgram({ status: "draft" });
    const { setId: draftSet } = await createTriviaSet(draft.programId);
    const { playerId } = await createPlayer({ programId: draft.programId, eligible: true });
    expect(await sqlState(startAttempt(playerId, draftSet))).toBe("ET050");
  });

  it("rejects an attempt on another program's set (ET050)", async () => {
    const other = await createProgram();
    const { setId: otherProgramSet } = await createTriviaSet(other.programId);
    const { playerId } = await createPlayer({ programId, eligible: true });
    expect(await sqlState(startAttempt(playerId, otherProgramSet))).toBe("ET050");
  });

  it("rejects serving a question to a never-paid player (ET050)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: false });
    const attemptId = await createAttempt(playerId, setId); // e.g. left over from before a refund
    expect(await sqlState(serve(attemptId, q1))).toBe("ET050");
  });

  it("rejects serving a question from another set (ET051)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await startAttempt(playerId, setId);
    expect(await sqlState(serve(attemptId, otherSetQuestion))).toBe("ET051");
  });

  it("cannot move a play row to another player or set (42501)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await startAttempt(playerId, setId);
    for (const statement of [
      `UPDATE public.set_attempts SET player_id = '${playerId}' WHERE id = '${attemptId}'`,
      `UPDATE public.set_attempts SET set_id = '${setId}' WHERE id = '${attemptId}'`,
      `UPDATE public.attempt_questions SET question_id = '${q1.id}' WHERE attempt_id = '${attemptId}'`,
      `UPDATE public.player_program_stats SET player_id = '${playerId}' WHERE player_id = '${playerId}'`,
    ]) {
      expect(await sqlState(asRole("trivia_play", (tx) => tx.unsafe(statement)))).toBe("42501");
    }
  });

  // Security review N1: waiting for the contest lock never costs the player time (US-018 rule).
  it("charges a pick its ARRIVAL time while an exclusive holder blocks it, and does not refuse it (no ET109)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await startAttempt(playerId, setId);
    const id = await serve(attemptId, q1);
    // The deadline + 1500 ms is 1.2 s away; the lock is then held for 3 s.
    await sql`UPDATE attempt_questions SET served_at = served_at - interval '20300 milliseconds', deadline_at = deadline_at - interval '20300 milliseconds' WHERE id = ${id}`;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = (): void => undefined;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = sql.begin(async (tx) => {
      await tx`SELECT public.lock_program_contest(${programId})`;
      held();
      await gate;
    });
    await holding;
    const sent = Date.now();
    const pick = asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET answered_at = now(), option_id = ${q1.options[0]} WHERE id = ${id}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const released = Date.now();
    release();
    await holder;
    await pick;
    const answered = await row(id);
    expect(answered.option).toBe(q1.options[0]);
    expect(answered.answered?.getTime() ?? 0).toBeGreaterThanOrEqual(sent - 1_000);
    expect(answered.answered?.getTime() ?? 0).toBeLessThan(released - 2_000);
    expect(answered.answered?.getTime() ?? 0).toBeLessThanOrEqual((answered.deadline?.getTime() ?? 0) + 1_500);
  });

  // Security review N1 follow-up (probe4): a pick queued on the ROW behind an open pick is charged its
  // real time, so holding a wrong pick open while a right one waits cannot beat the timer.
  it("refuses a pick that waited on the row behind an open pick until past the deadline (ET109)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await startAttempt(playerId, setId);
    const id = await serve(attemptId, q1);
    // The deadline + 1500 ms is 1 s away.
    await sql`UPDATE attempt_questions SET served_at = served_at - interval '20500 milliseconds', deadline_at = deadline_at - interval '20500 milliseconds' WHERE id = ${id}`;
    const hedger = await sql.reserve();
    try {
      await hedger.unsafe("BEGIN");
      await hedger.unsafe("SET LOCAL ROLE trivia_play");
      await hedger`UPDATE public.attempt_questions SET answered_at = now(), option_id = ${q1.options[1]} WHERE id = ${id}`;
      const queued = sqlState(asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET answered_at = now(), option_id = ${q1.options[0]} WHERE id = ${id}`));
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await hedger.unsafe("ROLLBACK");
      expect(await queued).toBe("ET109");
    } finally {
      hedger.release();
    }
    expect(await row(id)).toMatchObject({ answered: null, option: null });
  });

  // Security review N3: no serve and pick in one statement, and correctness is never readable.
  it("refuses a serve and a pick in one statement (ET108); public_rw reads no question text, option, explanation or answer row (42501)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await startAttempt(playerId, setId);
    const id = first(
      await asRole("trivia_play", (tx) => tx<Id[]>`
        INSERT INTO public.attempt_questions (attempt_id, question_id, position, permutation) VALUES (${attemptId}, ${q1.id}, 1, ${q1.options}::uuid[]) RETURNING id`),
    ).id;
    expect(await sqlState(asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET served_at = now(), answered_at = now(), option_id = ${q1.options[0]} WHERE id = ${id}`))).toBe("ET108");
    expect(await sqlState(asRole("public_rw", (tx) => tx`SELECT is_correct FROM public.question_options WHERE question_id = ${q1.id}`))).toBe("42501");
    expect(await sqlState(asRole("public_rw", (tx) => tx`SELECT * FROM public.question_options WHERE question_id = ${q1.id}`))).toBe("42501");
    for (const statement of [
      `SELECT id, position, label FROM public.question_options WHERE question_id = '${q1.id}'`,
      `SELECT prompt FROM public.questions WHERE id = '${q1.id}'`,
      `SELECT explanation FROM public.questions WHERE id = '${q1.id}'`,
      `SELECT option_id, correct FROM public.attempt_questions WHERE id = '${id}'`,
    ]) {
      expect(await sqlState(asRole("public_rw", (tx) => tx.unsafe(statement))), statement).toBe("42501");
    }
    // What the trivia page counts stays readable.
    const counted = await asRole("public_rw", (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM public.questions WHERE set_id = ${setId}`);
    expect(counted[0]?.n).toBe(2);
  });

  it("reads no results table: the banner function is the only public read path (42501, security review P1-5)", async () => {
    for (const statement of ["SELECT 1 FROM public.winners", "SELECT 1 FROM public.leaderboard_snapshots"]) {
      expect(await sqlState(asRole("public_rw", (tx) => tx.unsafe(statement))), statement).toBe("42501");
    }
  });
});

describe("winners and program status (US-028: written only inside contest_results' functions)", () => {
  let programId: string;
  let snapshotId: string;
  let tierId: string;
  beforeAll(async () => {
    ({ programId } = await createProgram());
    // Tiers first: once the snapshot exists they are final (prize_tiers_guard, ET072).
    tierId = first(
      await sql<Id[]>`
        INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr)
        VALUES (${programId}, 1, 10, 'Juara', 1000000) RETURNING id`,
    ).id;
    snapshotId = first(
      await sql<Id[]>`
        INSERT INTO leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${programId}, now(), '[]') RETURNING id`,
    ).id;
  });

  /** A winner as the superuser writes it (the guard still applies). */
  const newWinner = async (rank: number) => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    return first(
      await sql<Id[]>`
        INSERT INTO winners (program_id, snapshot_id, prize_tier_id, player_id, rank)
        VALUES (${programId}, ${snapshotId}, ${tierId}, ${playerId}, ${rank}) RETURNING id`,
    ).id;
  };

  it("no app role may insert, confirm or delete a winner (42501); only worker_rw may flag one", async () => {
    const id = await newWinner(1);
    const { playerId } = await createPlayer({ programId, eligible: true });
    const flag = `UPDATE public.winners SET status = 'flagged', flagged_at = now(), flag_reason = 'chargeback', updated_at = now() WHERE id = '${id}'`;
    for (const role of ["worker_rw", "admin_rw", "public_rw", "internal_rw"] as const) {
      for (const statement of [
        `INSERT INTO public.winners (program_id, snapshot_id, prize_tier_id, player_id, rank) VALUES ('${programId}', '${snapshotId}', '${tierId}', '${playerId}', 2)`,
        `UPDATE public.winners SET status = 'confirmed', confirmed_at = now() WHERE id = '${id}'`,
        `DELETE FROM public.winners WHERE id = '${id}'`,
        ...(role === "worker_rw" ? [] : [flag]),
      ]) {
        expect(await sqlState(asRole(role, (tx) => tx.unsafe(statement))), `${role}: ${statement}`).toBe("42501");
      }
    }
  });

  // US-021: a chargeback after the snapshot flags the winner (awaiting_confirmation or confirmed);
  // that is the worker's one change, of the flag columns only.
  it("worker_rw flags a winner (awaiting or confirmed) for a chargeback, and changes nothing else (ET105)", async () => {
    const awaiting = await newWinner(4);
    await asRole("worker_rw", (tx) => tx`UPDATE public.winners SET status = 'flagged', flagged_at = now(), flag_reason = 'chargeback', updated_at = now() WHERE id = ${awaiting}`);
    expect(first(await sql<{ status: string; reason: string }[]>`SELECT status::text, flag_reason AS reason FROM winners WHERE id = ${awaiting}`)).toEqual({ status: "flagged", reason: "chargeback" });
    // A confirmed winner (confirmed by the Owner's function, simulated here by its owner role).
    const confirmed = await newWinner(5);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE contest_results");
      await tx`UPDATE public.winners SET status = 'confirmed', confirmed_at = now() WHERE id = ${confirmed}`;
    });
    await asRole("worker_rw", (tx) => tx`UPDATE public.winners SET status = 'flagged', flagged_at = now(), flag_reason = 'chargeback' WHERE id = ${confirmed}`);
    const other = await newWinner(6);
    for (const statement of [
      // no flag time, back to awaiting, or a flagged winner moved on
      `UPDATE public.winners SET status = 'flagged', flag_reason = 'chargeback' WHERE id = '${other}'`,
      `UPDATE public.winners SET status = 'awaiting_confirmation', flagged_at = now() WHERE id = '${awaiting}'`,
      `UPDATE public.winners SET status = 'revoked', flagged_at = now() WHERE id = '${other}'`,
      `UPDATE public.winners SET flag_reason = 'edited' WHERE id = '${awaiting}'`,
    ]) {
      expect(await sqlState(asRole("worker_rw", (tx) => tx.unsafe(statement))), statement).toBe("ET105");
    }
    // contest_results confirms only; it cannot flag.
    expect(
      await sqlState(
        sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE contest_results");
          await tx`UPDATE public.winners SET status = 'flagged', flagged_at = now() WHERE id = ${other}`;
        }),
      ),
    ).toBe("42501");
  });

  it("a winner is inserted awaiting confirmation, inside its tier, for its snapshot's program (ET105, every writer)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const other = await createProgram();
    const otherSnapshot = first(await sql<Id[]>`INSERT INTO leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${other.programId}, now(), '[]') RETURNING id`).id;
    for (const statement of [
      `INSERT INTO winners (program_id, snapshot_id, prize_tier_id, player_id, rank, status, confirmed_at) VALUES ('${programId}', '${snapshotId}', '${tierId}', '${playerId}', 2, 'confirmed', now())`,
      `INSERT INTO winners (program_id, snapshot_id, prize_tier_id, player_id, rank) VALUES ('${programId}', '${snapshotId}', '${tierId}', '${playerId}', 11)`,
      `INSERT INTO winners (program_id, snapshot_id, prize_tier_id, player_id, rank) VALUES ('${programId}', '${otherSnapshot}', '${tierId}', '${playerId}', 2)`,
      `INSERT INTO winners (program_id, snapshot_id, prize_tier_id, player_id, rank) VALUES ('${other.programId}', '${otherSnapshot}', '${tierId}', '${playerId}', 2)`,
    ]) {
      expect(await sqlState(sql.unsafe(statement)), statement).toBe("ET105");
    }
  });

  it("a winner is never deleted, truncated or changed, not even by the owner or a superuser (ET105)", async () => {
    const id = await newWinner(3);
    for (const statement of [
      `DELETE FROM public.winners WHERE id = '${id}'`,
      `UPDATE public.winners SET rank = 4 WHERE id = '${id}'`,
      `UPDATE public.winners SET player_id = (SELECT id FROM public.players LIMIT 1) WHERE id = '${id}'`,
      `UPDATE public.winners SET status = 'confirmed', confirmed_at = now() WHERE id = '${id}'`,
      `UPDATE public.winners SET flagged_at = now() WHERE id = '${id}'`,
      "TRUNCATE public.winners CASCADE",
    ]) {
      expect(await sqlState(asRole("migrator", (tx) => tx.unsafe(statement))), `migrator: ${statement}`).toBe("ET105");
      expect(await sqlState(sql.unsafe(statement)), `superuser: ${statement}`).toBe("ET105");
    }
  });

  it("worker_rw changes no program status; admin_rw only between draft and published (ET046)", async () => {
    const p = await createProgram();
    const setStatus = (role: "worker_rw" | "admin_rw", status: string) =>
      asRole(role, (tx) => tx`UPDATE public.programs SET status = ${status} WHERE id = ${p.programId}`);
    // worker_rw holds no UPDATE on programs any more (the grace end runs as contest_results).
    expect(await sqlState(setStatus("worker_rw", "awaiting_confirmation"))).toBe("42501");
    for (const status of ["awaiting_confirmation", "finalized"]) expect(await sqlState(setStatus("admin_rw", status)), status).toBe("ET046");
    await setStatus("admin_rw", "draft");
    await setStatus("admin_rw", "published");
    await sql`UPDATE programs SET status = 'awaiting_confirmation' WHERE id = ${p.programId}`;
    for (const status of ["published", "draft", "finalized"]) expect(await sqlState(setStatus("admin_rw", status)), status).toBe("ET046");
  });
});
