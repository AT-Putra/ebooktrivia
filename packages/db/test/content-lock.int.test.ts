// Criterion 5: once a set has attempts, the correct option, points, timer and the question /
// option list are locked by trigger (ET020); text edits stay allowed. Exercised as admin_rw.
import { beforeAll, describe, expect, it } from "vitest";
import { asRole, sql, sqlState } from "./db.ts";
import { createAttempt, createPlayer, createProgram, createTriviaSet, type Question } from "./fixtures.ts";

const asAdmin = (statement: string) => asRole("admin_rw", (tx) => tx.unsafe(statement));

let programId: string;
beforeAll(async () => {
  ({ programId } = await createProgram());
});

describe("before any attempt", () => {
  it("allows every edit", async () => {
    const { setId, q1, q2 } = await createTriviaSet(programId, 1);
    await asAdmin(`UPDATE public.questions SET points = 20, timer_seconds = 30 WHERE id = '${q1.id}'`);
    await asAdmin(`UPDATE public.question_options SET is_correct = false WHERE id = '${q1.options[0]}'`);
    await asAdmin(`UPDATE public.question_options SET is_correct = true WHERE id = '${q1.options[1]}'`);
    await asAdmin(
      `INSERT INTO public.question_options (question_id, position, label) VALUES ('${q1.id}', 4, 'D')`,
    );
    await asAdmin(`DELETE FROM public.question_options WHERE id = '${q1.options[2]}'`);
    await asAdmin(
      `INSERT INTO public.questions (set_id, position, prompt, points, timer_seconds) VALUES ('${setId}', 3, 'Baru', 10, 20)`,
    );
    await asAdmin(`DELETE FROM public.questions WHERE id = '${q2.id}'`);
  });
});

describe("after the first attempt", () => {
  let setId: string;
  let otherSetId: string;
  let q1: Question;
  let q2: Question;
  beforeAll(async () => {
    ({ setId, q1, q2 } = await createTriviaSet(programId, 2));
    ({ setId: otherSetId } = await createTriviaSet(programId, 3));
    const { playerId } = await createPlayer({ programId, eligible: true });
    await createAttempt(playerId, setId);
  });

  it.each([
    ["change points", () => `UPDATE public.questions SET points = 99 WHERE id = '${q1.id}'`],
    ["change the timer", () => `UPDATE public.questions SET timer_seconds = 5 WHERE id = '${q1.id}'`],
    ["reorder a question", () => `UPDATE public.questions SET position = 9 WHERE id = '${q1.id}'`],
    ["move a question to another set", () => `UPDATE public.questions SET set_id = '${otherSetId}' WHERE id = '${q1.id}'`],
    [
      "add a question",
      () =>
        `INSERT INTO public.questions (set_id, position, prompt, points, timer_seconds) VALUES ('${setId}', 9, 'Baru', 10, 20)`,
    ],
    ["delete a question", () => `DELETE FROM public.questions WHERE id = '${q2.id}'`],
    ["unmark the correct option", () => `UPDATE public.question_options SET is_correct = false WHERE id = '${q1.options[0]}'`],
    ["mark another option correct", () => `UPDATE public.question_options SET is_correct = true WHERE id = '${q1.options[1]}'`],
    ["reorder an option", () => `UPDATE public.question_options SET position = 4 WHERE id = '${q1.options[2]}'`],
    ["move an option to another question", () => `UPDATE public.question_options SET question_id = '${q2.id}' WHERE id = '${q1.options[2]}'`],
    ["add an option", () => `INSERT INTO public.question_options (question_id, position, label) VALUES ('${q1.id}', 4, 'D')`],
    ["delete an option", () => `DELETE FROM public.question_options WHERE id = '${q1.options[2]}'`],
  ])("rejects: %s (ET020)", async (_what, statement) => {
    expect(await sqlState(asAdmin(statement()))).toBe("ET020");
  });

  it("rejects deleting the whole set", async () => {
    // Two guards: the cascade into questions hits the lock (ET020, observed on PG 18.6) and the
    // set_attempts foreign key is ON DELETE RESTRICT. Which fires first follows RI trigger order.
    expect(await sqlState(asAdmin(`DELETE FROM public.trivia_sets WHERE id = '${setId}'`))).toMatch(
      /^(ET020|23001|23503)$/,
    );
  });

  it("still allows text edits (prompt, explanation, option label)", async () => {
    await asAdmin(`UPDATE public.questions SET prompt = 'Pertanyaan (typo diperbaiki)', explanation = 'Karena...' WHERE id = '${q1.id}'`);
    await asAdmin(`UPDATE public.question_options SET label = 'A (diperbaiki)' WHERE id = '${q1.options[0]}'`);
  });

  it("does not lock other sets", async () => {
    await asAdmin(`UPDATE public.questions SET points = 15 WHERE set_id = '${otherSetId}'`);
  });
});

// Security review item 4: under REPEATABLE READ the FOR UPDATE does not conflict with an already
// released KEY SHARE, and EXISTS reads the old snapshot, so an attempt committed after the
// snapshot went unseen.
describe("isolation", () => {
  it("rejects a REPEATABLE READ edit whose snapshot predates the first attempt (ET021)", async () => {
    const { setId, q1 } = await createTriviaSet(programId, 4);
    const { playerId } = await createPlayer({ programId, eligible: true });
    let snapshotTaken = (): void => undefined;
    let release = (): void => undefined;
    const taken = new Promise<void>((resolve) => (snapshotTaken = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const edit = sql.begin("isolation level repeatable read", async (tx) => {
      await tx.unsafe("SET LOCAL ROLE admin_rw");
      await tx`SELECT count(*) FROM public.questions`; // takes the snapshot
      snapshotTaken();
      await gate;
      await tx`UPDATE public.questions SET points = 999, timer_seconds = 1 WHERE id = ${q1.id}`;
    });
    const outcome = edit.then(
      () => "committed",
      (e: unknown) => (e as { code?: string }).code ?? "error",
    );
    await taken;
    await createAttempt(playerId, setId);
    release();
    expect(await outcome).toBe("ET021");
    const [q] = await sql<{ points: number }[]>`SELECT points FROM questions WHERE id = ${q1.id}`;
    expect(q?.points).toBe(10);
  });

  it.each(["repeatable read", "serializable"])("rejects a locked-field edit under %s (ET021)", async (level) => {
    const { q1 } = await createTriviaSet(programId, level === "serializable" ? 6 : 5);
    const edit = sql.begin(`isolation level ${level}`, async (tx) => {
      await tx.unsafe("SET LOCAL ROLE admin_rw");
      await tx`UPDATE public.questions SET points = 11 WHERE id = ${q1.id}`;
    });
    expect(await sqlState(edit)).toBe("ET021");
  });
});
