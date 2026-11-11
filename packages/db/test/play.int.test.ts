// Security review items 5 and 6: play rows only for eligible players on published programs, and
// winner confirmation / program finalization reserved for admin_rw (the Owner confirms winners).
import { beforeAll, describe, expect, it } from "vitest";
import { asRole, first, sql, sqlState } from "./db.ts";
import { createAttempt, createPlayer, createProgram, createTriviaSet, type Question } from "./fixtures.ts";

type Id = { id: string };

describe("play rows (public_rw)", () => {
  let programId: string;
  let setId: string;
  let q1: Question;
  let otherSetQuestion: Question;
  beforeAll(async () => {
    ({ programId } = await createProgram());
    ({ setId, q1 } = await createTriviaSet(programId, 1));
    ({ q1: otherSetQuestion } = await createTriviaSet(programId, 2));
  });

  const startAttempt = (playerId: string, set: string) =>
    asRole("public_rw", async (tx) =>
      first(await tx<Id[]>`INSERT INTO public.set_attempts (player_id, set_id) VALUES (${playerId}, ${set}) RETURNING id`)
        .id,
    );
  const serve = (attemptId: string, question: Question) =>
    asRole(
      "public_rw",
      (tx) => tx`
        INSERT INTO public.attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at)
        VALUES (${attemptId}, ${question.id}, 1, ${question.options}::uuid[], now(), now() + interval '20 seconds')`,
    );

  it("lets an eligible player play a published program", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await startAttempt(playerId, setId);
    await serve(attemptId, q1);
    await asRole("public_rw", async (tx) => {
      await tx`UPDATE public.attempt_questions SET answered_at = now(), option_id = ${q1.options[0]}, correct = true, points = 10
               WHERE attempt_id = ${attemptId}`;
      await tx`UPDATE public.set_attempts SET score = 10, finished_at = now() WHERE id = ${attemptId}`;
      await tx`INSERT INTO public.player_program_stats (player_id, program_id, score, total_ms) VALUES (${playerId}, ${programId}, 10, 1200)`;
    });
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

  it("rejects attempt_questions and stats writes for a never-paid player (ET050)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: false });
    const attemptId = await createAttempt(playerId, setId); // e.g. left over from before a refund
    expect(await sqlState(serve(attemptId, q1))).toBe("ET050");
    expect(
      await sqlState(asRole("public_rw", (tx) => tx`UPDATE public.set_attempts SET score = 2000000000 WHERE id = ${attemptId}`)),
    ).toBe("ET050");
    expect(
      await sqlState(
        asRole(
          "public_rw",
          (tx) => tx`
            INSERT INTO public.player_program_stats (player_id, program_id, score) VALUES (${playerId}, ${programId}, 2000000000)`,
        ),
      ),
    ).toBe("ET050");
    await sql`INSERT INTO player_program_stats (player_id, program_id) VALUES (${playerId}, ${programId})`;
    expect(
      await sqlState(
        asRole(
          "public_rw",
          (tx) => tx`UPDATE public.player_program_stats SET score = 2000000000 WHERE player_id = ${playerId}`,
        ),
      ),
    ).toBe("ET050");
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
      expect(await sqlState(asRole("public_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
    }
  });
});

describe("winners and program finalization", () => {
  let programId: string;
  let snapshotId: string;
  let tierId: string;
  beforeAll(async () => {
    ({ programId } = await createProgram());
    snapshotId = first(
      await sql<Id[]>`
        INSERT INTO leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${programId}, now(), '[]') RETURNING id`,
    ).id;
    tierId = first(
      await sql<Id[]>`
        INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr)
        VALUES (${programId}, 1, 10, 'Juara', 1000000) RETURNING id`,
    ).id;
  });

  const newWinner = async (rank: number) => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    return asRole("worker_rw", async (tx) =>
      first(
        await tx<Id[]>`
          INSERT INTO public.winners (program_id, snapshot_id, prize_tier_id, player_id, rank)
          VALUES (${programId}, ${snapshotId}, ${tierId}, ${playerId}, ${rank}) RETURNING id`,
      ).id,
    );
  };

  it("worker_rw writes winners as awaiting_confirmation", async () => {
    const id = await newWinner(1);
    const [w] = await sql<{ status: string }[]>`SELECT status FROM winners WHERE id = ${id}`;
    expect(w?.status).toBe("awaiting_confirmation");
  });

  it("worker_rw cannot insert a winner as confirmed (42501)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const insert = asRole(
      "worker_rw",
      (tx) => tx`
        INSERT INTO public.winners (program_id, snapshot_id, prize_tier_id, player_id, rank, status, confirmed_at)
        VALUES (${programId}, ${snapshotId}, ${tierId}, ${playerId}, 2, 'confirmed', now())`,
    );
    expect(await sqlState(insert)).toBe("42501");
  });

  it("worker_rw cannot confirm or revoke a winner (ET045) nor set confirmed_at (42501)", async () => {
    const id = await newWinner(3);
    for (const status of ["confirmed", "revoked"]) {
      expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.winners SET status = ${status} WHERE id = ${id}`))).toBe(
        "ET045",
      );
    }
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.winners SET confirmed_at = now() WHERE id = ${id}`))).toBe(
      "42501",
    );
  });

  it("worker_rw can flag a winner (chargeback); admin_rw confirms", async () => {
    const flagged = await newWinner(4);
    await asRole(
      "worker_rw",
      (tx) => tx`UPDATE public.winners SET status = 'flagged', flagged_at = now(), flag_reason = 'chargeback' WHERE id = ${flagged}`,
    );
    const confirmed = await newWinner(5);
    await asRole("admin_rw", (tx) => tx`UPDATE public.winners SET status = 'confirmed', confirmed_at = now() WHERE id = ${confirmed}`);
  });

  it("worker_rw may only move a published program to awaiting_confirmation (ET046)", async () => {
    const p = await createProgram();
    const setStatus = (role: "worker_rw" | "admin_rw", status: string) =>
      asRole(role, (tx) => tx`UPDATE public.programs SET status = ${status} WHERE id = ${p.programId}`);
    expect(await sqlState(setStatus("worker_rw", "finalized"))).toBe("ET046");
    expect(await sqlState(setStatus("worker_rw", "draft"))).toBe("ET046");
    await setStatus("worker_rw", "awaiting_confirmation");
    expect(await sqlState(setStatus("worker_rw", "published"))).toBe("ET046");
    await setStatus("admin_rw", "finalized");
  });
});
